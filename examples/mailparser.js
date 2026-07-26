'use strict';

/**
 * Using email-content with an already parsed message.
 *
 * This is the normal integration: you have `{ text, html, subject }` from mailparser, postal-mime,
 * EmailEngine or an IMAP client, and you want to know which part of it the sender actually wrote.
 * There is no need to re-serialise the message back to RFC 5322.
 *
 *   node examples/mailparser.js path/to/message.eml
 */

const fs = require('node:fs');
const { simpleParser } = require('mailparser');
const { analyze } = require('@postalsys/email-content');

async function main() {
    const file = process.argv[2];
    if (!file) {
        process.stderr.write('usage: node examples/mailparser.js <message.eml>\n');
        process.exitCode = 2;
        return;
    }

    const parsed = await simpleParser(fs.readFileSync(file));

    const result = await analyze({
        text: parsed.text,
        html: parsed.html || null,
        subject: parsed.subject,
        // Optional. Improves signature detection: a trailing block containing the sender's own name
        // is strong evidence of a sign-off.
        from: parsed.from?.text,
        // Optional. Only used to note whether the message looks like a reply.
        inReplyTo: parsed.inReplyTo,
        references: [].concat(parsed.references || [])
    });

    console.log(`primary representation: ${result.primaryRepresentation}`);
    console.log(`is a reply: ${result.isReply}`);
    console.log(`overall confidence: ${result.overallConfidence.toFixed(3)}\n`);

    // Render these.
    for (const segment of result.segments) {
        console.log(`[${segment.type} ${segment.visibility} ${segment.confidence.toFixed(2)}]`);
        console.log(segment.text);
        console.log();
    }

    // Retained in full, so a client can offer to reveal it. Never discarded.
    if (result.hiddenSegments.length) {
        const chars = result.hiddenSegments.reduce((sum, segment) => sum + segment.text.length, 0);
        console.log(`(${result.hiddenSegments.length} hidden segment(s), ${chars} characters of reply history)`);
        console.log(`reasons: ${result.hiddenSegments[0].reasons.join(', ')}`);
    }
}

main().catch(err => {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
});
