'use strict';

/**
 * Capture client reply and forward structure as labelled fixtures.
 *
 *   node run.js --client roundcube --locales en_US,de_DE --compose text,html \
 *       --scenarios reply,reply-below,reply-inline,reply-nested,forward
 *
 * For every combination: plant a seed message in the client's Ethereal INBOX, have the client
 * reply or forward through its real UI, read the result back over IMAP, score it token by token
 * against what each span should be, and write it to test/fixtures/clients/<client>/<locale>/.
 *
 * Needs ETHEREAL_API_KEY for account creation and the Docker services in docker/compose.yml.
 */

const crypto = require('node:crypto');
const path = require('node:path');
const { chromium } = require('playwright');
const { ethereal, appendSeed, waitForCapture, withImap } = require('./lib/mailbox');
const { buildScenario } = require('./lib/scenario');
const { score } = require('./lib/score');
const { writeFixture } = require('./lib/fixtures');

function args() {
    const out = {};
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i++) {
        if (argv[i].startsWith('--')) {
            out[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
        }
    }
    return out;
}

const PLACEMENT = { reply: 'above', 'reply-below': 'below', 'reply-inline': 'below', 'reply-nested': 'above', forward: 'above' };

async function seedUid(account, scenario) {
    await appendSeed(account, scenario.seed);
    return withImap(account, async client => {
        await client.mailboxOpen('INBOX');
        const uids = await client.search({ header: { 'message-id': scenario.messageId } }, { uid: true });
        if (!uids || !uids.length) {
            throw new Error('seed not found after append');
        }
        return uids[uids.length - 1];
    });
}

async function worker(driver, account, jobs, opts, summary) {
    const browser = await chromium.launch({ headless: !opts.headed });
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, ...(driver.pageOptions || {}) });
    await driver.login(page, account);
    const clientVersion = driver.version ? await driver.version(page) : 'unknown';
    for (;;) {
        const job = jobs.shift();
        if (!job) {
            break;
        }
        const { locale, compose, name } = job;
        const runId = crypto.randomBytes(5).toString('hex');
        const scenario = buildScenario(name, { runId, to: account.user, forwardTo: 'jaan.tamm@example.com' });
        const label = `${driver.name} ${locale} ${compose} ${name}`;
        try {
            await driver.login(page, account);
            await driver.configure(page, { locale, compose, placement: PLACEMENT[name] });
            const uid = await seedUid(account, scenario);
            await driver.respond(page, { uid, scenario, compose, placement: PLACEMENT[name] });
            const raw = await waitForCapture(account, scenario);
            const result = await score(raw, scenario.expected);
            writeFixture({
                client: driver.name,
                locale,
                compose,
                scenario,
                raw,
                result,
                meta: { clientVersion, capturedAt: new Date().toISOString().slice(0, 10) }
            });
            const bad = result.tokens.filter(item => item.outcome !== 'ok');
            summary.push({ label, ok: result.ok, bad });
            console.log(
                `${result.ok ? 'ok  ' : 'FAIL'} ${label}${bad.length ? '  ' + bad.map(b => `${b.token.slice(0, 3)}:${b.outcome}(${b.actual})`).join(' ') : ''}`
            );
        } catch (err) {
            summary.push({ label, ok: false, error: err.message });
            console.log(`ERR  ${label}  ${err.message.split('\n')[0]}`);
            if (opts.debug) {
                await page.screenshot({ path: path.join(__dirname, '.state', `err-${runId}.png`) }).catch(() => {});
            }
        }
    }
    await browser.close();
}

async function main() {
    const opts = args();
    const driver = require(path.join(__dirname, 'drivers', `${opts.client}.js`));
    const composes = String(opts.compose || 'text,html').split(',');
    const scenarios = String(opts.scenarios || 'reply,reply-below,reply-inline,reply-nested,forward').split(',');
    const workers = Math.max(1, Number(opts.workers || 1));

    // Preferences are per user, so each worker gets its own account and never shares one.
    const accounts = [];
    for (let i = 0; i < workers; i++) {
        accounts.push(await ethereal(i === 0 ? driver.name : `${driver.name}-w${i}`));
    }

    let locales = String(opts.locales || 'en_US').split(',');
    if (opts.locales === 'all') {
        const browser = await chromium.launch();
        const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, ...(driver.pageOptions || {}) });
        await driver.login(page, accounts[0]);
        locales = await driver.locales(page);
        await browser.close();
    }
    if (opts.skip) {
        const skip = new Set(String(opts.skip).split(','));
        locales = locales.filter(locale => !skip.has(locale));
    }

    const jobs = [];
    for (const locale of locales) {
        for (const compose of composes) {
            for (const name of scenarios) {
                jobs.push({ locale, compose, name });
            }
        }
    }
    const summary = [];
    await Promise.all(accounts.map(account => worker(driver, account, jobs, opts, summary)));
    const failed = summary.filter(item => !item.ok).length;
    console.log(`\n${summary.length - failed}/${summary.length} passed`);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
