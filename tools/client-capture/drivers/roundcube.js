'use strict';

/** Roundcube (elastic skin), pointed at Ethereal. */

const { writeScenario } = require('../lib/keyboard');

const BASE = 'http://127.0.0.1:8101';

module.exports = {
    name: 'roundcube',
    service: 'roundcube',
    // Roundcube takes a user's language from the browser only when the user is first created.
    perLocaleAccount: true,
    url: BASE,

    async login(page, account) {
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

    async configure(page, { locale }) {
        // The language comes from the per locale account, created by a browser in that locale.
        // Editor type and caret placement are handled per compose window in respond(): stored
        // preferences proved unreliable, applying one job late and silently producing captures in
        // the wrong editor.
        const active = await page.evaluate(() => window.rcmail && window.rcmail.env.locale);
        if (active !== locale) {
            throw new Error(`language is ${active}, expected ${locale}`);
        }
    },

    async respond(page, { uid, scenario, compose, placement }) {
        const action = scenario.name === 'forward' ? `_forward_uid=${uid}` : `_reply_uid=${uid}`;
        await page.goto(`${BASE}/?_task=mail&_action=compose&_mbox=INBOX&${action}`);
        await page.waitForSelector('#composebody', { state: 'attached' });

        if (scenario.name === 'forward') {
            const input = page.locator('.recipient-input input').first();
            await input.click();
            await input.type(`${scenario.forwardTo},`);
        }

        // Switch to the editor the scenario asks for with the compose window's own selector.
        const richActive = () =>
            Boolean(window.tinymce && window.tinymce.activeEditor && !window.tinymce.activeEditor.isHidden() && window.tinymce.activeEditor.initialized);
        const rich = () => page.evaluate(richActive);
        await page.waitForTimeout(1500);
        if ((await rich()) !== (compose === 'html')) {
            // Roundcube confirms the switch with a native confirm(), which Playwright dismisses by
            // default, silently cancelling it.
            page.once('dialog', dialog => dialog.accept().catch(() => {}));
            await page.$eval(
                '#editor-selector',
                (el, value) => {
                    el.value = value;
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                },
                compose === 'html' ? 'html' : 'plain'
            );
            await page.waitForFunction(`(${richActive})() === ${compose === 'html'}`, null, { timeout: 60000 });
        }

        const editor = compose === 'html' ? page.frameLocator('#composebody_ifr').locator('body') : page.locator('#composebody');
        await writeScenario(page, editor, scenario, placement);

        await page.click('button.send');
        await page.waitForURL(url => url.searchParams.get('_action') !== 'compose', { timeout: 30000 });
    }
};
