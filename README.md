# email-content

Extract the conversationally relevant content from arbitrary email messages.

Given a raw RFC 5322 message, the library separates what the sender actually wrote from the reply
history their mail client embedded automatically, and returns both, classified, with a confidence
and a machine readable reason for every decision.

It is built for a chat style application that uses ordinary email as its transport, where the other
participants use whatever client they like and do not know their mail is being read as chat.

## The rule everything follows from

Hiding a sentence the sender wrote is a silent data loss the reader may never notice. Showing a
paragraph of redundant quoted history is a cosmetic annoyance. The first is treated as at least ten
times worse than the second, and every design decision follows from that.

In practice that means:

- Content is only ever hidden when something structural says it is history: an attribution line, a
  client quote container, or a match against a message that demonstrably existed earlier. Quote
  characters alone are never enough.
- Nothing is deleted. Hidden segments are returned in full next to the visible ones, and the
  original message is always available. "Hidden" is a rendering hint.
- Ambiguous content is labelled `UNKNOWN` and stays visible.
- No generative model touches the sender's words. The pipeline selects and classifies existing
  spans; it never rewrites, summarises or paraphrases.

## Install and build

Requires Node 24 or later, for the built in `node:sqlite` and native TypeScript execution.

```bash
npm install
npm run build
npm test
```

## Library

The primary entry point takes content you have already parsed. Most callers hold
`{ text, html, subject }` from mailparser, postal-mime, EmailEngine or an IMAP client, and never
have a raw message to hand.

```js
const { analyze } = require('email-content');

const result = await analyze({
    text: plainTextBody,   // optional
    html: htmlBody,        // optional
    subject: 'Re: Deploy window',     // optional
    from: 'Bob <bob@example.net>',    // optional, improves signature detection
    inReplyTo: '<parent@example.com>' // optional
});

for (const segment of result.segments) {
    console.log(segment.type, segment.confidence, segment.text);
}
```

Either body may be omitted. When both are present the HTML drives the classification, because that
is where quote structure survives, and the plain text is used as a cross check.

If you do have a raw RFC 5322 message, `extract()` parses it and runs the same pipeline:

```js
const { extract } = require('email-content');
const result = await extract(fs.readFileSync('message.eml'));
```

### Result

```jsonc
{
  "segments": [                  // render these
    {
      "type": "NEW_CONTENT",
      "text": "No, wait until Monday.",
      "html": "<div>No, wait until Monday.</div>",
      "confidence": 0.95,
      "visibility": "show",      // show | collapse | hide
      "reasons": ["new_content_default", "html_primary_representation"],
      "source": {
        "mimePart": "1.2",       // IMAP style part path
        "representation": "html",
        "blockIndex": 0,
        "start": 0,              // character offsets into the canonical part text
        "end": 79,
        "domPath": "/0/1"
      }
    }
  ],
  "hiddenSegments": [ /* same shape, retained in full */ ],
  "overallConfidence": 0.97,
  "warnings": [],
  "originalAvailable": true,
  "primaryRepresentation": "html",
  "extractorVersion": "0.1.0",
  "historyUsed": false,
  "isReply": true
}
```

Segment types: `NEW_CONTENT`, `INLINE_QUOTE`, `REPLY_HISTORY`, `FORWARDED_CONTENT`, `SIGNATURE`,
`DISCLAIMER`, `UNKNOWN`.

Render `segments`. `hiddenSegments` holds what the extractor is confident is embedded reply
history, in full, so a client can offer to reveal it. Nothing is ever discarded.

### Thread history

If earlier messages in the thread are available, pass them. A block whose text provably existed
before this message was written is history by definition, which is far stronger evidence than any
markup heuristic. Measured on the reference set, supplying history cuts the share of reply history
left visible from 70.9 percent to 60.1 percent, with no loss of new content.

```js
const result = await analyze(
    { text, html },
    { history: [{ text: parentText, html: parentHtml }] }   // nearest ancestor first
);
```

History is always optional. Extraction works without it and never depends on it.

`analyze()` and `extract()` never throw. Malformed input produces a result whose body is a single
visible `UNKNOWN` segment plus a warning.

## Command line

```bash
# Classify one message
email-content extract message.eml
email-content extract message.eml --json
email-content extract message.eml --explain      # per block evidence, features and reasons

# Label blocks with an LLM instead of a human (opt in, sends content to OpenAI)
email-content annotate --sample 60 --model gpt-5.4-mini
email-content disagreements --direction expensive

# Scan a corpus of .eml files into a local SQLite database
email-content corpus scan /path/to/eml-folder
email-content corpus scan /path/to/eml-folder --sample 2000 --seed phase1
email-content corpus scan /path/to/eml-folder --concurrency 14

# Report on it
email-content corpus stats --out docs/corpus-report.md
email-content corpus stats --json
email-content corpus threads                     # in-corpus thread parent resolution

# Throughput and catastrophic error rates
email-content benchmark --sample 3000
```

## What it gets right

The two cases that define the problem:

```text
> Should we deploy this today?

No, wait until Monday.

> Should I notify the customer?

Yes, please.
```

Both questions are `INLINE_QUOTE` and stay visible: they are the context the answers depend on.

```text
Yes, Monday works.

On Friday, Alice wrote:
> Can we meet on Monday?
```

The trailing quote is `REPLY_HISTORY` and is hidden, because an attribution line anchors it and no
authored content follows.

Beyond that, the deterministic baseline handles Gmail, Outlook desktop, Outlook Web, Apple Mail,
Thunderbird, Proton, Yahoo and Zimbra quote structures; forwarded messages with a comment above
them; bottom posted replies, which are collapsed rather than hidden because the reader is more
likely to need the context; `format=flowed`; legacy charsets; and messages whose plain text part
has lost its quote markers entirely, which is now the majority case for recent mail.

It also, deliberately, does not fire on ordinary prose that merely looks like email structure. Text
containing `From:` and `Subject:` lines is only treated as an embedded header block when the values
look like header values, so a support message explaining which headers to include stays visible.

## Accuracy

Measured against a 452 message stratified reference set annotated by gpt-5.6-sol under the
conventions in [docs/annotation-guide.md](docs/annotation-guide.md), with thread history enabled.

The reference is not ground truth, but it is close. Two strong models (gpt-5.5 and gpt-5.6-sol)
given identical input agree with each other on **98.6 percent** of blocks, and **99.2 percent** once
a single spam message of machine generated word salad is excluded. That is the practical ceiling.

| property | measured |
| --- | ---: |
| block label agreement | 79.8% |
| new content characters retained | **100.0%** |
| new content blocks retained | **100.0%** |
| hidden content genuinely history | 99.4% |
| reply history correctly hidden | 60.3% |
| messages losing all new content | 0 |
| messages losing an inline answer | 0 |

Not one character the reference considers newly written is hidden, across 452 messages and 206,368
characters of new content.

Per label F1: REPLY_HISTORY 90.4, FORWARDED_CONTENT 81.5, NEW_CONTENT 70.1, SIGNATURE 48.8,
INLINE_QUOTE 35.9, DISCLAIMER 30.1.

With thread history available the numbers are materially better than the aggregate suggests, and a
chat application always has the thread it is rendering:

| | messages | agreement | history hidden |
| --- | ---: | ---: | ---: |
| history available | 305 | 85.9% | 64.7% |
| history unavailable | 147 | 64.9% | 37.0% |

## Limitations

- **It still errs towards showing too much.** Around 40 percent of reply history remains displayed.
  That is the cheap direction of error and it is deliberate, but it is the largest remaining gap.
- **Disclaimer recall is 18.1 percent** at 87.8 percent precision. The generic notification footer
  shapes are covered; what remains is per-sender templates, which hand written rules cannot reach
  without overfitting to one vendor. This is the clearest case for a learned model.
- **Signature recall is 36.7 percent** at 73.1 percent precision. Two independent signals are
  required, such as a closing greeting plus contact details, or the sender's own name plus either.
- **INLINE_QUOTE precision is 27.2 percent.** Blocks wrongly called inline quote stay visible, so
  this costs tidiness, not content.
- **Outlook remains the weakest client**, around 62 percent against 92 percent for Gmail and Apple
  Mail.
- **No learned model.** This is the deterministic baseline. The labelled data, a settled labelling
  convention and the evaluation harness all exist to train one.

## Privacy

The corpus this was built against is private email, and the project is built accordingly:

- Nothing contacts the network by default. The runtime dependency tree is three packages and none
  opens a socket. The one exception is `email-content annotate`, an opt in command that sends block
  text to an LLM API; see [docs/annotation.md](docs/annotation.md).
- Source `.eml` files are opened read only and never modified.
- No message body, subject or address is written to logs, to the terminal, or to the corpus
  database. Subjects and addresses are stored as salted hashes; sender domains are kept because
  stratified sampling needs them.
- The corpus database is derived from private mail and is not anonymised. It is gitignored. See
  [docs/threat-model.md](docs/threat-model.md) for exactly what it can still reveal.

## Documentation

| document | contents |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | Pipeline stages, dependency choices and why, safety invariants |
| [docs/implementation-plan.md](docs/implementation-plan.md) | Phases, decisions taken, open questions |
| [docs/threat-model.md](docs/threat-model.md) | What is stored, what it reveals, hostile content handling |
| [docs/corpus-report.md](docs/corpus-report.md) | Statistics over the working corpus (generated, gitignored) |
| [docs/benchmark.md](docs/benchmark.md) | Throughput, memory, and where the time goes |
| [docs/annotation.md](docs/annotation.md) | Using an LLM as annotator: method, results, limitations |

## Project layout

```
src/mime/        MIME parsing, charset decoding, normalised message model
src/canonical/   Plain text and HTML canonicalisation
src/segment/     Block segmentation and feature extraction
src/detect/      Detectors, with pattern sets as JSON data
src/classify/    Rules, reconciliation, confidence
src/corpus/      Scanner, worker pool, SQLite store, statistics
src/cli/         Command line entry points
test/            Tests and hand written fixtures
```

Pattern sets in `src/detect/patterns/` can be overridden at runtime by pointing
`EMAIL_CONTENT_PATTERNS` at a directory containing replacements.

## Status

Working and measured: the MIME parser, canonicalisation, block segmentation, the deterministic rule
baseline, thread history matching, the corpus scanner over 320k messages, LLM assisted annotation,
the evaluation harness, the CLI, and 123 tests including fuzzing and performance bounds.

Not built: the local annotation app for adjudicating disagreements, and a learned sequence model.
Both are described in [docs/implementation-plan.md](docs/implementation-plan.md).
