'use strict';

/**
 * Cypht, authenticating against Ethereal IMAP. Its origin check compares the Origin header with a
 * host that nginx passes without the published port, so pages send X-Forwarded-Host.
 */

const { writeScenario } = require('../lib/keyboard');
const { appendSeed } = require('../lib/mailbox');

const BASE = 'http://localhost:8103';
const INBOX = Buffer.from('INBOX').toString('hex');

async function setHidden(page, name, value) {
    await page.$eval(
        `select[name=${name}]`,
        (el, v) => {
            el.value = v;
            el.dispatchEvent(new Event('change', { bubbles: true }));
        },
        value
    );
}

module.exports = {
    name: 'cypht',
    service: 'cypht',
    url: BASE,
    pageOptions: { extraHTTPHeaders: { 'X-Forwarded-Host': 'localhost:8103' } },

    async login(page, account) {
        await page.goto(`${BASE}/`);
        if (
            await page
                .locator('#username')
                .isVisible()
                .catch(() => false)
        ) {
            await page.fill('#username', account.user);
            await page.fill('#password', account.pass);
            await Promise.all([page.waitForLoadState('load'), page.press('#password', 'Enter')]);
        }
        if (!page.cyphtProfile) {
            // Sending stays disabled until the account has a sender profile.
            await page.goto(`${BASE}/?page=profiles`);
            if (!(await page.locator('table').filter({ hasText: account.user }).count())) {
                await page.getByRole('button', { name: /add a profile/i }).click();
                const form = page.locator('form:has(input[name=profile_name])');
                await form.locator('input[name=profile_name]').fill('Test Sender');
                await form.locator('input[name=profile_address]').fill(account.user);
                await form
                    .locator('input[name=profile_default]')
                    .check()
                    .catch(() => {});
                await Promise.all([page.waitForLoadState('load'), form.locator('input[type=submit], button[type=submit]').first().click()]);
            }
            page.cyphtProfile = true;
        }
        if (!page.cyphtServer) {
            // IMAP folders are addressed as imap_<server id>_<hex folder name>; the id is per login.
            // The id is only visible on message links, so a fresh account needs one unread message.
            const link = page.locator('a[href*="list_path=imap_"]').first();
            for (let attempt = 0; attempt < 3; attempt++) {
                await page.goto(`${BASE}/?page=message_list&list_path=unread`);
                if (
                    await link
                        .waitFor({ state: 'attached', timeout: 15000 })
                        .then(() => true)
                        .catch(() => false)
                ) {
                    break;
                }
                await appendSeed(
                    account,
                    `From: <setup@example.com>\r\nTo: <${account.user}>\r\nSubject: setup\r\nMessage-ID: <setup.${Date.now()}@example.com>\r\n\r\nsetup\r\n`
                );
            }
            await link.waitFor({ state: 'attached', timeout: 15000 });
            page.cyphtServer = (await link.getAttribute('href')).match(/list_path=(imap_[^_&]+)_/)[1];
        }
    },

    async version() {
        return 'latest';
    },

    async locales(page) {
        await page.goto(`${BASE}/?page=settings`);
        return page.$$eval('select[name=language] option', options => options.map(option => option.value));
    },

    async configure(page, { locale, compose }) {
        const type = compose === 'html' ? '1' : '0';
        for (let attempt = 0; attempt < 3; attempt++) {
            await page.goto(`${BASE}/?page=settings`);
            const current = await page.$eval('select[name=smtp_compose_type]', el => el.value);
            const language = await page.$eval('select[name=language]', el => el.value);
            if (current === type && language === locale) {
                return;
            }
            await setHidden(page, 'language', locale);
            await setHidden(page, 'smtp_compose_type', type);
            await Promise.all([page.waitForLoadState('load'), page.click('input[name=save_settings]')]);
        }
        throw new Error('settings did not save');
    },

    async respond(page, { uid, scenario, placement }) {
        const action = scenario.name === 'forward' ? 'forward=1' : 'reply=1';
        await page.goto(`${BASE}/?page=compose&${action}&list_path=${page.cyphtServer}_${INBOX}&uid=${uid}`);
        await page.waitForSelector('#compose_body', { state: 'attached' });
        if (scenario.name === 'forward') {
            await page.fill('#compose_to', scenario.forwardTo);
        }
        const rich = page.frameLocator('iframe.ke-edit-iframe');
        const editor = (await page.locator('iframe.ke-edit-iframe').count()) ? rich.locator('body') : page.locator('#compose_body');
        await editor.waitFor({ state: 'visible' });
        await writeScenario(page, editor, scenario, placement);
        // Sending navigates back to a fresh compose page that can take a while to settle, so
        // click without waiting for it; the runner confirms delivery over IMAP.
        // Send waits for any draft save to finish, and with no drafts folder configured the save
        // never reports back. Nothing here needs the draft, so clear the flag first.
        await page.evaluate(() => {
            for (const input of document.querySelectorAll('.saving_draft')) {
                input.value = '0';
            }
        });
        await page
            .locator('button.smtp_send_placeholder')
            .first()
            .evaluate(el => el.click());
        // Recipients missing from the contact list trigger a confirmation modal.
        const confirm = page.locator('.modal.show button.btn-warning').first();
        if (
            await confirm
                .waitFor({ state: 'visible', timeout: 4000 })
                .then(() => true)
                .catch(() => false)
        ) {
            await confirm.evaluate(el => el.click());
        }
        await page.waitForTimeout(4000);
        if (process.env.DEBUG_DRIVER) {
            await page.screenshot({ path: '.state/cypht-after-send.png' });
        }
    }
};
