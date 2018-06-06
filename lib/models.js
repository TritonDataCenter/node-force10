/* vim: set ts=8 sts=8 sw=8 noet: */

var mod_jsprim = require('jsprim');

var DEFAULT_IFACE_VLAN = {
	ip_address: null,
	ip_vrf_forwarding: null,
	ip_ospf_network_ptp: null,
	ip_proxy_arp: null,
	name: null,
	description: null,
	shutdown: true,
	tagged_ports: [],
	untagged_ports: [],
	vrrp_group: {}
};

var DEFAULT_IFACE_LOOPBACK = {
	ip_address: null,
	ip_vrf_forwarding: null,
	ip_ospf_network_ptp: null,
	ip_proxy_arp: null,
	description: null,
	shutdown: true,
	mtu: null,
	ip_unreachables: null
};

var DEFAULT_IFACE_MGMT = {
	ip_address: null,
	description: null,
	shutdown: true
};

var DEFAULT_IFACE_ETHER = {
	ip_address: null,
	ip_vrf_forwarding: null,
	ip_ospf_network_ptp: null,
	ip_proxy_arp: null,
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
	rate_interval: null,
	sflow: null,
	dampening: null,
	vrrp_group: {}
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
	case 'hundredGigE':
		return (mod_jsprim.deepCopy(DEFAULT_IFACE_ETHER));

	case 'Port-channel':
		var pc = mod_jsprim.deepCopy(DEFAULT_IFACE_ETHER);

		pc.channel_members = []; /* XXX sigh */
		pc.vlt_peer_lag = null;

		return (pc);

	case 'Vlan':
		return (mod_jsprim.deepCopy(DEFAULT_IFACE_VLAN));

	case 'Loopback':
		return (mod_jsprim.deepCopy(DEFAULT_IFACE_LOOPBACK));

	default:
		return (null);
	}
}

module.exports = {
	model_default_interface: model_default_interface
};
