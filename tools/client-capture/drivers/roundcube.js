'use strict';

/** Roundcube (elastic skin), pointed at Ethereal. */

const { editPlain, editHtmlInline } = require('../lib/edit');

const { execFileSync } = require('node:child_process');

const BASE = 'http://127.0.0.1:8101';
const CONTAINER = 'email-content-clients-roundcube-1';

function setLanguage(username, locale) {
    // Values travel as environment variables into a prepared statement, never into the code.
    execFileSync('docker', [
        'exec',
        '-e',
        `RC_USER=${username}`,
        '-e',
        `RC_LANG=${locale}`,
        CONTAINER,
        'php',
        '-r',
        '$d = new PDO("sqlite:/var/roundcube/db/sqlite.db"); $s = $d->prepare("UPDATE users SET language = ? WHERE username = ?"); $s->execute([getenv("RC_LANG"), getenv("RC_USER")]);'
    ]);
}

async function savePrefs(page, section, values) {
    await page.goto(`${BASE}/?_task=settings&_action=edit-prefs&_section=${section}&_framed=1`);
    for (const [name, value] of Object.entries(values)) {
        await page.selectOption(`select[name=${name}]`, String(value));
    }
    // Wait for the save itself: the page is already loaded, so a load-state wait returns at once
    // and the next navigation would abort the POST, silently dropping the preference.
    await Promise.all([page.waitForResponse(response => response.request().method() === 'POST'), page.click('button.submit')]);
}

module.exports = {
    name: 'roundcube',
    service: 'roundcube',
    url: BASE,

    async login(page, account) {
        this.account = account;
        await page.goto(`${BASE}/`);
        if (await page.$('#rcmloginuser')) {
            await page.fill('#rcmloginuser', account.user);
            await page.fill('#rcmloginpwd', account.pass);
            await page.click('#rcmloginsubmit');
        }
        await page.waitForSelector('#messagelist', { state: 'attached', timeout: 30000 });
    },

    async version(page) {
        await page.goto(`${BASE}/?_task=settings&_action=about&_framed=1`);
        const text = await page.textContent('body');
        return (text.match(/Version\s*([\d.]+)/i) || [])[1] || 'unknown';
    },

    async locales(page) {
        await page.goto(`${BASE}/?_task=settings&_action=edit-prefs&_section=general&_framed=1`);
        return page.$$eval('select[name=_language] option', options => options.map(option => option.value));
    },

    async configure(page, { locale, compose, placement }) {
        // _htmleditor: 0 never, 1 always. _reply_mode: 0 below the quote, 1 above it.
        await savePrefs(page, 'compose', { _htmleditor: compose === 'html' ? 1 : 0, _reply_mode: placement === 'below' ? 0 : 1 });
        // Changing the language through Settings proved unreliable: the session keeps the language
        // it logged in with and writes it back on later saves, so captures silently carried the
        // previous job's language. Roundcube reads users.language at login, so set it there and
        // log in again.
        let active = null;
        for (let attempt = 0; attempt < 3 && active !== locale; attempt++) {
            setLanguage(this.account.user, locale);
            await page.context().clearCookies();
            await this.login(page, this.account);
            active = await page.evaluate(() => window.rcmail && window.rcmail.env.locale);
        }
        if (active !== locale) {
            throw new Error(`language is ${active}, expected ${locale}`);
        }
    },

    async respond(page, { uid, scenario, compose }) {
        const action = scenario.name === 'forward' ? `_forward_uid=${uid}` : `_reply_uid=${uid}`;
        await page.goto(`${BASE}/?_task=mail&_action=compose&_mbox=INBOX&${action}`);
        await page.waitForSelector('#composebody', { state: 'attached' });

        if (scenario.name === 'forward') {
            const input = page.locator('.recipient-input input').first();
            await input.click();
            await input.type(`${scenario.forwardTo},`);
        }

        if (compose === 'html') {
            await page.waitForFunction(() => window.tinymce && window.tinymce.activeEditor && window.tinymce.activeEditor.initialized, null, {
                timeout: 60000
            });
            await page.evaluate(
                ([editHtmlInlineSrc, typed, inline]) => {
                    const editor = window.tinymce.activeEditor;
                    if (inline && inline.length) {
                        // eslint-disable-next-line no-new-func
                        new Function(`return ${editHtmlInlineSrc}`)()(editor.getBody(), inline);
                        editor.setDirty(true);
                        editor.save();
                    } else {
                        editor.focus();
                        editor.execCommand('mceInsertContent', false, typed.lines.map(line => `<p>${line}</p>`).join(''));
                    }
                },
                [editHtmlInline.toString(), scenario.typed, scenario.inline]
            );
        } else {
            await page.$eval('#composebody', editPlain, { lines: scenario.typed.lines, inline: scenario.inline });
        }

        await page.click('button.send');
        await page.waitForURL(url => url.searchParams.get('_action') !== 'compose', { timeout: 30000 });
    }
};
