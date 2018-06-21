#!/usr/bin/env node
/* vim: set ts=8 sts=8 sw=8 noet: */


function
f10_cfg_lex(lines)
{
	var ftl = {};

	ftl.ftl_tree = {
		n_indent: -1,
		n_children: [],
		n_words: null,
		n_parent: null
	};
	ftl.ftl_node = ftl.ftl_tree;

	for (var i = 0; i < lines.length; i++) {
		f10_cfg_lex_line(ftl, lines[i]);
	}

	return (f10_cfg_lex_convert_children(ftl.ftl_tree.n_children));
}

function
f10_cfg_lex_convert_children(nc)
{
	var r = [];

	for (var i = 0; i < nc.length; i++) {
		var cn = nc[i];

		r.push({
			w: cn.n_words,
			c: f10_cfg_lex_convert_children(cn.n_children)
		});
	}

	return (r);
}

function
f10_cfg_lex_remove_comments(raw)
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
f10_cfg_lex_word_split(raw)
{
	return (raw.trim().split(/[ \t]+/));
}

function
f10_cfg_lex_line(ftl, raw)
{
	/*
	 * Strip out comments first.
	 */
	var line = f10_cfg_lex_remove_comments(raw);

	/*
	 * Ignore blank lines and the configuration file banner.
	 */
	if (line === '' || line === 'Current Configuration ...') {
		return (null);
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
	while (ind <= ftl.ftl_node.n_indent) {
		ftl.ftl_node = ftl.ftl_node.n_parent;
	}

	var nn = {
		n_indent: ind,
		n_children: [],
		n_words: f10_cfg_lex_word_split(line),
		n_parent: ftl.ftl_node
	};

	ftl.ftl_node.n_children.push(nn);
	ftl.ftl_node = nn;

	return (null);
}


module.exports = {
	f10_cfg_lex: f10_cfg_lex,
};
