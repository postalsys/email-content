/**
 * Hostile input bounds.
 *
 * Inbound mail is attacker controlled and the library runs synchronously on the caller's event
 * loop, so a fail soft catch is not enough: an algorithm that blocks for seconds is a denial of
 * service whether or not it eventually returns the right answer. Every case here reproduced a
 * measured multi second block or a hard failure on 0.0.5.
 *
 * Each case asserts two things, because either alone is misleading. An absolute ceiling alone
 * passes on a fast machine even after quadratic behaviour returns; a growth ratio alone is noisy at
 * millisecond scale. Together they fail loudly on a return of superlinear work and tolerate a busy
 * CI runner.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../src/analyze';
import { stripTagsToText } from '../src/canonical/html';
import { detectAttributionLine, detectQuotedHeaderBlock } from '../src/detect/reply-header';
import { extract } from '../src/index';
import { isPathologicalHtml } from '../src/segment/html-blocks';
import { readFixture } from './helpers';

/**
 * Slack allowed on top of ideal linear growth.
 *
 * Doubling the input four times is a sixteenfold size increase. Linear work grows sixteenfold,
 * quadratic work grows 256 fold. A factor of three of slack sits far from both, so the assertion
 * survives a noisy runner and still fails an obvious return to quadratic behaviour.
 */
const LINEAR_SLACK = 3;

/** Absolute ceiling for a single adversarial case. Every one of these took seconds before the fix. */
const BUDGET_MS = 2000;

/** Least of several runs, in milliseconds. The minimum is the least noisy estimate of real cost. */
function measure(fn: () => void, runs = 3): number {
    let best = Infinity;
    for (let run = 0; run < runs; run++) {
        const started = process.hrtime.bigint();
        fn();
        const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
        if (elapsed < best) {
            best = elapsed;
        }
    }
    return best;
}

/**
 * Assert that `fn` scales no worse than linearly across a set of doubling input sizes.
 *
 * The comparison is anchored on the smallest size, so one slow sample in the middle cannot fail the
 * test on its own, and the ratio between the largest and smallest sizes is what a quadratic
 * regression blows through.
 */
function assertLinear(label: string, sizes: readonly number[], build: (size: number) => string, run: (input: string) => void): void {
    const first = sizes[0] as number;
    // Warm the JIT before the anchor measurement, so an unoptimised first run cannot make later,
    // larger runs look superlinear.
    run(build(first));

    const timings = sizes.map(size => {
        const input = build(size);
        return { size, ms: measure(() => run(input)) };
    });

    const anchor = timings[0] as { size: number; ms: number };
    // A floor, because a sub millisecond anchor turns timer noise into an enormous ratio.
    const anchorMs = Math.max(anchor.ms, 0.5);

    for (const timing of timings) {
        assert.ok(timing.ms < BUDGET_MS, `${label}: size ${timing.size} took ${timing.ms.toFixed(1)}ms, over the ${BUDGET_MS}ms ceiling`);
        const allowed = anchorMs * (timing.size / anchor.size) * LINEAR_SLACK;
        assert.ok(
            timing.ms <= allowed,
            `${label}: size ${timing.size} took ${timing.ms.toFixed(2)}ms, over ${allowed.toFixed(2)}ms allowed for linear growth from ${anchor.size} at ${anchor.ms.toFixed(2)}ms`
        );
    }
}

describe('hostile input stays bounded', () => {
    it('strips mailto URLs from attribution candidates in linear time', () => {
        // A leading "\s*" in the stripping regex was retried at every position of a space run:
        // one 2000 character line of spaces took 2.5 ms, and a megabyte of them over a second.
        assertLinear(
            'mailto strip on space runs',
            [250, 500, 1000, 2000],
            size => `a${' '.repeat(size - 2)}b`,
            input => {
                for (let i = 0; i < 200; i++) {
                    detectAttributionLine(input);
                    detectAttributionLine(`${input.slice(0, -1)}mailto:x`);
                }
            }
        );
    });

    it('keeps attribution patterns cheap on a line with a time and no address', () => {
        // An overlapping ".*[^\s@]+@" lookahead re-scanned every word from every backtrack point.
        const line = `12:30 ${'x'.repeat(290)}`;
        detectAttributionLine(line);
        const ms = measure(() => {
            for (let i = 0; i < 2000; i++) {
                detectAttributionLine(line);
            }
        });
        assert.ok(ms < 400, `2000 hostile lines took ${ms.toFixed(1)}ms`);
    });

    it('detects quoted header blocks in a single pass', () => {
        // 12,000 of these took 4.8 seconds, and doubling the count roughly quadrupled it. The lines
        // are header shaped but never form a strong block, which is the worst case for a detector
        // that restarts a forward scan at every candidate line.
        assertLinear(
            'quoted header scan',
            [2000, 4000, 8000, 16000],
            size => Array.from({ length: size }, () => 'Cc: nobody@example.test').join('\n'),
            input => {
                detectQuotedHeaderBlock(input.split('\n'));
            }
        );
    });

    it('projects unmatched angle brackets in a single pass', () => {
        // `/<[^>]*>/g` rescanned to end of input for every one of these. 128k took 5.8 seconds.
        assertLinear(
            'unmatched <',
            [16000, 32000, 64000, 128000],
            size => '<'.repeat(size),
            input => {
                stripTagsToText(input);
            }
        );
    });

    it('projects unmatched script openers in a single pass', () => {
        assertLinear(
            'unmatched <script',
            [4000, 8000, 16000, 32000],
            size => '<script'.repeat(size),
            input => {
                stripTagsToText(input);
            }
        );
    });

    it('projects closed script elements in a single pass', () => {
        // The closing tag search must not copy the remainder of the document per element.
        assertLinear(
            'closed script elements',
            [2000, 4000, 8000, 16000],
            size => '<script>var a=1;</script>text '.repeat(size),
            input => {
                stripTagsToText(input);
            }
        );
    });

    it('projects unmatched comment openers in a single pass', () => {
        assertLinear(
            'unmatched <!--',
            [8000, 16000, 32000, 64000],
            size => '<!--'.repeat(size),
            input => {
                stripTagsToText(input);
            }
        );
    });

    it('projects malformed quoted attributes in a single pass', () => {
        assertLinear(
            'unterminated quoted attribute',
            [4000, 8000, 16000, 32000],
            size => '<a href="'.repeat(size),
            input => {
                stripTagsToText(input);
            }
        );
    });

    it('projects incomplete entities in a single pass', () => {
        assertLinear(
            'incomplete entities',
            [8000, 16000, 32000, 64000],
            size => '&#x'.repeat(size),
            input => {
                stripTagsToText(input);
            }
        );
    });

    it('projects a mixed hostile document in a single pass', () => {
        assertLinear(
            'mixed hostile markup',
            [2000, 4000, 8000, 16000],
            size => '<<!--<script<a href="&#x<b class=\''.repeat(size),
            input => {
                stripTagsToText(input);
            }
        );
    });

    it('classifies more short lines than V8 allows call arguments', async () => {
        // Spreading a 130,000 element array into Math.max threw RangeError, and the whole message
        // fell back to one unclassified block. Large is not the same as hostile: this is a legal
        // message and must be classified normally.
        const result = await analyze({ text: 'x\n'.repeat(130000) });
        assert.ok(result.segments.length > 0);
        assert.equal(
            result.warnings.some(warning => warning.code === 'extraction_degraded'),
            false,
            `degraded: ${JSON.stringify(result.warnings)}`
        );
        assert.ok(result.segments.some(segment => segment.text.includes('x')));
    });

    it('classifies more HTML nodes than V8 allows call arguments', async () => {
        // One inline run holding 200,000 nodes. Math.min/max over the node ranges was spread based,
        // and spreading that many arguments throws RangeError before any of them is compared.
        const result = await analyze({ html: `<div>x${'<b></b>'.repeat(200000)}</div>` });
        assert.ok(result.segments.length > 0);
        assert.equal(
            result.warnings.some(warning => warning.code === 'extraction_degraded'),
            false,
            `degraded: ${JSON.stringify(result.warnings)}`
        );
    });

    it('refuses to parse a document whose text nodes are all siblings', async () => {
        // node-html-parser is quadratic in the number of text children of one element: 20,000 of
        // them took 1.4 seconds on 120 KB. No message in a 19,982 message corpus sample came within
        // a factor of one and a half of the cap.
        assert.equal(isPathologicalHtml(`<div>${'a<br>'.repeat(20000)}</div>`), true);
        assert.equal(isPathologicalHtml(`<div>${'a<br>'.repeat(5000)}</div>`), false);

        const elapsed = measure(() => {
            isPathologicalHtml(`<div>${'a<br>'.repeat(20000)}</div>`);
        });
        assert.ok(elapsed < BUDGET_MS, `guard itself took ${elapsed}ms`);

        // Degraded, not lost: the authored text is still visible.
        const result = await analyze({ html: `<div>SENTINEL<br>${'a<br>'.repeat(20000)}</div>` });
        assert.ok(result.segments.some(segment => segment.text.includes('SENTINEL')));
    });

    it('keeps script and style bodies out of the text projection', () => {
        const projected = stripTagsToText('<style>.a{color:red}</style><p>Visible</p><script>alert("x")</script>');
        assert.equal(projected.includes('color:red'), false);
        assert.equal(projected.includes('alert'), false);
        assert.ok(projected.includes('Visible'));

        // Unterminated: a renderer shows nothing after an unclosed script either, and the body is
        // code rather than authored prose.
        assert.equal(stripTagsToText('<p>Visible</p><script>alert("x")').includes('alert'), false);
    });

    it('keeps ordinary markup projecting the way it always has', () => {
        // A closing and an opening block tag each break the line, exactly as before.
        assert.equal(stripTagsToText('<p>one</p><p>two</p>'), 'one\n\ntwo');
        assert.equal(stripTagsToText('one<br>two'), 'one\ntwo');
        assert.equal(stripTagsToText('a &amp; b &#65; c'), 'a & b A c');
        assert.equal(stripTagsToText('<!--hidden--><p>shown</p>'), 'shown');
        assert.equal(stripTagsToText('<![if !supportLists]><p>item</p>'), 'item');
        // A bare angle bracket in prose is text, not the start of a tag.
        assert.equal(stripTagsToText('<p>a &lt; b and 3 &gt; 2</p>'), 'a < b and 3 > 2');
        assert.equal(stripTagsToText('<p>a < b</p>'), 'a < b');
        // A quoted attribute value may contain the tag delimiter.
        assert.equal(stripTagsToText('<a title="a>b">link</a>'), 'link');
        // An unterminated trailing tag stays visible rather than swallowing the tail.
        assert.equal(stripTagsToText('<p>text</p><div class="x'), 'text\n<div class="x');
    });

    it('leaves real embedded header fixtures classified exactly as before', async () => {
        // Characterisation. The single pass detector is meant to be behaviour preserving, so the
        // Outlook history in this fixture must still be found and still be collapsed or hidden.
        const result = await extract(readFixture('outlook-unmarked-history.eml'));
        const all = [...result.segments, ...result.hiddenSegments];

        assert.ok(result.segments.some(segment => segment.text.includes('Ok, no problem then!')));
        const history = all.find(segment => segment.text.includes('I would sign up to Tuesdays'));
        assert.ok(history, 'quoted history segment missing');
        assert.notEqual(history.visibility, 'show');
        assert.equal(history.type, 'REPLY_HISTORY');
    });
});
