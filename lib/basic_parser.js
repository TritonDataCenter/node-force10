#!/usr/bin/env node
/* vim: set ts=8 sts=8 sw=8 noet: */

var mod_stream = require('stream');
var mod_util = require('util');


function
Force10BasicParserStream()
{
	var self = this;

	mod_stream.Writable.call(self, { objectMode: true,
	    highWaterMark: 0 });

	self.ftps_ended = false;
	self.ftps_tree = {
		n_indent: -1,
		n_children: [],
		n_words: null,
		n_parent: null
	};
	self.ftps_node = self.ftps_tree;

	self.on('finish', function () {
		self._on_finish();
	});
}
mod_util.inherits(Force10BasicParserStream, mod_stream.Writable);

Force10BasicParserStream.prototype._on_finish = function
_on_finish()
{
	var self = this;

	var convert_children = function (nc, top) {
		var r = [];

		for (var i = 0; i < nc.length; i++) {
			var cn = nc[i];

			r.push({
				w: cn.n_words,
				c: convert_children(cn.n_children)
			});
		}

		return (r);
	};

	var out = convert_children(self.ftps_tree.n_children);

	/*
	 * Walk the tree and remove all of the cyclic "n_parent" references.
	 */
	self.emit('model', out);
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

function
word_split(raw)
{
	return (raw.trim().split(/[ \t]+/));
}

Force10BasicParserStream.prototype._write = function
_write(raw, _, done)
{
	var self = this;

	/*
	 * Strip out comments first.
	 */
	var line = remove_comments(raw);

	/*
	 * Ignore blank lines and the configuration file banner.
	 */
	if (line === '' || line === 'Current Configuration ...') {
		setImmediate(done);
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

	/*
	 * If this line is indented the same (or less) than the section we were
	 * in previously, we have left that section.  This might be true of
	 * several nested sections at once; e.g., if we leave a
	 * "port-channel-protocol" section within an "interface" section to get
	 * to the next "interface".
	 */
	while (ind <= self.ftps_node.n_indent) {
		self.ftps_node = self.ftps_node.n_parent;
	}

	var nn = {
		n_indent: ind,
		n_children: [],
		n_words: word_split(line),
		n_parent: self.ftps_node
	};

	self.ftps_node.n_children.push(nn);
	self.ftps_node = nn;

	setImmediate(done);
};


module.exports = {
	Force10BasicParserStream: Force10BasicParserStream
};
