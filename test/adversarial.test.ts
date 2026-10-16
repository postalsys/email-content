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
import { isPathologicalHtml, scanMarkup, segmentHtmlBlocks } from '../src/segment/html-blocks';
import { NodeType, type Node, parse } from 'node-html-parser';
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

    it('keeps the originator value check cheap on a From: line of brackets', () => {
        // `<[^>]*@[^>]*>` was cubic on a value of `<` characters followed by `@` characters: 1.5
        // seconds for 3,000 characters, minutes for 20 KB. The value is capped like an attribution
        // line, and the pattern itself no longer rescans the suffix once per opener.
        const block = (count: number, length: number) => {
            const openers = Math.floor(length / 3);
            const from = `From: ${'<'.repeat(openers)}${'@'.repeat(length - openers)}`;
            return [...Array.from({ length: count }, () => from), 'Sent: Monday, 13 January 2025 09:15', 'Subject: hi'];
        };
        const long = measure(() => detectQuotedHeaderBlock(block(1, 20000)));
        assert.ok(long < 50, `a 20,000 character value took ${long.toFixed(1)}ms`);
        assertLinear(
            'bracket originator values',
            [250, 500, 1000, 2000],
            size => block(size, 300).join('\n'),
            input => {
                detectQuotedHeaderBlock(input.split('\n'));
            }
        );
    });

    it('still anchors on every address form in an embedded From: line', () => {
        const rest = ['Sent: Monday, 13 January 2025 09:15', 'Subject: hi'];
        for (const from of ['From: Bob <bob@example.com>', 'From: bob@example.com', 'From: Bob [bob@example.com]', 'From: Bob [mailto:bob@example.com]']) {
            assert.ok(detectQuotedHeaderBlock([from, ...rest]), from);
        }
        assert.equal(detectQuotedHeaderBlock(['From: the address that sent the message', ...rest]), null);
        // A value past the cap earns no role, so the block does not anchor on it.
        assert.equal(detectQuotedHeaderBlock([`From: Bob <bob@example.com>${' x'.repeat(200)}`, ...rest]), null);
    });

    it('refuses to parse a document the parser would leave hundreds of elements open in', async () => {
        // The guard counted a fixed list of block tags, so unclosed inline and sectioning tags
        // reached node-html-parser, whose cleanup of the elements left open is cubic: 5,000
        // unclosed <b> took 26 seconds and 10,000 took 206.
        for (const unit of ['<b>x', '<i>', '<a href="#">x', '<section>x', '<center>x', '<font>x', '<Br>']) {
            assert.equal(isPathologicalHtml(`<p>hi</p>${unit.repeat(5000)}`), true, unit);
        }
        // Elements the parser closes implicitly are not left open, whatever their number.
        for (const unit of ['<p>para', '<li>item', '<td>cell', '<dt>term', '<h1>x', '<h2>a<h2>b', '<br>', '<img src="x">']) {
            assert.equal(isPathologicalHtml(unit.repeat(5000)), false, unit);
        }
        assert.equal(isPathologicalHtml('<b>x</b>'.repeat(5000)), false);
        assert.equal(isPathologicalHtml('<div><b>x</div>'.repeat(5000)), false);
        assert.equal(isPathologicalHtml('<span><p>x</span>'.repeat(5000)), false);
        assert.equal(isPathologicalHtml(`<pre>${'<b>'.repeat(5000)}</pre>`), false);
        assert.equal(isPathologicalHtml(`<!--${'<b>'.repeat(5000)}-->`), false);

        const html = `<p>SENTINEL</p>${'<b>x'.repeat(5000)}`;
        const started = Date.now();
        const result = await analyze({ html });
        assert.ok(Date.now() - started < BUDGET_MS);
        assert.ok(result.warnings.some(warning => warning.code === 'html_parse_error'));
        assert.ok(result.segments.some(segment => segment.text.includes('SENTINEL')));
    });

    it('counts the elements an ignored end tag leaves open', () => {
        // The parser ignores an end tag that does not name the open element, so a count of start
        // tags against end tags is defeated by padding with end tags that close nothing: each of
        // these copies nets at most one tag while leaving one to three open.
        for (const unit of ['<a><b><c>y</a></b>', '<b>x</i>', '<td><font>x</td>', '<b>x</B>', '<b title="x></b>">', '<a>x</a!>', '<ul><li><b>x</ul>']) {
            assert.equal(isPathologicalHtml(unit.repeat(1000)), true, unit);
        }
    });

    it('counts open elements exactly as the parser does', () => {
        // Checked against the tree node-html-parser builds when asked to leave open elements in
        // place: for markup whose nesting comes only from what is left open, its element depth
        // is the count the guard has to predict.
        const parserDepth = (html: string): number => {
            let deepest = 0;
            const walk = (node: Node, depth: number) => {
                if (depth > deepest) {
                    deepest = depth;
                }
                for (const child of node.childNodes) {
                    if (child.nodeType === NodeType.ELEMENT_NODE) {
                        walk(child, depth + 1);
                    }
                }
            };
            walk(parse(html, { parseNoneClosedTags: true, comment: false }), 0);
            return deepest;
        };
        const unbalanced = [
            '<b>x',
            '<a><b><c>y</a></b>',
            '<b>x</i>',
            '<td><font>x</td>',
            '<b>x</B>',
            '<b title="x></b>">',
            '<a>x</a!>',
            '<tr>',
            '<Br>',
            '<ul><li><b>x</ul>'
        ];
        for (const unit of unbalanced) {
            const html = unit.repeat(20);
            assert.equal(scanMarkup(html).unclosedTags, parserDepth(html), unit);
        }
        for (const unit of [
            '<p>para',
            '<li>item',
            '<td>cell',
            '<h2>a<h2>b',
            '<div><b>x</div>',
            '<span><p>x</span>',
            '<b>x</b>',
            `<pre>${'<b>'.repeat(5)}</pre>`,
            '<!--<b>-->',
            '<br/>',
            '<div/>'
        ]) {
            const html = unit.repeat(20);
            assert.ok(scanMarkup(html).unclosedTags <= 1, `${unit}: ${scanMarkup(html).unclosedTags} left open`);
        }
    });

    it('scans markup for open elements in a single pass', () => {
        for (const [label, unit] of [
            ['unclosed tags', '<b>x'],
            ['unterminated quotes', '<a "'],
            ['unterminated comments', '<!--'],
            ['unterminated raw text elements', '<pre>x']
        ] as const) {
            assertLinear(
                label,
                [8000, 16000, 32000, 64000],
                size => unit.repeat(size),
                input => {
                    isPathologicalHtml(input);
                }
            );
        }
    });

    it('projects leaked markup in a <pre> text node in linear time', () => {
        // `[^>]*` and `[^\]]*` rescanned the rest of the node once per opener: 6.7 seconds per
        // pattern on 240 KB of either unit.
        for (const [label, unit] of [
            ['unclosed tags in a pre', '<a '],
            ['unclosed conditional comments in a pre', '<![']
        ] as const) {
            assertLinear(
                label,
                [10000, 20000, 40000, 80000],
                size => `<pre>${unit.repeat(size)}</pre>`,
                input => {
                    segmentHtmlBlocks(input, '1');
                }
            );
        }
        // The markup a <pre> hides from the parser still projects as the reader sees it.
        const result = segmentHtmlBlocks('<pre><![if !supportLists]><table><tr><td>cell</td></tr></table><![endif]></pre>', '1');
        assert.equal(
            result.blocks
                .map(block => block.content)
                .join('')
                .trim(),
            'cell'
        );
    });
});
