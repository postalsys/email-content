'use strict';

/** SnappyMail, pointed at Ethereal through a preconfigured ethereal.email domain. */

const { writeScenario } = require('../lib/keyboard');

const BASE = 'http://127.0.0.1:8102';

async function ready(page) {
    await page.waitForFunction(() => window.rl && window.rl.app && window.rl.app.Remote, null, { timeout: 30000 });
}

async function dismissPopups(page) {
    // First login opens an identity dialog, and any open dialog blocks clicks on the list.
    for (let i = 0; i < 3; i++) {
        await page.waitForTimeout(800);
        const identity = page.locator('#identityform');
        if (await identity.isVisible().catch(() => false)) {
            const name = identity.locator('input[type=text]').first();
            if (!(await name.inputValue())) {
                await name.fill('Test Sender');
            }
            await page.locator('button.buttonAddIdentity').click();
            continue;
        }
        const open = page.locator('#rl-popups dialog[open]:not(:has(a[data-bind*="sendCommand"]))');
        if (!(await open.count())) {
            return;
        }
        await page.keyboard.press('Escape');
    }
}

module.exports = {
    name: 'snappymail',
    service: 'snappymail',
    url: BASE,

    async login(page, account) {
        await page.goto(`${BASE}/`);
        await page.waitForSelector('input[name=Email], .messageList', { timeout: 30000 });
        if (await page.locator('input[name=Email]').isVisible()) {
            await page.fill('input[name=Email]', account.user);
            await page.fill('input[name=Password]', account.pass);
            await page.press('input[name=Password]', 'Enter');
        }
        await ready(page);
        await page.waitForSelector('.messageList', { timeout: 30000 });
        await dismissPopups(page);
    },

    async version() {
        return '2.38.2';
    },

    async locales(page) {
        return page.evaluate(() => window.rl.settings.app('languages'));
    },

    async configure(page, { locale, compose }) {
        await page.evaluate(settings => new Promise(resolve => window.rl.app.Remote.saveSettings(resolve, settings)), {
            language: locale,
            EditorDefaultType: compose === 'html' ? 'Html' : 'Plain'
        });
        await page.goto(`${BASE}/`);
        await ready(page);
        await page.waitForSelector('.messageList', { timeout: 30000 });
        await dismissPopups(page);
    },

    async respond(page, { scenario, placement, compose }) {
        await page.goto(`${BASE}/#/mailbox/INBOX`);
        const item = page.locator('.messageListItem', { hasText: scenario.subjectTag }).first();
        for (let i = 0; i < 10 && !(await item.count()); i++) {
            await page
                .locator('[data-bind*="reloadCommand"]')
                .first()
                .click()
                .catch(() => {});
            await page.waitForTimeout(1500);
        }
        await item.click();
        const command = scenario.name === 'forward' ? 'forwardCommand' : 'replyCommand';
        // Real clicks only: the command binding ignores synthetic ones. The message view's menu
        // holds both reply and forward; a click during its open animation is dropped, so retry
        // until the compose dialog shows this scenario's subject.
        const popup = page.locator('#rl-popups dialog[open]:has(a[data-bind*="sendCommand"])');
        const toggle = page.locator('#more-view-dropdown-id');
        await toggle.waitFor({ state: 'visible' });
        let opened = false;
        for (let attempt = 0; attempt < 4 && !opened; attempt++) {
            await toggle.click();
            const entry = page.locator(`menu[aria-labelledby="more-view-dropdown-id"] [data-bind="command: ${command}"]`);
            await entry.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
            await page.waitForTimeout(300);
            await entry.click({ timeout: 5000 }).catch(() => {});
            opened = await page
                .waitForFunction(
                    tag => [...document.querySelectorAll('#rl-popups dialog[open] input[name=subject]')].some(input => input.value.includes(tag)),
                    scenario.subjectTag,
                    { timeout: 8000 }
                )
                .then(() => true)
                .catch(() => false);
        }
        if (!opened) {
            throw new Error('compose did not open');
        }
        if (scenario.name === 'forward') {
            // The tag widget replaces the input with its own markup. The recipient does not affect
            // quoting, so set it on the view model the widget writes to.
            await page.evaluate(address => {
                const send = document.querySelector('#rl-popups dialog[open] a[data-bind*="sendCommand"]');
                window.ko.dataFor(send).to(address);
            }, scenario.forwardTo);
        }
        if (compose === 'text') {
            // Replies to HTML mail open in the rich editor whatever the default; switch the way a
            // person would, with the editor's own mode selector.
            const modeSelect = popup.locator('select:has(option[value="plain" i]), select:has(option:text-matches("plain", "i"))').first();
            if (await modeSelect.count()) {
                const value = await modeSelect.evaluate(select => [...select.options].find(option => /plain/i.test(option.value + option.text)).value);
                await modeSelect.selectOption(value);
                await page.waitForTimeout(700);
            }
        }
        const editor = popup.locator('.textAreaParent textarea:visible, .textAreaParent [contenteditable=true]:visible').first();
        await editor.waitFor({ state: 'visible' });
        await page.waitForTimeout(500);
        await writeScenario(page, editor, scenario, placement);

        await popup.locator('a.btn[data-bind^="command: sendCommand"]').click();
        await popup.waitFor({ state: 'hidden', timeout: 30000 });
    }
};
