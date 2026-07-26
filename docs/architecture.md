# Architecture

## Problem

A chat style application uses ordinary email as its transport. The other participants use whatever
mail client they like and do not know the conversation is being read as chat. For every inbound
message the system must separate what the sender actually wrote from the reply history their client
embedded automatically.

The cost of the two error directions is not symmetric. Hiding a sentence the sender wrote is a
silent data loss that the reader may never notice. Showing a paragraph of redundant quoted history
is a cosmetic annoyance. The whole design follows from treating the first as at least ten times
worse than the second.

## Principles

1. **Select, never generate.** The pipeline classifies and selects existing spans of the message. No
   generative model rewrites, summarises or paraphrases the sender's words at any point.
2. **Hiding requires an anchor.** Content may only be classified as reply history when a structural
   anchor supports it: an attribution line, a client quote container, or a match against a message
   that demonstrably existed earlier. Quote depth on its own is never sufficient.
3. **Nothing is discarded.** Hidden segments are returned in full alongside visible ones, and the
   original message is always available. "Hidden" is a rendering hint, not a deletion.
4. **Every decision names its reason.** Reasons come from a closed vocabulary. A heuristic that
   cannot name its reason is not allowed to influence visibility.
5. **Fail per message, never per corpus.** Any error becomes a warning plus a degraded result for
   that one message.

## Pipeline

```
raw .eml
   |
   v
[1] MIME parse          mailsplit walk, tree preserved, byte ranges recovered
   |
   +--> text/plain parts ---+          +--- text/html parts
   |                        |          |
   v                        v          v
[2] canonicalise      plain: line endings, NFC, quote depth
                      html:  DOM, source ranges, text projection
   |
   v
[3] segment           ordered blocks with features, per representation
   |
   v
[4] detect            reply headers, forward headers, client containers,
                      signatures, disclaimers. Evidence, not verdicts.
   |
   v
[5] match history     exact, then shingle, then bounded alignment
   |                  (optional, works without any history)
   v
[6] classify          rule baseline now, model-ready sequence interface later
   |
   v
[7] reconcile         align plain and HTML, transfer strong evidence,
                      pick the primary representation
   |
   v
[8] calibrate         confidence per block and per message, visibility bands
   |
   v
ExtractionResult
```

Stages 1 to 4 and 7 to 8 are deterministic and independently useful. Stages 5 and 6 improve accuracy
when history or a trained model is available, and their absence degrades output quality rather than
correctness.

## Stage 1: MIME parsing

Built on `@zone-eu/mailsplit`. The choice matters enough to record the reasoning.

The requirement is that every output segment stays traceable to its original MIME part and source
range. Both `postal-mime` and `mailparser` build a MIME tree internally and then collapse it into a
flat `html`/`text`/`attachments` shape, discard raw byte spans, and inline `message/rfc822` children
into the parent body. Neither exposes what traceability needs.

mailsplit emits raw header bytes and raw body chunks in document order, byte for byte. Its own round
trip test asserts that concatenating every chunk reproduces the input exactly, which is what makes
byte offsets recoverable by accumulating chunk lengths, even though mailsplit does not expose an
offset field. It also gives each node an IMAP style part number (`[1, 2]` becomes `"1.2"`), the
per part charset exactly as declared, the transfer encoding, `format=flowed` and `DelSp` flags, and
a `parentNode` chain from which `multipart/alternative` relationships are read.

What the parser produces is a `ParsedMessage`: every part with its own header list, byte ranges for
the header block and the raw body, parent and child ids, and decoded text for `text/plain` and
`text/html` parts only. Attachment bytes are measured and dropped rather than held.

Charset decoding runs an explicit chain: normalise the label through libmime, try Node's
`TextDecoder`, fall back to libmime's iconv-lite path for labels TextDecoder rejects such as utf-7,
then windows-1252 as a decoder that cannot fail. Each downgrade is reported as a warning. A body
declared utf-8 that decodes to more than two percent replacement characters is re-decoded as
windows-1252, because mislabelled single byte content is common while a genuinely damaged utf-8
message usually has one bad byte rather than hundreds.

## Stage 2: canonicalisation

Plain text and HTML are canonicalised separately and never merged into one representation.

Offsets in the rest of the pipeline are character offsets into the canonical string, not byte
offsets into the file. Traceability to the file is through the owning part's byte range. This split
is deliberate: transfer decoding, charset conversion and line ending normalisation each change
lengths, and threading a byte level offset map through three lossy transforms would be fragile for
no practical benefit.

Plain text canonicalisation normalises line endings to LF, drops a BOM and NUL bytes, applies NFC,
and records quote depth per line. It deliberately does **not** unwrap hard wrapped lines. Unwrapping
changes offsets and can merge a quoted line into an unquoted one, which is exactly the mistake that
loses content. Wrapping is resolved later and only in the matching projection.

The quote prefix matcher accepts `>` with optional spaces, up to three characters of leading
indentation, and repeated markers for depth. It does not accept `|` or `:`, which appear constantly
in tables, code and diffs, where a false positive would promote new content into history.

## Stage 3: segmentation

Each representation becomes an ordered list of blocks carrying position, quote depth, blockquote
ancestry, tag and class information, indentation and border hints, and lexical features such as
dates, addresses, header-like lines, question marks and separators. Features are inspectable and
dumped by `extract --explain`, because a feature nobody can look at is a feature nobody can debug.

## Stage 4: detectors

Detectors return evidence with a strength, never a verdict. Pattern sets live in JSON under
`src/detect/patterns/` so they can be extended or overridden at runtime through
`EMAIL_CONTENT_PATTERNS`. A pattern that fails to compile is skipped and reported, never fatal.

Reply attribution patterns cover English, French, German, Spanish, Italian, Portuguese, Dutch,
Polish, Estonian, Finnish, Swedish and Russian, plus the client separators
(`-----Original Message-----`, the Outlook underscore rule). Forward markers open a
`FORWARDED_CONTENT` region, which is collapsed but never hidden, since forwarded material was
included deliberately.

An embedded copy of a previous message's headers (`From:`, `Sent:`, `To:`, `Subject:`) is weak
evidence per line and strong evidence when several appear on consecutive lines including a date-like
field. That two-tier treatment exists because ordinary prose starts with "From:" often enough to
matter, as `test/fixtures/text-mentions-headers.eml` demonstrates.

HTML detectors are CSS selectors with a declared role: `quote` encloses history, `separator` means
everything after it in document order is history, `attribution` is the line introducing a quote, and
`new` marks containers a client uses for freshly typed text. Priority follows measured prevalence in
the working corpus rather than intuition.

## Stage 5: history matching

When a prior message is available, incoming blocks are compared against it with progressively more
tolerant methods: exact normalised match, then rolling hash token shingles, then bounded token
alignment on candidate regions only.

Embedding similarity is deliberately not implemented. It is documented as a possible weak feature
that could never on its own justify hiding content.

Measured over the full working corpus, 90.9 percent of replies resolve `In-Reply-To` to a
`Message-ID` that is also present, which makes this stage unusually valuable here and also provides
distant supervision for evaluation.

## Stage 6: classification

A rule baseline classifies block sequences in context. The interface is designed so a learned
sequence model can be dropped in later as an additional evidence source, with the rule invariants
still enforced on top of its output. The model never gets to override the anchor requirement.

## Stage 7: reconciliation

Measured over the whole corpus on human authored replies that carry both representations and show
quoting at all: 25 percent are marked only in the HTML, 72 percent in both, and 3 percent only in
plain text. The plain part is frequently a flattened render in which the quote markers are gone.

The trend matters more than the average. Splitting the same measurement by period:

| period       | replies with quoting | marked in HTML only |
| ------------ | -------------------: | ------------------: |
| 2005 to 2009 |                  996 |               26.0% |
| 2010 to 2014 |                2,164 |               18.4% |
| 2015 to 2019 |                2,072 |               21.8% |
| 2020 to 2022 |                1,051 |               19.3% |
| 2023 to 2026 |                1,158 |           **47.0%** |

Modern clients increasingly stop marking quotes in the `text/plain` alternative at all. A system
being built now has to assume that trend continues, so HTML is the primary representation whenever
both exist and the HTML carries structure.

Blocks are aligned by normalised text, classifications compared, strong structural evidence
transferred to the weaker representation, and any disagreement recorded as a reason with reduced
confidence rather than silently resolved. Adjustment is downward only: two renderings of the same
message agreeing does not make a wrong decision right, but disagreement is a genuine reason to stop
short of hiding.

## Stage 8: confidence and visibility

| band   | condition                                      | visibility |
| ------ | ---------------------------------------------- | ---------- |
| high   | confidence >= 0.95 **and** a structural anchor | `hide`     |
| medium | 0.75 to 0.95                                   | `collapse` |
| low    | below 0.75                                     | `show`     |
| any    | label is `UNKNOWN`                             | `show`     |

Thresholds live in one configuration object so that calibration against the labelled set can move
them without touching detector code.

## Safety invariants

Enforced by tests, not by convention:

1. **Lossless reconstruction.** Concatenating all segments in source order reproduces the canonical
   text of each representation exactly.
2. **Never empty.** A message with non-empty body text always yields at least one visible segment.
   If classification produces none, everything degrades to a single visible `UNKNOWN` segment plus a
   warning.
3. **Hiding requires an anchor**, as above.
4. **Original retained**, always.
5. **Per message failure.** Errors become warnings and a fully visible degraded result.

## Corpus subsystem

Separate from extraction, sharing the parser and detectors.

The scanner walks a directory with `opendir` so a folder of 320k entries is streamed, collects
candidates as `(path, size, mtime)` triples, sorts them for determinism, optionally samples them
deterministically by hashing each path with a seed, then feeds a fixed pool of worker threads. The
scanner drives backpressure itself with a bounded in flight window, so peak memory depends on the
window rather than the corpus size. Results are written to SQLite in batches inside transactions.

Storage is `node:sqlite`, built into Node 24. No native build step and no lockfile that stops
working in two years. The database holds derived metadata only: raw messages stay on disk and are
referenced by path. Schema changes go through forward only migrations tracked by `user_version`.

Resume compares `(path, size, mtime)` plus the processing version against the `files` table, rather
than hashing, because hashing every file to decide what to skip would mean reading the whole corpus
again.

## Model boundary

If and when a learned model is added, it follows the pattern already proven in
`@postalsys/bounce-classifier`: training lives in `trainer/` as Python, consuming exported JSONL
features; the runtime ships a weights JSON plus a dependency free forward pass in TypeScript, hot
reloadable and versioned by a model hash recorded alongside every prediction. Inference never
reaches the network, and rules retain veto power over the model.

## Directory map

| path             | contents                                                    |
| ---------------- | ----------------------------------------------------------- |
| `src/mime/`      | Stage 1: parse, charset, headers, normalised model          |
| `src/canonical/` | Stage 2: plain text and HTML canonicalisation               |
| `src/segment/`   | Stage 3: block segmentation and features                    |
| `src/detect/`    | Stage 4: detectors, with pattern data in `patterns/*.json`  |
| `src/match/`     | Stage 5: normalisation, shingles, alignment, history lookup |
| `src/classify/`  | Stages 6 to 8: rules, decoding, reconciliation, confidence  |
| `src/model/`     | Learned model inference, pure JS                            |
| `src/corpus/`    | Scanner, worker, store, migrations, stats, sampling         |
| `src/weak/`      | Weak label generation                                       |
| `src/eval/`      | Metrics, catastrophic error tracking, reports               |
| `src/review/`    | Local annotation app, zero build                            |
| `src/cli/`       | Command line entry points                                   |
| `src/util/`      | Hashing, language estimation, worker pool                   |
