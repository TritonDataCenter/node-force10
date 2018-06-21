#!/usr/bin/env node
/* vim: set ts=8 sts=8 sw=8 noet: */

var mod_assert = require('assert-plus');

function
isdigit(c)
{
	if (c === undefined)
		return (false);

	mod_assert.string(c, 'c');
	mod_assert.strictEqual(c.length, 1, 'c must be one character');

	return (c >= '0' && c <= '9');
}

function
array_set(arr, str, present)
{
	mod_assert.arrayOfString(arr, 'arr');
	mod_assert.string(str, 'str');

	var idx = arr.indexOf(str);

	if (present) {
		if (idx === -1) {
			arr.push(str);
		}
	} else {
		if (idx !== -1) {
			arr.splice(idx, 1);
		}
	}
}

/*
 * Port ranges are awful.  Some valid port ranges include:
 *
 *	0/1
 *	0/1-10
 *	0/1-10,20-30	<--- 20-30 are also for stack unit 0?
 *	1/31,1/32
 *	1/11-1/16,1/18-1/19,1/21-1/24
 */
function
explode_port_range(rng)
{
	var pos = 0;
	var state = 'REST';
	var stack_unit = null;
	var accum = '';
	var out = [];
	var lower = null;

	var commit_port = function (name) {
		var upto = parseInt(name, 10);
		var from = lower === null ? upto : lower;

		for (var i = from; i <= upto; i++) {
			var full = '' + i;

			if (stack_unit !== null)
				full = stack_unit + '/' + full;

			array_set(out, full, true);
		}

		lower = null;
	};

	for (;;) {
		var c = rng[pos++];

		switch (state) {
		case 'REST':
			if (c !== undefined && isdigit(c)) {
				accum += c;
				state = 'BASIC';
				continue;
			}

			/*
			 * Currently we treat the empty string as an error.
			 */
			return (null);

		/*
		 * Handle a basic port number; i.e., no stack unit, no
		 * ranges (a-b); e.g., "24".
		 */
		case 'BASIC':
			if (isdigit(c)) {
				accum += c;
				continue;

			} else if (c === '/') {
				/*
				 * It doesn't make sense to change the
				 * stack-unit value if we're defining a port
				 * range.  For example, it doesn't seem to
				 * make sense to have "1/31-2/33".
				 */
				if (lower !== null) {
					return (null);
				}

				/*
				 * Store the stack-unit value (which sticks
				 * to subsequent port numbers and ranges,
				 * until explicitly set to a different value).
				 */
				stack_unit = accum;
				accum = '';
				continue;

			} else if (c === '-') {
				if (lower !== null) {
					/*
					 * Nonsensical; e.g., "1-2-3".
					 */
					return (null);
				}

				lower = parseInt(c, 10);
				accum = '';
				continue;

			} else if (c === undefined) {
				commit_port(accum);
				return (out);

			} else if (c === ',') {
				/*
				 * Commit this basic entry and start again
				 * with the next entry after the comma.
				 */
				commit_port(accum);
				accum = '';
				continue;
			}
			return (null);
		}
	}
}

module.exports = {
	explode_port_range: explode_port_range,
	array_set: array_set,
};
