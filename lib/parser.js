#!/usr/bin/env node
/* vim: set ts=8 sts=8 sw=8 noet: */

var mod_stream = require('stream');
var mod_verror = require('verror');
var mod_util = require('util');
var mod_jsprim = require('jsprim');
var mod_net = require('net');
var mod_assert = require('assert-plus');

var lib_models = require('./models');

var VE = mod_verror.VError;

var EXPECTED_REDUNDANCY = [
	[ 'redundancy', 'auto-synchronize', 'full' ]
];

var EXPECTED_HARDWARE = [
	[ 'hardware', 'watchdog' ]
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
explode_port_range(rng)
{
	if (!rng.match(/^[0-9\/\-,]+$/)) {
		return (null);
	}

	var t = rng.split('/');

	if (t.length === 1) {
		/*
		 * This form is generally only used for "Port-channel" and
		 * "Vlan" interfaces.  Make sure the value is a bare integer.
		 */
		if (!t[0].match(/^[0-9]+$/)) {
			return (null);
		}

		return ([ t[0] ]);
	}

	if (t.length !== 2) {
		return (null);
	}

	if (!t[0].match(/^[0-9]+$/)) {
		/*
		 * In a STACK-UNIT/PORTS range, the STACK-UNIT portion should
		 * be a bare integer.
		 */
		return (null);
	}

	var ranges = t[1].split(',');
	var ports = [];
	for (var i = 0; i < ranges.length; i++) {
		var range = ranges[i];

		var u = range.split('-');

		for (var j = 0; j < u.length; j++) {
			if (!u[j].match(/^[0-9]+$/)) {
				return (null);
			}
		}

		switch (u.length) {
		case 1:
			ports.push(t[0] + '/' + u[0]);
			break;

		case 2:
			var lo = parseInt(u[0], 10);
			var hi = parseInt(u[1], 10);

			for (j = lo; j <= hi; j++) {
				ports.push(t[0] + '/' + j);
			}
			break;

		default:
			return (null);
		}
	}

	return (ports);
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
		hostname: null,
		ip: {
			name_servers: [],
			domain_name: null,
			domain_lookup: false,
			routes: []
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
				location: null
			},
			ftp: {
				enabled: false,
				users: {}
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
		protocols: {
			rstp: {
				enabled: false
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
		reload_type: null
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
	var line = raw.replace(/\!.*/, '');

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

		case 'protocol':
			self._process_protocol(words, disable, done);
			return;

		case 'port-channel-protocol':
			self._process_port_channel(words, disable, done);
			return;

		case 'line':
			self._process_line(words, disable, done);
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
		self._process_ip(words, disable, done);
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
		 */
		if (words[1] !== '0' || words[2] !== 'provision' ||
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

		/*
		 * Looking for lines of the form:
		 *	username admin password 5 blahblahblah privilege 15
		 */
		if (words[2] !== 'password' || words[5] !== 'privilege' ||
		    words[7]) {
			done(VE('unexpected USERNAME: %j', words));
			return;
		}

		self.ftps_model.users[words[1]] = {
			password: { type: words[3], value: words[4] },
			privilege: words[6]
		};
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

	case 'reload-type':
		if (unexpected_disable())
			return;

		switch (words[1]) {
		case 'normal-reload':
			self.ftps_model.reload_type = words[1];
			done();
			return;
		}

		done(VE('unexpected RELOAD-TYPE line: %j', words));
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
		if ((berr = check_basic('hardware', self.ftps_model.hardware,
		    EXPECTED_HARDWARE)) !== null ||
		    (berr = check_basic('redundancy',
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

	done(VE('unhandled LINE block directive: %s%j',
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
	case 'Port-channel':
		self._process_interface_ethernet(words, disable, done);
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

	if (words[0] === 'description') {
		if (disable) {
			done(VE('unexpected "no": %j', words));
			return;
		}

		iface.description = words.slice(1).join(' ');
		done();
		return;
	}

	done(VE('unhandled INTERFACE block directive: %s%j',
	    disable ? 'no ' : '', words));
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
		self._process_interface_common(words, disable, done);
		return;

	case 'mtu':
		if (disable) {
			iface.mtu = null;
		} else {
			iface.mtu = parseInt(words[1], 10);
		}
		done();
		return;

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

	default:
		done(VE('unhandled INTERFACE block directive: %s%j iface %j',
		    disable ? 'no ' : '', words, iface));
	}
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
		self._process_interface_common(words, disable, done);
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

			if (vlan.untagged_ports.indexOf(fn) === -1)
				vlan.untagged_ports.push(fn);
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

			if (vlan.tagged_ports.indexOf(fn) === -1)
				vlan.tagged_ports.push(fn);
		});

		done();
		return;

	default:
		done(VE('unhandled VLAN block directive: %s%j',
		    disable ? 'no ' : '', words));
	}
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

	done(VE('unhandled "snmp" directive: %s%j', disable ? 'no ' : '',
	    words));
};

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
		if (unexpected_disable())
			return;

		if (self.ftps_model.ip.name_servers.indexOf(words[2]) === -1) {
			self.ftps_model.ip.name_servers.push(words[2]);
		}
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

	default:
		break;
	}

	done(VE('unhandled "ip" directive: %s%j', disable ? 'no ' : '', words));
};

module.exports = {
	Force10ParserStream: Force10ParserStream
};
