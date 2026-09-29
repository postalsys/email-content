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
const { score } = require('./lib/score');
const { FIXTURE_ROOT } = require('./lib/fixtures');

function* walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            yield* walk(full);
        } else if (entry.name.endsWith('.eml')) {
            yield full;
        }
    }
}

async function main() {
    const verbose = process.argv.includes('--verbose');
    const byOutcome = {};
    const byClient = {};
    let files = 0;
    let hidden = 0;
    for (const file of walk(FIXTURE_ROOT)) {
        const meta = JSON.parse(fs.readFileSync(file.replace(/\.eml$/, '.expected.json'), 'utf8'));
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
            const bad = result.tokens.filter(item => item.outcome !== 'ok');
            console.log(`${path.relative(FIXTURE_ROOT, file)}  ${bad.map(b => `${b.token.slice(0, 3)}:${b.outcome}(${b.actual}/${b.visibility})`).join(' ')}`);
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
