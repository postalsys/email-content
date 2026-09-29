'use strict';

/** Plant seed messages into web service mailboxes through the EmailEngine API. */

const BASE = process.env.EE_URL || 'https://emailengine.dev';

async function uploadSeed(account, raw) {
    const token = process.env.EE_TOKEN;
    if (!token) {
        throw new Error('EE_TOKEN is not set');
    }
    const response = await fetch(`${BASE}/v1/account/${encodeURIComponent(account)}/message`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'INBOX', raw: Buffer.from(raw).toString('base64'), flags: [] })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(`seed upload to ${account} failed: ${response.status} ${body.message || ''}`);
    }
    return body;
}

/** The account's own address, for the seed's To header. */
async function accountAddress(account) {
    const response = await fetch(`${BASE}/v1/account/${encodeURIComponent(account)}`, { headers: { Authorization: `Bearer ${process.env.EE_TOKEN}` } });
    const body = await response.json();
    if (!body.email) {
        throw new Error(`no address for account ${account}`);
    }
    return body.email;
}

module.exports = { uploadSeed, accountAddress };
