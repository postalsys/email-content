'use strict';

/**
 * Ethereal accounts and IMAP plumbing.
 *
 * Ethereal never delivers mail externally: whatever an account sends, to any recipient, lands back
 * in that same account's INBOX. So a mail client configured with an Ethereal account can reply and
 * forward freely, and the harness reads the result back over IMAP. Accounts come from the
 * commercial backend, which also accepts mail from outside servers, so web services can reply to
 * them too.
 */

const fs = require('node:fs');
const path = require('node:path');
const { ImapFlow } = require('imapflow');

const STATE_DIR = path.join(__dirname, '..', '.state');
const ACCOUNTS_FILE = path.join(STATE_DIR, 'accounts.json');

function readAccounts() {
    try {
        return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
    } catch {
        return {};
    }
}

/** One Ethereal account per name, created once and reused, so client settings survive reruns. */
async function ethereal(name) {
    const accounts = readAccounts();
    if (accounts[name]) {
        return accounts[name];
    }
    const key = process.env.ETHEREAL_API_KEY;
    if (!key) {
        throw new Error('ETHEREAL_API_KEY is not set');
    }
    const response = await fetch('https://api-alt.nodemailer.com/user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ requestor: 'email-content-client-capture', version: '0.1.0' })
    });
    const body = await response.json();
    if (body.status !== 'success') {
        throw new Error(`ethereal account creation failed: ${body.error || response.status}`);
    }
    accounts[name] = body;
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2), { mode: 0o600 });
    return body;
}

async function withImap(account, fn) {
    const client = new ImapFlow({
        host: account.imap.host,
        port: account.imap.port,
        secure: account.imap.secure,
        auth: { user: account.user, pass: account.pass },
        logger: false
    });
    await client.connect();
    try {
        return await fn(client);
    } finally {
        await client.logout().catch(() => {});
    }
}

/** Plant a message in the INBOX, unread, as if it had just arrived. */
async function appendSeed(account, raw) {
    await withImap(account, client => client.append('INBOX', Buffer.from(raw), [], new Date()));
}

/**
 * Wait for the client's outgoing message to loop back into the INBOX and return its raw source.
 *
 * Matched by the scenario's subject tag, excluding the seed itself by Message-ID, so parallel runs
 * against one account cannot pick up each other's mail.
 */
async function waitForCapture(account, scenario, timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const found = await withImap(account, async client => {
            const lock = await client.getMailboxLock('INBOX');
            try {
                const uids = await client.search({ subject: scenario.subjectTag }, { uid: true });
                for (const uid of uids || []) {
                    const message = await client.fetchOne(uid, { envelope: true, source: true }, { uid: true });
                    if (message && message.envelope.messageId !== scenario.messageId) {
                        return message.source;
                    }
                }
                return null;
            } finally {
                lock.release();
            }
        });
        if (found) {
            return found;
        }
        await new Promise(resolve => setTimeout(resolve, 3000));
    }
    throw new Error(`no captured message for ${scenario.subjectTag} within ${timeoutMs} ms`);
}

module.exports = { STATE_DIR, ethereal, appendSeed, waitForCapture, withImap };
