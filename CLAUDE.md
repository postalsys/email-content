# email-content

Extracts the conversationally relevant content of an email: what the sender wrote, separated from
the reply history their client attached automatically.

## The rule everything follows from

Losing genuine new content is treated as **at least ten times worse** than leaving redundant quoted
history visible. Every design decision follows from that asymmetry. If a change makes the extractor
hide more, it needs evidence that it does not hide more of the wrong thing.

These invariants are enforced by tests, not by convention. Do not weaken them:

1. **Blocks tile their representation.** Concatenating every block's `text` reproduces the canonical
   text exactly. Segmenters must preserve this.
2. **Never empty.** A message with body text always yields at least one visible segment. An empty
   result must name its reason: `no_body_parts` or `no_visible_body_text`, never silence.
3. **Hiding requires a structural anchor**: an attribution line, a client quote container, a client
   separator, or a match against a message that provably existed earlier. Quote depth alone is never
   enough.
4. **A message never comes out as only its footer.**
5. **Every structurally independent body section is represented.** `multipart/mixed` siblings are
   pieces of the message, not alternatives, and size never decides between them. A part left out is
   named in a `body_section_not_selected` warning with a machine readable reason.
6. **Degrading is not winning.** A representation that failed to segment may never displace one that
   segmented successfully, and its content is returned visible and `UNKNOWN` rather than classified.
7. **Provenance is truthful.** `SourceRef` is discriminated: a segment either names the MIME part it
   came from or admits it only knows a raw message range. Never invent a part.
8. **Work is bounded.** Detectors and projections are linear or explicitly capped. A fail-soft catch
   does not make multi-second event-loop blocking acceptable; see `test/adversarial.test.ts`.

`REPLY_HISTORY` is the only label whose content is hidden. Everything else is shown or collapsed.

## Layout

| path             | contents                                                                    |
| ---------------- | --------------------------------------------------------------------------- |
| `src/mime/`      | Stage 1: mailsplit walk, charset chain, normalised message model, body plan |
| `src/canonical/` | Stage 2: plain text and HTML canonicalisation                               |
| `src/segment/`   | Stage 3: block segmentation and the inspectable feature vector              |
| `src/detect/`    | Stage 4: detectors. Patterns live in `patterns/*.json`, not in code         |
| `src/match/`     | Stage 5: normalisation, shingles, history matching                          |
| `src/classify/`  | Stages 6 to 8: rules, reconciliation, confidence bands                      |
| `src/corpus/`    | Scanner, worker pool, SQLite store, migrations, sampling                    |
| `src/annotate/`  | Optional LLM annotator. The only code that touches the network              |
| `src/eval/`      | Metrics and the benchmark's independent safety oracles                      |

`analyze()` is the core entry point and takes already parsed content. `extract()` parses raw RFC 5322
and delegates to it. Never duplicate pipeline logic between them: anything `extract()` can express
must be expressible through `MessageContent`, which is why multi section bodies go through
`MessageContent.sections` rather than being composed inside `extract()`.

`src/eval/oracle.ts` deliberately reimplements the MIME decision table instead of calling
`src/mime/select.ts`. A gate that shares its implementation with the thing it checks agrees by
construction and proves nothing. Keep them separate and keep both matching
`docs/adr-001-document-global-classification.md`.

Malformed **messages** degrade and never throw. Invalid **caller options** throw `ConfigurationError`
before any processing, and missing classifier assets throw `PatternAssetError` at require time. Both
are loaded and validated outside the per-message fail-soft catch, because a fault that repeats on
every message must not look like one more degraded result.

## Conventions

- TypeScript, strict, compiled to CommonJS. Every runtime dependency must be CJS safe and pure
  JavaScript, because this is consumed by EmailEngine, which forbids native modules and ESM and is
  bundled with `@yao-pkg/pkg`.
- **The library runs on Node 20; the corpus tooling needs Node 22.5 for `node:sqlite`.** Keep that
  split: nothing reachable from `src/index.ts` may use an API newer than Node 20, and `node:sqlite`
  stays lazily loaded so requiring the package never pulls it in. CI tests both runtimes. The Node 20
  floor is for source installs; EmailEngine's pkg binaries are built against Node 24.
- **Pattern files must stay loadable through `path.join(__dirname, 'patterns')`.** That exact form is
  what lets @yao-pkg/pkg bundle them without any asset configuration. Computing the path any other
  way would break single file binaries, and the symptom is silent: no detectors, no error. Verified
  on macOS, Linux and Windows binaries.
- Prettier: 160 columns, 4 spaces, single quotes, LF, no trailing commas, `arrowParens: avoid`.
- `node:test` with `node:assert/strict`, files named `*.test.ts`. Tests run against the compiled
  output, never the sources.
- Exact dependency versions, no `^` or `~`.
- Conventional Commits, release-please owns the version and CHANGELOG. Never edit them by hand.
- No emojis. Printable ASCII in code. No em or en dashes in prose, use commas or restructure.
- Document non-obvious heuristics with the reason and, where there is one, the measurement that
  motivated them.

## Before committing

```bash
npm run format && npm run lint && npm test
```

Then, for anything touching segmentation or classification:

```bash
node dist/cli/main.js benchmark --dir test/fixtures  # committed tier, no corpus needed
node dist/cli/main.js benchmark --sample 3000        # every catastrophic check must read 0
node dist/cli/main.js evaluate --model gpt-5.6-sol --history
npm run verify:package                               # the packed tarball, not the source tree
```

`benchmark` exits non zero if any catastrophic check fires, so it works as a regression gate; the
`--dir` tier runs in CI on every pull request. `evaluate` needs annotations; see
`docs/annotation.md`. `verify:package` installs the real tarball and checks the README examples and
the missing/corrupt asset behaviour against it, which source tests cannot do.

## Working on the classifier

Detectors return **evidence with a strength**, never a verdict. Only `src/classify/rules.ts` assigns
labels. A recurring bug class has been detectors wired into the plain text segmenter but not the
HTML one: most real mail is HTML primary, so a detector that is not called from
`src/segment/html-blocks.ts` is close to dead code. Check both.

Pattern sets are data. Add to `src/detect/patterns/*.json` rather than hard coding, and give each
entry a `comment` explaining what it is for. `EMAIL_CONTENT_PATTERNS` can point at an override
directory at runtime.

## Labelling

`docs/annotation-guide.md` is the source of truth for what each label means. `PROMPT_VERSION` in
`src/annotate/prompt.ts` must change whenever the guide changes in a way that could alter a label,
so runs made under different conventions are never silently compared.

## Privacy

The working corpus is private email.

- Nothing contacts the network except `email-content annotate`, which is opt in and fails closed.
- Never log message bodies, subjects or addresses. The corpus database stores hashes, offsets and
  counts only.
- `data/`, `annotations/*.jsonl`, `docs/corpus-report.md` and `.env` are gitignored, and
  `corpus-report.md` is excluded from the npm tarball as well.
- Source `.eml` files are opened read only and never modified.
