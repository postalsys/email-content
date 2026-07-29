# Annotation guide

How to label blocks of an email message. This is the reference for both human annotators and the
LLM annotation prompt, and the two must agree: `src/annotate/prompt.ts` encodes these rules, and
`PROMPT_VERSION` changes whenever this document changes in a way that could alter a label.

## Why this document exists

Before it, two capable models given identical input agreed on 97.6 percent of blocks. That sounds
high until you look at where they differed: roughly half of every disagreement was about a single
label, `DISCLAIMER`, and the same text was labelled three different ways in different messages.

```
<the same standing promotional footer, appearing in three different notifications>
   gpt-5.5 = DISCLAIMER      gpt-5.6-sol = NEW_CONTENT
   gpt-5.5 = NEW_CONTENT     gpt-5.6-sol = DISCLAIMER
   gpt-5.5 = DISCLAIMER      gpt-5.6-sol = REPLY_HISTORY
```

Neither annotator was wrong. The label had no agreed meaning. A classifier trained on that learns
the coin flip, and a rule tuned against it is fitting noise. So the conventions below are decisions,
not discoveries: they exist to be applied consistently, and consistency matters more than which way
each one went.

## The two rules that settle most disputes

### Rule 1: region wins over content type

**Label every block by the region it belongs to, not by what the text looks like.**

A message is made of regions: what the sender wrote now, history their client attached, material
they forwarded on purpose. Footers, greetings and signatures exist inside all of them.

- A signature belonging to **this** sender, in **this** message, is `SIGNATURE`.
- A signature inside quoted history is `REPLY_HISTORY`. It was someone else's sign-off, in an
  earlier message.
- A legal disclaimer inside a forwarded message is `FORWARDED_CONTENT`.
- A `--` delimiter inside a quote is part of that quote.

The test is "which message does this block belong to?", never "what kind of text is this?".

Boundary lines a client inserts follow the same test by convention: an attribution line, a forward
marker or a separator rule belongs to the region it introduces. "On Friday, Alice wrote:" is
`REPLY_HISTORY` and "---------- Forwarded message ----------" is `FORWARDED_CONTENT`, even though
this sender's client generated both lines in this message.

When regions nest, ask which message attached the block. A forward that appears inside quoted
history is `REPLY_HISTORY`: the forwarding was done by the earlier correspondent, not by this
sender. A forward marker in this message's own text opens `FORWARDED_CONTENT`.

This matters because the extractor hides regions, not sentences. A footer inside history is hidden
along with the history around it, and labelling it `DISCLAIMER` would split a region that is
structurally one thing.

### Rule 2: DISCLAIMER is any machine appended boilerplate, with one guard

`DISCLAIMER` covers text attached by a system, gateway or template **independently of what the
sender wrote**:

- legal and confidentiality notices
- liability and virus scanning notices
- company registration, VAT numbers, registered office addresses
- unsubscribe and preference footers
- "powered by" and provider branding
- recognisably templated promotional or navigational footers: subscribe invitations, app download
  links, social media links, help and support pointers, and similar service boilerplate

The last item is judged by shape, deliberately. An annotator sees one message at a time and cannot
check whether a footer repeats across notifications, so "repeats on every message" is not a usable
test; "reads as the service's template rather than this message's content" is.

The reasoning is the reader's, not the lawyer's: in a chat interface all of it is the same thing,
boilerplate that repeats on every message and is never the point of this one.

**The guard: if the message contains no authored content at all outside the boilerplate, the
boilerplate is `NEW_CONTENT`.** A newsletter is not a disclaimer with nothing attached to it. When
there is no other content, the boilerplate _is_ the content. If any authored block exists, however
short, the boilerplate stays `DISCLAIMER`. Judge from the blocks shown; a truncated message is
judged from what is visible. This mirrors the extractor's own invariant that a message must never
come out as nothing but its footer.

## The labels

### NEW_CONTENT

Text the sender wrote themselves in this message. **The default when torn between visible labels**,
meaning `NEW_CONTENT`, `INLINE_QUOTE`, `SIGNATURE` or `DISCLAIMER`. Doubt about hiding is
`UNKNOWN`'s territory; see below.

Includes text that merely resembles email structure: a support message explaining which headers to
include, a pasted excerpt the sender is discussing, a quoted line the sender typed by hand.

### INLINE_QUOTE

Old text the sender quoted deliberately in order to answer it here, point by point.

The test is that the sender's own new text appears **after it and responds to it**, usually
alternating several times. Inline quotes stay visible: the answer beside them is meaningless without
the question.

```text
> Should we deploy this today?          <- INLINE_QUOTE
No, wait until Monday.                  <- NEW_CONTENT
> Should I notify the customer?         <- INLINE_QUOTE
Yes, please.                            <- NEW_CONTENT
```

Quoting happens at depth 1: you quote the person you are replying to. Text at depth 2 or deeper was
already quoted by someone else before this conversation reached the sender, so it is history, not
something being answered here.

### REPLY_HISTORY

A copy of an earlier message that the sender's client attached automatically. **The only label whose
content gets hidden.**

Usually the whole previous message at the end, introduced by an attribution line
("On <date>, <person> wrote:"), a separator ("-----Original Message-----"), or an embedded
`From:/Sent:/To:/Subject:` block.

Quote characters are a hint, not proof, in both directions:

- Outlook embeds the previous message as plain paragraphs with **no** quote markers at all. Still
  `REPLY_HISTORY`.
- A hard wrapped quoted line whose continuation lost its `>` prefix is still part of the quote.

```text
Yes, Monday works.                      <- NEW_CONTENT

On Friday, Alice wrote:                 <- REPLY_HISTORY (the attribution line too)
> Can we meet on Monday?                <- REPLY_HISTORY
```

### FORWARDED_CONTENT

A message the sender forwarded on purpose, usually after "Begin forwarded message:" or
"---------- Forwarded message ----------".

Content the sender meant to pass on, so it is kept and collapsed, never hidden. A comment written
above the forward is `NEW_CONTENT`.

Note the ordering against Rule 1: a forward marker wins over an embedded header block, because a
forwarded message repeats the original `From:/Date:/Subject:` fields and would otherwise read as
reply history.

### SIGNATURE

The sender's own sign-off in this message: name, role, company, phone, links, postal address,
"Sent from my phone".

A signature usually opens with a closing greeting ("Best regards", "Parimat", "Mit freundlichen
Grüßen") and runs to the end of the authored region. Per Rule 1, a signature inside quoted history is
`REPLY_HISTORY`.

### DISCLAIMER

As defined in Rule 2 above.

### UNKNOWN

Use when you genuinely cannot tell **which message a block belongs to**. When torn between visible
labels, do not use `UNKNOWN`: choose `NEW_CONTENT`. When the doubt is about hiding, meaning
`REPLY_HISTORY` is one of the candidates and nothing structural settles it, **prefer `UNKNOWN` over
guessing `REPLY_HISTORY`**, because `REPLY_HISTORY` is the only label that hides content.

## The cost of errors is not symmetric

Marking the sender's own words as `REPLY_HISTORY` hides them from a reader who may never learn what
was said. Leaving old text visible is untidy. **Treat the first mistake as ten times worse than the
second.**

When torn:

| between                                             | choose       |
| --------------------------------------------------- | ------------ |
| NEW_CONTENT and REPLY_HISTORY                       | NEW_CONTENT  |
| INLINE_QUOTE and REPLY_HISTORY                      | INLINE_QUOTE |
| two visible labels                                  | NEW_CONTENT  |
| cannot tell at all which message a block belongs to | UNKNOWN      |

## Worked examples

**A signature inside a quote.** Rule 1: it belongs to the quoted message.

```text
Thanks, that works.                     <- NEW_CONTENT
Andris                                  <- SIGNATURE (this sender, this message)

On Tue, Bob wrote:                      <- REPLY_HISTORY
> Shall we meet Monday?                 <- REPLY_HISTORY
> --                                    <- REPLY_HISTORY (not SIGNATURE: it is Bob's, inside history)
> Bob Smith, Acme Ltd                   <- REPLY_HISTORY
```

**A legal notice inside a forward.** Rule 1 again.

```text
Please look at this.                    <- NEW_CONTENT
---------- Forwarded message ---------- <- FORWARDED_CONTENT
From: billing@vendor.example            <- FORWARDED_CONTENT
Invoice attached.                       <- FORWARDED_CONTENT
This email is confidential and ...      <- FORWARDED_CONTENT (not DISCLAIMER)
```

**A promotional footer on a notification.** Rule 2, broad reading.

```text
Your build #421 passed.                 <- NEW_CONTENT
Want to know about upcoming build
environment updates? Subscribe to ...   <- DISCLAIMER (standing boilerplate)
Acme Cloud Ltd, 8 Example Street       <- DISCLAIMER (registered address)
```

**A newsletter that is entirely boilerplate.** Rule 2's guard.

```text
Happy Holidays from a notification service! From
Dec 19th to Jan 4th the team is
taking a break ...                      <- NEW_CONTENT (it is the whole message)
```

**Prose that looks like structure.** Not history: the sender typed it.

```text
When you report the problem, include:   <- NEW_CONTENT
From: the address that sent it          <- NEW_CONTENT
Subject: the exact subject line         <- NEW_CONTENT
```

## Versioning

Changing this document changes labels. Bump `PROMPT_VERSION` in `src/annotate/prompt.ts` and record
the version with every annotation, so runs made under different conventions are never silently
compared. Annotations already store `prompt_version` for this reason.

| version       | change                                                                                                                                                                                                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `annotate-v1` | first prompt, no quote depth shown to the annotator                                                                                                                                                                                                                                  |
| `annotate-v2` | quote depth shown; signatures inside quotes are history                                                                                                                                                                                                                              |
| `annotate-v3` | this guide: Rule 1 generalised to all footer types, Rule 2 defines DISCLAIMER breadth and its whole-message guard                                                                                                                                                                    |
| `annotate-v4` | depth 1 follows the INLINE_QUOTE test instead of being declared history, resolving a contradiction between the prompt and this guide; boundary markers and nested forwards settled under Rule 1; promotional footers judged by shape; whole-message guard and UNKNOWN made decidable |
