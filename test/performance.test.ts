import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../src/analyze';
import { isPathologicalHtml } from '../src/segment/html-blocks';
import { computeFeatures } from '../src/segment/features';

/**
 * Bounds, not benchmarks.
 *
 * Each case below took seconds before it was fixed, on input a library taking arbitrary email
 * content will eventually be handed. The limits are deliberately loose, roughly fifty times the
 * measured time, so the tests fail on a return of quadratic behaviour rather than on a slow
 * machine.
 */
const BUDGET_MS = 1500;

async function timed(fn: () => Promise<unknown>): Promise<number> {
    const started = Date.now();
    await fn();
    return Date.now() - started;
}

describe('performance bounds', () => {
    it('handles a long unbroken token without catastrophic backtracking', async () => {
        // A pasted log line, a base64 blob or a minified payload. The email feature regex used to
        // backtrack quadratically here, taking 21 seconds on 200 KB.
        const elapsed = await timed(() => analyze({ text: 'x'.repeat(200000) }));
        assert.ok(elapsed < BUDGET_MS, `took ${elapsed}ms`);
    });

    it('handles a base64 style blob', async () => {
        const elapsed = await timed(() => analyze({ text: 'QUJD'.repeat(50000) }));
        assert.ok(elapsed < BUDGET_MS, `took ${elapsed}ms`);
    });

    it('handles a one megabyte plain text body', async () => {
        const elapsed = await timed(() => analyze({ text: 'lorem ipsum dolor sit amet '.repeat(40000) }));
        assert.ok(elapsed < BUDGET_MS, `took ${elapsed}ms`);
    });

    it('handles a one megabyte HTML body', async () => {
        const elapsed = await timed(() => analyze({ html: '<p>lorem ipsum dolor sit amet</p>'.repeat(30000) }));
        assert.ok(elapsed < BUDGET_MS, `took ${elapsed}ms`);
    });

    it('refuses to spend seconds parsing wildly unbalanced markup', async () => {
        // Only 25 KB, but it took six and a half seconds inside the HTML parser.
        //
        // The input carries authored text on purpose. This case used to be `'<div>'.repeat(5000)`,
        // which contains no text at all, and asserted only that a warning was present. It could
        // therefore never have caught the defect it was meant to cover: the fallback returned the
        // warning and dropped the content, and the test passed.
        const html = `${'<div>'.repeat(5000)}<p>SENTINEL</p>`;
        assert.equal(isPathologicalHtml(html), true);

        const elapsed = await timed(async () => {
            const result = await analyze({ html });
            assert.ok(result.warnings.some(warning => warning.code === 'html_parse_error'));
            // Degraded, but the content really is returned rather than dropped.
            assert.ok(result.segments.some(segment => segment.text.includes('SENTINEL')));
        });
        assert.ok(elapsed < BUDGET_MS, `took ${elapsed}ms`);
    });

    it('does not treat ordinary nested markup as pathological', () => {
        assert.equal(isPathologicalHtml('<div><p>hello</p></div>'), false);
        // A deeply quoted thread nests, and must still be parsed properly.
        assert.equal(isPathologicalHtml('<blockquote><div>x</div></blockquote>'.repeat(40)), false);
        assert.equal(isPathologicalHtml(`${'<div>'.repeat(100)}x${'</div>'.repeat(100)}`), false);
    });

    it('computes features in bounded time on a large block', () => {
        const started = Date.now();
        computeFeatures('x'.repeat(500000), { index: 0, total: 1, start: 0, totalChars: 500000, quoteDepth: 0 });
        const elapsed = Date.now() - started;
        assert.ok(elapsed < BUDGET_MS, `took ${elapsed}ms`);
    });

    it('extracts a realistic message in a few milliseconds', async () => {
        const html =
            '<div dir="ltr">Thanks, that works for me.</div><div class="gmail_quote">' +
            '<div class="gmail_attr">On Mon, Jan 13, 2025 at 9:15 AM Bob wrote:</div>' +
            `<blockquote class="gmail_quote">${'<div>Some quoted history line.</div>'.repeat(50)}</blockquote></div>`;
        const elapsed = await timed(() => analyze({ html, subject: 'Re: Scheduling' }));
        assert.ok(elapsed < 200, `took ${elapsed}ms`);
    });
});
