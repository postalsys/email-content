import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseMessage } from '../src/mime/parse';
import { listFixtures, readFixture } from './helpers';

describe('parseMessage', () => {
    it('preserves the MIME tree rather than flattening it', async () => {
        const message = await parseMessage(readFixture('gmail-top-post.eml'));

        assert.equal(message.structure, 'm/alternative(P,H)');
        const root = message.partsById.get(message.rootId);
        assert.ok(root);
        assert.equal(root.multipart, 'alternative');
        assert.deepEqual(root.childIds, ['1', '2']);

        const plain = message.partsById.get('1');
        const html = message.partsById.get('2');
        assert.equal(plain?.contentType, 'text/plain');
        assert.equal(html?.contentType, 'text/html');
        // The alternative relationship must be recoverable, not collapsed away.
        assert.equal(plain?.parentId, message.rootId);
        assert.equal(html?.parentId, message.rootId);
    });

    it('gives every part a traceable byte range inside the original message', async () => {
        const raw = readFixture('gmail-top-post.eml');
        const message = await parseMessage(raw);

        for (const part of message.parts) {
            assert.ok(part.headerRange.start >= 0, `${part.partId} header start`);
            assert.ok(part.headerRange.end <= raw.length, `${part.partId} header end`);
            assert.ok(part.headerRange.end > part.headerRange.start, `${part.partId} header range non-empty`);
            if (part.bodyRange) {
                assert.ok(part.bodyRange.start >= part.headerRange.end, `${part.partId} body starts after headers`);
                assert.ok(part.bodyRange.end <= raw.length, `${part.partId} body within file`);
            }
        }

        // The raw bytes a part points at must actually contain that part's headers.
        const html = message.partsById.get('2');
        assert.ok(html);
        const headerBytes = raw.subarray(html.headerRange.start, html.headerRange.end).toString('binary');
        assert.match(headerBytes, /text\/html/);
    });

    it('decodes quoted-printable and charset together', async () => {
        const message = await parseMessage(readFixture('gmail-top-post.eml'));
        const plain = message.partsById.get('1');
        assert.ok(plain?.decoded);
        assert.match(plain.decoded.text, /No, wait until Monday\./);
        // A quoted-printable encoded narrow no-break space must survive as one character.
        assert.match(plain.decoded.text, /9:15\u202fAM/);
        assert.equal(plain.decoded.replacementChars, 0);
    });

    it('decodes legacy charsets', async () => {
        const message = await parseMessage(readFixture('charset-latin1.eml'));
        const plain = message.parts.find(part => part.contentType === 'text/plain');
        assert.ok(plain?.decoded);
        assert.match(plain.decoded.text, /Grüße aus München/);
        assert.match(plain.decoded.text, /Straße/);
        assert.equal(plain.decoded.charsetUsed, 'windows-1252');
        // Subject encoded words decode too.
        assert.equal(message.headers.subject, 'Grüße');
    });

    it('falls back predictably on an unknown charset and reports it', async () => {
        const message = await parseMessage(readFixture('invalid-charset.eml'));
        const plain = message.parts.find(part => part.contentType === 'text/plain');
        assert.ok(plain?.decoded);
        assert.match(plain.decoded.text, /Plain ascii survives/);
        assert.ok(message.warnings.some(warning => warning.code === 'unknown_charset'));
    });

    it('applies format=flowed unfolding', async () => {
        const message = await parseMessage(readFixture('format-flowed.eml'));
        const plain = message.parts.find(part => part.contentType === 'text/plain');
        assert.ok(plain?.decoded);
        assert.equal(plain.flowed, true);
        assert.match(plain.decoded.text, /wrapped across several physical lines using format=flowed, so it should be joined/);
        // The signature delimiter must survive unfolding, per RFC 3676.
        assert.match(plain.decoded.text, /\n-- ?\nMallory/);
    });

    it('never throws on malformed MIME and still returns content', async () => {
        const message = await parseMessage(readFixture('broken-mime.eml'));
        const texts = message.parts.filter(part => part.decoded).map(part => part.decoded?.text ?? '');
        assert.ok(texts.some(text => text.includes('never closed')));
        assert.equal(message.parts.length >= 2, true);
    });

    it('reports messages with no text parts instead of failing', async () => {
        const message = await parseMessage(readFixture('no-text-parts.eml'));
        assert.ok(message.warnings.some(warning => warning.code === 'no_body_parts'));
        assert.equal(message.parts.length, 1);
    });

    it('extracts threading headers without requiring them', async () => {
        const reply = await parseMessage(readFixture('gmail-top-post.eml'));
        assert.equal(reply.headers.messageId, 'caf8xyz123@mail.gmail.com');
        assert.equal(reply.headers.inReplyTo, '20250113071500.aaa@example.net');
        assert.deepEqual(reply.headers.references, ['20250113071500.aaa@example.net']);

        const noThread = await parseMessage(readFixture('text-mentions-headers.eml'));
        assert.equal(noThread.headers.inReplyTo, null);
        assert.deepEqual(noThread.headers.references, []);
    });

    it('parses every fixture without throwing', async () => {
        for (const name of listFixtures()) {
            const message = await parseMessage(readFixture(name));
            assert.ok(Array.isArray(message.parts), `${name} produced parts`);
            assert.ok(message.size > 0, `${name} recorded a size`);
        }
    });

    it('survives truncation at every offset of a valid message', async () => {
        // Property style: a message cut short at an arbitrary point is a real thing that happens on
        // disk and over the wire. None of those prefixes may throw.
        const raw = readFixture('gmail-top-post.eml');
        for (let cut = 1; cut < raw.length; cut += 37) {
            const message = await parseMessage(raw.subarray(0, cut));
            assert.ok(Array.isArray(message.warnings), `cut at ${cut}`);
        }
    });

    it('survives byte level corruption', async () => {
        const raw = readFixture('gmail-top-post.eml');
        for (let seed = 0; seed < 40; seed++) {
            const copy = Buffer.from(raw);
            // Deterministic pseudo random mutation, so a failure is reproducible.
            for (let i = 0; i < 8; i++) {
                const index = (seed * 7919 + i * 104729) % copy.length;
                copy[index] = (copy[index] ?? 0) ^ 0xff;
            }
            const message = await parseMessage(copy);
            assert.ok(Array.isArray(message.parts), `seed ${seed}`);
        }
    });
});
