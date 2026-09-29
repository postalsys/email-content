'use strict';

/**
 * Score every captured client fixture against the current build of the library.
 *
 *   node rescore.js [--verbose]
 *
 * Needs `npm run build` at the repository root first. Exits non zero if any token that should be
 * visible comes back hidden, so it can serve as a regression gate.
 */

const fs = require('node:fs');
const path = require('node:path');
const { formatBad, score } = require('./lib/score');
const { FIXTURE_ROOT, walkFixtures } = require('./lib/fixtures');

async function main() {
    const verbose = process.argv.includes('--verbose');
    const byOutcome = {};
    const byClient = {};
    let files = 0;
    let hidden = 0;
    for (const { file, meta } of walkFixtures()) {
        const result = await score(fs.readFileSync(file), meta.expected);
        files++;
        const client = (byClient[meta.client] ||= { files: 0, ok: 0 });
        client.files++;
        client.ok += result.ok ? 1 : 0;
        for (const item of result.tokens) {
            byOutcome[item.outcome] = (byOutcome[item.outcome] || 0) + 1;
            hidden += item.outcome === 'content-hidden' ? 1 : 0;
        }
        if (verbose && !result.ok) {
            console.log(`${path.relative(FIXTURE_ROOT, file)}  ${formatBad(result)}`);
        }
    }
    console.log(`\n${files} fixtures`);
    for (const [client, stats] of Object.entries(byClient)) {
        console.log(`  ${client.padEnd(14)} ${stats.ok}/${stats.files} fully correct`);
    }
    console.log('tokens by outcome:', byOutcome);
    process.exit(hidden ? 1 : 0);
}

main().catch(err => {
    console.error(err);
    process.exit(2);
});
