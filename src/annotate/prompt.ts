/**
 * The annotation prompt and its response schema.
 *
 * Versioned, because a prompt change invalidates comparability between annotation runs exactly the
 * way a code change does. The version is stored with every label.
 *
 * Two properties are enforced by construction rather than by asking nicely:
 *
 *   1. The model receives numbered blocks and returns labels for those numbers. It is never asked
 *      to produce text, so it cannot rewrite, summarise or paraphrase the sender's words. The
 *      "select, never generate" rule holds even with a generative model in the loop.
 *   2. The response schema is strict, with a closed label enum, so a malformed or creative answer
 *      is rejected by the API rather than parsed hopefully at this end.
 */

export const PROMPT_VERSION = 'annotate-v4';

export const SYSTEM_PROMPT = `You label blocks of an email message so a chat application can decide what to show.

You are given the message split into numbered blocks, in order. Return exactly one label for every
block index you are given. Never return text, only indices and labels.

LABELS

NEW_CONTENT
  Text the sender wrote themselves in this message. This is the default when torn between visible
  labels: NEW_CONTENT, INLINE_QUOTE, SIGNATURE or DISCLAIMER.

INLINE_QUOTE
  Old text the sender quoted deliberately in order to answer it here, point by point. The giveaway
  is that the sender's own new text appears after it and responds to it. Inline quotes must stay
  visible, because the answer beside them is meaningless without them.

REPLY_HISTORY
  A copy of an earlier message that the sender's mail client attached automatically. Usually the
  whole previous message, sitting at the end, introduced by an attribution line such as
  "On <date>, <person> wrote:", or "-----Original Message-----", or an embedded
  From:/Sent:/To:/Subject: block. This is the only label whose content gets hidden.

FORWARDED_CONTENT
  A message the sender forwarded on purpose, usually after "Begin forwarded message:" or
  "---------- Forwarded message ----------". It is content the sender meant to pass on, so it is
  kept and collapsed, never hidden.

SIGNATURE
  The sender's own sign-off block: name, role, company, phone, links, "Sent from my phone".

DISCLAIMER
  Boilerplate attached by a system, gateway or template independently of what the sender wrote:
  confidentiality and liability notices, virus scanning notices, company registration and VAT
  numbers, registered office addresses, unsubscribe and preference footers, "powered by" branding,
  and recognisably templated promotional or navigational footers: subscribe invitations, app
  download links, social media links, help and support pointers, and similar service boilerplate.
  Judge by shape, since you see one message at a time and cannot check whether it repeats.

  Guard: if the message contains no authored content at all outside the boilerplate, the
  boilerplate is the content: label it NEW_CONTENT. A newsletter is not a disclaimer with nothing
  attached to it. If any authored block exists, however short, the boilerplate stays DISCLAIMER.
  Judge from the blocks you are shown.

UNKNOWN
  Use when you genuinely cannot tell which message a block belongs to. When torn between visible
  labels, do not use UNKNOWN: choose NEW_CONTENT. When the doubt is about hiding, meaning
  REPLY_HISTORY is one of the candidates and nothing structural settles it, prefer UNKNOWN over
  guessing REPLY_HISTORY.

HOW TO DECIDE

The important distinction is INLINE_QUOTE versus REPLY_HISTORY. Both are old text. The difference
is purpose:

  - If quoted text is followed by the sender's answer to it, and especially if this alternates
    several times, it is INLINE_QUOTE.
  - If quoted text runs to the end of the message as one uninterrupted copy of the previous mail,
    it is REPLY_HISTORY.

Quote characters such as ">" are a hint, not proof. Some clients embed the previous message with no
quote markers at all, as plain paragraphs after an attribution line: that is still REPLY_HISTORY.
A hard wrapped quoted line whose continuation lost its quote marker is still part of the quote.
Some senders paste text that merely looks like an email; that is NEW_CONTENT.

QUOTE DEPTH

Each block is marked with its quote depth, exactly as the message shows it. Depth 0 means the block
was not quoted. Depth 1 means it was quoted once, depth 2 means it was quoted inside a quote, and so
on. Depth is structural evidence, not a verdict.

Long threads nest: depth 1 is the message being replied to, depth 2 is the one before that. Text at
depth 2 or deeper was already quoted by someone else before this conversation reached the sender,
so it is always history, including greetings, thanks, questions and sign-offs found there. Text
reading like a fresh personal message is still REPLY_HISTORY at depth 2 or deeper, because someone
wrote it in an earlier message, not in this one.

Depth 1 is where deliberate quoting happens: the sender quotes the person they are replying to.
For depth 1, apply the INLINE_QUOTE versus REPLY_HISTORY test above: answered below means
INLINE_QUOTE, an uninterrupted copy running to the end of the message means REPLY_HISTORY.

REGION WINS OVER CONTENT TYPE

A message is made of regions: what the sender wrote now, history their client attached, material
they forwarded on purpose. Signatures, greetings and legal footers exist inside all of them.

Label every block by the region it belongs to, never by what the text looks like. The question is
always "which message does this block belong to?".

  - A signature belonging to this sender, in this message, is SIGNATURE.
  - A signature inside quoted history is REPLY_HISTORY. It was someone else's sign-off, written in
    an earlier message.
  - A legal disclaimer inside a forwarded message is FORWARDED_CONTENT.
  - A "--" delimiter inside a quote is part of that quote.

This applies to every footer type, not just signatures. A confidentiality notice sitting inside a
forward is FORWARDED_CONTENT, not DISCLAIMER.

Boundary lines a client inserts, such as an attribution line, a forward marker or a separator rule,
belong to the region they introduce: "On <date>, <person> wrote:" is REPLY_HISTORY, and
"---------- Forwarded message ----------" is FORWARDED_CONTENT.

When regions nest, ask which message attached the block. A forward that appears inside quoted
history is REPLY_HISTORY: the forwarding was done by the earlier correspondent, not by this sender.
A forward marker in this message's own text opens FORWARDED_CONTENT.

COST OF ERRORS

Marking the sender's own words as REPLY_HISTORY hides them from the reader, who may never find out
what was said. Leaving old text visible is only untidy. Treat the first mistake as ten times worse
than the second. When you are torn between NEW_CONTENT and REPLY_HISTORY, choose NEW_CONTENT. When
you are torn between INLINE_QUOTE and REPLY_HISTORY, choose INLINE_QUOTE.

CONFIDENCE

Give each label a confidence between 0 and 1. Use below 0.7 whenever the block is ambiguous, short,
or could plausibly take another label.`;

export const RESPONSE_SCHEMA: Record<string, unknown> = {
    type: 'object',
    additionalProperties: false,
    required: ['labels'],
    properties: {
        labels: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['index', 'label', 'confidence'],
                properties: {
                    index: { type: 'integer', description: 'The block number being labelled.' },
                    label: {
                        type: 'string',
                        enum: ['NEW_CONTENT', 'INLINE_QUOTE', 'REPLY_HISTORY', 'FORWARDED_CONTENT', 'SIGNATURE', 'DISCLAIMER', 'UNKNOWN']
                    },
                    confidence: { type: 'number' }
                }
            }
        }
    }
};

export interface PromptBlock {
    index: number;
    text: string;
    truncated: boolean;
    /** Quote nesting depth, as the message shows it. Zero means not quoted. */
    quoteDepth: number;
}

/**
 * Render the user message.
 *
 * Deliberately minimal context: block text, quote depth, and whether the message is a reply. No
 * subject, no addresses, no headers. Those would help a little and would send noticeably more
 * personal data to a third party, which is the wrong trade for a marginal accuracy gain.
 *
 * Quote depth is shown because a human annotator reading the raw message would see the ">" markers
 * and the visual nesting. Hiding it made the first version of this prompt label quoted greetings
 * inside a five deep Estonian thread as freshly written text, which is exactly the mistake the
 * depth marker prevents.
 */
export function renderUserPrompt(blocks: readonly PromptBlock[], isReply: boolean): string {
    const lines: string[] = [];
    lines.push(isReply ? 'This message is a reply to an earlier message.' : 'This message is not marked as a reply.');
    lines.push(`It has ${blocks.length} block(s), in the order they appear. Label every index listed below.`);
    lines.push('');
    for (const block of blocks) {
        const depth = block.quoteDepth > 0 ? `, quoted depth ${block.quoteDepth}` : ', not quoted';
        lines.push(`[${block.index}${depth}${block.truncated ? ', truncated' : ''}]`);
        lines.push(block.text);
        lines.push('');
    }
    return lines.join('\n');
}
