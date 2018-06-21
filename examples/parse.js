#!/usr/bin/env node

var mod_fs = require('fs');
var mod_verror = require('verror');

var mod_force10 = require('../index.js');

var VE = mod_verror.VError;


var d = mod_fs.readFileSync(process.argv[2], { encoding: 'utf8' });
var l = d.split('\n');

console.log('parsing...');

var ret = mod_force10.f10_cfg_parse(l);
if (ret instanceof Error) {
	console.error('ERROR: %s', VE.fullStack(ret));
	process.exit(1);
}

console.log('%s', JSON.stringify(ret, null, 4));
console.log('ok');
