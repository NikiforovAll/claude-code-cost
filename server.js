#!/usr/bin/env node
'use strict';

const cli = require('./lib/cli');

if (cli.isCommand(process.argv[2])) {
  cli.main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
} else {
  require('./lib/app');
}
