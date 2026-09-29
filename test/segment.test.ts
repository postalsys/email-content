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

    it('requires an attribution to be a line of its own', () => {
        // A known and deliberate limitation, recorded here because it looks like a bug and was
        // measured as one.
        //
        // When a client splits an attribution across inline elements, "On", the date and the sender
        // as separate spans, the projected text carries newlines and no anchor is found. Joining the
        // lines before matching looks like the obvious fix and is not: every pattern would then also
        // match ordinary prose that happens to start with "On" and end in "wrote:", for example
        // "On Monday I spoke to the vendor<br>and here is what they wrote:". Measured over the 452
        // message reference set, joining changed three messages, improved one, and turned two into a
        // single undifferentiated block because the anchor landed above the authored text and the
        // never-empty guard had to rescue the whole message.
        //
        // Fixing this properly needs corroboration that the block introduces a quote, not a looser
        // line test. Until then a split attribution is left unanchored, which leaves quoted history
        // visible: the safe direction.
        const split = '<div>new</div><div>On<br>Mon, 27 Jul at 3:51 AM<br>, Alice &lt;alice@example.com&gt; wrote:</div><blockquote>old</blockquote>';
        assert.equal(segmentHtmlBlocks(split, '2').blocks.find(block => block.content.startsWith('On'))?.kind, 'paragraph');

        // The one line form is detected, and must stay detected.
        const oneLine = '<div>new</div><div>On Mon, 27 Jul at 3:51 AM, Alice &lt;alice@example.com&gt; wrote:</div><blockquote>old</blockquote>';
        const attr = segmentHtmlBlocks(oneLine, '2').blocks.find(block => block.content.startsWith('On'));
        assert.equal(attr?.kind, 'reply_header');
        assert.ok(attr?.evidence.some(item => item.kind === 'reply-anchor'));
    });

    it('never treats a paragraph that merely ends in "wrote:" as an attribution', () => {
        const html = '<div>Please read the note below before Monday.<br>On Mon, 27 Jul, Alice &lt;alice@example.com&gt; wrote:</div>';
        assert.ok(segmentHtmlBlocks(html, '2').blocks.every(block => block.kind !== 'reply_header'));
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

    it('finds an embedded header block split across sibling paragraphs', () => {
        // Outlook desktop emits each From/Sent/To/Subject field as its own <p class=MsoNormal>, so
        // no single block holds the three roles the detector needs. The cross-block scan has to see
        // the chain the way the plain text line scan does.
        const outlook =
            '<div>Thanks, will do.</div><hr>' +
            '<p class=MsoNormal><b>From:</b> Bob &lt;bob@example.com&gt;</p>' +
            '<p class=MsoNormal><b>Sent:</b> Monday, July 27, 2026 9:15 AM</p>' +
            '<p class=MsoNormal><b>To:</b> Alice &lt;alice@example.com&gt;</p>' +
            '<p class=MsoNormal><b>Subject:</b> Quarterly numbers</p>' +
            '<p class=MsoNormal>Here are the numbers you asked for.</p>';
        const { blocks } = segmentHtmlBlocks(outlook, '2');
        const from = blocks.find(block => block.content.startsWith('From:'));
        assert.equal(from?.kind, 'quoted_header_block');
        assert.ok(from?.evidence.some(evidence => evidence.id === 'reply:quoted_header_block'));
        const subject = blocks.find(block => block.content.startsWith('Subject:'));
        assert.equal(subject?.kind, 'quoted_header_block');
        // The body paragraph after the chain is not part of the header block.
        const body = blocks.find(block => block.content.startsWith('Here are'));
        assert.equal(body?.kind, 'paragraph');
    });

    it('does not mistake prose mentioning header fields for an embedded header block', () => {
        // Same guard as text-mentions-headers.eml, across blocks: the From value carries no
        // address and the Sent value nothing date shaped, so no roles accumulate.
        const prose =
            '<p>When you report the problem, include:</p>' +
            '<p>From: the address that sent it</p>' +
            '<p>Sent: roughly when it happened</p>' +
            '<p>Subject: the exact subject line</p>';
        const { blocks } = segmentHtmlBlocks(prose, '2');
        assert.ok(blocks.every(block => block.kind !== 'quoted_header_block'));
    });

    it('attaches attribution evidence when the attribution leads a larger block', () => {
        // The kind must stay paragraph: the block also holds the material after the attribution,
        // and an anchor-kinded block is treated as client boilerplate by the adoption rule.
        const mixed = '<div>my answer</div><div>On Mon, 27 Jul 2026 at 09:15, Bob &lt;bob@example.com&gt; wrote:<br>Pasted old text.<br>More old text.</div>';
        const { blocks } = segmentHtmlBlocks(mixed, '2');
        const block = blocks.find(item => item.content.startsWith('On Mon'));
        assert.equal(block?.kind, 'paragraph');
        assert.ok(block?.evidence.some(evidence => evidence.kind === 'reply-anchor'));
        // A block whose first line is prose gets nothing, even when a later line looks like an
        // attribution: nothing above an anchor inside the same block may be swept as history.
        const prose = '<div>Please read the note below.<br>On Mon, 27 Jul 2026 at 09:15, Bob &lt;bob@example.com&gt; wrote:</div>';
        const other = segmentHtmlBlocks(prose, '2').blocks[0];
        assert.ok(!other?.evidence.some(evidence => evidence.kind === 'reply-anchor'));
    });

    it('gives hr and underscore rules weak separator evidence', () => {
        const { blocks } = segmentHtmlBlocks('<div>text</div><hr><p>__________</p>', '2');
        const hr = blocks.find(block => block.kind === 'separator' && block.content === '');
        assert.ok(hr?.evidence.some(evidence => evidence.kind === 'separator' && evidence.strength < 0.85));
        const underscore = blocks.find(block => block.content.includes('_____'));
        assert.equal(underscore?.kind, 'separator');
        assert.ok(underscore?.evidence.some(evidence => evidence.kind === 'separator' && evidence.strength < 0.85));
    });

    it('computes position from projected text rather than markup offsets', () => {
        // A large <style> block used to push every visible block's position towards 1, which
        // blinded the position gated signature and disclaimer detectors on heavy markup mail.
        const styled = '<style>' + 'x'.repeat(5000) + '</style><div>hello there friend</div><div>Best regards</div>';
        const { blocks } = segmentHtmlBlocks(styled, '2');
        const first = blocks.find(block => block.content === 'hello there friend');
        assert.equal(first?.features.position, 0);
        const last = blocks.find(block => block.content === 'Best regards');
        assert.ok(last !== undefined && last.features.position < 0.75);
    });
});

describe('quote depth of plain text blocks', () => {
    it('does not let a trailing empty quoted line pull an answer into the quote', () => {
        // Inline replies from Roundcube and SnappyMail: an answer, a blank line, then "> " before
        // the next quoted paragraph. The answer came back as quoted history before.
        const text = 'On x wrote:\n> \n> Could you check the invoice.\n\nDone, the invoice is correct.\n\n> \n> Also the address.\n\nUpdated it.\n';
        const blocks = segmentTextBlocks(text, 'TEXT').blocks.filter(block => !block.features.isAllBlank);
        const depthOf = (needle: string) => blocks.find(block => block.content.includes(needle))?.features.quoteDepth;
        assert.equal(depthOf('Done, the invoice'), 0);
        assert.equal(depthOf('Updated it'), 0);
        assert.equal(depthOf('Also the address'), 1);
    });
});
