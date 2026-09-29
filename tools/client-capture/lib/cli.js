'use strict';

/** `--flag value` and bare `--flag` arguments, for the harness scripts. */
function args(argv = process.argv.slice(2)) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        if (argv[i].startsWith('--')) {
            out[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
        }
    }
    return out;
}

module.exports = { args };
