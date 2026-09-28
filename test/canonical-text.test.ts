import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalisePlainText, canonicaliseText, profileQuoting, splitQuotePrefix } from '../src/canonical/text';
import * as publicApi from '../src/index';
import { analyze } from '../src/analyze';
import { segmentTextBlocks } from '../src/segment/text-blocks';

describe('splitQuotePrefix', () => {
    it('measures quote depth', () => {
        assert.deepEqual(splitQuotePrefix('no quote'), { depth: 0, content: 'no quote' });
        assert.deepEqual(splitQuotePrefix('> one'), { depth: 1, content: 'one' });
        assert.deepEqual(splitQuotePrefix('>> two'), { depth: 2, content: 'two' });
        assert.deepEqual(splitQuotePrefix('> > two spaced'), { depth: 2, content: 'two spaced' });
        assert.deepEqual(splitQuotePrefix('  > indented'), { depth: 1, content: 'indented' });
    });

    it('does not treat pipes or colons as quote markers', () => {
        // Tables, code and diffs use these constantly. Treating them as quotes would promote new
        // content into history, which is the expensive direction of error.
        assert.equal(splitQuotePrefix('| a | b |').depth, 0);
        assert.equal(splitQuotePrefix(': not a quote').depth, 0);
        assert.equal(splitQuotePrefix('    indented code').depth, 0);
    });

    it('ignores a marker that is too deeply indented to be a quote prefix', () => {
        assert.equal(splitQuotePrefix('        > deep indent').depth, 0);
    });
});

describe('canonicaliseText', () => {
    it('normalises line endings and keeps offsets consistent', () => {
        const canonical = canonicaliseText('a\r\nb\rc\nd');
        assert.equal(canonical.text, 'a\nb\nc\nd');
        assert.equal(canonical.lines.length, 4);
        for (const line of canonical.lines) {
            assert.equal(canonical.text.slice(line.start, line.end), line.raw);
        }
    });

    it('strips a BOM and NUL bytes', () => {
        const canonical = canonicaliseText('\ufeffhello\0 world');
        assert.equal(canonical.text, 'hello world');
    });

    it('does not unwrap or trim content', () => {
        const input = 'one\ntwo   \n\n  three';
        const canonical = canonicaliseText(input);
        assert.equal(canonical.text, input);
    });

    it('produces lines whose raw text reassembles the original exactly', () => {
        const input = '> quoted\n\nreply text\n> more\n';
        const canonical = canonicaliseText(input);
        const rebuilt = canonical.lines.map(line => line.raw).join('\n');
        assert.equal(rebuilt, canonical.text);
    });
});

describe('profileQuoting', () => {
    const profile = (text: string) => profileQuoting(canonicaliseText(text).lines);

    it('detects no quoting', () => {
        const result = profile('just a message\n\nwith two paragraphs');
        assert.equal(result.style, 'none');
        assert.equal(result.maxDepth, 0);
    });

    it('detects a top post', () => {
        const result = profile('My answer.\n\nOn Monday, X wrote:\n> the question\n> more question');
        assert.equal(result.style, 'top');
        assert.equal(result.contentAfter, 0);
    });

    it('detects a bottom post', () => {
        const result = profile('> the question\n> more question\n\nMy answer.');
        assert.equal(result.style, 'bottom');
        assert.equal(result.contentBefore, 0);
        assert.equal(result.contentAfter, 1);
    });

    it('detects interleaved replies', () => {
        const result = profile('> question one\n\nanswer one\n\n> question two\n\nanswer two');
        assert.equal(result.style, 'interleaved');
        assert.equal(result.contentBetween, 1);
        assert.equal(result.contentAfter, 1);
    });

    it('separates a top post with a trailing signature from a genuine bottom post', () => {
        // This distinction is the one a naive detector gets wrong, and it matters: the trailing
        // block might be a signature or might be real content.
        const result = profile('My answer.\n\nOn Monday, X wrote:\n> the question\n\n--\nSignature');
        assert.equal(result.style, 'top-and-trailing');
        assert.ok(result.contentBefore > 0);
        assert.ok(result.contentAfter > 0);
    });

    it('records maximum depth for nested quotes', () => {
        const result = profile('>>> deepest\n>> middle\n> outer\n\nreply');
        assert.equal(result.maxDepth, 3);
        assert.equal(result.quotedLines, 3);
    });
});

describe('wrapped quote continuations', () => {
    it('re-attaches a quoted line whose wrap lost its prefix', () => {
        // Some clients wrap a quoted paragraph and fail to re-apply ">" on the continuation. The
        // orphaned tail is part of the quote, not something the sender wrote.
        const canonical = canonicaliseText(
            ['> First of all, sorry for the delay in giving some final information', 'about the', '> course. After seeing your preferences, plus my'].join('\n')
        );

        const orphan = canonical.lines[1];
        assert.ok(orphan);
        assert.equal(orphan.depth, 1, 'the wrapped tail should inherit the quote depth');
        assert.equal(orphan.wrapContinuation, true);
        // The raw text is untouched, so tiling still reproduces the input.
        assert.equal(orphan.raw, 'about the');
    });

    it('leaves a genuine inline reply alone', () => {
        // Separated by blank lines and following a quote that ended a sentence: a real answer.
        const canonical = canonicaliseText(['> Should we deploy this today?', '', 'No, wait until Monday.', '', '> Should I notify the customer?'].join('\n'));
        const answer = canonical.lines.find(line => line.content.startsWith('No, wait'));
        assert.ok(answer);
        assert.equal(answer.depth, 0);
        assert.ok(!answer.wrapContinuation);
    });

    it('does not re-attach after a quoted line that ended a sentence', () => {
        const canonical = canonicaliseText(['> Are we ready to ship?', 'Yes we are.', '> Anything else?'].join('\n'));
        const middle = canonical.lines[1];
        assert.ok(middle);
        assert.equal(middle.depth, 0, 'the quote above ended a sentence, so this is new content');
    });

    it('does not re-attach a long line', () => {
        const long = 'this is a genuinely long reply that the sender typed themselves and it should not be swallowed';
        const canonical = canonicaliseText(['> some quoted text that trails off mid', long, '> and continues here'].join('\n'));
        assert.equal(canonical.lines[1]?.depth, 0);
    });

    it('does not re-attach across differing depths', () => {
        const canonical = canonicaliseText(['> outer quote trailing off mid', 'fragment', '>> deeper quote'].join('\n'));
        assert.equal(canonical.lines[1]?.depth, 0);
    });

    it('keeps block tiling exact when continuations are re-attached', () => {
        const input = ['> quoted line trailing off mid', 'about the', '> course continues', '', 'My reply.'].join('\n');
        const { canonical, blocks } = segmentTextBlocks(input, 'TEXT');
        assert.equal(blocks.map(block => block.text).join(''), canonical.text);
    });
});

describe('canonicalisePlainText (public)', () => {
    // EmailEngine slices text at the offsets the extractor reports, using this function (formerly a
    // hand-kept copy in lib/web-safe-html.js). These outputs are a contract: if one has to change,
    // the release note must say that offsets moved.
    const cases: [string, string, string][] = [
        ['CRLF becomes LF', 'a\r\nb\r\n', 'a\nb\n'],
        ['lone CR becomes LF', 'a\rb\r', 'a\nb\n'],
        ['CR CR LF is one LF plus one LF', 'a\r\r\nb', 'a\n\nb'],
        ['NUL is removed', 'a\0b\0\0c', 'abc'],
        ['leading BOM is dropped', '\ufeffhello', 'hello'],
        ['only a leading BOM is dropped', 'a\ufeffb', 'a\ufeffb'],
        ['NFC composes', 'e\u0301', '\u00e9'],
        ['whitespace and quote markers are kept', '  > quoted  \n\t\n', '  > quoted  \n\t\n'],
        ['empty stays empty', '', '']
    ];

    for (const [name, input, expected] of cases) {
        it(name, () => {
            assert.equal(canonicalisePlainText(input), expected);
            // The line model is built on exactly this string, so the offsets agree.
            assert.equal(canonicaliseText(input).text, expected);
        });
    }

    it('is exported from the package entry point', () => {
        assert.equal(publicApi.canonicalisePlainText, canonicalisePlainText);
    });
});

describe('analyze() canonicalText', () => {
    // Input chosen so the canonical form differs from the input (BOM, CRLF, NUL, decomposed e),
    // which is exactly when slicing the caller's own string at the offsets goes wrong.
    const input =
        '\ufeffCaf\u0065\u0301 on Monday?\r\nYes.\0\r\n\r\nOn Mon, Jan 5, 2026 at 10:00 AM Bob <bob@example.com> wrote:\r\n> Shall we meet?\r\n> Bob\r\n';

    it('carries the canonical text the segment offsets index into', async () => {
        const result = await analyze({ text: input, textPartId: '1' });
        assert.deepEqual(Object.keys(result.canonicalText), ['1']);
        const canonical = result.canonicalText['1'];
        assert.equal(canonical, canonicalisePlainText(input));
        assert.notEqual(canonical, input);

        const segments = [...result.segments, ...result.hiddenSegments];
        assert.ok(segments.length >= 2, 'expected new content and reply history');
        for (const segment of segments) {
            assert.equal(segment.source.kind, 'mime-part');
            if (segment.source.kind !== 'mime-part') {
                continue;
            }
            assert.equal(segment.source.representation, 'text');
            const slice = canonical.slice(segment.source.start, segment.source.end);
            // Segment text is the block content without quote prefixes, so each of its lines must
            // appear inside the slice its offsets name.
            for (const line of segment.text.split('\n').filter(line => line.trim())) {
                assert.ok(slice.includes(line), `${JSON.stringify(line)} not within ${JSON.stringify(slice)}`);
            }
        }
    });

    it('omits parts whose representation did not drive the segments', async () => {
        const result = await analyze({ text: 'Plain.', html: '<p>Html.</p>' });
        if (result.primaryRepresentation === 'html') {
            assert.deepEqual(result.canonicalText, {});
        }
    });

    it('is empty when there is no body', async () => {
        const result = await analyze({});
        assert.deepEqual(result.canonicalText, {});
    });
});
