'use strict';

/** Print every tab of the login browser with its URL and title, to see which services are in. */

const { chromium } = require('playwright');

(async () => {
    const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
    for (const context of browser.contexts()) {
        for (const page of context.pages()) {
            console.log(`${(await page.title()).slice(0, 50).padEnd(52)} ${page.url().slice(0, 90)}`);
        }
    }
    // Detach without closing the person's browser.
    await browser.close().catch(() => {});
})();
