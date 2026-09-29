/**
 * Shapes found by auditing the extractor against the gpt-6-sol corpus reference, each of which hid
 * text the sender wrote. The corpus is private, so every case here is a synthetic reconstruction of
 * the structure, not a copy of a message.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../src/analyze';
import { detectQuotedHeaderBlock } from '../src/detect/reply-header';
import { evaluate, type LabelledBlock } from '../src/eval/metrics';

function visibleText(result: Awaited<ReturnType<typeof analyze>>): string {
    return result.segments.map(segment => segment.text).join('\n');
}

function hiddenText(result: Awaited<ReturnType<typeof analyze>>): string {
    return result.hiddenSegments.map(segment => segment.text).join('\n');
}

describe('corpus regressions', () => {
    it('keeps a reply visible when Outlook glued it to the separator in one run', async () => {
        const html =
            '<html><body><p>Hi both,</p><font size=2>Same here, I forgot to copy Tom earlier.<br>Sorry, Anna<br><br>' +
            '-----Original Message-----<br>From: Tom Example [mailto:tom@example.com]<br>Sent: Sat 13.12.2008 19:04<br>' +
            'To: Anna Example<br>Subject: Re: Quick one<br><br>Mornings do not work for me, I can come at two.<br><br>Tom<br><br>' +
            'On 13 Dec 2008, at 11:41, Anna Example wrote:<br><br>&gt; Could we meet on Monday morning?<br>&gt; Anna</font></body></html>';
        const result = await analyze({ html, subject: 'RE: Quick one' });
        assert.match(visibleText(result), /Same here, I forgot to copy Tom earlier/);
        assert.doesNotMatch(hiddenText(result), /Same here/);
    });

    it('still hides a clean Outlook header block that starts its own run', async () => {
        const html =
            '<html><body><p>Thanks, that works.</p><p>Anna</p>' +
            '<p>-----Original Message-----<br>From: Tom Example [mailto:tom@example.com]<br>Sent: Sat 13.12.2008 19:04<br>' +
            'To: Anna Example<br>Subject: Re: Quick one</p><p>Mornings do not work for me.</p></body></html>';
        const result = await analyze({ html, subject: 'RE: Quick one' });
        assert.match(visibleText(result), /Thanks, that works/);
        assert.match(hiddenText(result), /Mornings do not work for me/);
    });

    it('does not treat a pasted raw header as a reply anchor', () => {
        const lines = [
            'From: Sender Name <sender@example.com>',
            'To: Receiver <receiver@example.com>',
            'Date: Tue, 6 Sep 2016 19:38:34 +0300',
            'Message-ID: <1@localhost>',
            'Subject: Hello'
        ];
        assert.equal(detectQuotedHeaderBlock(lines), null);
        // The same fields without the transport line are a client header block.
        assert.notEqual(detectQuotedHeaderBlock(lines.filter(line => !line.startsWith('Message-ID'))), null);
    });

    it('does not treat a code object literal as a reply anchor', () => {
        const lines = ['var options = {', 'from: "test@example.com",', 'to: "other@example.com",', 'date: "2020-10-14",', 'subject: "Testing " + now,', '};'];
        assert.equal(detectQuotedHeaderBlock(lines), null);
    });

    it('keeps the tutorial after a pasted sample header visible', async () => {
        const text = [
            'The server returns the header of the message:',
            '',
            'From: Sender Name <sender@example.com>',
            'To: Receiver <receiver@example.com>',
            'Date: Tue, 6 Sep 2016 19:38:34 +0300',
            'Message-ID: <12345@localhost>',
            'Subject: Message subject',
            '',
            'Now you have enough information to create a new entry in the message list.'
        ].join('\n');
        const result = await analyze({ text, subject: 'Re: IMAP question' });
        assert.match(visibleText(result), /enough information to create a new entry/);
        assert.equal(result.hiddenSegments.length, 0);
    });

    for (const representation of ['text', 'html'] as const) {
        it(`keeps answers typed into the quote visible when the sender says so (${representation})`, async () => {
            const content =
                representation === 'text'
                    ? {
                          text: [
                              'Hi, my answers are inline.',
                              '',
                              'On Mon, Jan 13, 2025 at 9:15 AM Bob <bob@example.net> wrote:',
                              '> Which port do you use?',
                              'Port 993 with TLS.',
                              '> And the timeout?',
                              'Thirty seconds.'
                          ].join('\n')
                      }
                    : {
                          html:
                              '<div>Hi, my answers are inline.</div><div class="gmail_quote"><div class="gmail_attr">On Mon, Jan 13, 2025 at 9:15 AM Bob &lt;bob@example.net&gt; wrote:</div>' +
                              '<blockquote class="gmail_quote"><div>Which port do you use?</div><div><font color="red">Port 993 with TLS.</font></div>' +
                              '<div>And the timeout?</div><div><font color="red">Thirty seconds.</font></div></blockquote></div>'
                      };
            const result = await analyze({ ...content, subject: 'Re: Settings' });
            assert.match(visibleText(result), /Port 993 with TLS/);
            assert.match(visibleText(result), /Thirty seconds/);
        });
    }

    it('does not hide the disclaimer of a forwarded thread', async () => {
        const html =
            '<div>See below.</div><div class="gmail_quote"><div class="gmail_attr">---------- Forwarded message ---------<br>From: Museum &lt;info@example.org&gt;<br>' +
            'Date: Wed, Sep 6, 2023 at 10:00 AM<br>Subject: Reminder<br>To: Parents &lt;parents@example.org&gt;<br></div>' +
            '<div>Reminder: the meeting is at seven.</div>' +
            '<p>From: Museum<br>Sent: Wednesday, 6 September 2023 09:00<br>To: Teachers<br>Subject: Reminder</p>' +
            '<p>The first reminder text.</p>' +
            '<p>This e-mail may contain confidential information. If you are not the intended recipient, please notify the sender and delete it.</p></div>';
        const result = await analyze({ html, subject: 'Fwd: Reminder' });
        assert.doesNotMatch(hiddenText(result), /confidential information/);
    });

    it('drops a doctype the parser left in the body text', async () => {
        const result = await analyze({ html: '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 3.2//EN"><html><body><p>Hello there</p></body></html>' });
        assert.doesNotMatch(visibleText(result), /DOCTYPE/);
        assert.match(visibleText(result), /Hello there/);
    });
});

describe('evaluation of messages with several parts', () => {
    const block = (overrides: Partial<LabelledBlock>): LabelledBlock => ({
        path: 'a.eml',
        blockIndex: 0,
        charCount: 20,
        reference: 'REPLY_HISTORY',
        predicted: 'REPLY_HISTORY',
        hidden: true,
        ...overrides
    });

    it('does not call a message empty when another part is on screen', () => {
        assert.equal(evaluate([block({})]).catastrophic.emptyExtraction, 1);
        assert.equal(evaluate([block({ messageHasVisibleText: true })]).catastrophic.emptyExtraction, 0);
        assert.equal(evaluate([block({ messageHasVisibleText: false })]).catastrophic.emptyExtraction, 1);
    });
});
