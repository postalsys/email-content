import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extract } from '../src/index';
import { type ExtractionResult, mimePartOf } from '../src/types';
import { listFixtures, readFixture } from './helpers';

function visibleText(result: ExtractionResult): string {
    return result.segments.map(segment => segment.text).join('\n');
}

function allText(result: ExtractionResult): string {
    return [...result.segments, ...result.hiddenSegments].map(segment => segment.text).join('\n');
}

describe('extract, the two cases from the specification', () => {
    it('keeps inline quoted questions visible next to their answers', async () => {
        const raw = [
            'From: a@example.com',
            'To: b@example.com',
            'Subject: Re: Deploy',
            'Message-ID: <inline@example.com>',
            'Content-Type: text/plain; charset=utf-8',
            '',
            '> Should we deploy this today?',
            '',
            'No, wait until Monday.',
            '',
            '> Should I notify the customer?',
            '',
            'Yes, please.',
            ''
        ].join('\n');

        const result = await extract(raw);

        assert.equal(result.hiddenSegments.length, 0, 'nothing may be hidden in an inline reply');
        const types = result.segments.map(segment => segment.type);
        assert.deepEqual(types, ['INLINE_QUOTE', 'NEW_CONTENT', 'INLINE_QUOTE', 'NEW_CONTENT']);

        const text = visibleText(result);
        assert.match(text, /Should we deploy this today\?/);
        assert.match(text, /No, wait until Monday\./);
        assert.match(text, /Should I notify the customer\?/);
        assert.match(text, /Yes, please\./);
    });

    it('hides a trailing reply history region', async () => {
        const raw = [
            'From: a@example.com',
            'To: b@example.com',
            'Subject: Re: Meeting',
            'Message-ID: <trailing@example.com>',
            'Content-Type: text/plain; charset=utf-8',
            '',
            'Yes, Monday works.',
            '',
            'On Friday, Alice wrote:',
            '> Can we meet on Monday?',
            '> I am free after lunch.',
            ''
        ].join('\n');

        const result = await extract(raw);

        assert.match(visibleText(result), /Yes, Monday works\./);
        assert.ok(result.hiddenSegments.length > 0, 'the trailing quote should be hidden');
        assert.equal(result.hiddenSegments[0]?.type, 'REPLY_HISTORY');
        assert.ok(!visibleText(result).includes('Can we meet on Monday'));
        // Hidden does not mean gone.
        assert.match(allText(result), /Can we meet on Monday\?/);
    });
});

describe('extract safety invariants', () => {
    it('never produces an empty result from a non empty message', async () => {
        for (const name of listFixtures()) {
            const result = await extract(readFixture(name));
            const parsedSomething = result.segments.length + result.hiddenSegments.length > 0;
            if (!parsedSomething) {
                // Only allowed when the message genuinely has no text parts, or when the parts it
                // has hold no text a reader would have seen. Either way it must say which.
                assert.ok(
                    result.warnings.some(warning => warning.code === 'no_body_parts' || warning.code === 'no_visible_body_text'),
                    `${name} produced nothing without saying why`
                );
                continue;
            }
            assert.ok(result.segments.length > 0, `${name} hid everything`);
        }
    });

    it('always reports the original as available', async () => {
        for (const name of listFixtures()) {
            const result = await extract(readFixture(name));
            assert.equal(result.originalAvailable, true, name);
        }
    });

    it('only ever hides REPLY_HISTORY', async () => {
        for (const name of listFixtures()) {
            const result = await extract(readFixture(name));
            for (const segment of result.hiddenSegments) {
                assert.equal(segment.type, 'REPLY_HISTORY', `${name} hid a ${segment.type}`);
                assert.ok(segment.confidence >= 0.95, `${name} hid at confidence ${segment.confidence}`);
            }
        }
    });

    it('gives every hidden segment a structural reason', async () => {
        const anchors = new Set([
            'preceded_by_reply_header',
            'preceded_by_forward_header',
            'inside_quote_container',
            'outlook_reply_separator',
            'matched_parent_message',
            'matched_thread_ancestor'
        ]);
        for (const name of listFixtures()) {
            const result = await extract(readFixture(name));
            for (const segment of result.hiddenSegments) {
                const hasAnchor = segment.reasons.some(reason => anchors.has(reason));
                assert.ok(hasAnchor, `${name} hid content with reasons ${segment.reasons.join(',')}`);
            }
        }
    });

    it('keeps every segment traceable to a MIME part and range', async () => {
        for (const name of listFixtures()) {
            const result = await extract(readFixture(name));
            for (const segment of [...result.segments, ...result.hiddenSegments]) {
                assert.equal(segment.source.kind, 'mime-part', name);
                assert.ok((mimePartOf(segment.source) ?? '').length > 0, name);
                assert.ok(segment.source.end >= segment.source.start, name);
                assert.ok(segment.source.kind === 'mime-part' && ['text', 'html'].includes(segment.source.representation), name);
            }
        }
    });

    it('never throws, whatever the input', async () => {
        const inputs = [
            Buffer.alloc(0),
            Buffer.from('not an email at all'),
            Buffer.from('From: broken\n'),
            Buffer.from('Content-Type: multipart/mixed; boundary=x\n\n--x\n'),
            Buffer.from([0x00, 0xff, 0xfe, 0x01, 0x02]),
            Buffer.from('Subject: '.repeat(10000)),
            Buffer.from(`Content-Type: text/html\n\n${'<div>'.repeat(5000)}deep${'</div>'.repeat(5000)}`)
        ];
        for (const input of inputs) {
            const result = await extract(input);
            assert.equal(result.originalAvailable, true);
            assert.ok(Array.isArray(result.segments));
        }
    });
});

describe('extract behaviour by message shape', () => {
    it('classifies a Gmail top post', async () => {
        const result = await extract(readFixture('gmail-top-post.eml'));
        assert.equal(result.primaryRepresentation, 'html');
        assert.match(visibleText(result), /No, wait until Monday/);
        assert.ok(!visibleText(result).includes('Should we deploy this today'));
        assert.equal(result.hiddenSegments[0]?.type, 'REPLY_HISTORY');
    });

    it('collapses rather than hides a bottom posted quote', async () => {
        // Bottom posting means the reader is more likely to need the quote for context, so the
        // conservative choice is collapse, not hide.
        const result = await extract(readFixture('plain-bottom-post.eml'));
        assert.equal(result.hiddenSegments.length, 0);
        const history = result.segments.find(segment => segment.type === 'REPLY_HISTORY');
        assert.ok(history);
        assert.equal(history.visibility, 'collapse');
        assert.match(visibleText(result), /Approved\. I have signed it off/);
    });

    it('keeps forwarded content and the comment above it', async () => {
        const result = await extract(readFixture('forwarded-with-comment.eml'));
        assert.equal(result.hiddenSegments.length, 0, 'forwarded content must never be hidden');
        const types = result.segments.map(segment => segment.type);
        assert.ok(types.includes('NEW_CONTENT'));
        assert.ok(types.includes('FORWARDED_CONTENT'));
        assert.match(visibleText(result), /I think the amount is wrong/);
        assert.match(allText(result), /Invoice 2025-014/);
    });

    it('finds Outlook history that carries no quote markers at all', async () => {
        // Outlook desktop embeds the previous message as ordinary paragraphs introduced by
        // "-----Original Message-----" and a From/Sent/To/Subject block. Nothing is prefixed with
        // ">", so quote-depth based rules see the whole previous message as new content.
        const result = await extract(readFixture('outlook-unmarked-history.eml'));

        assert.match(visibleText(result), /Ok, no problem then/);
        assert.ok(!visibleText(result).includes('I would sign up to Tuesdays'));
        assert.equal(result.hiddenSegments.length, 1, 'the history should be one region, not several');
        assert.equal(result.hiddenSegments[0]?.type, 'REPLY_HISTORY');
        assert.ok(result.hiddenSegments[0]?.reasons.includes('contains_old_message_headers'));
        assert.match(allText(result), /I would sign up to Tuesdays/);
    });

    it('handles an Outlook Web reply separator', async () => {
        const result = await extract(readFixture('outlook-web-reply.eml'));
        assert.equal(result.primaryRepresentation, 'html');
        assert.match(visibleText(result), /Looks good to me/);
        assert.ok(!visibleText(result).includes('Could you review the contract'));
        // Either anchor is acceptable: the separator element, or the embedded header block it
        // introduces. The test asserts the outcome, not which of the two structures won.
        const anchors = new Set(['outlook_reply_separator', 'preceded_by_reply_header', 'contains_old_message_headers']);
        assert.ok(result.hiddenSegments.some(segment => segment.reasons.some(reason => anchors.has(reason))));
        assert.match(allText(result), /Could you review the contract/);
    });

    it('does not treat prose containing header names as history', async () => {
        const result = await extract(readFixture('text-mentions-headers.eml'));
        assert.equal(result.hiddenSegments.length, 0);
        assert.match(visibleText(result), /From: the address that sent the message/);
        assert.match(visibleText(result), /That is usually enough/);
    });

    it('handles a message with no text parts', async () => {
        const result = await extract(readFixture('no-text-parts.eml'));
        assert.equal(result.segments.length, 0);
        assert.ok(result.warnings.some(warning => warning.code === 'no_body_parts'));
    });

    it('extracts from a legacy charset message', async () => {
        const result = await extract(readFixture('charset-latin1.eml'));
        assert.match(visibleText(result), /Grüße aus München/);
    });

    it('keeps a signature visible but collapsed', async () => {
        const result = await extract(readFixture('format-flowed.eml'));
        const signature = result.segments.find(segment => segment.type === 'SIGNATURE');
        assert.ok(signature, 'expected a signature segment');
        assert.equal(signature.visibility, 'collapse');
        assert.match(visibleText(result), /This second paragraph stands alone/);
    });
});
