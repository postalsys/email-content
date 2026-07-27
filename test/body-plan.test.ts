/**
 * Section aware body handling.
 *
 * Reproduces the second content loss defect found against 0.0.5:
 *
 *     multipart/mixed(P authored, P long inline footer)
 *       -> segment source.mimePart = ['2'] only
 *       -> the authored sentinel is absent, the footer sentinel is present, warnings = []
 *
 * Silent content loss with no warning at all. Body selection kept the longest part of each type,
 * and in a `multipart/mixed` the siblings are not renderings of one thing, they are pieces of the
 * message.
 *
 * Assertions are on user visible text and on which MIME part each sentinel came from. A warning is
 * not evidence that content survived, and neither is a non empty result.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../src/analyze';
import { extract } from '../src/index';
import { planBody } from '../src/mime/select';
import { parseMessage } from '../src/mime/parse';
import { readFixture } from './helpers';
import { type Segment, blockIndexOf, mimePartOf } from '../src/types';

interface Resultish {
    segments: Segment[];
    hiddenSegments: Segment[];
}

function allSegments(result: Resultish): Segment[] {
    return [...result.segments, ...result.hiddenSegments];
}

function allResultText(result: Resultish): string {
    return allSegments(result)
        .map(segment => segment.text)
        .join('\n');
}

function visibleResultText(result: Resultish): string {
    return result.segments.map(segment => segment.text).join('\n');
}

/** Which MIME part contributed the segment holding a phrase. */
function partHolding(result: Resultish, phrase: string): string | undefined {
    const source = allSegments(result).find(segment => segment.text.includes(phrase))?.source;
    return source ? (mimePartOf(source) ?? undefined) : undefined;
}

/** Build a message from header lines and body lines, with the CRLF endings MIME boundaries need. */
function message(lines: readonly string[]): Buffer {
    return Buffer.from(lines.join('\r\n'), 'utf8');
}

const LONG_FOOTER = Array.from({ length: 12 }, () => 'FOOTER_SENTINEL this notice is appended automatically by the mail gateway.').join(' ');

describe('multipart body planning', () => {
    it('keeps a short authored body beside a long inline footer', async () => {
        const result = await extract(readFixture('mixed-short-body-long-footer.eml'));

        assert.ok(visibleResultText(result).includes('AUTHORED_SENTINEL yes, Monday works.'), 'the authored body disappeared');
        assert.ok(allResultText(result).includes('FOOTER_SENTINEL'), 'the appended footer disappeared');
        assert.notEqual(partHolding(result, 'AUTHORED_SENTINEL'), partHolding(result, 'FOOTER_SENTINEL'));
        assert.equal(partHolding(result, 'AUTHORED_SENTINEL'), '1');
        assert.equal(partHolding(result, 'FOOTER_SENTINEL'), '2');
    });

    it('keeps an appended footer beside an alternative primary section', async () => {
        const result = await extract(readFixture('mixed-alternative-plus-footer.eml'));

        assert.equal(result.primaryRepresentation, 'html');
        assert.ok(visibleResultText(result).includes('AUTHORED_SENTINEL yes, Monday works.'));
        assert.ok(allResultText(result).includes('FOOTER_SENTINEL'));
        // The primary section is the HTML member of the alternative; the footer is its own part.
        assert.equal(partHolding(result, 'AUTHORED_SENTINEL'), '1.2');
        assert.equal(partHolding(result, 'FOOTER_SENTINEL'), '2');
    });

    it('still finds a signature that an appended footer follows', async () => {
        // The positional feature regression guard. Classifying each section on its own would give
        // every section its own last block, and the appended footer would stop the primary
        // section's signature from being the final thing the sender wrote.
        const result = await extract(readFixture('mixed-primary-signature-plus-footer.eml'));

        assert.ok(visibleResultText(result).includes('AUTHORED_SENTINEL yes, Monday works for me.'));
        assert.ok(allResultText(result).includes('FOOTER_SENTINEL'));

        const signature = allSegments(result).find(segment => segment.text.includes('Head of Delivery'));
        assert.ok(signature, 'the signature block disappeared');
        assert.equal(signature.type, 'SIGNATURE');
        assert.equal(mimePartOf(signature.source), '1');
    });

    it('never lets a long attachment become the body', async () => {
        const result = await extract(
            message([
                'From: Alice <alice@example.com>',
                'Subject: Attachment longer than the body',
                'MIME-Version: 1.0',
                'Content-Type: multipart/mixed; boundary="B"',
                '',
                '--B',
                'Content-Type: text/plain; charset=utf-8',
                '',
                'AUTHORED_SENTINEL short note.',
                '',
                '--B',
                'Content-Type: text/plain; charset=utf-8; name="report.txt"',
                'Content-Disposition: attachment; filename="report.txt"',
                '',
                `ATTACHED_SENTINEL ${'padding line of the attached report. '.repeat(60)}`,
                '',
                '--B--',
                ''
            ])
        );

        assert.ok(visibleResultText(result).includes('AUTHORED_SENTINEL short note.'));
        assert.equal(allResultText(result).includes('ATTACHED_SENTINEL'), false, 'an attachment became body content');
    });

    it('does not let a filename without a disposition replace the body', async () => {
        const result = await extract(readFixture('filename-text-without-disposition.eml'));

        assert.ok(visibleResultText(result).includes('AUTHORED_SENTINEL see the log below.'), 'the body was replaced');
        // Retained rather than dropped: the part carries no attachment disposition, and keeping
        // more is the safe direction when a tree is ambiguous.
        assert.ok(allResultText(result).includes('ATTACHED_SENTINEL'));
        assert.equal(partHolding(result, 'AUTHORED_SENTINEL'), '1');
    });

    it('treats alternative members as alternatives whatever their sizes', async () => {
        const long = `AUTHORED_SENTINEL ${'the same message written out at length in plain text. '.repeat(20)}`;
        const result = await extract(
            message([
                'From: Alice <alice@example.com>',
                'Subject: Long text alternative',
                'MIME-Version: 1.0',
                'Content-Type: multipart/alternative; boundary="B"',
                '',
                '--B',
                'Content-Type: text/plain; charset=utf-8',
                '',
                long,
                '',
                '--B',
                'Content-Type: text/html; charset=utf-8',
                '',
                '<div dir="ltr">HTML_SENTINEL short.</div>',
                '',
                '--B--',
                ''
            ])
        );

        // Exactly one representation of an alternative group reaches the output, and size does not
        // change which semantics apply.
        const parts = new Set(allSegments(result).map(segment => mimePartOf(segment.source)));
        assert.equal(parts.size, 1);
        assert.equal(
            result.warnings.some(warning => warning.code === 'body_section_not_selected'),
            false
        );
    });

    it('selects the related root and ignores its inline resources', async () => {
        const result = await extract(readFixture('nested-alternative-related-root.eml'));

        assert.ok(visibleResultText(result).includes('AUTHORED_SENTINEL the plan is attached below.'));
        // The related root is named by the container's start parameter, and it is itself an
        // alternative, so the HTML member of that nested group drives the output.
        assert.equal(partHolding(result, 'AUTHORED_SENTINEL'), '2.2');
        assert.equal(
            result.warnings.some(warning => warning.code === 'body_section_not_selected'),
            false
        );
    });

    it('does not descend into an embedded message', async () => {
        // Characterisation: this already held on 0.0.5 and must keep holding.
        const result = await extract(readFixture('forwarded-with-comment.eml'));
        const message_ = await parseMessage(readFixture('forwarded-with-comment.eml'));
        const plan = planBody(message_);

        assert.ok(plan.excluded.every(entry => entry.partId !== message_.rootId));
        for (const section of plan.sections) {
            for (const part of [section.text, section.html]) {
                assert.equal(part?.rfc822 ?? false, false);
            }
        }
        assert.ok(result.segments.length > 0);
    });

    it('keeps every appended sibling, in document order', async () => {
        const result = await extract(
            message([
                'From: Alice <alice@example.com>',
                'Subject: Three inline text parts',
                'MIME-Version: 1.0',
                'Content-Type: multipart/mixed; boundary="B"',
                '',
                '--B',
                'Content-Type: text/plain; charset=utf-8',
                '',
                'SENTINEL_ONE first.',
                '',
                '--B',
                'Content-Type: text/plain; charset=utf-8',
                '',
                'SENTINEL_TWO second.',
                '',
                '--B',
                'Content-Type: text/plain; charset=utf-8',
                '',
                'SENTINEL_THREE third.',
                '',
                '--B--',
                ''
            ])
        );

        const text = allResultText(result);
        assert.ok(text.includes('SENTINEL_ONE') && text.includes('SENTINEL_TWO') && text.includes('SENTINEL_THREE'));
        assert.ok(text.indexOf('SENTINEL_ONE') < text.indexOf('SENTINEL_TWO'));
        assert.ok(text.indexOf('SENTINEL_TWO') < text.indexOf('SENTINEL_THREE'));
        assert.deepEqual(
            allSegments(result).map(segment => mimePartOf(segment.source)),
            ['1', '2', '3']
        );
    });

    it('keeps both inline siblings whichever one is longer', async () => {
        // Property: length must not decide. The defect was exactly a length comparison.
        for (const [firstLength, secondLength] of [
            [1, 40],
            [40, 1],
            [20, 20]
        ]) {
            const raw = message([
                'From: Alice <alice@example.com>',
                'Subject: Length must not decide',
                'MIME-Version: 1.0',
                'Content-Type: multipart/mixed; boundary="B"',
                '',
                '--B',
                'Content-Type: text/plain; charset=utf-8',
                '',
                `SENTINEL_FIRST ${'alpha '.repeat(firstLength as number)}`,
                '',
                '--B',
                'Content-Type: text/plain; charset=utf-8',
                '',
                `SENTINEL_SECOND ${'beta '.repeat(secondLength as number)}`,
                '',
                '--B--',
                ''
            ]);
            const result = await extract(raw);
            const text = allResultText(result);
            assert.ok(text.includes('SENTINEL_FIRST'), `first lost at ${firstLength}/${secondLength}`);
            assert.ok(text.includes('SENTINEL_SECOND'), `second lost at ${firstLength}/${secondLength}`);
        }
    });

    it('merges a plain and an HTML sibling that are the same content', async () => {
        // Some clients use mixed where they mean alternative, `mixed(H, P)` most often. Merging is
        // decided by content, not by structure, because merging two genuinely distinct siblings
        // would drop one of them.
        const body = 'AUTHORED_SENTINEL the release is scheduled for Monday morning and the runbook is linked below.';
        const result = await extract(
            message([
                'From: Alice <alice@example.com>',
                'Subject: Mixed used as alternative',
                'MIME-Version: 1.0',
                'Content-Type: multipart/mixed; boundary="B"',
                '',
                '--B',
                'Content-Type: text/html; charset=utf-8',
                '',
                `<div dir="ltr">${body}</div>`,
                '',
                '--B',
                'Content-Type: text/plain; charset=utf-8',
                '',
                body,
                '',
                '--B--',
                ''
            ])
        );

        const occurrences = allResultText(result).split('AUTHORED_SENTINEL').length - 1;
        assert.equal(occurrences, 1, 'the same content came out twice');
    });

    it('keeps a plain and an HTML sibling that are different content', async () => {
        const result = await extract(
            message([
                'From: Alice <alice@example.com>',
                'Subject: Genuinely distinct siblings',
                'MIME-Version: 1.0',
                'Content-Type: multipart/mixed; boundary="B"',
                '',
                '--B',
                'Content-Type: text/plain; charset=utf-8',
                '',
                'SENTINEL_INTRO please find the quarterly summary reproduced underneath this note.',
                '',
                '--B',
                'Content-Type: text/html; charset=utf-8',
                '',
                '<div dir="ltr">SENTINEL_BODY revenue grew across every region we operate in this quarter.</div>',
                '',
                '--B--',
                ''
            ])
        );

        const text = allResultText(result);
        assert.ok(text.includes('SENTINEL_INTRO'), 'a distinct plain sibling was merged away');
        assert.ok(text.includes('SENTINEL_BODY'), 'a distinct HTML sibling was merged away');
    });

    it('retains outer inline text from a malformed tree', async () => {
        // A boundary that never closes. Conservative retention beats strict rejection: some real
        // messages misuse MIME, and the reader still wrote what they wrote.
        const result = await extract(
            message([
                'From: Alice <alice@example.com>',
                'Subject: Unclosed boundary',
                'MIME-Version: 1.0',
                'Content-Type: multipart/mixed; boundary="B"',
                '',
                '--B',
                'Content-Type: text/plain; charset=utf-8',
                '',
                'AUTHORED_SENTINEL the boundary below never closes.',
                ''
            ])
        );

        assert.ok(visibleResultText(result).includes('AUTHORED_SENTINEL'));
    });

    it('names an excluded part and why, rather than dropping it silently', async () => {
        // A text part inside a multipart/related that is not the root is an inline resource by the
        // written rule, so it is excluded, and the exclusion is reported with the part and reason.
        const raw = message([
            'From: Alice <alice@example.com>',
            'Subject: Related with a text resource',
            'MIME-Version: 1.0',
            'Content-Type: multipart/related; boundary="B"',
            '',
            '--B',
            'Content-Type: text/html; charset=utf-8',
            '',
            '<div dir="ltr">AUTHORED_SENTINEL the body.</div>',
            '',
            '--B',
            'Content-Type: text/plain; charset=utf-8',
            'Content-ID: <notes@example.com>',
            '',
            'RESOURCE_SENTINEL side notes.',
            '',
            '--B--',
            ''
        ]);
        const result = await extract(raw);

        assert.ok(visibleResultText(result).includes('AUTHORED_SENTINEL the body.'));
        const omission = result.warnings.find(warning => warning.code === 'body_section_not_selected');
        assert.ok(omission, 'an excluded part was not reported');
        assert.equal(omission.mimePart, '2');
        assert.equal(omission.detail, 'related_resource');
    });
});

describe('the sections contract', () => {
    it('gives extract() and analyze() the same composition path', async () => {
        const raw = readFixture('mixed-short-body-long-footer.eml');
        const fromRaw = await extract(raw);

        // The same body, expressed by a caller who already parsed the message.
        const fromContent = await analyze({
            sections: [
                { text: 'AUTHORED_SENTINEL yes, Monday works.\n', textPartId: '1', role: 'primary' },
                { text: `${LONG_FOOTER}\n`, textPartId: '2', role: 'appended' }
            ]
        });

        assert.deepEqual(
            fromContent.segments.map(segment => mimePartOf(segment.source)),
            fromRaw.segments.map(segment => mimePartOf(segment.source))
        );
        assert.ok(visibleResultText(fromContent).includes('AUTHORED_SENTINEL yes, Monday works.'));
        assert.ok(allResultText(fromContent).includes('FOOTER_SENTINEL'));
    });

    it('treats a single text and html pair as one section', async () => {
        const sugar = await analyze({ text: 'Yes, Monday works.', html: '<div>Yes, Monday works.</div>' });
        const explicit = await analyze({ sections: [{ text: 'Yes, Monday works.', html: '<div>Yes, Monday works.</div>' }] });

        assert.deepEqual(
            explicit.segments.map(segment => [segment.type, segment.text]),
            sugar.segments.map(segment => [segment.type, segment.text])
        );
        assert.equal(explicit.primaryRepresentation, sugar.primaryRepresentation);
    });

    it('rejects a body given two ways at once, rather than guessing', async () => {
        await assert.rejects(() => analyze({ text: 'one', sections: [{ text: 'two' }] }), /sections must be the only body input/);
    });

    it('rejects more than one primary section', async () => {
        await assert.rejects(
            () =>
                analyze({
                    sections: [
                        { text: 'one', role: 'primary' },
                        { text: 'two', role: 'primary' }
                    ]
                }),
            /at most one section whose role is "primary"/
        );
    });

    it('reports the section-local block index, not the document one', async () => {
        const result = await analyze({
            sections: [
                { text: 'First paragraph.\n\nSecond paragraph.', textPartId: '1' },
                { text: 'Appended footer text.', textPartId: '2', role: 'appended' }
            ]
        });

        const appended = allSegments(result).find(segment => mimePartOf(segment.source) === '2');
        assert.ok(appended);
        // Its own part's first block, whatever its position in the classified sequence.
        assert.equal(blockIndexOf(appended.source), 0);
    });
});
