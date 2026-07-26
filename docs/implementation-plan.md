# Implementation plan

Phased, with the repository left in a usable state after each phase.

Status key: **done**, **in progress**, **planned**.

## Phase 0: inspect and plan (done)

- Inspected the environment: Node 24.18, npm 11.16, Python 3.14, 18 cores, 24 GB RAM.
- Verified `node:sqlite`, `fs.glob` and native TypeScript execution under `node --test`.
- Inspected candidate MIME libraries in the local checkouts and chose mailsplit, with the reasoning
  recorded in `architecture.md`.
- Wrote `architecture.md`, `threat-model.md` and this plan.

Decisions taken and their rationale:

| decision                                 | rationale                                                                                                                                                                            |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| TypeScript, strict, compiled to CommonJS | Strict typing was required, and CJS output keeps the `@yao-pkg/pkg` and EmailEngine path open. Dependencies are restricted to CJS safe packages for the same reason.                 |
| TypeScript 5.9.3, not 7.x                | TypeScript 7 is released, but `typescript-eslint` declares `typescript <6.1.0`. Revisit when the lint tooling catches up.                                                            |
| `@zone-eu/mailsplit` for MIME            | The only local option that preserves the tree with recoverable byte offsets and IMAP part numbers. See `architecture.md`.                                                            |
| `node:sqlite` for storage                | Built into Node 24. No native build, no `better-sqlite3`.                                                                                                                            |
| Tests compiled, not stripped             | `node --test` runs TypeScript natively, but module resolution differs subtly between the stripped and compiled paths. Tests run against compiled output so they exercise what ships. |
| Python trainer, JS inference             | Mirrors `@postalsys/bounce-classifier`: better modelling tooling for training, zero dependency inference at runtime.                                                                 |
| Optimise for the human slice             | Only 22 percent of the corpus is human authored, and human replies are 13,991 messages. Annotation budget goes there, with a random control slice for unbiased numbers.              |

## Phase 1: corpus inventory (done)

Delivered:

- `src/mime/` complete: parser, charset chain, header extraction, normalised model.
- `src/canonical/text.ts`: line canonicalisation, quote depth, reply style profiling.
- `src/canonical/html.ts`: entity decoding, text projection, structural hint detection.
- `src/detect/`: pattern loader plus six JSON pattern sets, client fingerprinting, traffic
  classification.
- `src/corpus/`: streaming scanner, worker, SQLite store with migrations, statistics, report
  renderer.
- `src/util/`: hashing and SimHash, language estimation, worker pool.
- `email-content corpus scan|stats|threads`.
- 55 tests including truncation and byte corruption fuzzing.

Measured on the full corpus: see `corpus-report.md`.

Deferred from this phase, deliberately:

- Near duplicate clustering by Hamming distance. Exact SimHash collisions are reported as a lower
  bound. True clustering needs banded LSH and is only required once splits are being built, in
  Phase 3.
- `corpus sample`. The sampling primitives exist and are tested, but the strata that matter are
  defined by extraction disagreement, which does not exist until Phase 2 lands.

## Phase 2: deterministic baseline (in progress)

Order of work. Each step ships with fixtures and tests.

1. `src/segment/text-blocks.ts`: group canonical lines into blocks at quote depth changes, blank
   line boundaries and detector anchors. Emit block features.
2. `src/segment/html-blocks.ts`: DOM walk with `node-html-parser`, which exposes a `range` per node
   so blocks keep source offsets. Blockquote ancestry, tag and class hints, style borders.
3. `src/segment/features.ts`: the shared feature vector, inspectable by `extract --explain`.
4. `src/detect/reply-header.ts`, `forward-header.ts`, `signature.ts`, `disclaimer.ts`: evidence
   producers over blocks, using the pattern sets already shipped.
5. `src/classify/rules.ts`: sequence rules honouring the anchor invariant.
6. `src/classify/reconcile.ts`: plain and HTML alignment, HTML primary.
7. `src/classify/confidence.ts`: bands and visibility.
8. `src/index.ts`: the public `extract()` API.
9. `email-content extract [--json] [--explain]`.
10. Property tests for the three safety invariants over a corpus sample.

Fixture priority follows measured prevalence on human replies: Gmail (51 percent carry
`gmail_quote`), Outlook web (`divRplyFwdMsg`, 26 percent), Outlook desktop (`MsoNormal`, 16
percent), Outlook mobile (13 percent), Apple Mail (4 percent), Thunderbird (0.8 percent), then the
plain text forms, then the malformed and adversarial cases.

## Phase 3: annotation workflow (planned)

1. `src/weak/rules.ts`: high precision weak labels, each carrying the rule id, its confidence, the
   source block, and whether any other rule disagreed.
2. Distant supervision from resolved parents. With 90.9 percent of replies resolvable, hidden text
   can be checked against text that provably existed earlier, at corpus scale and without a human.
   Stored separately from human labels and never mixed into the benchmark.
3. Migration 002: `blocks`, `weak_labels`, `annotations`, `predictions`.
4. Near duplicate clustering with banded LSH over the SimHash column, feeding split assignment.
5. `src/corpus/sample.ts`: stratified sampling over client, body kind, MIME shape, reply style,
   language, charset, malformed HTML, rule disagreement and low confidence, plus a random control
   slice.
6. The review app: zero build, `node:http` on 127.0.0.1, strict CSP, sanitised rendering, keyboard
   driven, incremental saves, duplicate prevention, annotator notes, versioned export.
7. `docs/annotation-guide.md` with concrete examples and the hard cases.

## Phase 4: evaluation (planned)

1. A permanent, manually labelled test set with thread aware and near duplicate aware splitting, so
   no message from the same thread or template crosses a split boundary.
2. Block level metrics: precision, recall, F1 per label, confusion matrix, calibration error,
   broken down by client, MIME structure, language, and with or without history.
3. Content retention metrics, with new content character recall as the headline number.
4. Catastrophic error tracking, counted separately and never averaged into an aggregate: all new
   content removed, an inline answer removed, inline context removed leaving an unintelligible
   answer, forwarded content discarded, only a signature retained, empty extraction from a non
   empty message, substantial unknown content hidden.
5. Baseline comparison: separator only, client rules, thread aware fuzzy matching, and the hybrid.

## Phase 5: learned model (planned)

Only after the labelled set and baseline exist. A block classifier with constrained sequence
decoding, trained in `trainer/`, exported as JSON weights, executed by a dependency free forward
pass. The model adds evidence and never overrides the anchor invariant.

## Phase 6: calibration and integration (planned)

Threshold calibration against the labelled set, reliability curves, throughput and memory
benchmarks, and a frozen, versioned public API.

## Open questions

1. **Is a `text/plain` part that lost its quote markers worth reconstructing?** Half of human replies
   are in this state. Current answer: no, prefer the HTML and project the classification onto the
   plain text. Revisit if a meaningful share of messages turn out to be plain only replies whose
   history has no markers at all, currently measured at 5.6 percent of replies.
2. **How should a forwarded message inside a reply be nested?** Currently both are flat regions.
   Structured nesting may be needed once the chat UI renders them.
3. **How much history is worth matching against?** The immediate parent is cheap and effective.
   Walking the full `References` chain costs one file read per ancestor. Decide with measurements in
   Phase 4.
4. **Should notification mail get its own extraction profile?** GitHub notification bodies are
   40 percent of the corpus and highly templated. A per-sender profile would be very accurate but
   adds a maintenance surface. Deferred until the evaluation shows whether the general rules are
   good enough.
