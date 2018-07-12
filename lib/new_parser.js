

var mod_net = require('net');
var mod_assert = require('assert-plus');
var mod_verror = require('verror');
var mod_jsprim = require('jsprim');

var lib_common = require('./common');
var lib_lexer = require('./lexer');

var VE = mod_verror.VError;


function
f10_enable_proto(ftc, proto)
{
	switch (proto) {
	case 'rstp':
		if (ftc.ftc_model.protocols.rstp === null) {
			ftc.ftc_model.protocols.rstp = {
				enabled: false,
				bridge_priority: null
			};
		}
		break;
	}
}

function
f10_cfg_parse(input)
{
	mod_assert.array(input, 'input');
	if (input.length > 0 && typeof (input[0]) === 'string') {
		input = lib_lexer.f10_cfg_lex(input);
	}
	mod_assert.arrayOfObject(input, 'input');

	var ftc = {
		ftc_ended: false,
		ftc_model: {
			v: 2,

			vlans: {},
			ifaces: {},

			hostname: null,
			reload_type: null,

			ip: {
				name_servers: [],
				domain_name: null,
				domain_lookup: false,
				routes: [],
				vrf: {}
			},

			protocols: {
				rstp: null,
				lldp: {
					enabled: true,
					management_tlv: []
				}
			},

			servers: {
				ssh: {
					enabled: false,
					version: null
				},
				telnet: {
					enabled: true,
				},
				snmp: {
					communities: {},
					contact: null,
					location: null,
				},
				ftp: {
					enabled: false,
					users: {}
				},
			},

			enable: null,
			users: {},

			lines: {},

			/*
			 * These configuration sections are merely copied as-is
			 * without interpretation.
			 */
			boot: [],
			redundancy: [],
			hardware: [],
			stack_unit: [],
		},
	};

	/*
	 * VLAN 1 is the default VLAN, and always exists in the model.
	 */
	mod_assert.ok(!f10_section(ftc, {
		w: [ 'interface', 'Vlan', '1' ],
		c: []
	}), 'pre-add vlan 1');

	for (var i = 0; i < input.length; i++) {
		var s = input[i];

		var err = f10_section(ftc, s);
		if (err) {
			return (new VE(err, 'failed to parse config %j', s.w));
		}
	}

	if (!ftc.ftc_ended) {
		return (new VE(err, 'config ended before "end" directive'));
	}

	return (ftc.ftc_model);
}

function
f10_get_iface(ftc, type, port)
{
	var iface;
	var vid;

	if (type === 'Vlan') {
		vid = mod_jsprim.parseInteger(port, { allowSign: false });
		if (vid instanceof Error) {
			throw (vid);
		}

		iface = ftc.ftc_model.vlans[vid];
	} else {
		iface = ftc.ftc_model.ifaces[type + ':' + port];
	}

	if (!iface) {
		/*
		 * Construct a new interface.  Basic properties of all
		 * interface types:
		 */
		iface = {
			type: type,
			ip_address: null,
			description: null,
			shutdown: true,
		};

		switch (type) {
		case 'Vlan':
			iface.vid = vid;
			iface.tagged = {};
			iface.untagged = {};
			break;

		case 'ManagementEthernet':
			iface.port = port;
			break;

		case 'TenGigabitEthernet':
		case 'GigabitEthernet':
		case 'fortyGigE':
		case 'hundredGigE':
			iface.port = port;
			iface.mtu = null;
			iface.switchport = false;
			iface.flow_rx = false;
			iface.flow_tx = false;
			iface.stp = true;
			iface.stp_portfast_bpduguard = false;
			iface.rate_interval = false;
			break;

		default:
			throw (new VE('invalid interface type: %s', type));
		}

		if (type === 'Vlan') {
			ftc.ftc_model.vlans[vid] = iface;
		} else {
			ftc.ftc_model.ifaces[type + ':' + port] = iface;
		}
	}

	return (iface);
}

/*
 * Given a configuration section "s", process using a table of directives for
 * different section types ("section_types").  An optional "extra" argument can
 * be passed, which will be passed on without modification to handler
 * functions.
 *
 * Each section type record has the following properties:
 *
 *	n	(array of) string	this section type record matches if
 *					the provided names match; a single
 *					string behaves the same as an array
 *					of one element.
 *
 *	h	function		the handler function to use for this
 *					section; function arguments:
 *
 *						ftc
 *
 *						disable (boolean): true if
 *						    this section began with "no"
 *
 *						s (section); if section began
 *						    with "no", it will be
 *						    removed from "w" here
 *
 *						extra (optional extra argument)
 *
 *	c	boolean			whether to allow child sections for
 *					this section (defaults to false).
 *
 *	d	boolean			whether to allow the "no" prefix for
 *					this section to represent disabling
 *					some functionality (defaults to false).
 */
function
f10_st_apply(ftc, s, section_types, extra)
{
	s = mod_jsprim.deepCopy(s);

	var disable = false;
	if (s.w[0] === 'no') {
		disable = true;
		s.w.shift();
	}

	for (var i = 0; i < section_types.length; i++) {
		var st = section_types[i];

		if (Array.isArray(st.n)) {
			var match = true;
			for (var j = 0; j < st.n.length; j++) {
				if (st.n[j] !== s.w[j]) {
					match = false;
					break;
				}
			}
			if (!match) {
				continue;
			}

		} else if (st.n !== s.w[0]) {
			continue;
		}

		if (!st.d && disable) {
			return (new VE('unexpected "no" prefix: %s', s.w));
		}

		if (!st.c && s.c.length !== 0) {
			return (new VE('unexpected children: %s: %j', s.w,
			    s.c));
		}

		return (st.h(ftc, disable, s, extra));
	}

	return (new VE('unrecognised section: %j', s));
}

/*
 * Process a section in the tokenised configuration.  Each section ("s") has two
 * properties:
 *
 *	w	array of string		list of words for this section
 *	c	array of sections	list of child sections, if they exist
 *
 * An example of a directive with child sections is an "interface"; e.g.,
 *
 *	interface GigabiteEthernet 0/24
 *	  description first interface
 *	  no shutdown
 *
 * The "description" and "shutdown" lines represent new child sections of the
 * "interface" section, which are themselves without children.
 */
function
f10_section(ftc, s)
{
	/*
	 * This section type set is appropriate for top-level configuration
	 * sections on a Force 10 switch.  Other section type tables are used
	 * in functions for processing a section which has child sections.
	 */
	var section_types = [
		{ n: 'boot', h: f10_h_basic },
		{ n: 'redundancy', h: f10_h_basic },
		{ n: 'hardware', h: f10_h_basic },
		{ n: 'stack-unit', h: f10_h_basic },

		{ n: 'hostname', h: f10_h_oneword },
		{ n: 'reload-type', h: f10_h_oneword },

		/*
		 * Authentication.
		 */
		{ n: 'enable', h: f10_h_enable },
		{ n: 'username', h: f10_h_username },

		/*
		 * Interface management sections.
		 */
		{ n: [ 'interface', 'Vlan' ], h: f10_h_vlan, c: true },
		{ n: [ 'interface', 'ManagementEthernet' ], h: f10_h_mgmt,
		    c: true },
		{ n: [ 'interface', 'TenGigabitEthernet' ], h: f10_h_ether,
		    c: true },
		{ n: [ 'interface', 'GigabitEthernet' ], h: f10_h_ether,
		    c: true },
		{ n: [ 'interface', 'fortyGigE' ], h: f10_h_ether, c: true },
		{ n: [ 'interface', 'hundredGigE' ], h: f10_h_ether, c: true },

		/*
		 * Network servers.
		 */
		{ n: [ 'ip', 'telnet', 'server' ], h: f10_h_telnet, d: true },
		{ n: [ 'ip', 'ssh', 'server', 'enable' ], h: f10_h_ssh_enable,
		    d: true },
		{ n: [ 'ip', 'ssh', 'server', 'version' ],
		    h: f10_h_ssh_version },
		{ n: [ 'snmp-server', 'contact' ], h: f10_h_snmp_prop },
		{ n: [ 'snmp-server', 'location' ], h: f10_h_snmp_prop },
		{ n: [ 'snmp-server', 'community' ], h: f10_h_snmp_community },
		{ n: [ 'ftp-server', 'username' ], h: f10_h_ftp_user },
		{ n: 'ftp-server', h: f10_h_ftp },

		/*
		 * IP stack management.
		 */
		{ n: [ 'ip', 'route' ], h: f10_h_ip_route },
		{ n: [ 'ip', 'domain-name' ], h: f10_h_ip_domain_name },
		{ n: [ 'ip', 'domain-lookup' ], h: f10_h_ip_domain_lookup,
		    d: true },
		{ n: [ 'ip', 'name-server' ], h: f10_h_ip_name_server },

		/*
		 * Switching protocols.
		 */
		{ n: [ 'protocol', 'lldp' ], h: f10_h_lldp, c: true, d: true },
		{ n: [ 'protocol', 'spanning-tree', 'rstp' ], h: f10_h_rstp,
		    c: true, d: true },

		/*
		 * Console and virtual line (e.g., Telnet) management.
		 */
		{ n: 'line', h: f10_h_line },

		{ n: 'end', h: f10_h_end },
	];

	return (f10_st_apply(ftc, s, section_types, null));
}

function
f10_section_children(ftc, s, section_types, extra)
{
	for (var i = 0; i < s.c.length; i++) {
		var err = f10_st_apply(ftc, s.c[i], section_types, extra);

		if (err) {
			return (new VE(err, 'failed to parse config'));
		}
	}

	return (null);
}

function
f10_h_ftp_user(ftc, disable, s)
{
	/*
	 * ftp-server username USERNAME password 7 SECRET
	 */
	if (s.w.length !== 6 || s.w[1] !== 'username' ||
	    s.w[3] !== 'password') {
		return (new VE('invalid FTP-SERVER USERNAME section: %j', s));
	}

	var username = s.w[2];
	var password = { type: s.w[4], value: s.w[5] };

	if (password.type !== '7') {
		return (new VE('invalid FTP-SERVER USERNAME section: %j', s));
	}

	ftc.ftc_model.servers.ftp.users[username] = {
		username: username,
		password: password
	};

	return (null);
}

function
f10_h_ftp(ftc, disable, s)
{
	/*
	 * ftp-server enable
	 */
	if (s.w.length !== 2 || s.w[1] !== 'enable') {
		return (new VE('invalid FTP-SERVER section: %j', s));
	}

	ftc.ftc_model.servers.ftp.enabled = !disable;
	return (null);
}

function
f10_h_ssh_version(ftc, disable, s)
{
	/*
	 * ip ssh server version <1-2>
	 */
	if (s.w.length !== 5 || (s.w[4] !== '1' && s.w[4] !== '2')) {
		return (new VE('invalid IP SSH SERVER section: %j', s));
	}

	ftc.ftc_model.servers.ssh.version = s.w[4];
	return (null);
}

function
f10_h_ssh_enable(ftc, disable, s)
{
	/*
	 * ip ssh server enable
	 */
	if (s.w.length !== 4 || s.w[3] !== 'enable') {
		return (new VE('invalid IP SSH SERVER section: %j', s));
	}

	ftc.ftc_model.servers.ssh.enabled = !disable;
	return (null);
}

function
f10_h_telnet(ftc, disable, s)
{
	/*
	 * ip telnet server enable
	 */
	if (s.w.length !== 4 || s.w[3] !== 'enable') {
		return (new VE('invalid IP TELNET SERVER section: %j', s));
	}

	ftc.ftc_model.servers.telnet.enabled = !disable;
	return (null);
}

function
f10_h_snmp_community(ftc, disable, s)
{
	/*
	 * snmp-server community COMMUNITY [ro|rw]
	 */
	if (s.w.length !== 4 || (s.w[3] !== 'ro' && s.w[3] !== 'rw')) {
		return (new VE('invalid SNMP-SERVER COMMUNITY section: %j', s));
	}

	ftc.ftc_model.servers.snmp.communities[s.w[2]] = s.w[3];
	return (null);
}

function
f10_h_snmp_prop(ftc, disable, s)
{
	/*
	 * snmp-server contact WORDS...
	 * snmp-server location WORDS...
	 */
	var b = s.w[1].replace(/-/g, '_');

	ftc.ftc_model.servers.snmp[b] = disable ? null : s.w.slice(2).join(' ');
	return (null);
}

function
f10_h_line(ftc, disable, s)
{
	/*
	 * line console 0
	 */
	if (s.w.length !== 3) {
		return (new VE('invalid LINE section: %j', s));
	}

	var lnum = mod_jsprim.parseInteger(s.w[2], { allowSign: false });
	if (lnum instanceof Error) {
		return (new VE(lnum, 'invalid LINE section: %j', s));
	}

	var lid = s.w[1] + ':' + lnum;

	var line = ftc.ftc_model.lines[lid];
	if (!line) {
		line = ftc.ftc_model.lines[lid] = {
			type: s.w[1],
			id: lnum
		};
	}

	return (null);
}

function
f10_h_iface_flowcontrol(ftc, disable, s, iface)
{
	if (s.w.length !== 5 || s.w[1] !== 'rx' || s.w[3] !== 'tx') {
		return (new VE('malformed FLOWCONTROL: %j', s));
	}

	var rx = s.w[2] === 'on' ? true : s.w[2] === 'off' ? false : null;
	var tx = s.w[4] === 'on' ? true : s.w[4] === 'off' ? false : null;

	if (rx === null || tx === null) {
		return (new VE('malformed FLOWCONTROL: %j', s));
	}

	iface.flow_rx = rx;
	iface.flow_tx = tx;
	return (null);
}

function
f10_h_iface_switchport(ftc, disable, s, iface)
{
	if (disable) {
		if (s.w.length !== 1) {
			return (new VE('malformed NO SWITCHPORT: %j', s));
		}

		iface.switchport = false;
		return;
	}

	if (s.w.length !== 1) {
		return (new VE('malformed SWITCHPORT: %j', s));
	}

	iface.switchport = true;
	return (null);
}

function
f10_h_iface_mtu(ftc, disable, s, iface)
{
	if (disable) {
		if (s.w.length !== 1) {
			return (new VE('malformed NO MTU: %j', s));
		}

		iface.mtu = null;
		return;
	}

	if (s.w.length !== 2) {
		return (new VE('malformed MTU: %j', s));
	}

	var mtu = mod_jsprim.parseInteger(s.w[1], { allowSign: false });
	if (mtu instanceof Error) {
		return (new VE('malformed MTU: %j', s));
	}

	iface.mtu = mtu;
	return (null);
}

function
f10_h_iface_basic(ftc, disable, s, iface)
{
	/*
	 * description WORDS
	 * name WORDS
	 */
	var b = s.w[0].replace(/-/g, '_');
	if (disable) {
		if (s.w.length !== 1) {
			return (new VE('malformed NO %s: %j',
			    b.toUpperCase(), s));
		}

		iface[b] = null;
		return;
	}

	if (s.w.length < 2) {
		return (new VE('malformed %s: %j', b.toUpperCase(), s));
	}

	iface[b] = s.w.slice(1).join(' ');
	return (null);
}

function
f10_h_iface_shutdown(ftc, disable, s, iface)
{
	if (s.w.length !== 1) {
		return (new VE('malformed SHUTDOWN: %j', s));
	}

	iface.shutdown = !disable;
	return (null);
}

function
f10_h_iface_ip_address(ftc, disable, s, iface)
{
	if (disable) {
		if (!mod_jsprim.deepEqual(s.w, [ 'ip', 'address' ])) {
			return (new VE('malformed NO IP ADDRESS: %j', s));
		}

		iface.ip_address = null;
		return (null);
	}

	if (s.w.length !== 3) {
		return (new VE('malformed IP ADDRESS: %j', s));
	}

	iface.ip_address = s.w[2];
	return (null);
}

function
f10_h_rstp(ftc, disable, s)
{
	if (!mod_jsprim.deepEqual(s.w, [ 'protocol', 'spanning-tree',
	    'rstp' ])) {
		return (new VE('malformed PROTOCOL RSTP section: %j', s));
	}

	if (disable) {
		if (s.c.length > 0) {
			return (new VE('cannot have NO PROTOCOL RSTP with ' +
			    'children: %j', s));
		}

		/*
		 * Reset the protocol completely.
		 */
		ftc.ftc_model.protocols.rstp = null;
		return (null);
	}

	/*
	 * If the protocol block is present, ensure that our model of the
	 * default values has been loaded.
	 */
	f10_enable_proto(ftc, 'rstp');

	var section_types = [
		{ n: 'disable', h: f10_h_rstp_disable, d: true },
	];

	return (f10_section_children(ftc, s, section_types, null));
}

function
f10_h_rstp_disable(ftc, disable, s)
{
	if (s.w.length !== 1) {
		return (new VE('malformed DISABLE: %j', s));
	}

	ftc.ftc_model.protocols.rstp.enabled = disable;
	return (null);
}

function
f10_h_lldp(ftc, disable, s)
{
	/*
	 * protocol lldp
	 */
	if (!mod_jsprim.deepEqual(s.w, [ 'protocol', 'lldp' ])) {
		return (new VE('malformed PROTOCOL LLDP section: %j', s));
	}

	if (disable) {
		if (s.c.length > 0) {
			return (new VE('cannot have NO PROTOCOL LLDP with ' +
			    'children: %j', s));
		}

		var lldp = ftc.ftc_model.protocols.lldp;
		lldp.enabled = false;

		/*
		 * If the entire protocol is disabled, reset any enabled TLVs.
		 */
		mod_jsprim.forEachKey(lldp.management_tlv, function (k, v) {
			lldp.management_tlv[k] = false;
		});

		return (null);
	}

	var section_types = [
		{ n: [ 'advertise', 'management-tlv' ],
		    h: f10_h_lldp_advertise },
		{ n: [ 'disable' ], h: f10_h_lldp_disable, d: true },
	];

	return (f10_section_children(ftc, s, section_types, null));
}

function
f10_h_lldp_disable(ftc, disable, s)
{
	if (s.w.length !== 1) {
		return (new VE('malformed DISABLE: %j', s));
	}

	ftc.ftc_model.protocols.lldp.enabled = disable;
	return (null);
}

function
f10_h_lldp_advertise(ftc, disable, s)
{
	/*
	 * advertise management-tlv TLV_NAME
	 */
	if (s.w.length < 3 || s.w[1] !== 'management-tlv') {
		return (new VE('malformed ADVERTISE section: %j', s));
	}

	var MANAGEMENT_TLVS = [
		'management-address',
		'system-capabilities',
		'system-description',
		'system-name',
	];

	var err = null;
	s.w.slice(2).forEach(function (tlv) {
		if (err) {
			return;
		}

		if (MANAGEMENT_TLVS.indexOf(tlv) === -1) {
			err = new VE('malformed ADVERTISE section: %j', s);
			return;
		}

		lib_common.array_set(
		    ftc.ftc_model.protocols.lldp.management_tlv, tlv, !disable);
	});
	return (err);
}

function
f10_h_rate_interval(ftc, disable, s, iface)
{
	if (s.w.length !== 2) {
		return (new VE('malformed RATE-INTERVAL: %j', s));
	}

	var num = mod_jsprim.parseInteger(s.w[1], { allowSign: false });
	if (num instanceof Error) {
		return (new VE(num, 'malformed RATE-INTERVAL: %j', s));
	}

	iface.rate_interval = num;
	return (null);
}

function
f10_h_iface_stp(ftc, disable, s, iface)
{
	/*
	 * [no] spanning-tree
	 */
	if (s.w.length === 1) {
		iface.stp = !disable;
		return (null);
	}

	/*
	 * spanning-tree 0 portfast bpduguard
	 */
	if (mod_jsprim.deepEqual(s.w, [ 'spanning-tree', '0', 'portfast',
	    'bpduguard' ])) {
		iface.stp_portfast_bpduguard = true;
		return (null);
	}

	return (new VE('malformed SPANNING-TREE: %j', s));
}

function
f10_h_ether(ftc, disable, s)
{
	if (s.w.length !== 3) {
		return (new VE('malformed INTERFACE section: %j', s));
	}

	var iface = f10_get_iface(ftc, s.w[1], s.w[2]);

	var section_types = [
		{ n: 'description', h: f10_h_iface_basic },
		{ n: 'shutdown', h: f10_h_iface_shutdown, d: true },
		{ n: [ 'ip', 'address' ], h: f10_h_iface_ip_address, d: true },

		{ n: 'mtu', h: f10_h_iface_mtu, d: true },
		{ n: 'switchport', h: f10_h_iface_switchport, d: true },
		{ n: 'flowcontrol', h: f10_h_iface_flowcontrol, d: true },
		{ n: 'spanning-tree', h: f10_h_iface_stp, d: true },
		{ n: 'rate-interval', h: f10_h_rate_interval },
	];

	return (f10_section_children(ftc, s, section_types, iface));
}

function
f10_h_mgmt(ftc, disable, s)
{
	if (s.w.length !== 3) {
		return (new VE('malformed INTERFACE section: %j', s));
	}

	var iface = f10_get_iface(ftc, s.w[1], s.w[2]);

	var section_types = [
		{ n: 'description', h: f10_h_iface_basic },
		{ n: 'shutdown', h: f10_h_iface_shutdown, d: true },
		{ n: [ 'ip', 'address' ], h: f10_h_iface_ip_address, d: true },
	];

	return (f10_section_children(ftc, s, section_types, iface));
}

function
f10_h_vlan_member(ftc, disable, s, vlan)
{
	if (s.w.length !== 3 ||
	    (s.w[0] !== 'tagged' && s.w[0] !== 'untagged')) {
		return (new VE('malformed VLAN member section: %j', s));
	}

	var rng = lib_common.explode_port_range(s.w[2]);
	if (rng === null) {
		return (new VE('invalid port range: %j', s));
	}

	rng.forEach(function (port) {
		vlan[s.w[0]][s.w[1] + ':' + port] = true;
	});
}

function
f10_h_vlan(ftc, disable, s)
{
	if (s.w.length !== 3) {
		return (new VE('malformed INTERFACE VLAN section: %j', s));
	}

	var vlan = f10_get_iface(ftc, s.w[1], s.w[2]);

	var section_types = [
		{ n: 'name', h: f10_h_iface_basic },
		{ n: 'description', h: f10_h_iface_basic },
		{ n: 'shutdown', h: f10_h_iface_shutdown, d: true },
		{ n: [ 'ip', 'address' ], h: f10_h_iface_ip_address, d: true },
		{ n: 'tagged', h: f10_h_vlan_member },
		{ n: 'untagged', h: f10_h_vlan_member },
	];

	return (f10_section_children(ftc, s, section_types, vlan));
}

function
f10_h_end(ftc, disable, s)
{
	if (!mod_jsprim.deepEqual(s.w, [ 'end' ])) {
		return (new VE('malformed END line: %j', s.w));
	}

	ftc.ftc_ended = true;
	return (null);
}

/*
 * We don't much care about the structure of some of the more baroque
 * directives right now; e.g., "boot", "hardware", etc.  For lines of this
 * type, just store the line on a top-level property of the model.
 */
function
f10_h_basic(ftc, disable, s)
{
	var b = s.w[0].replace(/-/g, '_');

	var w = mod_jsprim.deepCopy(s.w);
	if (disable) {
		w.unshift('no');
	}

	ftc.ftc_model[b].push(w);
	return (null);
}

/*
 * A handful of properties are really just a single word (e.g., "hostname")
 * and require no further interpretation.  Store them directly on the model.
 */
function
f10_h_oneword(ftc, disable, s)
{
	if (s.w.length !== 2) {
		return (new VE('malformed %s line: %j', s.w[0].toUpperCase(),
		    s.w));
	}

	var b = s.w[0].replace(/-/g, '_');
	ftc.ftc_model[b] = disable ? null : s.w[1];
	return (null);
}

function
f10_h_enable(ftc, disable, s)
{
	/*
	 * enable secret 7 blahblahblah
	 */
	if (s.w.length !== 4 || s.w[1] !== 'secret') {
		return (new VE('malformed ENABLE line: %j', s.w));
	}

	ftc.ftc_model.enable = { type: s.w[2], value: s.w[3] };
	return (null);
}

function
f10_h_username(ftc, disable, s)
{
	/*
	 * username admin password 7 blahblahblah privilege 15
	 */
	if (s.w.length !== 7 || s.w[2] !== 'password' ||
	    s.w[5] !== 'privilege') {
		return (new VE('malformed USERNAME line: %j', s.w));
	}

	var o = {
		username: s.w[1],
		password: {
			type: s.w[3],
			value: s.w[4]
		},
		privilege: s.w[6]
	};

	ftc.ftc_model.users[o.username] = o;
	return (null);
}

function
f10_h_ip_name_server(ftc, disable, s)
{
	/*
	 * ip name-server IP_ADDRESS
	 */
	if (s.w.length !== 3 || !mod_net.isIPv4(s.w[2])) {
		return (new VE('malformed IP NAME-SERVER: %j', s.w));
	}

	lib_common.array_set(ftc.ftc_model.ip.name_servers, s.w[2], !disable);
	return (null);
}

function
f10_h_ip_domain_lookup(ftc, disable, s)
{
	/*
	 * ip domain-lookup
	 */
	if (s.w.length !== 2) {
		return (new VE('malformed IP DOMAIN-LOOKUP: %j', s.w));
	}

	ftc.ftc_model.ip.domain_lookup = !disable;
	return (null);
}

function
f10_h_ip_domain_name(ftc, disable, s)
{
	/*
	 * ip domain-name DOMAIN_NAME
	 */
	if (s.w.length !== 3) {
		return (new VE('malformed IP DOMAIN-NAME: %j', s.w));
	}

	ftc.ftc_model.ip.domain_name = s.w[2];
	return (null);
}

function
f10_h_ip_route(ftc, disable, s)
{
	/*
	 * ip route DESTINATION/PREFIX [Vlan VID] GATEWAY [permanent]
	 */
	var p = 2;
	var dest = s.w[p].split('/');
	if (dest.length !== 2 || !mod_net.isIPv4(dest[0])) {
		return (new VE('invalid IP route dest: %j', s.w));
	}
	p++;

	var perm = false;
	var vid = null;
	if (s.w[p] === 'Vlan') {
		p++;
		vid = mod_jsprim.parseInteger(s.w[p], { allowSign: false });
		if (vid instanceof Error) {
			return (new VE('invalid VLAN ID: %j', s.w));
		}
		p++;
	}

	var gw = s.w[p++];
	if (!mod_net.isIPv4(gw)) {
		return (new VE('invalid IP route gateway: %j', s.w));
	}

	while (p < s.w.length) {
		if (s.w[p] === 'permanent') {
			perm = true;
		} else {
			return (new VE('invalid IP route extras: %j', s.w));
		}
		p++;
	}

	ftc.ftc_model.ip.routes.push({
		destination: dest.join('/'),
		gateway: gw,
		vlan: vid,
		permanent: perm
	});
	return (null);
}

module.exports = {
	f10_cfg_parse: f10_cfg_parse,
};
