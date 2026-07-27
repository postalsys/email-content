/**
 * The public result and source contracts.
 *
 * `extract()` and `analyze()` are the same pipeline entered at different stages, and the result
 * shape is meant to say so. It did not: `analyze()` returned `isReply`, `extract()` built a fresh
 * object and dropped it, and the README documented it on both. The type level assertions below make
 * that class of drift a build failure rather than a documentation bug.
 *
 * Provenance is the other half. A degraded result used to hardcode `mimePart: 'TEXT'` and
 * `representation: 'text'` even when the surviving content came from HTML, and even when there was
 * no MIME tree at all. A traceability field that points at a part which never held the text is a
 * defect of the same family as losing the text.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, type AnalyzeResult } from '../src/analyze';
import { extract } from '../src/index';
import { mimePartOf, type ContentAnalysisResult, type ExtractionResult } from '../src/types';
import { readFixture } from './helpers';

/** Fields both entry points must expose, checked at runtime as well as by the type below. */
const SHARED_FIELDS = [
    'segments',
    'hiddenSegments',
    'overallConfidence',
    'warnings',
    'originalAvailable',
    'primaryRepresentation',
    'extractorVersion',
    'historyUsed',
    'isReply'
] as const;

function reply(headers: readonly string[], body: string): Buffer {
    return Buffer.from([...headers, 'Content-Type: text/plain; charset=utf-8', '', body, ''].join('\r\n'), 'utf8');
}

describe('one shared result contract', () => {
    it('accepts both results as the shared type', async () => {
        const fromRaw = await extract(readFixture('gmail-top-post.eml'));
        const fromContent = await analyze({ text: 'Yes, Monday works.' });

        // Type level: if either result stopped satisfying the shared contract this would not compile.
        const shared: ContentAnalysisResult[] = [fromRaw, fromContent];
        const extraction: ExtractionResult = fromRaw;
        const analysis: AnalyzeResult = fromContent;

        assert.equal(shared.length, 2);
        assert.equal(extraction.originalAvailable, true);
        assert.equal(analysis.originalAvailable, true);
    });

    it('exposes every shared field from both entry points', async () => {
        const fromRaw = await extract(readFixture('gmail-top-post.eml'));
        const fromContent = await analyze({ text: 'Yes, Monday works.' });

        for (const field of SHARED_FIELDS) {
            assert.ok(field in fromRaw, `extract() is missing ${field}`);
            assert.ok(field in fromContent, `analyze() is missing ${field}`);
        }
    });

    it('reports isReply from threading headers', async () => {
        const threaded = await extract(
            reply(['From: a@example.com', 'Subject: Re: Deploy', 'Message-ID: <r@example.com>', 'In-Reply-To: <parent@example.com>'], 'Yes, Monday works.')
        );
        assert.equal(threaded.isReply, true);

        const fresh = await extract(reply(['From: a@example.com', 'Subject: Deploy', 'Message-ID: <n@example.com>'], 'Shall we deploy on Monday?'));
        assert.equal(fresh.isReply, false);
    });

    it('agrees about isReply between raw and pre-parsed input', async () => {
        const fromRaw = await extract(
            reply(['From: a@example.com', 'Subject: Re: Deploy', 'Message-ID: <r@example.com>', 'In-Reply-To: <parent@example.com>'], 'Yes, Monday works.')
        );
        const fromContent = await analyze({ text: 'Yes, Monday works.\n', subject: 'Re: Deploy', inReplyTo: '<parent@example.com>' });

        assert.equal(fromRaw.isReply, fromContent.isReply);
        assert.equal(fromRaw.primaryRepresentation, fromContent.primaryRepresentation);
        assert.equal(fromRaw.originalAvailable, fromContent.originalAvailable);
    });

    it('puts only hidden segments in hiddenSegments', async () => {
        // Collapsed segments stay in `segments`: a collapsed segment is still rendered, just folded.
        for (const fixture of ['gmail-top-post.eml', 'plain-bottom-post.eml', 'outlook-web-reply.eml', 'forwarded-with-comment.eml']) {
            const result = await extract(readFixture(fixture));
            assert.ok(
                result.hiddenSegments.every(segment => segment.visibility === 'hide'),
                `${fixture} put a non hidden segment in hiddenSegments`
            );
            assert.ok(
                result.segments.every(segment => segment.visibility !== 'hide'),
                `${fixture} left a hidden segment in segments`
            );
        }
    });

    it('keeps every fallback path satisfying the shared shape', async () => {
        const inputs: Buffer[] = [
            Buffer.alloc(0),
            Buffer.from('not an email at all'),
            readFixture('no-text-parts.eml'),
            readFixture('broken-mime.eml'),
            readFixture('pathological-html-visible-text.eml'),
            reply(['From: a@example.com', 'Subject: Text only'], 'Just a plain body.'),
            Buffer.from(['From: a@example.com', 'Subject: HTML only', 'Content-Type: text/html; charset=utf-8', '', '<p>Just HTML.</p>', ''].join('\r\n'))
        ];
        for (const input of inputs) {
            const result = await extract(input);
            for (const field of SHARED_FIELDS) {
                assert.ok(field in result, `a fallback path is missing ${field}`);
            }
            assert.equal(typeof result.isReply, 'boolean');
            assert.equal(result.originalAvailable, true);
        }
    });
});

describe('truthful provenance', () => {
    it('names the HTML part when degraded content came from HTML', async () => {
        // The degraded path used to hardcode TEXT/text regardless of where the content came from.
        const result = await analyze({ html: `${'<div>'.repeat(600)}<p>SENTINEL</p>`, htmlPartId: '1.2' });
        const source = result.segments[0]?.source;

        assert.equal(source?.kind, 'mime-part');
        assert.equal(source && mimePartOf(source), '1.2');
        assert.equal(source?.kind === 'mime-part' && source.representation, 'html');
    });

    it('returns the raw message rather than nothing when no MIME body survives', async () => {
        // `parseMessage()` never rejects; it records the failure and returns what it salvaged. When
        // it salvages no parts, the result used to be zero segments plus a warning, even though the
        // raw bytes plainly held text.
        const raw = Buffer.from('From: a@example.com\r\nSubject: x\r\n\r\nAUTHORED_SENTINEL hello world');
        const result = await extract(raw, { parse: { maxHeadSize: 1 } });

        assert.ok(result.segments.length > 0, 'a message with text came back empty');
        assert.ok(result.segments[0]?.text.includes('AUTHORED_SENTINEL'));
        assert.equal(result.segments[0]?.type, 'UNKNOWN');
        assert.equal(result.segments[0]?.visibility, 'show');
    });

    it('never invents a MIME part when there is no MIME tree', async () => {
        // A total parse failure knows a range in the raw message and nothing else. Naming a part
        // here would send a reviewer to a part that does not exist.
        const raw = Buffer.from('From: a@example.com\r\nSubject: x\r\n\r\nAUTHORED_SENTINEL hello world');
        const result = await extract(raw, { parse: { maxHeadSize: 1 } });

        const source = result.segments[0]?.source;
        assert.equal(source?.kind, 'raw-message');
        assert.equal(source ? mimePartOf(source) : 'missing', null);
        assert.equal(source?.start, 0);
        assert.ok((source?.end ?? 0) > 0);
    });

    it('says so when reply status could not be determined', async () => {
        const raw = Buffer.from('From: a@example.com\r\nSubject: Re: x\r\n\r\nAUTHORED_SENTINEL hello world');
        const result = await extract(raw, { parse: { maxHeadSize: 1 } });

        assert.equal(result.isReply, false, 'false means "not known to be a reply", never a claim');
        assert.ok(
            result.warnings.some(warning => warning.code === 'reply_status_unknown'),
            'the uncertainty must be observable'
        );
    });

    it('marks returned HTML as source markup and never claims it is safe', async () => {
        const hostile =
            '<p><span onclick="steal()">Hello</span> <img src="https://tracker.example/pixel.gif"><a href="javascript:alert(1)">click</a> there.</p>';
        const result = await analyze({ html: hostile });
        const segment = result.segments.find(item => item.html);

        assert.ok(segment, 'the HTML segment disappeared');
        // The extractor is not a sanitiser and does not pretend to be one: active markup survives
        // exactly as it arrived, and nothing in the result claims otherwise.
        assert.ok(segment.html?.includes('onclick='), 'an event handler was rewritten');
        assert.ok(segment.html?.includes('javascript:'), 'a dangerous URL scheme was rewritten');
        assert.ok(segment.html?.includes('https://tracker.example/pixel.gif'), 'a remote image was rewritten');
        assert.equal(JSON.stringify(result).includes('sanitis'), false, 'the result must not suggest it sanitised anything');
    });

    it('does not turn a tracking pixel into authored text', async () => {
        const result = await analyze({ html: '<html><body><img src="https://tracker.example/p.gif" width="1" height="1"></body></html>' });
        assert.equal(result.segments.length, 0);
        assert.ok(result.warnings.some(warning => warning.code === 'no_visible_body_text'));
    });
});
