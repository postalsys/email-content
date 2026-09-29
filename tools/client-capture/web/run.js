'use strict';

/**
 * Capture reply and forward structure from web mail services, in a browser a person logged into.
 *
 *   ./web/open-chrome.sh                        # once: log in to each service by hand
 *   node web/run.js --services gmail,yahoo --scenarios reply,reply-nested,forward
 *
 * Seeds are uploaded to each service's INBOX through EmailEngine, from an mx-enabled Ethereal
 * address, so the service's real reply or forward is delivered to Ethereal and read back over IMAP.
 * The UI is driven generically: find the seed by its subject tag, press the reply or forward
 * control (matched by accessible name in many languages), type at the caret, send with Cmd+Enter
 * or the send button. Services that need more get an entry in OVERRIDES.
 */

const crypto = require('node:crypto');
const path = require('node:path');
const { chromium } = require('playwright');
const { ethereal, waitForCapture } = require('../lib/mailbox');
const { buildScenario } = require('../lib/scenario');
const { score } = require('../lib/score');
const { writeFixture } = require('../lib/fixtures');
const { accountAddress, uploadSeed } = require('./emailengine');
const SERVICES = require('./services');

const WORDS = {
    // Reply all quotes exactly like reply and is sometimes the only visible control.
    reply: /^(reply|reply all|vasta|vasta saatjale|vasta kõigile|antworten|répondre|responder|rispondi|beantwoorden|odpowiedz|ответить|回复|回覆|返信|답장|svara|svar|vastaa|atbildēt|atsakyti|odpovědět|válasz|yanıtla|απάντηση|відповісти|responder)$/i,
    forward:
        /^(forward|edasta|saada edasi|edasi|weiterleiten|transférer|reenviar|inoltra|doorsturen|przekaż|переслать|转发|轉寄|转寄|転送|전달|vidarebefordra|videresend|välitä|pārsūtīt|persiųsti|přeposlat|továbbítás|ilet|προώθηση|переслати|encaminhar)$/i,
    more: /^(more|more actions|more options|rohkem|rohkem toiminguid|veel|mehr|ещё|еще|更多|plus|más|altro|meer|więcej|lisää|mer|flere)$/i,
    send: /^(send|saada|senden|envoyer|enviar|invia|verzenden|wyślij|отправить|发送|傳送|送信|보내기|skicka|lähetä|sūtīt|siųsti|odeslat|küldés|gönder|αποστολή|надіслати)\b/i
};

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

/** Visible element whose accessible name, title or own text matches, innermost first. */
async function clickByName(page, regex, options = {}) {
    // Controls can live in any frame; try the top document first.
    for (const frame of [page.mainFrame(), ...page.frames().filter(frame => frame !== page.mainFrame())]) {
        if (await clickInFrame(frame, regex, options).catch(() => false)) {
            return true;
        }
    }
    return false;
}

async function clickInFrame(frame, regex, options = {}) {
    // Role and title locators pierce shadow DOM, which several webmails use for toolbars.
    for (const locator of [
        frame.getByRole('button', { name: regex }),
        frame.getByRole('link', { name: regex }),
        frame.getByRole('menuitem', { name: regex }),
        frame.getByTitle(regex),
        // Some toolbars are plain elements with text and no role at all.
        frame.getByText(regex)
    ]) {
        // Toolbars keep overflowed copies of their buttons that count as visible but cannot be
        // clicked, so try each match briefly.
        const visible = locator.filter({ visible: true });
        const count = await visible.count().catch(() => 0);
        for (let i = 0; i < count; i++) {
            if (
                await visible
                    .nth(i)
                    .click({ timeout: 3000 })
                    .then(() => true)
                    .catch(() => false)
            ) {
                return true;
            }
        }
    }
    return clickInDocument(frame, regex, options);
}

async function clickInDocument(page, regex, { within } = {}) {
    const handle = await page.evaluateHandle(
        ([source, flags, scope]) => {
            const re = new RegExp(source, flags);
            const root = (scope && document.querySelector(scope)) || document;
            const visible = el => {
                const rect = el.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== 'hidden';
            };
            const candidates = [
                ...root.querySelectorAll('button, [role=button], [role=link], [role=menuitem], [role=menuitemradio], a, div[title], span[title], li[title]')
            ].filter(visible);
            const nameOf = el =>
                [el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('data-tooltip'), el.textContent].filter(Boolean).map(text =>
                    text
                        .trim()
                        .split(/\s*[(\n]/)[0]
                        .trim()
                );
            return candidates.find(el => nameOf(el).some(name => re.test(name))) || null;
        },
        [regex.source, regex.flags, within || null]
    );
    const element = handle.asElement();
    if (!element) {
        return false;
    }
    await element.click();
    return true;
}

/** The editor the service focused after reply or forward, or the largest visible one. */
async function findEditor(page, exclude = null) {
    for (let i = 0; i < 20; i++) {
        for (const frame of page.frames().filter(frame => frame !== page.mainFrame())) {
            const inner = await frame.$('body[contenteditable=true], [contenteditable=true], textarea').catch(() => null);
            if (inner && (await inner.evaluate(el => el.getBoundingClientRect().height > 60).catch(() => false))) {
                return inner;
            }
        }
        const handle = await page.evaluateHandle(skip => {
            // Recipient fields are often contenteditable too: never type the body into one.
            // A forwarded body quotes addresses too, so only short elements count as recipient fields.
            const usable = el => {
                const text = el.textContent || el.value || '';
                return !(skip && text.includes(skip) && text.length < 300);
            };
            const active = document.activeElement;
            // A focused editor wins even when small: inline reply composers start one line tall.
            if (active && (active.isContentEditable || active.tagName === 'TEXTAREA') && active.getBoundingClientRect().height > 15 && usable(active)) {
                return active;
            }
            const editors = [...document.querySelectorAll('[contenteditable=true], textarea')].filter(
                el => el.getBoundingClientRect().height > 60 && usable(el)
            );
            editors.sort((a, b) => b.getBoundingClientRect().height - a.getBoundingClientRect().height);
            return editors[0] || null;
        }, exclude);
        const element = handle.asElement();
        if (element) {
            return element;
        }
        await page.waitForTimeout(500);
    }
    throw new Error('no compose editor found');
}

const OVERRIDES = {
    gmail: {
        search: tag => `https://mail.google.com/mail/u/0/#search/${tag}`
    },
    'outlook-com': {},
    yahoo: {
        search: tag => `https://mail.yahoo.com/d/search/keyword=${tag}`
    },
    fastmail: {
        search: tag => `https://app.fastmail.com/mail/search:${tag}`
    }
};

/**
 * The seed's row in the message list. Lists often live in iframes, and the first text match is
 * frequently a search box suggestion, so look in every frame and take the last visible match,
 * which is the list entry below any search UI.
 */
async function findSeed(page, tag) {
    for (const frame of page.frames()) {
        const matches = frame.getByText(tag, { exact: false }).filter({ visible: true });
        if (await matches.count().catch(() => 0)) {
            return matches.last();
        }
    }
    return null;
}

async function openSeed(page, service, scenario) {
    const override = OVERRIDES[service.id] || {};
    for (let attempt = 0; attempt < 12; attempt++) {
        if (override.search) {
            await page.goto(override.search(scenario.subjectTag));
        } else if (attempt % 3 === 0) {
            // Back to the mailbox rather than reload: a reload keeps an open message view,
            // which hides the list the seed would appear in.
            await page.goto(service.login).catch(() => {});
        }
        await page.waitForTimeout(4000);
        await page.keyboard.press('Escape').catch(() => {});
        const target = await findSeed(page, scenario.subjectTag);
        if (target) {
            await target.click();
            await page.waitForTimeout(2500);
            return;
        }
    }
    throw new Error(`seed ${scenario.subjectTag} never appeared in the ${service.id} UI`);
}

async function respond(page, service, scenario) {
    const kind = scenario.name === 'forward' ? 'forward' : 'reply';
    if (!(await clickByName(page, WORDS[kind]))) {
        // Forward often sits in a "more actions" menu next to reply.
        let found = false;
        if (await clickByName(page, WORDS.more)) {
            await page.waitForTimeout(1200);
            found = await clickByName(page, WORDS[kind]);
        }
        if (!found) {
            throw new Error(`no ${kind} control found`);
        }
    }
    await page.waitForTimeout(2500);
    if (kind === 'forward') {
        // Forward usually opens with the caret in the To field.
        await page.keyboard.type(scenario.forwardTo);
        await page.waitForTimeout(800);
        await page.keyboard.press('Enter');
        await page.waitForTimeout(500);
    }
    const editor = await findEditor(page, kind === 'forward' ? scenario.forwardTo : null);
    await editor.evaluate(el => {
        el.focus();
        if (el.tagName === 'TEXTAREA') {
            el.setSelectionRange(0, 0);
            return;
        }
        const range = el.ownerDocument.createRange();
        range.selectNodeContents(el);
        range.collapse(true);
        const selection = el.ownerDocument.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
    });
    for (const line of scenario.typed.lines) {
        await page.keyboard.type(line);
        await page.keyboard.press('Enter');
    }
    await page.keyboard.press('Enter');
    await page.keyboard.press('Meta+Enter');
    await page.waitForTimeout(3000);
    // If the editor is still there, the shortcut did not send: use the button.
    const still = await editor.evaluate(el => el.isConnected && el.getBoundingClientRect().height > 0).catch(() => false);
    if (still && !(await clickByName(page, WORDS.send))) {
        throw new Error('could not send');
    }
}

async function main() {
    const opts = args();
    const wanted = opts.services ? new Set(String(opts.services).split(',')) : null;
    const scenarios = String(opts.scenarios || 'reply,reply-nested,forward').split(',');
    const capture = await ethereal('web-capture');
    const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
    const context = browser.contexts()[0];

    const summary = [];
    for (const service of SERVICES.filter(item => !wanted || wanted.has(item.id))) {
        let page = context.pages().find(candidate => candidate.url().includes(service.match));
        if (!page) {
            page = await context.newPage();
            await page.goto(service.login);
        }
        await page.bringToFront();
        const address = await accountAddress(service.account);
        for (const name of scenarios) {
            const runId = crypto.randomBytes(5).toString('hex');
            const scenario = buildScenario(name, { runId, to: address, from: capture.user, forwardTo: capture.user });
            const label = `${service.id} ${name}`;
            try {
                await uploadSeed(service.account, scenario.seed);
                await openSeed(page, service, scenario);
                await respond(page, service, scenario);
                const raw = await waitForCapture(capture, scenario, 180000);
                const result = await score(raw, scenario.expected);
                writeFixture({
                    client: service.id,
                    locale: opts.locale || 'default',
                    compose: 'html',
                    scenario,
                    raw,
                    result,
                    meta: { clientVersion: 'web', capturedAt: new Date().toISOString().slice(0, 10) }
                });
                const bad = result.tokens.filter(item => item.outcome !== 'ok');
                summary.push({ label, ok: result.ok });
                console.log(
                    `${result.ok ? 'ok  ' : 'FAIL'} ${label}${bad.length ? '  ' + bad.map(b => `${b.token.slice(0, 3)}:${b.outcome}(${b.actual})`).join(' ') : ''}`
                );
            } catch (err) {
                summary.push({ label, ok: false });
                console.log(`ERR  ${label}  ${err.message.split('\n')[0]}`);
                await page.screenshot({ path: path.join(__dirname, '..', '.state', `web-${service.id}-${runId}.png`) }).catch(() => {});
            }
        }
    }
    const failed = summary.filter(item => !item.ok).length;
    console.log(`\n${summary.length - failed}/${summary.length} passed`);
    await browser.close().catch(() => {});
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
