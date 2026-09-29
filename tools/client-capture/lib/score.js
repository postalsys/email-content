'use strict';

/**
 * Score a captured message against its scenario's expectations, token by token.
 *
 * Severity follows the project's cost asymmetry: text that should be visible coming back hidden is a
 * content loss, history left visible is only untidy, and any other wrong label (including history
 * labels that are collapsed rather than hidden) is a mislabel.
 */

const path = require('node:path');
const { extract } = require(path.join(__dirname, '..', '..', '..', 'dist', 'index.js'));
const { findTokens } = require('./scenario');

async function score(raw, expected) {
    const result = await extract(raw);
    const where = new Map();
    // Hidden history is returned separately from what is shown.
    const segments = [...result.segments, ...(result.hiddenSegments || [])];
    for (const segment of segments) {
        for (const found of findTokens(segment.text)) {
            if (!where.has(found.token)) {
                where.set(found.token, { type: segment.type, visibility: segment.visibility });
            }
        }
    }

    const tokens = [];
    for (const [token, labels] of Object.entries(expected)) {
        const seen = where.get(token);
        const actual = seen ? seen.type : 'MISSING';
        let outcome = 'ok';
        if (!labels.includes(actual)) {
            if (!seen) {
                outcome = 'missing';
            } else if (seen.visibility === 'hide') {
                // Hidden when it should have been visible: the expensive error.
                outcome = 'content-hidden';
            } else if (labels.includes('REPLY_HISTORY')) {
                outcome = 'history-visible';
            } else {
                outcome = 'mislabel';
            }
        }
        tokens.push({ token, expected: labels, actual, visibility: seen ? seen.visibility : null, outcome });
    }
    // The canonical text comes back too, so callers that need it do not extract a second time.
    return { tokens, ok: tokens.every(item => item.outcome === 'ok'), canonicalText: result.canonicalText || {} };
}

/** The wrong tokens of a result, one short entry each, for a log line. */
function formatBad(result) {
    return result.tokens
        .filter(item => item.outcome !== 'ok')
        .map(item => `${item.token.slice(0, 3)}:${item.outcome}(${item.actual}${item.visibility ? `/${item.visibility}` : ''})`)
        .join(' ');
}

module.exports = { score, formatBad };
