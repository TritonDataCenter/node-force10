/* vim: set ts=8 sts=8 sw=8 noet: */

var mod_jsprim = require('jsprim');

var DEFAULT_IFACE_VLAN = {
	ip_address: null,
	description: null,
	shutdown: true,
	tagged_ports: [],
	untagged_ports: []
};

var DEFAULT_IFACE_MGMT = {
	ip_address: null,
	description: null,
	shutdown: true
};

var DEFAULT_IFACE_ETHER = {
	ip_address: null,
	description: null,
	shutdown: true,
	mtu: null,
	switchport: false,
	flow_rx: false,
	flow_tx: false,
	storm_control: {},
	aggr: null,
	rstp_edge_port: false,
	stp: false,
	stp_portfast_bpduguard: false,
	rate_interval: null
};

function
model_default_interface(type)
{
	switch (type) {
	case 'ManagementEthernet':
		return (mod_jsprim.deepCopy(DEFAULT_IFACE_MGMT));

	case 'TenGigabitEthernet':
	case 'GigabitEthernet':
	case 'fortyGigE':
		return (mod_jsprim.deepCopy(DEFAULT_IFACE_ETHER));

	case 'Port-channel':
		return (mod_jsprim.deepCopy(DEFAULT_IFACE_ETHER));

	case 'Vlan':
		return (mod_jsprim.deepCopy(DEFAULT_IFACE_VLAN));

	default:
		return (null);
	}
}

module.exports = {
	model_default_interface: model_default_interface
};
