'use strict';

/**
 * Write captured messages as fixtures.
 *
 * Captures are synthetic end to end, but the transport still stamps them with Received lines that
 * carry the capturing machine's public IP address. Those, and the similar trace headers webmails
 * add, are removed before anything is written into the repository.
 */

const fs = require('node:fs');
const path = require('node:path');

const FIXTURE_ROOT = path.join(__dirname, '..', '..', '..', 'test', 'fixtures', 'clients');
const TRACE_HEADERS = new RegExp(
    '^(' +
        [
            // Transport traces: these carry the capturing machine's public IP address.
            'received',
            'x-received',
            'return-path',
            'delivered-to',
            'x-originating-ip',
            'x-sender-ip',
            'x-remote-ip',
            'x-forwarded-for',
            'x-real-ip',
            'x-mailer-ip',
            'x-authenticated-sender',
            'x-authenticated-user',
            // Signatures and authentication verdicts, meaningless once headers are removed.
            'dkim-signature',
            'x-google-dkim-signature',
            'arc-.*',
            'authentication-results',
            'received-spf',
            'x-sonic-dkim-sign',
            // Provider diagnostics: tenant ids, spam scores and routing internals.
            'x-ms-.*',
            'x-microsoft-.*',
            'x-forefront-.*',
            'x-originatororg',
            'x-proofpoint-.*',
            'x-me-.*',
            'x-icl-.*',
            'x-vr-.*',
            'x-ovh-.*',
            'x-sonic-.*',
            'x-ymail-osg',
            'x-gm-.*',
            'x-google-smtp-source',
            'x-ui-.*',
            'ui-outboundreport',
            'x-provags-id',
            'x-jnj',
            'x-authority-.*',
            'x-pm-.*',
            'x-lms-return-path',
            'x-yandex-.*',
            'x-zimbra-.*',
            'feedback-id',
            'thread-index'
        ].join('|') +
        ')$',
    'i'
);

function sanitize(raw) {
    const text = Buffer.isBuffer(raw) ? raw.toString('binary') : String(raw);
    const split = text.search(/\r?\n\r?\n/);
    const head = split === -1 ? text : text.slice(0, split);
    const body = split === -1 ? '' : text.slice(split);
    const lines = head.split(/\r?\n/);
    const kept = [];
    let dropping = false;
    for (const line of lines) {
        if (/^[ \t]/.test(line)) {
            if (!dropping) {
                kept.push(line);
            }
            continue;
        }
        const name = line.slice(0, line.indexOf(':'));
        dropping = TRACE_HEADERS.test(name.trim());
        if (!dropping) {
            kept.push(line);
        }
    }
    return Buffer.from(kept.join('\r\n') + body, 'binary');
}

function writeFixture({ client, locale, compose, scenario, raw, meta, result }) {
    const dir = path.join(FIXTURE_ROOT, client, locale);
    fs.mkdirSync(dir, { recursive: true });
    const base = `${scenario.name}-${compose}`;
    fs.writeFileSync(path.join(dir, `${base}.eml`), sanitize(raw));
    fs.writeFileSync(
        path.join(dir, `${base}.expected.json`),
        JSON.stringify({ client, locale, compose, scenario: scenario.name, ...meta, expected: scenario.expected }, null, 4) + '\n'
    );
    return { file: path.join(dir, `${base}.eml`), ok: result.ok };
}

/** Re-apply sanitize() to every fixture already written, after the header list grows. */
function resanitizeAll(dir = FIXTURE_ROOT) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            resanitizeAll(full);
        } else if (entry.name.endsWith('.eml')) {
            fs.writeFileSync(full, sanitize(fs.readFileSync(full)));
        }
    }
}

module.exports = { FIXTURE_ROOT, sanitize, writeFixture, resanitizeAll };
