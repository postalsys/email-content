import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { segmentHtmlBlocks } from '../src/segment/html-blocks';
import { segmentTextBlocks } from '../src/segment/text-blocks';

describe('text segmentation', () => {
    it('tiles the canonical text exactly', () => {
        const samples = [
            'one\n\ntwo\n\nthree',
            '> quoted\n\nreply\n\n> more quoted\n\nanswer',
            'On Mon, Jan 1, 2025 at 09:15 Bob wrote:\n> question\n\nanswer\n\n-- \nSignature',
            'no trailing newline',
            'trailing newline\n',
            '\n\n\n',
            '',
            'a\n> b\n>> c\n> b\na'
        ];
        for (const sample of samples) {
            const { canonical, blocks } = segmentTextBlocks(sample, 'TEXT');
            const rebuilt = blocks.map(block => block.text).join('');
            assert.equal(rebuilt, canonical.text, `tiling failed for ${JSON.stringify(sample)}`);
            // Blocks must be contiguous and ordered.
            let cursor = 0;
            for (const block of blocks) {
                assert.equal(block.start, cursor, `gap before block ${block.index}`);
                cursor = block.end;
            }
            if (blocks.length) {
                assert.equal(cursor, canonical.text.length, 'blocks must reach the end');
            }
        }
    });

    it('splits at quote depth changes', () => {
        const { blocks } = segmentTextBlocks('plain\n> depth one\n>> depth two\n> depth one again', 'TEXT');
        const depths = blocks.map(block => block.features.quoteDepth);
        assert.deepEqual(depths, [0, 1, 2, 1]);
    });

    it('isolates an attribution line as its own block', () => {
        const { blocks } = segmentTextBlocks('answer\n\nOn Mon, Jan 1, 2025 at 09:15 Bob wrote:\n> question', 'TEXT');
        const header = blocks.find(block => block.kind === 'reply_header');
        assert.ok(header, 'expected a reply_header block');
        assert.match(header.content, /^On Mon/);
        assert.ok(header.evidence.some(evidence => evidence.kind === 'reply-anchor'));
    });

    it('detects an embedded header block but not a single header-like line', () => {
        const withBlock = segmentTextBlocks('From: a@b.com\nSent: Monday, 13 January 2025 09:15\nTo: c@d.com\nSubject: Hello\n\nbody', 'TEXT');
        assert.ok(withBlock.blocks.some(block => block.kind === 'quoted_header_block'));

        const prose = segmentTextBlocks('Please include the following:\n\nFrom: the sending address\n\nThanks', 'TEXT');
        assert.equal(
            prose.blocks.some(block => block.kind === 'quoted_header_block'),
            false
        );
    });
});

describe('html segmentation', () => {
    it('tiles the source exactly', () => {
        const samples = [
            '<div>hello</div>',
            '<div>a<br>b<p>c</p></div><blockquote class="gmail_quote">old</blockquote>',
            '<html><body><div>x</div></body></html>',
            '<div>unclosed<p>tags',
            '<table><tr><td>cell one</td><td>cell two</td></tr></table>',
            '',
            'bare text with no tags'
        ];
        for (const sample of samples) {
            const { blocks, source } = segmentHtmlBlocks(sample, '2');
            const rebuilt = blocks.map(block => block.text).join('');
            assert.equal(rebuilt, source, `tiling failed for ${JSON.stringify(sample)}`);
            let cursor = 0;
            for (const block of blocks) {
                assert.equal(block.start, cursor, `gap before block ${block.index}`);
                cursor = block.end;
            }
            if (blocks.length) {
                assert.equal(cursor, source.length);
            }
        }
    });

    it('records blockquote ancestry rather than collapsing containers', () => {
        const { blocks } = segmentHtmlBlocks(
            '<div>new</div><blockquote class="gmail_quote"><div>old</div><blockquote><div>older</div></blockquote></blockquote>',
            '2'
        );
        const byText = new Map(blocks.map(block => [block.content, block]));
        assert.equal(byText.get('new')?.features.blockquoteDepth, 0);
        assert.equal(byText.get('old')?.features.blockquoteDepth, 1);
        assert.equal(byText.get('older')?.features.blockquoteDepth, 2);
    });

    it('recognises client quote containers', () => {
        const { blocks } = segmentHtmlBlocks('<div>new</div><div class="gmail_quote"><div>old</div></div>', '2');
        const old = blocks.find(block => block.content === 'old');
        assert.ok(old?.evidence.some(evidence => evidence.id === 'html:gmail_quote' && evidence.kind === 'quote-container'));
    });

    it('sees through the Outlook Web class prefix on nested quotes', () => {
        // Outlook Web rewrites quoted markup's class names with an x_ prefix, so a quoted Gmail
        // reply arrives as x_gmail_quote. Detectors must still fire one level deeper.
        const { blocks } = segmentHtmlBlocks('<div>new</div><div class="x_gmail_quote"><div>old</div></div>', '2');
        const old = blocks.find(block => block.content === 'old');
        assert.ok(old?.evidence.some(evidence => evidence.id === 'html:gmail_quote'));
    });

    it('marks attribution containers as reply headers', () => {
        const { blocks } = segmentHtmlBlocks('<div>new</div><div class="gmail_attr">On Mon, Bob wrote:</div><blockquote>old</blockquote>', '2');
        const attr = blocks.find(block => block.content.startsWith('On Mon'));
        assert.equal(attr?.kind, 'reply_header');
    });

    it('converts br to newlines and decodes entities', () => {
        const { blocks } = segmentHtmlBlocks('<div>a &amp; b<br>second</div>', '2');
        assert.equal(blocks[0]?.content, 'a & b\nsecond');
    });

    it('ignores script and style content', () => {
        const { blocks } = segmentHtmlBlocks('<style>.x{color:red}</style><div>visible</div><script>alert(1)</script>', '2');
        const text = blocks.map(block => block.content).join(' ');
        assert.ok(!text.includes('color'));
        assert.ok(!text.includes('alert'));
        assert.ok(text.includes('visible'));
    });

    it('never throws on malformed markup', () => {
        const nasty = [
            '<div><div><div>'.repeat(200),
            '<blockquote>'.repeat(100) + 'deep' + '</blockquote>'.repeat(50),
            '<td>orphan cell</td>',
            '<!-- comment only -->',
            '<div class=>broken attr</div>',
            '<a href="'.repeat(50)
        ];
        for (const html of nasty) {
            const { blocks } = segmentHtmlBlocks(html, '2');
            assert.ok(Array.isArray(blocks));
        }
    });
});
