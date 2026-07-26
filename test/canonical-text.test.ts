import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { canonicaliseText, profileQuoting, splitQuotePrefix } from '../src/canonical/text';
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
        const canonical = canonicaliseText('﻿hello\0 world');
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
