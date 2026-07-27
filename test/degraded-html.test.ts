/**
 * The malformed HTML fallback.
 *
 * Reproduces the first of two content loss defects found against 0.0.5:
 *
 *     analyze({ html: '<div>'.repeat(501) + '<p>SENTINEL</p>' })
 *       -> segments = 0, hiddenSegments = 0, warnings = [html_parse_error]
 *
 * Total content loss whose only trace was a warning. The fallback built a block whose `content` was
 * the empty string, and `toSegments()` drops segments with no text.
 *
 * Every assertion here is about user visible outcome. `originalAvailable: true` and the presence of
 * a warning were both true throughout the defect, so neither proves anything about retention.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../src/analyze';
import { extract } from '../src/index';
import { isPathologicalHtml } from '../src/segment/html-blocks';
import { readFixture } from './helpers';
import { mimePartOf } from '../src/types';

/** Markup unbalanced past the parse threshold, wrapping the given body. */
function pathological(body: string, unclosed = 501): string {
    return '<div>'.repeat(unclosed) + body;
}

function visibleText(result: { segments: { text: string }[] }): string {
    return result.segments.map(segment => segment.text).join('\n');
}

describe('degraded HTML stays visible', () => {
    it('returns authored text from a body it cannot parse', async () => {
        const result = await analyze({ html: pathological('<p>SENTINEL the deploy is Monday.</p>') });

        assert.equal(result.segments.length, 1);
        assert.equal(result.segments[0]?.type, 'UNKNOWN');
        assert.equal(result.segments[0]?.visibility, 'show');
        assert.ok(visibleText(result).includes('SENTINEL the deploy is Monday.'));
        assert.equal(result.hiddenSegments.length, 0);
        assert.ok(result.warnings.some(warning => warning.code === 'html_parse_error'));
    });

    it('finds text at the beginning, middle and end of malformed markup', async () => {
        const cases = {
            beginning: `<p>SENTINEL_ONE</p>${'<div>'.repeat(600)}`,
            middle: `${'<div>'.repeat(300)}<p>SENTINEL_TWO</p>${'<div>'.repeat(300)}`,
            end: `${'<div>'.repeat(600)}<p>SENTINEL_THREE</p>`
        };
        for (const [where, html] of Object.entries(cases)) {
            const result = await analyze({ html });
            assert.ok(visibleText(result).includes(`SENTINEL_${where === 'beginning' ? 'ONE' : where === 'middle' ? 'TWO' : 'THREE'}`), where);
        }
    });

    it('never leaks script or style text out of a degraded body', async () => {
        const result = await analyze({
            html: pathological('<script>var tracked = 1;</script><style>.a{color:red}</style>')
        });

        assert.equal(result.segments.length, 0);
        assert.equal(result.hiddenSegments.length, 0);
        assert.ok(result.warnings.some(warning => warning.code === 'html_parse_error'));
        assert.ok(result.warnings.some(warning => warning.code === 'no_visible_body_text'));
        // Nothing to show is not the same as complete certainty about a body we could not read.
        assert.notEqual(result.overallConfidence, 1);
        assert.equal(JSON.stringify(result).includes('tracked'), false);
        assert.equal(JSON.stringify(result).includes('color:red'), false);
    });

    it('does not classify a degraded body as reply history', async () => {
        // The projection contains an attribution line and quote markers. A degraded parse has lost
        // the structure those rules depend on, so it must not be allowed to act on them.
        const result = await analyze({
            html: pathological('<p>On Mon, 13 Jan 2025 at 09:15, Bob wrote:</p><blockquote>SENTINEL earlier message text</blockquote>')
        });

        assert.equal(result.hiddenSegments.length, 0);
        assert.ok(result.segments.every(segment => segment.type === 'UNKNOWN'));
        assert.ok(visibleText(result).includes('SENTINEL earlier message text'));
    });

    it('reports half confidence and the degraded reason', async () => {
        const result = await analyze({ html: pathological('<p>SENTINEL</p>') });
        assert.equal(result.overallConfidence, 0.5);
        assert.equal(result.segments[0]?.confidence, 0.5);
        assert.ok(result.segments[0]?.reasons.includes('degraded_to_unknown'));
    });

    it('covers the whole HTML part with its source offsets', async () => {
        const html = pathological('<p>SENTINEL</p>');
        const result = await analyze({ html, htmlPartId: '1.2' });
        const source = result.segments[0]?.source;

        assert.equal(source?.start, 0);
        assert.equal(source?.end, html.length);
        assert.equal(source?.kind, 'mime-part');
        assert.equal(source && mimePartOf(source), '1.2');
        assert.equal(source?.kind === 'mime-part' && source.representation, 'html');
    });

    it('never displaces a text part that segmented successfully', async () => {
        // The regression guard for the companion fix. Giving the degraded block real content makes
        // it look substantial, so without the rule it wins primary selection by default and folds a
        // perfectly classified plain text body into one UNKNOWN blob.
        const text = ['Yes, Monday works.', '', 'On Mon, 13 Jan 2025 at 09:15, Bob wrote:', '> Can we meet on Monday?', '> Let me know.'].join('\n');
        const result = await analyze({ text, html: pathological('<p>Yes, Monday works.</p>'), subject: 'Re: Scheduling' });

        assert.equal(result.primaryRepresentation, 'text');
        assert.ok(result.warnings.some(warning => warning.code === 'html_parse_error'));
        assert.ok(visibleText(result).includes('Yes, Monday works.'));

        const all = [...result.segments, ...result.hiddenSegments];
        const quoted = all.find(segment => segment.text.includes('Can we meet on Monday?'));
        assert.ok(quoted, 'the quoted region disappeared');
        assert.equal(quoted.type, 'REPLY_HISTORY');
        assert.notEqual(quoted.visibility, 'show');
        assert.ok(
            result.segments.every(segment => segment.type !== 'UNKNOWN'),
            'the good text representation was folded into an UNKNOWN blob'
        );
    });

    it('still wins when the text part is only a stub', async () => {
        const result = await analyze({ text: 'x', html: pathological('<p>SENTINEL the real body lives here.</p>') });

        assert.equal(result.primaryRepresentation, 'html');
        assert.ok(visibleText(result).includes('SENTINEL the real body lives here.'));
        assert.ok(result.segments.every(segment => segment.type === 'UNKNOWN'));
    });

    it('holds at every unclosed tag count around the threshold', async () => {
        for (const unclosed of [499, 500, 501, 5000]) {
            const html = pathological('<p>SENTINEL</p>', unclosed);
            const result = await analyze({ html });
            assert.ok(visibleText(result).includes('SENTINEL'), `${unclosed} unclosed tags lost the text`);
            assert.equal(isPathologicalHtml(html), unclosed > 500, `${unclosed} classified wrongly`);
        }
    });

    it('extracts the committed pathological fixture end to end', async () => {
        const result = await extract(readFixture('pathological-html-visible-text.eml'));

        assert.ok(visibleText(result).includes('AUTHORED_SENTINEL the deploy is on Monday.'));
        assert.equal(
            result.segments.every(segment => segment.type === 'UNKNOWN'),
            true
        );
        assert.ok(result.warnings.some(warning => warning.code === 'html_parse_error'));
        assert.equal(result.hiddenSegments.length, 0);
    });

    it('stays inside the performance budget with text present', async () => {
        // The old performance test fed `'<div>'.repeat(5000)`, which contains no text at all, so it
        // could not have caught this defect even if it had asserted on content.
        const html = pathological('<p>SENTINEL</p>', 5000);
        const started = Date.now();
        const result = await analyze({ html });
        const elapsed = Date.now() - started;

        assert.ok(elapsed < 1500, `took ${elapsed}ms`);
        assert.ok(visibleText(result).includes('SENTINEL'));
    });
});
