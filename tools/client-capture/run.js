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
const { STATE_DIR, ethereal, appendSeed, waitForCapture, withImap } = require('./lib/mailbox');
const { args } = require('./lib/cli');
const { buildScenario } = require('./lib/scenario');
const { formatBad, score } = require('./lib/score');
const { writeFixture } = require('./lib/fixtures');

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

/**
 * A browser page logged in as the account a job should use.
 *
 * Drivers that set `perLocaleAccount` get a fresh account and a browser context whose locale
 * matches the job, because some clients (Roundcube) only take a user's language from the browser
 * when the user is first created and cannot be switched reliably afterwards.
 */
async function sessionFor(browser, driver, account, locale, shared) {
    if (!driver.perLocaleAccount) {
        return { page: shared, account, close: async () => {} };
    }
    const jobAccount = await ethereal(`${driver.name}-${locale}`);
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: locale.replace(/_/g, '-'), ...(driver.pageOptions || {}) });
    const page = await context.newPage();
    return { page, account: jobAccount, close: () => context.close() };
}

async function worker(driver, account, jobs, opts, summary) {
    const browser = await chromium.launch({ headless: !opts.headed });
    const shared = driver.perLocaleAccount ? null : await browser.newPage({ viewport: { width: 1400, height: 900 }, ...(driver.pageOptions || {}) });
    let clientVersion = 'unknown';
    if (shared) {
        await driver.login(shared, account);
        clientVersion = driver.version ? await driver.version(shared) : 'unknown';
    }
    // Jobs arrive grouped by locale, and a worker takes a whole group: with per locale accounts,
    // two workers on one locale would change the same account's preferences under each other.
    for (let group = jobs.shift(); group; group = jobs.shift()) {
        for (const { locale, compose, name } of group) {
            const runId = crypto.randomBytes(5).toString('hex');
            const label = `${driver.name} ${locale} ${compose} ${name}`;
            const session = await sessionFor(browser, driver, account, locale, shared);
            const { page } = session;
            try {
                const scenario = buildScenario(name, { runId, to: session.account.user, forwardTo: 'jaan.tamm@example.com' });
                await driver.login(page, session.account);
                await driver.configure(page, { locale, compose });
                if (clientVersion === 'unknown' && driver.version) {
                    clientVersion = await driver.version(page);
                    await driver.login(page, session.account);
                }
                const uid = await seedUid(session.account, scenario);
                await driver.respond(page, { uid, scenario, compose, placement: PLACEMENT[name] });
                const raw = await waitForCapture(session.account, scenario);
                const result = await score(raw, scenario.expected);
                writeFixture({
                    client: driver.name,
                    locale,
                    compose,
                    scenario,
                    raw,
                    meta: { clientVersion, capturedAt: new Date().toISOString().slice(0, 10) }
                });
                summary.push({ label, ok: result.ok });
                console.log(`${result.ok ? 'ok  ' : 'FAIL'} ${label}  ${formatBad(result)}`.trimEnd());
            } catch (err) {
                summary.push({ label, ok: false });
                console.log(`ERR  ${label}  ${err.message.split('\n')[0]}`);
                if (opts.debug) {
                    await page.screenshot({ path: path.join(STATE_DIR, `err-${runId}.png`) }).catch(() => {});
                }
            } finally {
                await session.close();
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
        const group = [];
        for (const compose of composes) {
            for (const name of scenarios) {
                group.push({ locale, compose, name });
            }
        }
        jobs.push(group);
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
