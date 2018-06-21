#!/usr/bin/env node
/* vim: set ts=8 sts=8 sw=8 noet: */

var mod_stream = require('stream');
var mod_verror = require('verror');
var mod_util = require('util');
var mod_jsprim = require('jsprim');
var mod_net = require('net');
var mod_assert = require('assert-plus');

var lib_models = require('./models');
var lib_common = require('./common');

var VE = mod_verror.VError;
var explode_port_range = lib_common.explode_port_range;
var array_set = lib_common.array_set;

var EXPECTED_REDUNDANCY = [
	[ 'redundancy', 'auto-synchronize', 'full' ]
];

function
check_cidr(cidr)
{
	var x = cidr.split('/');

	if (x.length !== 2)
		return (false);

	/*
	 * XXX check the prefix length, too!
	 */
	return (mod_net.isIPv4(x[0]));
}

function
check_basic(name, actual, expected)
{
	var aa = [].concat(actual).sort();
	var ee = [].concat(expected).sort();

	if (!mod_jsprim.deepEqual(aa, ee)) {
		return (VE({ info: { actual: aa, expected: ee } },
		    '"%s" did not match expected list of directives',
		    name));
	}

	return (null);
}


function
Force10ParserStream()
{
	var self = this;

	mod_stream.Writable.call(self, { objectMode: true,
	    highWaterMark: 0 });

	/*
	 * The initial contents of the model reflects our understanding
	 * of the defaults for each configuration directive that we
	 * can process.  Getting the defaults right is important as,
	 * in the Force10 configuration language, the absence of many
	 * directives often has an implicit meaning; e.g., a lack of
	 * "no ip telnet server enable" means telnet is enabled.
	 */
	self.ftps_model = {
		v: 1,
		hostname: null,
		ip: {
			name_servers: [],
			domain_name: null,
			domain_lookup: false,
			routes: [],
			vrf: {}
		},
		arp: {
			learn_enable: null
		},
		servers: {
			ssh: {
				enabled: false,
				version: null
			},
			telnet: {
				enabled: true
			},
			snmp: {
				communities: {},
				contact: null,
				location: null,
				enable_traps: []
			},
			ftp: {
				enabled: false,
				users: {}
			}
		},
		clients: {
			tftp: {
				source_interface: null,
				vrf: null
			},
			tacacs: {
				source_interface: null,
				hosts: {}
			},
			ntp: {
				hosts: {}
			}
		},
		vlans: {},
		interfaces: {},
		lines: {},
		enable: null,
		users: {},
		boot: [],
		redundancy: [],
		hardware: [],
		logging: [],
		service: [],
		feature: [],
		aaa: [],
		vlt: {},
		eula_consent: [],
		route_map: {},
		timezone: {},
		protocols: {
			rstp: {
				enabled: false,
				bridge_priority: null
			},
			stp: {
				enabled: false
			},
			lldp: {
				enabled: true,
				'management-tlv': {
					'system-capabilities': false,
					'system-description': false,
					'system-name': false,
				}
			}
		},
		reload_type: null,
		sflow: null
	};

	/*
	 * VLAN 1 is the default VLAN, and always exists in the model.
	 */
	self._get_interface('Vlan', '1');

	self.ftps_section_stack = [];
	self.ftps_ended = false;

	self.on('finish', function () {
		self._on_finish();
	});
}
mod_util.inherits(Force10ParserStream, mod_stream.Writable);

Force10ParserStream.prototype._get_interface = function
_get_interface(type, id)
{
	var self = this;

	if (type === 'Vlan') {
		return (self._get_vlan(id));
	}

	if (self.ftps_model.interfaces[type + ' ' + id]) {
		return (self.ftps_model.interfaces[type + ' ' + id]);
	}

	var iface = lib_models.model_default_interface(type);

	if (iface === null)
		return (null);

	self.ftps_model.interfaces[type + ' ' + id] = iface;

	return (iface);
};

Force10ParserStream.prototype._get_vlan = function
_get_vlan(id)
{
	var self = this;

	mod_assert.string(id, 'id');

	if (!self.ftps_model.vlans[id]) {
		self.ftps_model.vlans[id] =
		    lib_models.model_default_interface('Vlan');
	}

	return (self.ftps_model.vlans[id]);
};

Force10ParserStream.prototype._on_finish = function
_on_finish()
{
	var self = this;

	self.emit('model', mod_jsprim.deepCopy(self.ftps_model));
};

function
remove_comments(raw)
{
	var out = '';

	var p = null;
	for (var i = 0; i < raw.length; i++) {
		var c = raw[i];

		if (c === '!' && (p === ' ' || p === '\t' || p === null)) {
			break;
		}

		out += c;
		p = c;
	}

	return (out);
}

Force10ParserStream.prototype._write = function
_write(raw, _, done)
{
	var self = this;

	if (self.ftps_ended) {
		done(VE('line after "end" directive: "%s"', raw));
		return;
	}

	/*
	 * Strip out comments first.
	 */
	// var line = raw.replace(/\!.*/, '');
	var line = remove_comments(raw);

	/*
	 * Ignore blank lines and the configuration file banner.
	 */
	if (line === '' || line === 'Current Configuration ...') {
		done();
		return;
	}

	/*
	 * Determine the indentation level of this command.  We must do this
	 * before any trimming of whitespace.
	 */
	var ind = 0;
	for (var i = 0; i < line.length; i++) {
		if (line[i] !== ' ' && line[i] !== '\t') {
			break;
		}
		ind++;
	}

	mod_assert.arrayOfObject(self.ftps_section_stack,
	    'ftps_section_stack');
	var stack = self.ftps_section_stack;

	while (stack.length > 0 && ind <= stack[0].ss_level) {
		/*
		 * If this line is indented the same (or less) than the
		 * section we were in previously, we have left that section.
		 * This might be true of several nested sections at once;
		 * e.g., if we leave a "port-channel-protocol" section
		 * within an "interface" section to get to the next
		 * "interface".
		 */
		stack.shift();
	}

	var section = stack[0] || null;

	if (section !== null) {
		if (section.ss_sublevel !== null) {
			if (ind !== section.ss_sublevel) {
				done(VE('subsection indent changed: %d -> %d',
				    section.ss_sublevel, ind));
				return;
			}
		} else if (ind > section.ss_level) {
			section.ss_sublevel = ind;
		}
	}

	var words = line.trim().split(/[ \t]+/);

	/*
	 * Check for "no", the negation operator.
	 */
	var disable = false;
	if (words[0] === 'no') {
		disable = true;
		words.shift();
	}

	var unexpected_disable = function () {
		if (disable) {
			done(VE('unexpected "no" prefix: %s', line));
			return (true);
		}

		return (false);
	};

	if (section !== null) {
		switch (section.ss_type) {
		case 'interface':
			self._process_interface(words, disable, done);
			return;

		case 'vlt_domain':
			self._process_vlt_domain(words, disable, done);
			return;

		case 'vrrp-group':
			self._process_vrrp_group(words, disable, done);
			return;

		case 'protocol':
			self._process_protocol(words, disable, done);
			return;

		case 'port-channel-protocol':
			self._process_port_channel(words, disable, done);
			return;

		case 'line':
			self._process_line(words, disable, done);
			return;

		case 'route-map':
			self._process_route_map(words, disable, done);
			return;

		case 'router-ospf':
		case 'ip-prefix-list':
		case 'ip-access-list':
		case 'reload-type':
			/*
			 * XXX
			 */
			done();
			return;

		default:
			done(VE('unknown section type: "%s"',
			    section.ss_type));
			return;
		}
	}

	switch (words[0]) {
	case 'boot':
		if (unexpected_disable())
			return;

		self.ftps_model.boot.push(words);
		done();
		return;

	case 'redundancy':
		if (unexpected_disable())
			return;

		self.ftps_model.redundancy.push(words);
		done();
		return;

	case 'hardware':
		if (unexpected_disable())
			return;

		self.ftps_model.hardware.push(words);
		done();
		return;

	case 'hostname':
		if (unexpected_disable())
			return;

		if (words.length !== 2) {
			done(VE('malformed HOSTNAME line: %j', words));
			return;
		}

		self.ftps_model.hostname = words[1];
		done();
		return;

	case 'interface':
		if (unexpected_disable())
			return;

		if (section !== null) {
			done(VE('nested section not supported: %j', section));
			return;
		}

		var iface_type = words[1];
		var iface_name = words[2] || null;
		if (iface_name === null) {
			done(VE('expected an interface name: %j', words));
			return;
		}

		var iface = self._get_interface(iface_type, iface_name);
		if (iface === null) {
			done(VE('unknown interface type "%s"', iface_type));
			return;
		}

		stack.unshift({
			ss_type: 'interface',
			ss_data: {
				iface_type: iface_type,
				iface_name: iface_name,
				iface: iface
			},
			ss_words: words,
			ss_level: ind,
			ss_sublevel: null,
			ss_sublines: []
		});
		done();
		return;

	case 'ip':
		if (words[1] === 'prefix-list' || words[1] === 'access-list') {
			stack.unshift({
				ss_type: 'ip-prefix-list',
				ss_data: {},
				ss_words: words,
				ss_level: ind,
				ss_sublevel: null,
				ss_sublines: []
			});
			done();
			return;
		}
		self._process_ip(words, disable, done);
		return;

	case 'router':
		if (unexpected_disable())
			return;

		if (words[1] === 'ospf') {
			stack.unshift({
				ss_type: 'router-ospf',
				ss_data: {},
				ss_words: words,
				ss_level: ind,
				ss_sublevel: null,
				ss_sublines: []
			});
			done();
			return;
		}

		done(VE('unexpected router type "%s": %j', words[1], words));
		return;


	case 'route-map':
		if (words[2] !== 'permit' && words[2] !== 'deny') {
			done(VE('invalid ROUTE-MAP type "%s": %j', words[2],
			    words));
			return;
		}

		var seqnum = parseInt(words[3], 10);
		if (!(seqnum >= 1 && seqnum <= 65535)) {
			done(VE('invalid ROUTE-MAP sequence "%s": %j', words[3],
			    words));
			return;
		}

		if (disable) {
			delete self.ftps_model.route_map[words[1]][seqnum];
			done();
			return;
		}

		if (!self.ftps_model.route_map[words[1]]) {
			self.ftps_model.route_map[words[1]] = {};
		}

		var rm;
		if (!self.ftps_model.route_map[words[1]][seqnum]) {
			 rm = self.ftps_model.route_map[words[1]][seqnum] = {};
		}

		rm.default = words[2];
		rm.match = [];

		stack.unshift({
			ss_type: 'route-map',
			ss_data: {
				route_map: rm
			},
			ss_words: words,
			ss_level: ind,
			ss_sublevel: null,
			ss_sublines: []
		});
		done();
		return;

	case 'snmp-server':
		self._process_snmp_server(words, disable, done);
		return;

	case 'ftp-server':
		self._process_ftp_server(words, disable, done);
		return;

	case 'line':
		if (unexpected_disable())
			return;

		if (section !== null) {
			done(VE('nested section not supported: %j', section));
			return;
		}

		var line_name = words[1] + ' ' + words[2];
		if (!self.ftps_model.lines[line_name]) {
			self.ftps_model.lines[line_name] = {
				privilege: null
			};
		}

		stack.unshift({
			ss_type: 'line',
			ss_data: {
				line_type: words[1],
				line_number: words[2],
				line: self.ftps_model.lines[line_name]
			},
			ss_words: words,
			ss_level: ind,
			ss_sublevel: null,
			ss_sublines: []
		});
		done();
		return;

	case 'stack-unit':
		if (unexpected_disable())
			return;

		/*
		 * Looking for lines of the form:
		 *	stack-unit 0 provision <MODEL>
		 * XXX non-0 ids?
		 */
		if (/*words[1] !== '0' || */ words[2] !== 'provision' ||
		    words[4]) {
			done(VE('unexpected STACK-UNIT: %j', words));
			return;
		}
		done();
		return;

	case 'enable':
		if (unexpected_disable())
			return;

		/*
		 * Looking for lines of the form:
		 *	enable secret 7 blahblahblahblah
		 */
		if (words[1] !== 'secret' || words[4]) {
			done(VE('unexpected ENABLE: %j', words));
			return;
		}

		self.ftps_model.enable = { type: words[2], value: words[3] };
		done();
		return;

	case 'username':
		if (unexpected_disable())
			return;

		var o = {};

		if (!words[1]) {
			done(VE('USERNAME line needs a username: %j', words));
			return;
		}

		o.username = words[1];

		if (words[2] !== 'password' || (words[3] !== '5' &&
		    words[3] !== '7') || !words[4]) {
			done(VE('USERNAME line needs a password: %j', words));
			return;
		}

		o.password = { type: words[3], value: words[4] };

		if (words[5]) {
			/*
			 * Check for "privilege" clause.
			 */
			if (words[5] !== 'privilege' || !words[6] || words[7]) {
				done(VE('unexpected USERNAME: %j', words));
				return;
			}

			o.privilege = words[6];
		}

		self.ftps_model.users[words[1]] = o;
		done();
		return;

	case 'protocol':
		if (unexpected_disable())
			return;

		var proto = null;
		if (words[1] === 'lldp' && !words[2]) {
			proto = 'lldp';
		} else if (words[1] === 'spanning-tree' && !words[3]) {
			switch (words[2]) {
			case '0':
				proto = 'stp';
				break;

			case 'rstp':
				proto = words[2];
				break;

			default:
				proto = null;
				break;
			}
		}

		if (proto !== null) {
			stack.unshift({
				ss_type: 'protocol',
				ss_data: {
					protocol: proto
				},
				ss_words: words,
				ss_level: ind,
				ss_sublevel: null,
				ss_sublines: []
			});
			done();
			return;
		}

		done(VE('unexpected PROTOCOL line: %j', words));
		return;

	case 'lacp':
		if (words[1] === 'ungroup' && words[2] === 'member-independent' &&
		    !words[4]) {
			switch (words[3]) {
			case 'vlt':
			case 'port-channel':
				done();
				return;
			}
		}

		done(VE('unexpected LACP line: %j', words));
		return;

	case 'reload-type':
		if (unexpected_disable())
			return;

		if (!words[1]) {
			/*
			 * XXX This may be a "reload-type" block?
			 */
			stack.unshift({
				ss_type: 'reload-type',
				ss_data: {},
				ss_words: words,
				ss_level: ind,
				ss_sublevel: null,
				ss_sublines: []
			});
			done();
			return;
		}

		switch (words[1]) {
		case 'normal-reload':
			self.ftps_model.reload_type = words[1];
			done();
			return;
		}

		done(VE('unexpected RELOAD-TYPE line: %j', words));
		return;

	case 'logging':
		if (unexpected_disable())
			return;

		switch (words[1]) {
		case 'buffered':
		case 'coredump':
		case 'history':
		case 'facility':
		case 'source-interface':
			self.ftps_model.logging.push(words);
			done();
			return;
		}

		if (mod_net.isIPv4(words[1]) && !words[2]) {
			self.ftps_model.logging.push(words);
			done();
			return;
		}

		done(VE('unexpected LOGGING line: %j', words));
		return;

	case 'service':
		if (unexpected_disable())
			return;

		switch (words[1]) {
		case 'timestamps':
			self.ftps_model.service.push(words);
			done();
			return;
		}

		done(VE('unexpected SERVICE line: %j', words));
		return;

	case 'clock':
		if (unexpected_disable())
			return;

		switch (words[1]) {
		case 'timezone':
			self.ftps_model.timezone[words[2]] = words[3];
			done();
			return;
		}

		done(VE('unexpected CLOCK line: %j', words));
		return;

	case 'aaa':
		if (unexpected_disable())
			return;

		switch (words[1]) {
		case 'authentication':
		case 'authorization':
			self.ftps_model.aaa.push(words);
			done();
			return;
		}

		done(VE('unexpected AAA line: %j', words));
		return;

	case 'eula-consent':
		if (unexpected_disable())
			return;

		switch (words[1]) {
		case 'support-assist':
			self.ftps_model.eula_consent.push(words);
			done();
			return;
		}

		done(VE('unexpected EULA-CONSENT line: %j', words));
		return;

	case 'feature':
		switch (words[1]) {
		case 'vrf':
			if (words[2])
				break;

			array_set(self.ftps_model.feature, words[1], !disable);

			done();
			return;
		}

		done(VE('unexpected FEATURE line: %j', words));
		return;

	case 'vlt':
		if (unexpected_disable())
			return;

		if (words[1] === 'domain' && words[2]) {
			self.ftps_model.vlt[words[2]] = [];

			stack.unshift({
				ss_type: 'vlt_domain',
				ss_data: {
					domain_id: words[2]
				},
				ss_words: words,
				ss_level: ind,
				ss_sublevel: null,
				ss_sublines: []
			});
			done();
			return;
		}

		done(VE('unexpected VLT line: %j', words));
		return;

	case 'sflow':
		if (unexpected_disable())
			return;

		if (words[1] === 'enable' && !words[2]) {
			self.ftps_model.sflow = true;
			done();
			return;
		}

		done(VE('unexpected SFLOW line: %j', words));
		return;

	case 'arp':
		if (unexpected_disable())
			return;

		if (words[1] === 'learn-enable' && !words[2]) {
			self.ftps_model.arp.learn_enable = true;
			done();
			return;
		}

		done(VE('unexpected ARP line: %j', words));
		return;

	case 'tacacs-server':
		if (unexpected_disable())
			return;

		if (words[1] === 'host' && words[2]) {
			/*
			 * XXX
			 */
			self.ftps_model.clients.tacacs.hosts[words[2]] =
			    words.slice(3).join(' ');
			done();
			return;
		}

		done(VE('unexpected TACACS-SERVER line: %j', words));
		return;

	case 'ntp':
		/*
		 * ntp server [vrf VRF_NAME] { hostname | ipv4 | ipv6 }
		 *     [key KEY_ID] [prefer] [version NUMBER]
		 */
		if (words[1] === 'server' && words[2] && !words[3]) {
			if (disable) {
				delete self.ftps_model.clients.ntp.hosts[
				    words[2]];
			} else {
				self.ftps_model.clients.ntp.hosts[words[2]] = {
					key: null,
					prefer: null,
					version: null
				};
			}

			done();
			return;
		}

		done(VE('unexpected NTP line: %j', words));
		return;

	case '':
		if (unexpected_disable())
			return;

		/*
		 * Ignore otherwise blank lines.
		 */
		done();
		return;

	case 'end':
		if (unexpected_disable())
			return;

		self.ftps_ended = true;

		/*
		 * Apply some completeness checks:
		 */
		var berr;
		if ((berr = check_basic('redundancy',
		    self.ftps_model.redundancy,
		    EXPECTED_REDUNDANCY)) !== null) {
			done(berr);
			return;
		}

		/*
		 * Sort some values for consistent output.
		 */
		self.ftps_model.ip.name_servers.sort();
		self.ftps_model.ip.routes.sort();

		Object.keys(self.ftps_model.vlans).forEach(function (vlid) {
			self.ftps_model.vlans[vlid].tagged_ports.sort();
			self.ftps_model.vlans[vlid].untagged_ports.sort();
		});

		done();
		return;

	default:
		done(VE('unknown word "%s" in line: %j', words[0], words));
		return;
	}
};

Force10ParserStream.prototype._process_line = function
_process_line(words, disable, done)
{
	var self = this;
	var section = self.ftps_section_stack[0];

	if (words[0] === 'privilege' && words[1] === 'level') {
		if (disable) {
			done(VE('unexpected "no": %j', words));
			return;
		}

		section.ss_data.line.privilege = parseInt(words[2], 10);

		done();
		return;
	}

	if (words[0] === 'exec-timeout' || words[0] === 'access-class') {
		/*
		 * XXX
		 */
		done();
		return;
	}

	done(VE('unhandled LINE block directive: %s%j',
	    disable ? 'no ' : '', words));
};

Force10ParserStream.prototype._process_route_map = function
_process_route_map(words, disable, done)
{
	var self = this;
	var section = self.ftps_section_stack[0];
	var route_map = section.ss_data.route_map;

	/*
	 * match ip address PREFIX_LIST_NAME
	 */
	if (words[0] === 'match' && words[1] === 'ip' &&
	    words[2] === 'address' && words[3] && !words[4]) {
		array_set(route_map.match, 'ip address ' + words[3], !disable);
		done();
		return;
	}

	done(VE('unhandled ROUTE-MAP block directive: %s%j',
	    disable ? 'no ' : '', words));
};

Force10ParserStream.prototype._process_vrrp_group = function
_process_vrrp_group(words, disable, done)
{
	var self = this;
	var section = self.ftps_section_stack[0];
	var vrrp_group = section.ss_data.vrrp_group;

	if (words[0] === 'priority' && !words[2]) {
		if (disable && !words[1]) {
			vrrp_group.priority = null;
			done();
			return;
		} else if (!disable && words[1]) {
			vrrp_group.priority = words[1];
			done();
			return;
		}
	}

	if (words[0] === 'virtual-address') {
		/*
		 * Accepts a list of addresses.
		 */
		var addrs = words.slice(1);

		for (var i = 0; i < addrs.length; i++) {
			array_set(vrrp_group.virtual_addresses, addrs[i],
			    !disable);
		}

		done();
		return;
	}

	done(VE('unhandled VRRP-GROUP block directive: %s%j',
	    disable ? 'no ' : '', words));
};

Force10ParserStream.prototype._process_port_channel = function
_process_port_channel(words, disable, done)
{
	var self = this;
	var section = self.ftps_section_stack[0];

	/*
	 * Looking for lines of the form:
	 *	port-channel 1 mode active
	 *	port-channel 2 mode passive
	 */
	if (words[0] === 'port-channel' && words[2] === 'mode' && !words[4]) {
		var mode = words[3];
		if (mode !== 'active' && mode !== 'passive') {
			done(VE('invalid port channel mode: %s', mode));
			return;
		}

		var number = parseInt(words[1], 10);

		if (section.ss_data.iface.aggr !== null) {
			done(VE('duplicate PORT CHANNEL?!'));
			return;
		}
		section.ss_data.iface.aggr = {
			protocol: 'lacp',
			number: number,
			mode: mode
		};

		done();
		return;
	}

	done(VE('unhandled PORT CHANNEL PROTOCOL block directive: %s%j',
	    disable ? 'no ' : '', words));
};

Force10ParserStream.prototype._process_interface = function
_process_interface(words, disable, done)
{
	var self = this;
	var section = self.ftps_section_stack[0];

	switch (section.ss_data.iface_type) {
	case 'Vlan':
		self._process_interface_vlan(words, disable, done);
		return;

	case 'GigabitEthernet':
	case 'TenGigabitEthernet':
	case 'fortyGigE':
	case 'hundredGigE':
		self._process_interface_ethernet(words, disable, done);
		return;

	case 'Port-channel':
		self._process_interface_portchan(words, disable, done);
		return;

	case 'Loopback':
		self._process_interface_common(words, disable, done);
		return;

	case 'ManagementEthernet':
		self._process_interface_mgmt(words, disable, done);
		return;

	default:
		done(VE('unknown interface type: "%s"',
		    section.ss_data.iface_type));
		return;
	}
};

Force10ParserStream.prototype._process_interface_common = function
_process_interface_common(words, disable, done)
{
	var self = this;
	var section = self.ftps_section_stack[0];
	var iface = section.ss_data.iface;

	if (words[0] === 'shutdown' && !words[1]) {
		iface.shutdown = !disable;
		done();
		return;
	}

	if (words[0] === 'ip' && words[1] === 'address' && !words[3]) {
		if (disable) {
			iface.ip_address = null;
			done();
			return;
		}

		if (!check_cidr(words[2])) {
			done(VE('invalid prefix notation IP: %s', words[2]));
			return;
		}

		iface.ip_address = words[2];
		done();
		return;
	}

	if (words[0] === 'ip' && words[1] === 'unreachables' && !words[2]) {
		iface.ip_unreachables = !disable;
		done();
		return;
	}

	if (words[0] === 'ip' && words[1] === 'proxy-arp' && !words[2]) {
		iface.ip_proxy_arp = !disable;
		done();
		return;
	}

	if (words[0] === 'ip' && words[1] === 'ospf' &&
	    words[2] === 'network' && words[3] === 'point-to-point' &&
	    !words[4]) {
		iface.ip_ospf_network_ptp = !disable;
		done();
		return;
	}

	if (words[0] === 'ip' && words[1] === 'vrf') {
		if (words[2] === 'forwarding' && words[3] && !words[4]) {
			if (disable)
				iface.ip_vrf_forwarding = null;
			else
				iface.ip_vrf_forwarding = words[3];
			done();
			return;
		}
	}

	if (words[0] === 'description') {
		if (disable) {
			done(VE('unexpected "no": %j', words));
			return;
		}

		iface.description = words.slice(1).join(' ');
		done();
		return;
	}

	if (words[0] === 'mtu' && words[1] && !words[2]) {
		if (disable) {
			iface.mtu = null;
		} else {
			iface.mtu = parseInt(words[1], 10);
		}
		done();
		return;
	}

	if (words[0] === 'vrrp-group' && words[1] && !words[2]) {
		if (disable) {
			delete iface.vrrp_group[words[1]];
			done();
			return;
		}

		iface.vrrp_group[words[1]] = {
			priority: null,
			virtual_addresses: []
		};

		self.ftps_section_stack.unshift({
			ss_type: 'vrrp-group',
			ss_data: {
				vrrp_group: iface.vrrp_group[words[1]]
			},
			ss_line: words,
			ss_level: section.ss_sublevel,
			ss_sublevel: null,
			ss_sublines: []
		});
		done();
		return;
	}

	done(VE('unhandled INTERFACE (%s %s) block directive: %s%j',
	    section.ss_data.iface_type,
	    section.ss_data.iface_name,
	    disable ? 'no ' : '', words));
};

Force10ParserStream.prototype._process_interface_portchan = function
_process_interface_portchan(words, disable, done)
{
	var self = this;
	var section = self.ftps_section_stack[0];
	var iface = section.ss_data.iface;

	if (words[0] === 'vlt-peer-lag' && words[1] === 'port-channel' &&
	    !words[3]) {
		var pcnum = parseInt(words[2], 10);

		if (pcnum >= 1 && pcnum <= 128) {
			iface.vlt_peer_lag = pcnum;
			done();
			return;
		}
	}

	if (words[0] === 'channel-member' && words[1] && words[2] &&
	    !words[3]) {
		/*
		 * e.g., "channel-member hundredGigE 1/31,1/32"
		 */
		var rng;
		if ((rng = explode_port_range(words[2])) === null) {
			done(VE('invalid port range "%s": %j', words[2],
			    words));
			return;
		}

		rng.forEach(function (port) {
			array_set(iface.channel_members, words[1] + ' ' + port,
			    !disable);
		});

		done();
		return;
	}

	/*
	 * Apart from the special Port-channel directives, everything else
	 * is basically the same as for a regular Ethernet interface.
	 */
	self._process_interface_ethernet(words, disable, done);
};

Force10ParserStream.prototype._process_interface_ethernet = function
_process_interface_ethernet(words, disable, done)
{
	var self = this;
	var section = self.ftps_section_stack[0];
	var iface = section.ss_data.iface;

	var unexpected_disable = function () {
		if (disable) {
			done(VE('unexpected "no" prefix: %j', words));
			return (true);
		}

		return (false);
	};

	switch (words[0]) {
	case 'ip':
	case 'shutdown':
	case 'description':
	case 'mtu':
	case 'vrrp-group':
		self._process_interface_common(words, disable, done);
		return;

	case 'sflow':
		if (words[1] === 'enable' && !words[2]) {
			iface.sflow = !disable;
			done();
			return;
		}
		break;

	case 'dampening':
		if (!words[2]) {
			iface.dampening = !disable;
			done();
			return;
		}
		break;

	case 'flowcontrol':
		if (unexpected_disable())
			return;

		/*
		 * Looking for lines of the form:
		 *	flowcontrol rx on tx off
		 */
		if (words[1] !== 'rx' || words[3] !== 'tx' ||
		    (words[2] !== 'on' && words[2] !== 'off') ||
		    (words[4] !== 'on' && words[4] !== 'off')) {
			done(VE('invalid flowcontrol: %j', words));
			return;
		}

		iface.flow_rx = (words[2] === 'on');
		iface.flow_tx = (words[4] === 'on');

		done();
		return;

	case 'switchport':
		if (disable) {
			iface.ip_address = null;
			done();
			return;
		}

		if (words[1]) {
			done(VE('unexpected "switchport" args: %j', words));
			return;
		}

		iface.switchport = !disable;
		done();
		return;

	case 'storm-control':
		if (unexpected_disable())
			return;

		if (words[1] !== 'broadcast' || words[3] !== 'in') {
			done(VE('unexpected "storm-control": %j', words));
			return;
		}

		var bctl = iface.storm_control[words[1]];
		if (!bctl) {
			bctl = iface.storm_control[words[1]] = {};
		}

		/*
		 * XXX
		 */
		bctl[words[3]] = parseInt(words[2], 10);
		done();
		return;

	case 'port-channel-protocol':
		if (words[1] !== 'LACP' || words[2]) {
			done(VE('unexpected "port-channel-protocol": %j',
			    words));
			return;
		}

		self.ftps_section_stack.unshift({
			ss_type: 'port-channel-protocol',
			ss_data: section.ss_data,
			ss_line: words,
			ss_level: section.ss_sublevel,
			ss_sublevel: null,
			ss_sublines: []
		});
		done();
		return;

	case 'spanning-tree':
		if (!words[1]) {
			iface.stp = !disable;
			done();
			return;
		}

		if (words[1] === '0') {
			if (unexpected_disable())
				return;

			/*
			 * Classical STP configuration.  The switch generally
			 * only supports the STP group with ID 0.
			 */
			if (words[2] === 'portfast' &&
			    words[3] === 'bpduguard' && !words[4]) {
				iface.stp_portfast_bpduguard = true;
				done();
				return;
			}

			done(VE('unexpected "spanning-tree 0": %j',
			    words));
			return;
		}

		if (words[1] !== 'rstp' || words[2] !== 'edge-port' ||
		    words[3]) {
			done(VE('unexpected "spanning-tree": %j',
			    words));
			return;
		}

		iface.rstp_edge_port = !disable;
		done();
		return;

	case 'rate-interval':
		if (unexpected_disable())
			return;

		if (words[1] && !words[2]) {
			/*
			 * XXX
			 */
			iface.rate_interval = words[1];
			done();
			return;
		}
		break;
	}

	done(VE('unhandled INTERFACE (%s %s) block directive: %s%j',
	    section.ss_data.iface_type,
	    section.ss_data.iface_name,
	    disable ? 'no ' : '', words));
};

Force10ParserStream.prototype._process_interface_mgmt = function
_process_interface_mgmt(words, disable, done)
{
	var self = this;

	switch (words[0]) {
	case 'ip':
	case 'shutdown':
	case 'description':
		self._process_interface_common(words, disable, done);
		return;

	default:
		done(VE('unhandled MGMT INTERFACE block directive: %s%j',
		    disable ? 'no ' : '', words));
		return;
	}
};


Force10ParserStream.prototype._process_interface_vlan = function
_process_interface_vlan(words, disable, done)
{
	var self = this;
	var section = self.ftps_section_stack[0];
	var vlan = section.ss_data.iface;
	var tag_type, rng;

	switch (words[0]) {
	case 'ip':
	case 'shutdown':
	case 'description':
	case 'mtu':
	case 'vrrp-group':
		self._process_interface_common(words, disable, done);
		return;

	case 'name':
		if (disable) {
			vlan.name = null;
		} else {
			vlan.name = words.slice(1).join(' ');
		}
		done();
		return;

	case 'untagged':
		if (disable) {
			done(VE('unexpected "no": %j', words));
			return;
		}

		tag_type = words[1];
		rng = explode_port_range(words[2]);

		if (rng === null) {
			done(VE('invalid port range: %s', words[2]));
			return;
		}

		rng.forEach(function (port) {
			var fn = tag_type + ' ' + port;

			array_set(vlan.untagged_ports, fn, true);
		});

		done();
		return;

	case 'tagged':
		if (disable) {
			done(VE('unexpected "no": %j', words));
			return;
		}

		tag_type = words[1];
		rng = explode_port_range(words[2]);

		if (rng === null) {
			done(VE('invalid port range: %s', words[2]));
			return;
		}

		rng.forEach(function (port) {
			var fn = tag_type + ' ' + port;

			array_set(vlan.tagged_ports, fn, true);
		});

		done();
		return;

	default:
		done(VE('unhandled VLAN block directive: %s%j',
		    disable ? 'no ' : '', words));
	}
};

Force10ParserStream.prototype._process_vlt_domain = function
_process_vlt_domain(words, disable, done)
{
	var self = this;
	var section = self.ftps_section_stack[0];
	var domain_id = section.ss_data.domain_id;

	if (disable) {
		done(VE('unexpected disable: %j', words));
		return;
	}

	var vlt = self.ftps_model.vlt[domain_id];

	vlt.push(words);
	done();
};

Force10ParserStream.prototype._process_protocol = function
_process_protocol(words, disable, done)
{
	var self = this;
	var section = self.ftps_section_stack[0];
	var proto = section.ss_data.protocol;

	if (words[0] === 'disable' && !words[1]) {
		if (!self.ftps_model.protocols[proto]) {
			done(VE('unexpected protocol "%s"', proto));
			return;
		}

		self.ftps_model.protocols[proto].enabled = disable;

		done();
		return;
	}

	if (section.ss_data.protocol === 'rstp' && words[0] ===
	    'bridge-priority' && words[1] && !words[2]) {
		self.ftps_model.protocols.rstp.bridge_priority = words[1];
		done();
		return;
	}

	if (section.ss_data.protocol !== 'lldp') {
		done(VE('unhandled PROTOCOL (%s) block: %s%j',
		    section.ss_data.protocol,
		    disable ? 'no ' : '', words));
		return;
	}

	if (words[0] === 'advertise') {
		var lldp = self.ftps_model.protocols.lldp;

		if (lldp.hasOwnProperty(words[1])) {
			var check = words.slice(2);
			var tlv = lldp[words[1]];

			for (var i = 0; i < check.length; i++) {
				if (tlv.hasOwnProperty(check[i])) {
					tlv[check[i]] = !disable;
					continue;
				}

				done(VE('unknown LLDP %s %s',
				    words[1], check[i]));
				return;
			}

			done();
			return;
		}

		done(VE('unknown LLDP %s', words[1]));
		return;
	}

	done(VE('unhandled PROTOCOL block directive: %s%j',
	    disable ? 'no ' : '', words));
	done();
};

Force10ParserStream.prototype._process_ftp_server = function
_process_ftp_server(words, disable, done)
{
	var self = this;

	if (words[1] === 'enable' && !words[2]) {
		self.ftps_model.servers.ftp.enabled = !disable;
		done();
		return;
	}

	if (words[1] === 'username' && words[3] === 'password' &&
	    !words[8]) {
		if (disable) {
			done(VE('unexpected "no": %j', words));
			return;
		}

		self.ftps_model.servers.ftp.users[words[2]] = {
			password: { type: words[4], value: words[5] }
		};

		done();
		return;
	}

	done(VE('unhandled FTP directive: %s%j', disable ? 'no ' : '',
	    words));
};

Force10ParserStream.prototype._process_snmp_server = function
_process_snmp_server(words, disable, done)
{
	var self = this;

	if (words[1] === 'community') {
		if (disable) {
			done(VE('unexpected "no": %j', words));
			return;
		}

		if (words[3] !== 'ro' && words[3] !== 'rw') {
			done(VE('unexpected SNMP community: %j', words));
			return;
		}

		self.ftps_model.servers.snmp.communities[words[2]] = words[3];
		done();
		return;
	}

	if (words[1] === 'contact' || words[1] === 'location') {
		if (disable) {
			done(VE('unexpected "no": %j', words));
			return;
		}

		self.ftps_model.servers.snmp[words[1]] =
		    words.slice(2).join(' ');
		done();
		return;
	}

	if (words[1] === 'enable' && words[2] === 'traps') {
		if (disable) {
			done(VE('unexpected "no": %j', words));
			return;
		}

		/*
		 * XXX
		 */
		self.ftps_model.servers.snmp.enable_traps.push(words.slice(3));
		done();
		return;
	}

	if (words[1] === 'host') {
		/*
		 * XXX
		 */
		done();
		return;
	}

	done(VE('unhandled "snmp" directive: %s%j', disable ? 'no ' : '',
	    words));
};

/*
 * Process "ip" directives in the top-level CONFIGURATION mode.
 */
Force10ParserStream.prototype._process_ip = function
_process_ip(words, disable, done)
{
	var self = this;

	var unexpected_disable = function () {
		if (disable) {
			done(VE('unexpected "no" prefix: %j', words));
			return (true);
		}

		return (false);
	};

	switch (words[1]) {
	case 'domain-name':
		if (unexpected_disable())
			return;

		self.ftps_model.ip.domain_name = words[2];
		done();
		return;

	case 'domain-lookup':
		self.ftps_model.ip.domain_lookup = !disable;
		done();
		return;

	case 'name-server':
		array_set(self.ftps_model.ip.name_servers, words[2], !disable);

		done();
		return;

	case 'route':
		if (unexpected_disable())
			return;

		var dest = words[2].split('/');
		if (dest.length !== 2 || !mod_net.isIPv4(dest[0])) {
			done(VE('invalid IP route dest: %s', words[2]));
			return;
		}

		var permanent = words[4] || null;
		var gw = words[3];
		var vlan = null;
		if (words[3] === 'Vlan') {
			vlan = parseInt(words[4], 10);

			if (isNaN(vlan) || vlan < 1 || vlan > 4095) {
				done(VE('invalid IP route VLAN: %s', words[4]));
				return;
			}
			gw = words[5];
			permanent = words[6] || null;
		}

		if (!mod_net.isIPv4(gw)) {
			done(VE('invalid IP route gw: %s', gw));
			return;
		}

		if (permanent !== null && permanent !== 'permanent') {
			done(VE('invalid IP route extras: %s', permanent));
			return;
		}

		self.ftps_model.ip.routes.push({
			destination: words[2],
			gateway: gw,
			vlan: vlan,
			permanent: permanent === 'permanent'
		});

		done();
		return;

	case 'vrf':
		if (unexpected_disable())
			return;

		/*
		 * Process VRF directives; e.g., "ip vrf <name> <id>".  The
		 * name is either a customer VRF name or the special word
		 * "management".
		 */
		if (words.length !== 4) {
			done(VE('invalid VRF: %j', words));
			return;
		}

		self.ftps_model.ip.vrf[words[2]] = {
			id: words[3]
		};

		done();
		return;

	case 'telnet':
		if (words[2] === 'server' && words[3] === 'enable' &&
		    !words[4]) {
			self.ftps_model.servers.telnet.enabled = !disable;
			done();
			return;
		}
		break;

	case 'ssh':
		if (words[2] !== 'server')
			break;

		if (words[3] === 'enable' && !words[4]) {
			self.ftps_model.servers.ssh.enabled = !disable;
			done();
			return;
		} else if (words[3] === 'version' && !words[5]) {
			if (unexpected_disable())
				return;

			if (words[4] === '2') {
				self.ftps_model.servers.ssh.version = 2;
				done();
				return;
			}
		}
		break;

	case 'tftp':
	case 'tacacs':
		var client = self.ftps_model.clients[words[1]];

		if (words[2] === 'source-interface') {
			if (disable) {
				client.source_interface = null;
			} else {
				client.source_interface =
				    words.slice(3).join(' ');
			}
			done();
			return;
		}
		break;

	default:
		break;
	}

	done(VE('unhandled "ip" directive: %s%j', disable ? 'no ' : '', words));
};

module.exports = {
	Force10ParserStream: Force10ParserStream
};
