'use strict';

/**
 * Scenarios and sentinel tokens.
 *
 * Every piece of text a scenario puts into a message carries a made-up word that encodes its role.
 * After a client has replied or forwarded, finding those words in the extractor's segments says
 * exactly what each span was supposed to be, with no model and no human labelling. Clients do not
 * care what the words are, so the quoting structure they produce is the real thing.
 *
 * Tokens are single lowercase words with no punctuation, so no client line wrapping, flowed text or
 * HTML conversion can split them.
 */

const crypto = require('node:crypto');

/** Role prefixes. Three letters chosen to appear in no natural language word list. */
const ROLES = {
    N: 'nvq', // new text written in the reply or forward
    H1: 'hvq', // the message being replied to: depth 1 history
    H2: 'gvq', // an older message already quoted inside it: depth 2 history
    F: 'fvq', // the forwarded message
    S: 'svq' // the replying sender's own signature
};

const TOKEN_RE = /\b(nvq|hvq|gvq|fvq|svq)([a-z]{6})\b/g;

function token(role) {
    const letters = [...crypto.randomBytes(6)].map(byte => String.fromCharCode(97 + (byte % 26))).join('');
    return `${ROLES[role]}${letters}`;
}

function roleOf(prefix) {
    return Object.keys(ROLES).find(role => ROLES[role] === prefix);
}

/** Every sentinel token in a string, with its role. */
function findTokens(text) {
    return [...String(text).matchAll(TOKEN_RE)].map(match => ({ token: match[0], role: roleOf(match[1]) }));
}

/**
 * What the extractor should say about each role in each scenario.
 *
 * `hide` roles must come back REPLY_HISTORY; `show` roles must stay visible with the given label.
 * For inline replies the quoted text is answered in place, so it is INLINE_QUOTE, which is shown.
 */
const EXPECTATIONS = {
    reply: { N: 'NEW_CONTENT', H1: 'REPLY_HISTORY', S: 'SIGNATURE' },
    'reply-below': { N: 'NEW_CONTENT', H1: 'REPLY_HISTORY', S: 'SIGNATURE' },
    'reply-inline': { N: 'NEW_CONTENT', H1: 'INLINE_QUOTE', S: 'SIGNATURE' },
    'reply-nested': { N: 'NEW_CONTENT', H1: 'REPLY_HISTORY', H2: 'REPLY_HISTORY', S: 'SIGNATURE' },
    forward: { N: 'NEW_CONTENT', F: 'FORWARDED_CONTENT', S: 'SIGNATURE' }
};

/**
 * Build a scenario: the seed message to plant in the inbox and the text the client should type.
 *
 * @param {string} name scenario name, a key of EXPECTATIONS
 * @param {{ runId: string, to: string, forwardTo: string }} options
 */
function buildScenario(name, options) {
    if (!EXPECTATIONS[name]) {
        throw new Error(`unknown scenario ${name}`);
    }
    const h = () => token(name === 'forward' ? 'F' : 'H1');
    const seedTokens = { a: h(), b: h(), c: h(), sig: h() };
    const nested = name === 'reply-nested' ? { a: token('H2'), b: token('H2') } : null;

    const subjectTag = `cc${options.runId}`;
    const subject = name === 'forward' ? `Quarterly figures ${subjectTag}` : `Invoice question ${subjectTag}`;
    const messageId = `<${options.runId}.seed@example.com>`;

    const paragraphs = [
        `Could you check the ${seedTokens.a} invoice before Friday? The totals looked different from last month.`,
        `Also, the ${seedTokens.b} delivery address changed, so please update it in the system.`,
        `Thanks, and let me know if the ${seedTokens.c} numbers need another look.`
    ];
    const signature = ['Marta Kask', `Finance, ${seedTokens.sig}`];

    const textParts = [...paragraphs, '', '-- ', ...signature];
    const htmlParts = [...paragraphs.map(p => `<p>${p}</p>`), `<div>--&nbsp;</div><div>${signature.join('<br>')}</div>`];

    if (nested) {
        const attribution = 'On Mon, 2 Mar 2026 at 09:12, Jaan Tamm <jaan.tamm@example.com> wrote:';
        const older = [`Here is the ${nested.a} draft of the invoice.`, `The ${nested.b} totals are still provisional.`];
        textParts.push('', attribution, ...older.map(line => `> ${line}`));
        htmlParts.push(
            `<div class="gmail_quote"><div class="gmail_attr">${attribution.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>` +
                `<blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">` +
                older.map(p => `<p>${p}</p>`).join('') +
                '</blockquote></div>'
        );
    }

    const boundary = `b${options.runId}`;
    const seed = [
        `From: Marta Kask <${options.from || 'marta.kask@example.com'}>`,
        `To: <${options.to}>`,
        `Subject: ${subject}`,
        `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
        `Message-ID: ${messageId}`,
        'MIME-Version: 1.0',
        `Content-Type: multipart/alternative; boundary="${boundary}"`,
        '',
        `--${boundary}`,
        'Content-Type: text/plain; charset=utf-8',
        'Content-Transfer-Encoding: 7bit',
        '',
        ...textParts,
        '',
        `--${boundary}`,
        'Content-Type: text/html; charset=utf-8',
        'Content-Transfer-Encoding: 7bit',
        '',
        // CRLF throughout: IMAP servers such as Cyrus reject bare LF on APPEND.
        `<html><body>${htmlParts.join('\r\n')}</body></html>`,
        '',
        `--${boundary}--`,
        ''
    ].join('\r\n');

    const n = () => token('N');
    // An inline reply answers in place and adds nothing above the quote.
    const typed =
        name === 'reply-inline'
            ? { lines: [] }
            : name === 'forward'
              ? { lines: [`Forwarding the ${n()} figures you asked about.`, `The ${n()} part is what matters.`] }
              : { lines: [`Checked, the ${n()} numbers look right to me.`, `I will update the ${n()} address today.`] };

    // Inline answers go after specific quoted paragraphs, keyed by the token that paragraph holds.
    const inline =
        name === 'reply-inline'
            ? [
                  { after: seedTokens.a, text: `Done, the ${n()} invoice is correct.` },
                  { after: seedTokens.b, text: `Updated the ${n()} address as well.` }
              ]
            : null;

    // Acceptable labels per token. Defaults come from the role; an inline reply narrows the
    // answered paragraphs to INLINE_QUOTE and accepts either reading for the unanswered tail,
    // which the labelling guide leaves to judgment.
    const expected = {};
    const expect = (tok, labels) => (expected[tok] = labels);
    for (const tok of Object.values(seedTokens)) {
        expect(tok, [EXPECTATIONS[name].H1 || (name === 'forward' ? 'FORWARDED_CONTENT' : 'REPLY_HISTORY')]);
    }
    if (inline) {
        expect(seedTokens.a, ['INLINE_QUOTE']);
        expect(seedTokens.b, ['INLINE_QUOTE']);
        expect(seedTokens.c, ['INLINE_QUOTE', 'REPLY_HISTORY']);
        expect(seedTokens.sig, ['INLINE_QUOTE', 'REPLY_HISTORY']);
    }
    for (const tok of Object.values(nested || {})) {
        expect(tok, ['REPLY_HISTORY']);
    }
    for (const line of [...typed.lines, ...(inline || []).map(item => item.text)]) {
        for (const found of findTokens(line)) {
            expect(found.token, ['NEW_CONTENT']);
        }
    }

    return {
        name,
        expected,
        subject,
        subjectTag,
        messageId,
        seed,
        typed,
        inline,
        forwardTo: options.forwardTo
    };
}

module.exports = { ROLES, EXPECTATIONS, token, findTokens, buildScenario };
