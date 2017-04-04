#!/usr/bin/env node
/* vim: set ts=8 sts=8 sw=8 noet: */

var mod_stream = require('stream');
var mod_util = require('util');
var mod_events = require('events');
var mod_net = require('net');

var mod_ssh2 = require('ssh2');
var mod_verror = require('verror');
var mod_lstream = require('lstream');
var mod_assert = require('assert-plus');
var mod_jsprim = require('jsprim');

var VE = mod_verror.VError;


function
emit_stderr(self, str)
{
	var ls = new mod_lstream();

	str.pipe(ls);

	ls.on('readable', function () {
		var l;

		while ((l = ls.read()) !== null) {
			self.emit('stderr', l);
		}
	});

	ls.on('end', function () {
		self.emit('stderr_end');
	});
}

/*
 * Connects to a Force10 switch via SSH.  Once connected, the "exec()" method
 * can be called to run a command on the switch.
 */
function
Force10Manager(options)
{
	var self = this;

	mod_assert.object(options, 'options');
	mod_assert.ok(mod_net.isIPv4(options.ip), 'ip must be an IP address');
	mod_assert.number(options.port, 'options.port');
	mod_assert.string(options.username, 'options.username');
	mod_assert.string(options.password, 'options.password');

	mod_events.EventEmitter.call(self);

	self.ftmg_ip = options.ip;
	self.ftmg_port = options.port;
	self.ftmg_username = options.username;
	self.ftmg_password = options.password;

	self.ftmg_error = null;
	self.ftmg_workq = [];
	self.ftmg_inflight = null;
	self.ftmg_maybe_s60 = false;

	setImmediate(function () {
		self._connect_ssh();
	});
}
mod_util.inherits(Force10Manager, mod_events.EventEmitter);

Force10Manager.prototype._connect_ssh = function
_connect_ssh()
{
	var self = this;

	var tripped = false;
	var need_retry = false;

	self.ftmg_chan = null;
	self.ftmg_client = new mod_ssh2.Client();
	self.ftmg_client.once('error', function (err) {
		if (tripped)
			return;

		if (self.ftmg_error !== null)
			return;

		self.ftmg_error = VE(err, 'SSH client (%s:%d) error',
		    self.ftmg.ip, self.ftmg.port);

		self.emit('error', self.ftmg_error);
	});
	self.ftmg_client.once('ready', function () {
		if (tripped)
			return;

		if (self.ftmg_error !== null)
			return;

		var window = false;
		var shopts = {};

		if (self.ftmg_maybe_s60) {
			/*
			 * Newer Force10 switches seem to be OK without a pty,
			 * but older switches appear to get confused.  We
			 * request a pty on a large, fake window to try to work
			 * around this broken behaviour.
			 */
			window = {
				rows: 25,
				cols: 80,
				height: 480,
				width: 640,
				term: 'vt100'
			};
		}

		self.ftmg_client.shell(window, shopts, function (err, chan) {
			if (self.ftmg_error !== null)
				return;

			if (err) {
				self.ftmg_error = VE(err, 'SSH client ' +
				    '(%s:%d) shell error', self.ftmg_ip,
				    self.ftmg_port);
				self.emit('error', self.ftmg_error);
				return;
			}

			self.ftmg_chan = chan;

			emit_stderr(self, chan.stderr);

			self.ftmg_dec = new Force10CommandDecoder(self.ftmg_ip,
			    chan);
			chan.pipe(new mod_lstream()).pipe(self.ftmg_dec);

			self.ftmg_dec.once('ready', function () {
				if (tripped)
					return;

				/*
				 * XXX interlock against emitting "ready"
				 * twice...
				 */
				self.emit('ready');

				setImmediate(function () {
					self._dispatch();
				});
			});

			self.ftmg_dec.on('output', function (out) {
				if (tripped)
					return;

				setImmediate(function () {
					self._on_output(out);
				});
			});

			self.ftmg_dec.once('maybe_s60', function () {
				if (tripped)
					return;

				if (!self.ftmg_maybe_s60) {
					/*
					 * We haven't tried assuming this is
					 * an S60 yet.  Schedule a retry...
					 */
					need_retry = true;
					self.ftmg_maybe_s60 = true;
				}
			});

			self.ftmg_dec.once('finish', function () {
				if (tripped)
					return;

				/*
				 * Make sure the SSH connection (and not just
				 * this channel) is closed:
				 */
				self.ftmg_client.end();

				if (need_retry) {
					tripped = true;
					setImmediate(function () {
						self._connect_ssh();
					});
					return;
				}

				if (!self.ftmg_inflight ||
				    !self.ftmg_inflight.infl_exit) {
					self.ftmg_error = VE(
					    'connection terminated ' +
					    'unexpectedly');
					self.emit('error', self.ftmg_error);
					return;
				}

				self.ftmg_inflight.infl_callback(null);

			});

			/*
			 * Send an empty command string to induce the switch
			 * to send us our first command prompt.
			 * XXX
			 */
			chan.write('terminal length 0\n');
		});
	});

	self.ftmg_client.connect({
		host: self.ftmg_ip,
		port: self.ftmg_port,
		username: self.ftmg_username,
		password: self.ftmg_password,

		algorithms: {
			cipher: [ 'aes128-cbc', '3des-cbc' ]
		}
	});
};

Force10Manager.prototype.hostname = function
hostname()
{
	var self = this;

	return (self.ftmg_dec.ftcd_hostname);
};

Force10Manager.prototype.close = function
close(done)
{
	var self = this;

	mod_assert.func(done, 'done');

	self.ftmg_workq.push({
		infl_callback: done,
		infl_exit: true
	});

	setImmediate(function () {
		self._dispatch();
	});
};

Force10Manager.prototype.exec = function
exec(cmd, done)
{
	var self = this;

	mod_assert.string(cmd, 'cmd');
	mod_assert.func(done, 'done');

	self.ftmg_workq.push({
		infl_callback: done,
		infl_command: cmd
	});

	self._dispatch();
};

Force10Manager.prototype._on_output = function
_on_output(output)
{
	var self = this;
	
	mod_assert.arrayOfString(output, 'output');
	mod_assert.object(self.ftmg_inflight, 'ftmg_inflight');

	var infl = self.ftmg_inflight;
	self.ftmg_inflight = null;

	/*
	 * The command we sent will have echoed back to us.  Strip it out,
	 * if present.
	 */
	output = output.join('\n');
	var pfx = output.substr(0, infl.infl_rendered.length);
	if (pfx === infl.infl_rendered) {
		output = output.substr(pfx.length);
	}

	infl.infl_callback(null, output.split('\n'));

	self._dispatch();
};

Force10Manager.prototype._dispatch = function
_dispatch()
{
	var self = this;

	if (self.ftmg_inflight !== null) {
		/*
		 * A command is in flight already.  Try later.
		 */
		return;
	}

	if (self.ftmg_workq.length < 1) {
		/*
		 * No work to schedule.
		 */
		return;
	}

	var infl = self.ftmg_inflight = self.ftmg_workq.shift();

	if (infl.infl_exit) {
		/*
		 * Sending the ^Z character (0x1A) puts the terminal
		 * back in the regular mode, from which we can use "exit"
		 * to gracefully disconnect.
		 */
		self.ftmg_dec.expect_exit();
		//self.ftmg_chan.write('\u001aexit\n');
		self.ftmg_chan.write('exit\n');
		self.ftmg_chan.end();
		return;
	} else {
		self.ftmg_dec.collect_output();
		//infl.infl_rendered = wrap_xml(infl.infl_command) + '\n';
		infl.infl_rendered = self.ftmg_dec.ftcd_hostname + '#' +
		    infl.infl_command + '\n';
		self.ftmg_chan.write(infl.infl_command + '\n');
		self.ftmg_chan.write('terminal length 0\n');
	}
};

function
Force10CommandDecoder(id, outbound)
{
	var self = this;

	mod_stream.Writable.call(self, { objectMode: true, highWaterMark: 0 });

	mod_assert.string(id, 'id');
	mod_assert.object(outbound, 'outbound');
	self.ftcd_id = id;
	self.ftcd_outbound = outbound;

	self.ftcd_state = 'WAIT_FOR_HOSTNAME';
	self.ftcd_hostname = null;
	self.ftcd_enabled = null;

	self.ftcd_pre = [];
	self.ftcd_accum = [];

	self.ftcd_xml_prompt = null;
	self.ftcd_started = false;
}
mod_util.inherits(Force10CommandDecoder, mod_stream.Writable);

Force10CommandDecoder.prototype.expect_exit = function
expect_exit()
{
	var self = this;

	mod_assert.strictEqual(self.ftcd_state, 'PARKED');
	self.ftcd_state = 'WAIT_FOR_EXIT';
};

Force10CommandDecoder.prototype.collect_output = function
collect_output()
{
	var self = this;

	mod_assert.strictEqual(self.ftcd_state, 'PARKED');
	self.ftcd_state = 'WAIT_FOR_PROMPT';
};

Force10CommandDecoder.prototype._send = function
_send(text)
{
	var self = this;

	self.ftcd_outbound.write(text);
};

Force10CommandDecoder.prototype._write = function
_write(l, _, done)
{
	var self = this;

	mod_assert.string(l, 'l');
	mod_assert.func(done, 'done');

	if (self.ftcd_state !== 'WAIT_FOR_PROMPT') {
		/*
		 * No sequence detection in effect.
		 */
		self._process(l, function (err) {
			if (err) {
				done(VE(err, 'Force10 decoder ' +
				    '(id: %s, state: %s)', 
				    self.ftcd_id,
				    self.ftcd_state));
				return;
			}

			done();
		});
		return;
	}

	var idx = self.ftcd_pre.length;
	if (idx >= self.ftcd_xml_prompt.length) {
		throw (VE('pre overflow'));
	}

	if (l === self.ftcd_xml_prompt[idx]) {
		/*
		 * This is the next part of the sequence.
		 */
		if (idx === self.ftcd_xml_prompt.length - 1) {
			/*
			 * This is the last element in the sequence.
			 * XXX commit "accum".
			 */
			self.ftcd_pre = [];
			self._process(true, function (err) {
				if (err) {
					done(VE(err, 'Force10 decoder ' +
					    '(id: %s, state: %s)', 
					    self.ftcd_id,
					    self.ftcd_state));
					return;
				}

				done();
			});
			return;
		} else {
			/*
			 * This is the correct value for the current
			 * offset into the potential complete sequence.
			 * XXX append to "pre".
			 */
			self.ftcd_pre.push(l);
			done();
			return;
		}
	} else {
		/*
		 * This does not match the sequence.
		 * XXX continue shifting elements from "pre" into "accum",
		 * one at a time, until all remaining elements in "pre"
		 * match those in "xml_prompt", or "pre" is empty.
		 * Note that we cannot terminate the sequence now as we
		 * don't have any new input to consider until the next
		 * turn.
		 */
		self.ftcd_pre.push(l);
		for (;;) {
			/*
			 * Move one element from "pre" to "accum".
			 */
			self.ftcd_accum.push(self.ftcd_pre.shift());

			/*
			 * Do we have any left?
			 */
			if (self.ftcd_pre.length < 1) {
				done();
				return;
			}

			var match = true;
			for (var i = 0; i < self.ftcd_pre.length; i++) {
				if (self.ftcd_pre[i] !==
				    self.ftcd_xml_prompt[i]) {
					match = false;
					break;
				}
			}

			if (match) {
				done();
				return;
			}
		}
	}
};

Force10CommandDecoder.prototype._process = function
_process(input, done)
{
	var self = this;

	switch (self.ftcd_state) {
	case 'ERROR':
		/*
		 * XXX
		 */
		return (false);

	case 'WAIT_FOR_HOSTNAME':
		var m;

		m = input.match(/^([a-zA-Z0-9-]+)(#|\$)terminal length 0$/);
		if (m) {
			var hn = self.ftcd_hostname = m[1];
			self.ftcd_enabled = (m[2] === '#');

			self._send('terminal length 0\n');
			if (false) {
				self._send('terminal xml\n');
			}

			self.ftcd_state = 'WAIT_FOR_PROMPT';

			/*
			 * This is the sequence of strings we look for to
			 * determine when we hit the XML mode command prompt
			 * again:
			 */
			if (false) {
			self.ftcd_xml_prompt = [
				'',
				hn + '(xml)#',
				'Enter XML request with CTRL-Y or empty line',
				'Clear XML request with CTRL-C',
				'Exit XML mode with CTRL-Z:',
				'',
			];
			} else {
				self.ftcd_xml_prompt = [
					hn + '#terminal length 0',
				];
			}

			done();
			return;
		}

		m = input.match(/^([a-zA-Z0-9-]+)(#|\$)$/);
		if (m) {
			/*
			 * This might be an earlier (e.g. S60) Force10 switch,
			 * with firmware that requires us to ask for a pty.
			 */
			self.emit('maybe_s60');
			done();
			return;
		}

		done(VE('unexpected output: "%s"', input));
		return;

	case 'WAIT_FOR_PROMPT':
		if (input !== true) {
			done(VE('EXPECTED true, got %s', input));
			return;
		}

		self.ftcd_state = 'PARKED';

		var acc = self.ftcd_accum;
		self.ftcd_accum = [];
		self.ftcd_pre = [];

		if (!self.ftcd_started) {
			/*
			 * The first output we collect should match the
			 * initialisation routine from WAIT_FOR_HOSTNAME.
			 */
			var chk = [];

			if (!mod_jsprim.deepEqual(chk, acc)) {
				done(VE('UNEXPECTED OUTPUT: %j; WANTED: %j',
				    acc, chk));
				return;
			}

			self.ftcd_started = true;
			self.emit('ready');
			done();
			return;
		}

		self.emit('output', acc);
		done();
		return;

	case 'WAIT_FOR_EXIT':
		if (input !== '' && input !== self.ftcd_hostname + '#exit') {
			self.ftcd_state = 'ERROR';
			done(VE('WAIT_FOR_EXIT: spurious output: "%s"',
			    input));
			return;
		}
		done();
		return;

	case 'PARKED':
		self.ftcd_state = 'ERROR';
		done(VE('PARKED got spurious output: "%s"', input));
		return;

	default:
		throw (VE('invalid state: %s', self.ftcd_state));
	}
};

module.exports = {
	Force10Manager: Force10Manager
};
