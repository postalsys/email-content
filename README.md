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

## Install

```bash
npm install @postalsys/email-content
```

**Runtime requirements.** The library is plain CommonJS JavaScript with no compiled dependencies,
and runs on **Node 20 or later**. Nothing in the dependency tree is native and none of it is ESM
only. There are exactly three direct runtime dependencies, each present for correctness rather than
convenience:

| dependency           | why                                                                                                                                                                                                                    |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@zone-eu/mailsplit` | The only local MIME parser that walks the tree non-destructively, emitting raw header and body bytes in document order with IMAP style part numbers. That is what makes every segment traceable to exact source bytes. |
| `libmime`            | Header encoded-word decoding, charset handling and `format=flowed` unfolding.                                                                                                                                          |
| `node-html-parser`   | A forgiving HTML parser that exposes a source `range` on every node, which is what lets an HTML block point back at the offsets it came from.                                                                          |

The corpus tooling shipped in the same package (`corpus`, `annotate`, `evaluate`, `audit`, `benchmark`)
needs **Node 22.5 or later**, because it uses the built in `node:sqlite`. That module is loaded
lazily, so it never touches a host that only calls `analyze()` or `extract()`. Running those
commands on an older runtime reports the requirement rather than failing obscurely.

### Bundling with @yao-pkg/pkg

Verified working as a single file binary on macOS arm64, Linux x64 and Windows x64, built against
Node 24 and each producing byte identical classifications.

**No pkg configuration is required.** The detector pattern files are read at runtime through
`path.join(__dirname, 'patterns')`, a form pkg detects statically and bundles automatically. Adding
them to `pkg.assets` also works but is unnecessary.

If the patterns ever fail to bundle, the library throws at load rather than degrading silently,
because the alternative is a binary that recognises no reply history at all and reports no error.

## Build from source

Requires Node 24 for the development workflow.

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
const { analyze } = require('@postalsys/email-content');

const result = await analyze({
    text: plainTextBody, // optional
    html: htmlBody, // optional
    subject: 'Re: Deploy window', // optional
    from: 'Bob <bob@example.net>', // optional, improves signature detection
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
const { extract } = require('@postalsys/email-content');
const result = await extract(fs.readFileSync('message.eml'));
```

### Result

Both entry points return the same shape. `extract()` adds nothing except optional MIME diagnostics.

```jsonc
{
    "segments": [
        // render these
        {
            "type": "NEW_CONTENT",
            "text": "No, wait until Monday.",
            "html": "<div>No, wait until Monday.</div>", // UNTRUSTED, see the security section
            "confidence": 0.95,
            "visibility": "show", // show | collapse | hide
            "reasons": ["new_content_default", "html_primary_representation"],
            "source": {
                "kind": "mime-part", // "mime-part" | "raw-message"
                "mimePart": "1.2", // IMAP style part path
                "representation": "html",
                "blockIndex": 0, // position within this part, not within the whole message
                "start": 0, // offsets: canonical text for "text", the HTML source for "html"
                "end": 79,
                "domPath": "/0/1"
            }
        }
    ],
    "hiddenSegments": [/* same shape, retained in full */],
    "overallConfidence": 0.97,
    "warnings": [],
    "originalAvailable": true,
    "primaryRepresentation": "html",
    "extractorVersion": "<current package version>",
    "historyUsed": false,
    "isReply": true,
    "canonicalText": {} // part id -> canonical plain text, for "text" segment offsets
}
```

Segment types: `NEW_CONTENT`, `INLINE_QUOTE`, `REPLY_HISTORY`, `FORWARDED_CONTENT`, `SIGNATURE`,
`DISCLAIMER`, `UNKNOWN`.

Render `segments`. `hiddenSegments` holds what the extractor is confident is embedded reply
history, in full, so a client can offer to reveal it. Nothing is ever discarded.

A few fields are easy to misread:

- **`originalAvailable`** is always `true`, and it is a statement about behaviour, not about this
  object. The library never mutates or consumes your source, so the original is always still
  recoverable. It is not embedded in the result: **you** must retain it.
- **`hiddenSegments`** holds only segments whose `visibility` is `hide`. Segments marked `collapse`
  stay in `segments`, because a collapsed segment is still rendered, just folded.
- **`primaryRepresentation`** names what drove the classification of the primary section. It is not
  an inventory of every MIME part represented: a message with several body sections can produce
  segments from more than one part.
- **`source.kind`** discriminates the two provenance cases. `mime-part` carries the part path,
  representation and block index. `raw-message` carries only a byte range, and is used when MIME
  parsing failed outright and there is no part structure to point at.
- **`isReply: false`** means "not known to be a reply". When parsing fails there are no threading
  headers to read, and the result carries a `reply_status_unknown` warning to say so.
- **`source.start` / `source.end`** on a plain text segment index the _canonical_ part text, not
  the string you passed in: line endings become LF, a leading BOM and NUL characters are removed,
  and the text is NFC normalised. Slice `result.canonicalText[source.mimePart]`, which holds that
  string for every plain text part the segments came from. HTML segments index the HTML source
  unchanged, and a degraded fail-soft segment indexes the input as given. To canonicalise a body
  yourself, without running the extractor, use the exported `canonicalisePlainText(text)`, which
  returns exactly the same string.

```js
const result = await analyze({ text });
for (const segment of result.segments) {
    const { mimePart, representation, start, end } = segment.source;
    if (representation === 'text') {
        const slice = result.canonicalText[mimePart].slice(start, end);
    }
}
```

### Thread history

If earlier messages in the thread are available, pass them. A block whose text provably existed
before this message was written is history by definition, which is far stronger evidence than any
markup heuristic. Measured on the reference set, supplying history cuts the share of reply history
left visible from 70.9 percent to 60.1 percent, with no loss of new content.

```js
const result = await analyze(
    { text, html },
    { history: [{ text: parentText, html: parentHtml }] } // nearest ancestor first
);
```

History is always optional. Extraction works without it and never depends on it.

It earns its place twice over. A block whose text is found in an earlier message is history by
provenance rather than by markup, which both raises confidence on regions the structure already
recognised and catches the ones it cannot see at all: clients that paste the previous message as
ordinary paragraphs, with no quote prefix, no blockquote and no attribution line. Nothing in such a
message says it is quoting, so only the thread can tell. That case is collapsed rather than hidden,
because a match proves the text existed before and proves nothing about whether the reader still
needs it.

If you are reading a mailbox you already have what this needs: resolve the parent by `In-Reply-To`
or `References`, usually from Sent, and pass it. Callers that resolve threads themselves can build
the documents once with `buildHistoryDocument()` and pass `historyDocuments` instead, which skips
re-parsing the ancestor on every message.

`analyze()` and `extract()` never throw for malformed **message input**. A body that cannot be
segmented is returned as a single visible `UNKNOWN` segment plus a warning.

## Security: rendering HTML

`segment.html` is **untrusted, attacker controlled markup**, copied verbatim out of the message. It
can contain event handler attributes, remote images and stylesheets that report the fact and time of
reading, forms, frames, unsafe SVG, `javascript:` and `data:` URLs, and tracking links.

Classification is not sanitisation. This library decides whether a span of the message is new
content, reply history or a footer. It says nothing about whether that span is safe to put into a
browser, and it deliberately does not rewrite source markup, because rewriting would destroy the
byte ranges every segment points at.

No sanitiser ships here, and that is deliberate too. Sanitisation is context dependent and
security sensitive, and a weak one bundled into an extraction library would be worse than none: it
would look like protection without being it.

The order matters:

```text
raw message
  -> MIME parse and classification      (this library)
  -> choose visible segments            (your product policy)
  -> sanitise each untrusted HTML segment   (a maintained sanitiser)
  -> render under a restrictive CSP
```

- **Never** assign `segment.html` to `innerHTML`, `dangerouslySetInnerHTML` or any equivalent.
- Sanitise **after** segmentation and immediately before rendering. Sanitising before extraction
  strips the Gmail and Outlook quote containers the detectors need, and costs accuracy.
- Block remote images, stylesheets, fonts, media, frames and forms. Loading them leaks that the mail
  was opened, from where, and when.
- Strip event attributes, and dangerous URL schemes such as `javascript:` and `vbscript:`. Decide a
  deliberate policy for `data:` URLs rather than allowing them by default.
- Rewrite or proxy links according to your product's policy.
- Use a Content Security Policy as defence in depth, not as the sanitiser. CSP does not neutralise
  every dangerous construct or navigation.
- Do not load remote resources while sanitising or previewing, on the server either.

Desktop mail clients and browser renderers have different threat models. Document which environment
your product supports rather than assuming one set of rules covers both. Before rolling extraction
out, prove in an integration test in the consuming application that active attributes, hostile URLs,
forms and tracking images are all neutralised and that no remote request is made.

## Running this on untrusted mail

Inbound mail is attacker controlled, and this library does its work synchronously on the caller's
event loop. Every algorithm here is bounded or linear in its input, and the adversarial cases that
were not are covered by scaling tests in `test/adversarial.test.ts`. That is a floor, not a
guarantee: the library cannot interrupt its own synchronous work, so a future bug in a detector or
in a dependency is a stalled event loop for whoever called it.

A service that renders mail from strangers should therefore put a boundary around extraction rather
than rely on the library alone:

- **Cap the raw message before `extract()`.** Reject oversized payloads at the transport if you can,
  before buffering. `maxMessageBytes` is a backstop for what still gets through, not a substitute.
- **Cap the bodies before `analyze()`**, with `maxTotalDecodedTextBytes` and `maxContentChars`.
  Per part limits do not bound total work: many legal sized parts add up.
- **Run untrusted parsing in a worker thread or subprocess.** That is the only way to enforce a wall
  clock or memory limit, because terminating the worker is the only mechanism that can interrupt a
  synchronous call.
- **Enforce a wall clock timeout by terminating that worker**, not by racing a promise. A promise
  race resolves while the blocked loop keeps burning.
- **Bound concurrency**, so a burst of large messages cannot occupy every worker at once.
- **Keep the original message.** On timeout, memory pressure or any degraded result, fall back to
  rendering it. Extraction output is a rendering artifact that can always be recomputed; the raw
  message is the system of record.

A syntactically small input can still exploit an algorithmic bug, so size limits do not remove the
need for isolation.

### Options and limits

```js
const result = await extract(raw, {
    parse: {
        maxMessageBytes: 64 * 1024 * 1024, // whole raw message
        maxTotalDecodedTextBytes: 16 * 1024 * 1024, // decoded text across every part
        maxTextPartBytes: 1024 * 1024, // decoded text per part
        maxParts: 500,
        maxHeadSize: 1024 * 1024
    },
    confidence: { collapseThreshold: 0.7 } // partial: the rest keep their defaults
});

const result2 = await analyze({ text, html }, { maxContentChars: 8_000_000 });
```

Recommended ceilings, documented rather than enforced, because the host knows its own memory budget
and a startup crash on a value you chose deliberately protects nobody: `maxTextPartBytes` around
32 MiB, `maxParts` around 10,000, `maxHeadSize` around 16 MiB.

**Malformed input and invalid configuration are handled differently, on purpose.**

|                       | behaviour                                                    |
| --------------------- | ------------------------------------------------------------ |
| Malformed **message** | Degrades. Never throws. Returns what it can, plus a warning. |
| Invalid **option**    | Throws `ConfigurationError` before any processing.           |

A bad message is the sender's doing and the caller cannot fix it. A bad option is the programmer's
own mistake, it will repeat on every message, and returning a plausible looking degraded result for
it would hide an operational fault behind what reads like ordinary output. `ConfigurationError`
carries a stable `code` and the `option` name, and never the offending value, message content or
credentials, so it is safe to log.

Values are rejected, never clamped: clamping makes the pipeline behave differently from what you
asked for, silently, forever. `NaN`, infinities, negatives, zero where a positive is required,
fractions where an integer is required, and an inverted `collapseThreshold`/`hideThreshold` pair all
throw. A large but finite value is accepted.

Exceeding an **input** limit is not a configuration error. It emits `input_limit_exceeded` naming
the option that fired, returns in full whatever the limit did allow through, and never throws.

Validation runs on every call, so it is kept cheap and deterministic. It is not amortised: if you
need it paid once, hold the validated options yourself with `validateParseOptions()` and
`validateConfidenceConfig()`.

The command line validates the same way and exits with status 2, naming the option, rather than
letting `--concurrency -1` or `--timeout -1` reach a worker pool or a SQL query.

## Command line

```bash
# Classify one message
email-content extract message.eml
email-content extract message.eml --json
email-content extract message.eml --explain      # per block evidence, features and reasons

# Label blocks with an LLM instead of a human (opt in, sends content to OpenAI or TypeSafe)
email-content annotate --sample 60 --model gpt-5.4-mini
email-content annotate --provider typesafe --paths data/relabel-paths.txt
email-content agreement --candidate jev-1.13.0@annotate-ts-v1 --reference gpt-5.6-sol@annotate-v4,gpt-5.5@annotate-v4
email-content disagreements --direction expensive
email-content disagreements --model jev-1.13.0 --sort margin    # most ambiguous first

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
given identical input agree with each other on **97.2 percent** of blocks under the current
conventions, and **98.5 percent** once three messages are excluded in which a single message-level
judgment flips every block at once. 392 of the 452 messages agree on every single block. That is
the practical ceiling; see [docs/annotation.md](docs/annotation.md).

| property                         |   measured |
| -------------------------------- | ---------: |
| block label agreement            |      84.2% |
| new content characters retained  | **100.0%** |
| new content blocks retained      | **100.0%** |
| hidden content genuinely history |      99.9% |
| reply history correctly hidden   |      60.4% |
| messages losing all new content  |          0 |
| messages losing an inline answer |          0 |

Not one character the reference considers newly written is hidden, across 197,671 characters of
new content. 426 of the 452 messages are scored: in the other 26 the annotated part is the
alternative the extractor did not show, so there is nothing to compare against.

Forwards are recognised by their subject, because several clients introduce a forward with the
same separator they use for reply history; the forwarded message is kept as collapsed forwarded
content rather than hidden. The reference annotator never sees the subject and calls about 340
blocks in 33 such forwards history, which is most of the FORWARDED_CONTENT precision gap below.

Per label F1: REPLY_HISTORY 93.8, NEW_CONTENT 80.2, INLINE_QUOTE 52.5, SIGNATURE 52.9,
FORWARDED_CONTENT 43.9, DISCLAIMER 35.3.

Recall is the number to read here, not F1. Precision is measured against a reference that labels
every block, while the extractor deliberately leaves anything it cannot anchor visible, so an honest
"I am not sure" scores as a miss. `REPLY_HISTORY` recall is 89.9 percent. `NEW_CONTENT` label recall
is 93.8 percent, and the difference from the 100 percent character retention is entirely blocks the
extractor labels `UNKNOWN`, which are always shown: an honest "not sure" costs label agreement,
never content.

With thread history available the numbers are materially better than the aggregate suggests, and a
chat application always has the thread it is rendering:

|                     | blocks | agreement | history hidden |
| ------------------- | -----: | --------: | -------------: |
| history available   |  6,270 |     92.8% |          67.2% |
| history unavailable |  1,991 |     57.2% |          14.7% |

## Limitations

- **It still errs towards showing too much.** Around 40 percent of reply history remains displayed.
  That is the cheap direction of error and it is deliberate, but it is the largest remaining gap.
- **Disclaimer recall is 22.2 percent** at 85.4 percent precision. The generic notification footer
  shapes are covered; what remains is per-sender templates, which hand written rules cannot reach
  without overfitting to one vendor. This is the clearest case for a learned model.
- **Signature recall is 39.6 percent** at 75.6 percent precision. Two independent signals are
  required, such as a closing greeting plus contact details, or the sender's own name plus either.
- **INLINE_QUOTE precision is 27.9 percent.** Blocks wrongly called inline quote stay visible, so
  this costs tidiness, not content. Under the settled depth-1 convention this is now a genuine
  disagreement with the reference, not a labelling artefact: the extractor treats any quoted run
  with authored text after it as answered, and the reference frequently reads the same run as a
  trailing copy.
- **Outlook desktop remains the weakest recognised client**, around 70 percent against 92 percent
  for Gmail and Apple Mail; unrecognised clients sit at 68 percent. Outlook Web reached 84 percent
  once its embedded header blocks were detected across sibling paragraphs.
- **No learned model.** This is the deterministic baseline. The labelled data, a settled labelling
  convention and the evaluation harness all exist to train one.

## Privacy

The corpus this was built against is private email, and the project is built accordingly:

- Nothing contacts the network by default. The runtime dependency tree is three packages and none
  opens a socket. The one exception is `email-content annotate`, an opt in command that sends block
  text to an LLM API (OpenAI, or TypeSafe with `--provider typesafe`); see
  [docs/annotation.md](docs/annotation.md).
- Source `.eml` files are opened read only and never modified.
- No message body, subject or address is written to logs, to the terminal, or to the corpus
  database by any command except `disagreements`, which prints block text on purpose so a human can
  adjudicate it. Subjects and addresses are stored as salted hashes; sender domains are kept because
  stratified sampling needs them.
- "Processed locally" is not the same as "can never leave the machine". `annotate` sends block text
  to an LLM API when you opt into it, file paths and diagnostics appear in your own terminal and
  shell history, and the corpus database sits on whatever disk and backup you point it at.
- The corpus database is derived from private mail and is not anonymised. It is gitignored. See
  [docs/threat-model.md](docs/threat-model.md) for exactly what it can still reveal.

## Documentation

| document                                                                                         | contents                                                                                    |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| [docs/architecture.md](docs/architecture.md)                                                     | Pipeline stages, dependency choices and why, safety invariants                              |
| [docs/adr-001-document-global-classification.md](docs/adr-001-document-global-classification.md) | Why multipart sections are classified as one sequence, and the two index spaces that follow |
| [docs/implementation-plan.md](docs/implementation-plan.md)                                       | Phases, decisions taken, open questions                                                     |
| [docs/threat-model.md](docs/threat-model.md)                                                     | What is stored, what it reveals, hostile content handling                                   |
| [docs/corpus-report.md](docs/corpus-report.md)                                                   | Statistics over the working corpus (generated, gitignored)                                  |
| [docs/benchmark.md](docs/benchmark.md)                                                           | Throughput, memory, and where the time goes                                                 |
| [docs/annotation.md](docs/annotation.md)                                                         | Using an LLM as annotator: method, results, limitations                                     |

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

### Overriding pattern sets

The detector patterns ship as JSON files in `src/detect/patterns/` (`reply-headers.json`,
`forward-headers.json`, `quoted-headers.json`, `signatures.json`, `disclaimers.json`,
`html-clients.json`). Setting the `EMAIL_CONTENT_PATTERNS` environment variable to a directory
replaces them at runtime for the whole process. The variable is read once, when the package is
first required.

- Files are matched by name, one file at a time. A file present in the override directory replaces
  the bundled file of the same name completely; it is not merged with it. A file missing from the
  directory falls back to the bundled one, so an override can replace a single set.
- An override file that exists but is not valid JSON throws `PatternAssetError`, as does a load
  that ends with no usable pattern at all.
- A pattern that fails to compile is skipped and its id recorded, rather than failing the load.

Because the variable is unprefixed and changes what gets hidden, a host application should log
which source is in effect at startup:

```js
const { patternSource } = require('@postalsys/email-content');

const source = patternSource();
// { override: null, overriddenFiles: [] } for the bundled sets, or
// { override: '/etc/patterns', overriddenFiles: ['signatures.json'] }
if (source.override) {
    console.warn(`email-content patterns overridden from ${source.override}: ${source.overriddenFiles.join(', ') || 'no matching files'}`);
}
```

## Status

Working and measured: the MIME parser, canonicalisation, block segmentation, the deterministic rule
baseline, section aware multipart body planning, thread history matching, the corpus scanner over
320k messages, LLM assisted annotation, the evaluation harness, the CLI, and a test suite covering
fuzzing, hostile input scaling bounds and the two content loss regressions. Run `npm test` for the
current count rather than trusting a number written here, which goes stale the moment a test is
added.

**Planned, not built.** Described in [docs/implementation-plan.md](docs/implementation-plan.md):

- the local review application for adjudicating annotator disagreements;
- the corpus redaction workflow;
- a learned sequence model.

Anything in this README describing those is design intent, not a shipped feature.
