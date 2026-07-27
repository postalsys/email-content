'use strict';

/**
 * Verify the published artifact, not the source tree.
 *
 * Packs the package, installs the tarball into a scratch project, and exercises it the way a
 * consumer would. Source imports pass in situations the packed artifact does not: the published
 * 0.0.5 tarball did not contain the behaviour its own tests asserted, because the tests ran against
 * compiled sources and never against a tarball.
 *
 * Four asset states are checked, because "no detector patterns" is the failure that reads as
 * success. Without the JSON files every detector returns nothing, no message is recognised as
 * having history, and the output looks entirely reasonable while being entirely wrong.
 *
 * Run with `npm run verify:package`. Needs no network.
 */

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'email-content-verify-'));

function run(command, args, cwd) {
    return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Run a snippet inside the scratch project, returning stdout, or the error if it throws. */
function inConsumer(source) {
    const file = path.join(work, `case-${Math.abs(hash(source))}.js`);
    fs.writeFileSync(file, source);
    try {
        return { ok: true, out: run(process.execPath, [file], work).trim() };
    } catch (err) {
        return { ok: false, out: `${err.stdout || ''}${err.stderr || ''}`.trim() };
    }
}

function hash(text) {
    let value = 0;
    for (let i = 0; i < text.length; i++) {
        value = (value * 31 + text.charCodeAt(i)) | 0;
    }
    return value;
}

const checks = [];
function check(name, fn) {
    try {
        fn();
        checks.push({ name, ok: true });
    } catch (err) {
        checks.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err) });
    }
}

process.stdout.write(`packing into ${work}\n`);
const packed = run('npm', ['pack', '--pack-destination', work, '--silent'], root).trim().split('\n').pop();
const tarball = path.join(work, packed);

// A consumer project that requires the tarball by its real package name.
fs.writeFileSync(path.join(work, 'package.json'), JSON.stringify({ name: 'consumer', version: '1.0.0', private: true }, null, 2));
run('npm', ['install', '--no-audit', '--no-fund', '--silent', tarball], work);

const installed = path.join(work, 'node_modules', '@postalsys', 'email-content');
const patternDir = path.join(installed, 'dist', 'detect', 'patterns');

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

check('the tarball carries no development or corpus files', () => {
    const listing = run('tar', ['-tzf', tarball], work).split('\n').filter(Boolean);
    const forbidden = listing.filter(
        entry =>
            /(^|\/)\.env/.test(entry) ||
            /\.tgz$/.test(entry) ||
            /(^|\/)data\//.test(entry) ||
            /(^|\/)annotations\//.test(entry) ||
            /corpus-report\.md$/.test(entry) ||
            /(^|\/)test\//.test(entry) ||
            /(^|\/)\.build-test\//.test(entry)
    );
    assert.deepEqual(forbidden, [], `unintended files in the tarball: ${forbidden.join(', ')}`);
    assert.ok(
        listing.some(entry => entry.endsWith('dist/detect/patterns/reply-headers.json')),
        'the pattern assets are missing from the tarball'
    );
});

check('the README CommonJS example runs against the installed package', () => {
    const result = inConsumer(`
        const { analyze } = require('${pkg.name}');
        analyze({ text: 'Yes, Monday works.\\n\\nOn Friday, Alice wrote:\\n> Can we meet on Monday?\\n> I am free after lunch.\\n' })
            .then(result => {
                const visible = result.segments.map(s => s.text).join('\\n');
                if (!visible.includes('Yes, Monday works.')) throw new Error('authored text missing');
                if (!result.segments.concat(result.hiddenSegments).some(s => s.type === 'REPLY_HISTORY')) {
                    throw new Error('no reply history detected: the classifier assets are not working');
                }
                console.log('ok', result.extractorVersion);
            })
            .catch(err => { console.error(err.message); process.exit(1); });
    `);
    assert.ok(result.ok, result.out);
    assert.match(result.out, /^ok /);
});

check('the shipped example runs', () => {
    // Run from the repository, where the example's own devDependencies live, rather than from the
    // consumer project. `examples/` is not in the tarball, so this checks that the example we hand
    // people still works, not that a consumer can run it. It broke unnoticed because nothing ran it:
    // `mailparser` is what the example parses with and was never a dependency of anything.
    const fixture = path.join(root, 'test', 'fixtures', 'gmail-top-post.eml');
    const out = run(process.execPath, [path.join(root, 'examples', 'mailparser.js'), fixture], root);
    assert.match(out, /primary representation:/);
    assert.match(out, /NEW_CONTENT/);
});

check('the documented extractorVersion matches the package version', () => {
    const result = inConsumer(`
        const { EXTRACTOR_VERSION } = require('${pkg.name}');
        console.log(EXTRACTOR_VERSION);
    `);
    assert.ok(result.ok, result.out);
    assert.equal(result.out, pkg.version, 'EXTRACTOR_VERSION and the package version have drifted apart');
});

check('the extract() example runs against the installed package', () => {
    const result = inConsumer(`
        const { extract } = require('${pkg.name}');
        const raw = ['From: a@example.com', 'Subject: Re: Deploy', 'In-Reply-To: <p@example.com>',
                     'Content-Type: text/plain; charset=utf-8', '', 'No, wait until Monday.', ''].join('\\r\\n');
        extract(raw).then(result => {
            if (!result.segments.some(s => s.text.includes('No, wait until Monday.'))) throw new Error('content missing');
            if (result.isReply !== true) throw new Error('isReply missing from extract()');
            if (result.originalAvailable !== true) throw new Error('originalAvailable missing');
            console.log('ok');
        }).catch(err => { console.error(err.message); process.exit(1); });
    `);
    assert.ok(result.ok, result.out);
});

const backup = path.join(work, 'patterns-backup');
fs.cpSync(patternDir, backup, { recursive: true });

check('a truncated pattern file fails loudly', () => {
    const target = path.join(patternDir, 'reply-headers.json');
    const original = fs.readFileSync(target, 'utf8');
    fs.writeFileSync(target, original.slice(0, Math.floor(original.length / 2)));
    const result = inConsumer(`
        try { require('${pkg.name}'); console.log('LOADED'); }
        catch (err) { console.log('THREW', err.name); }
    `);
    fs.writeFileSync(target, original);
    assert.match(result.out, /THREW PatternAssetError/, `a truncated asset did not fail loudly: ${result.out}`);
});

check('an invalid pattern file fails loudly', () => {
    const target = path.join(patternDir, 'signatures.json');
    const original = fs.readFileSync(target, 'utf8');
    fs.writeFileSync(target, 'this is not json');
    const result = inConsumer(`
        try { require('${pkg.name}'); console.log('LOADED'); }
        catch (err) { console.log('THREW', err.name); }
    `);
    fs.writeFileSync(target, original);
    assert.match(result.out, /THREW PatternAssetError/, `an invalid asset did not fail loudly: ${result.out}`);
});

check('absent pattern files fail loudly', () => {
    fs.rmSync(patternDir, { recursive: true, force: true });
    const result = inConsumer(`
        try { require('${pkg.name}'); console.log('LOADED'); }
        catch (err) { console.log('THREW', err.name); }
    `);
    fs.cpSync(backup, patternDir, { recursive: true });
    assert.match(result.out, /THREW PatternAssetError/, `absent assets did not fail loudly: ${result.out}`);
});

check('the package works again once the assets are restored', () => {
    const result = inConsumer(`
        const { loadPatterns } = require('${pkg.name}');
        console.log(loadPatterns().replyHeaders.length > 0 ? 'ok' : 'empty');
    `);
    assert.ok(result.ok, result.out);
    assert.equal(result.out, 'ok');
});

for (const item of checks) {
    process.stdout.write(`${item.ok ? 'ok  ' : 'FAIL'} ${item.name}${item.ok ? '' : `\n     ${item.detail}`}\n`);
}

fs.rmSync(work, { recursive: true, force: true });

const failed = checks.filter(item => !item.ok).length;
process.stdout.write(`\n${checks.length - failed}/${checks.length} package checks passed\n`);
process.exitCode = failed === 0 ? 0 : 1;
