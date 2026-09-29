# LLM annotation

The project's plan calls for a manually labelled dataset. This document covers the alternative that
was actually built: using a language model as the block annotator, at a scale manual labelling
cannot reach.

The conclusion up front: **these labels are good, but only from a capable model.** Two strong models
given identical input agree with each other on 97.6 percent of blocks. A weak model does not come
close: gpt-5.4-mini agrees with gpt-5.5 on only 80.5 percent. Model choice, not prompt tuning, is
what decides whether this reference is usable.

## How it works

```bash
cp .env.example .env          # add OPENAI_API_KEY
email-content annotate --sample 60 --model gpt-5.6-sol
email-content disagreements --direction expensive
```

Re-labelling after a convention change works on the same messages, not a fresh sample. Export the
paths the old reference covers, annotate them under the new prompt version, and pin evaluations to
one convention:

```bash
email-content annotate --paths data/relabel-paths.txt --model gpt-5.6-sol
email-content evaluate --model gpt-5.6-sol --prompt-version annotate-v4 --history
email-content disagreements --model gpt-5.6-sol --prompt-version annotate-v4
```

Resume state is scoped per prompt version, so bumping `PROMPT_VERSION` makes `annotate` treat every
message as unlabelled again; `--resume false` is only needed to redo labels within one version.

The annotator sits on top of the existing pipeline rather than replacing any of it:

1. The message is parsed and segmented by the ordinary deterministic pipeline.
2. Blocks are numbered and sent to the model with their quote depth.
3. The model returns one label per block index, under a strict JSON schema whose only fields are
   `index`, `label` and `confidence`.
4. Labels are validated against the blocks that were actually sent, then stored alongside the
   deterministic baseline's verdict on the same block, captured at the same moment.

**The model is never asked to produce text.** The response schema has no text field, so the
"extraction must select and classify existing content, not generate replacement content" rule holds
by contract rather than by good behaviour. This is asserted in `test/annotate.test.ts`.

Output validation matters more than it looks. A model that omits a block would otherwise make an
omission look like agreement, so omitted blocks become `UNKNOWN` with confidence zero. Indices the
model invents are discarded and counted. Repeated indices keep the first answer.

## What is sent

Block text, quote depth, and whether the message is a reply. No subject, no addresses, no headers.
Those would help accuracy slightly and would send noticeably more personal data to a third party.

Blocks are capped at 700 characters and 60 blocks per message, with truncation flagged in the
prompt.

## The prompt matters more than the model

The first version of the prompt sent block text with quote prefixes already stripped, so the
annotator could not see that a block was quoted at all.

On a deeply nested thread, that version labelled short quoted greetings and thanks at depth 1
through 3 as freshly written content, and sign-offs inside quoted messages as the sender's own
signature. Every one of those was wrong, and the deterministic baseline was right in all eight
cases.

Version 2 shows quote depth per block, exactly as a human annotator reading the raw message would
see it, and adds one convention: label a block by its role in _this_ message, so a signature inside
quoted material is part of the history, not a signature.

Measured on an identical sample of 20 messages, 237 blocks:

| prompt                    | agreement with baseline | by characters | expensive-direction disagreements |
| ------------------------- | ----------------------: | ------------: | --------------------------------: |
| v1, no quote depth        |                   51.1% |         43.2% |                          8 blocks |
| v2, depth and conventions |                   75.9% |         69.1% |                          2 blocks |

## Inter-annotator agreement

The number that bounds every other number here. Identical input, identical prompt, different model:

| pair                    | blocks | agreement | by characters |
| ----------------------- | -----: | --------: | ------------: |
| gpt-5.4-mini vs gpt-5.5 |  1,041 |     80.5% |         85.0% |
| gpt-5.5 vs gpt-5.6-sol  |  7,454 | **97.6%** |         98.5% |

The first pair suggested this method had a low ceiling and that anything above roughly 80 percent
agreement with the reference was measuring noise. Running a second strong model showed that
conclusion was wrong: it was measuring gpt-5.4-mini's weakness, not annotation noise. Two capable
models converge almost completely.

The practical consequence is that the extractor's agreement figure has real headroom above it, not
noise. Acting on that, the baseline moved from 78.3 to 80.6 percent and from 99.2 to 100 percent new
content retention, by fixing bugs the reference pointed at rather than by tuning thresholds.

Where the two strong models still differ is concentrated and informative:

| gpt-5.5 said      | gpt-5.6-sol said | blocks |
| ----------------- | ---------------- | -----: |
| DISCLAIMER        | NEW_CONTENT      |     35 |
| NEW_CONTENT       | REPLY_HISTORY    |     31 |
| DISCLAIMER        | REPLY_HISTORY    |     20 |
| UNKNOWN           | NEW_CONTENT      |     19 |
| NEW_CONTENT       | DISCLAIMER       |     17 |
| FORWARDED_CONTENT | REPLY_HISTORY    |     15 |

Disclaimers dominate, which matches the extractor's own weakest label. Where a footer stops being a
footer is genuinely ambiguous, and a labelling convention would settle more of it than a better
model would.

### A third strong model: gpt-6-astra

Measured on 2026-09-29 under annotate-v4, on the same 452 messages and 8,490 blocks, every block
aligned. The two directions are counted from the first model's side: "hides" means the first model
says REPLY_HISTORY where the second says NEW_CONTENT or INLINE_QUOTE.

| pair, annotate-v4          | agreement | by characters | first hides authored | first shows history |
| -------------------------- | --------: | ------------: | -------------------: | ------------------: |
| gpt-5.5 vs gpt-5.6-sol     |     97.2% |         97.4% |            47 blocks |            5 blocks |
| gpt-6-astra vs gpt-5.6-sol |     97.4% |         97.7% |            71 blocks |            0 blocks |
| gpt-6-astra vs gpt-5.5     |     97.3% |         97.5% |            30 blocks |             1 block |

Three strong models from two generations converge at about 97 percent, which supports reading that
figure as the effective ceiling for this prompt rather than a property of one model pair. Language
does not move it: gpt-6-astra agrees with gpt-5.6-sol on 97.1 percent of Estonian blocks and 97.7
percent of English ones.

Its disagreements are one sided. It almost never leaves visible what the others hide, and it labels
24 blocks (2,642 characters) as history that both gpt-5.5 and gpt-5.6-sol call authored. Against
gpt-5.6-sol the largest differences all move toward REPLY_HISTORY:

| gpt-5.6-sol said  | gpt-6-astra said  | blocks |
| ----------------- | ----------------- | -----: |
| NEW_CONTENT       | REPLY_HISTORY     |     51 |
| FORWARDED_CONTENT | REPLY_HISTORY     |     38 |
| NEW_CONTENT       | DISCLAIMER        |     23 |
| REPLY_HISTORY     | FORWARDED_CONTENT |     23 |
| INLINE_QUOTE      | REPLY_HISTORY     |     20 |
| SIGNATURE         | REPLY_HISTORY     |     14 |

That is the expensive direction, so gpt-6-astra alone would make a reference that is stricter about
history than the extractor is designed to be, and would score the extractor's conservative choices
as errors. Its weakest labels against gpt-5.6-sol are INLINE_QUOTE (78.6 percent) and
FORWARDED_CONTENT (83.3 percent). With three strong models labelling identical blocks, a per block
majority is now possible, and the 24 blocks it hides against both others are the first candidates for
human adjudication. Cost: about 2,200 prompt tokens and one second of wall time per message at
concurrency 8.

## What the panel actually found

Filtering to blocks where **both** models agree with each other and disagree with the baseline
leaves 276 blocks, 32,004 characters:

| baseline said | both annotators said | blocks |
| ------------- | -------------------- | -----: |
| INLINE_QUOTE  | REPLY_HISTORY        |    125 |
| NEW_CONTENT   | REPLY_HISTORY        |     95 |
| NEW_CONTENT   | SIGNATURE            |     36 |
| NEW_CONTENT   | DISCLAIMER           |     14 |
| REPLY_HISTORY | FORWARDED_CONTENT    |      3 |
| REPLY_HISTORY | INLINE_QUOTE         |      1 |
| NEW_CONTENT   | FORWARDED_CONTENT    |      1 |
| REPLY_HISTORY | SIGNATURE            |      1 |

Reading this as evidence rather than as truth:

- **Zero blocks where both annotators say the baseline hid genuinely authored content.** One block
  where both say hidden content was inline context. On this sample, the safety property the whole
  design exists to protect holds.
- **220 blocks of history left visible** (the first two rows). The conservative bias is real and
  now measured. Most of it is the deliberate choice to keep an unanchored quote visible.
- **50 blocks of missed footers.** This confirms, independently, the signature and disclaimer gap
  already flagged in the README, and sizes it.

## Two real bugs found

The disagreement list did its job on the first run of 20 messages.

1. **A Gmail quote container that was not a quote.** A mailing list message had
   `<div class="gmail_quote">` opening in the middle of a sentence: "…reminds that on 15 August is"
   then the container, then "the Fulbright application deadline." The container was a relay
   artefact, not a quote boundary, and the baseline was collapsing genuine newsletter content
   behind it.

    Fixed by requiring corroboration: a quote container only anchors a hide when the message also
    contains an attribution line or blockquote nesting. Genuine client quotes always have one.

2. **A bottom posted question labelled as history rather than inline context.** The baseline
   collapsed it rather than hiding it, so nothing was lost, but `INLINE_QUOTE` is the better label.
   Left alone deliberately: tuning that rule on a single example from 20 messages would be
   overfitting. It is a Phase 4 question.

## Cost

| run                       | messages | blocks | prompt tokens | completion tokens |
| ------------------------- | -------: | -----: | ------------: | ----------------: |
| gpt-5.4-mini, 60 messages |       60 |  1,041 |        99,326 |            17,145 |
| gpt-5.5, 60 messages      |       60 |  1,041 |        99,446 |            30,826 |

Roughly 1,650 prompt tokens per message, dominated by the system prompt, which is a good candidate
for prompt caching if this is ever run at corpus scale. Annotating all 13,991 human replies would
be on the order of 23 million prompt tokens.

## Limitations

- **Not ground truth**, but closer than first assumed. 97.6 percent agreement between two strong
  models. A weak model is not usable as an annotator here.
  never be used to score the extractor.
- **Correlated errors.** Both models share training data and failure modes, so agreement between
  them overstates reliability. Two models agreeing is weaker evidence than two independent humans
  agreeing.
- **Convention sensitivity.** A large part of the measured disagreement was never about the email
  at all: it was about whether a signature inside quoted text counts as a signature. Labelling
  conventions have to be pinned down before any number means anything.
- **No adjudication yet.** The disagreement list is produced but nothing resolves it. That is what
  the annotation app in Phase 3 is for, and its job is now much smaller: adjudicating 276 flagged
  blocks rather than labelling 1,041 from scratch.
- **English-centric prompt on a multilingual corpus.** The sample was heavily Estonian. The models
  handled it, but that is an assumption worth testing rather than trusting.

## Privacy

This is the only part of the project that sends message content off the machine, and it is a
configured exception to the local-only default. See `docs/threat-model.md`. Nothing else in the
codebase can reach the network, and `extract()` cannot: the annotator is a separate command that
fails closed when no key is configured.

Derived labels stored in the database contain block offsets and lengths, not block text, but the
messages they point at remain on disk and the labels are only meaningful next to them. Treat an
annotation export as being as sensitive as the mailbox it came from.

## Settling the conventions (prompt v3)

Half of all disagreement between the two strong models was about one label, DISCLAIMER, and the same
text was labelled three different ways in different messages. That is a definition problem, not a
model problem, so [docs/annotation-guide.md](annotation-guide.md) settles it with two rules:

1. **Region wins over content type.** Label a block by which message it belongs to, never by what
   the text looks like. A signature inside quoted history is history; a legal notice inside a
   forward is forwarded content.
2. **DISCLAIMER is any machine appended boilerplate**, legal or promotional, with a guard: if the
   boilerplate is the whole message, it is NEW_CONTENT.

Re-annotating with both models under v3 was the falsifiable check, and it passed: agreement rose
from 97.6 to 98.6 percent and disagreements fell from 181 to 116.

The residual is concentrated rather than diffuse. Fifty of the 116 remaining disagreements come from
a single spam message padded with random Russian dictionary words, which no annotator can label
sensibly. Excluding it gives 99.2 percent, and excluding the three worst messages gives 99.6.

Rule 1 did most of the work. Rule 2 widened the DISCLAIMER target from 234 to 397 blocks, which
lowered measured recall until generic notification footer patterns were added, taking it from 8.1 to
18.1 percent at unchanged precision. What remains is per-sender templates.

## Iterating the conventions (prompt v4)

v3 left one contradiction standing: the guide said inline quoting happens at depth 1, while the
prompt told the annotator that everything at depth 1 or deeper is history. The two documents are
required to agree, and INLINE_QUOTE, the label the contradiction sits on, had the worst measured
precision. v4 aligns the prompt with the guide and settles the calls that were still decided by
example rather than rule: promotional footers are judged by their template shape, the whole message
guard fires only when nothing authored exists outside the boilerplate, UNKNOWN is scoped to doubt
about hiding, and boundary markers and nested forwards follow Rule 1.

Re-annotating both models under v4 measured 97.2 percent agreement, down from v3's 98.6, and the
shape of the residual matters more than the headline. 392 of 452 messages agree on every block.
Three messages carry half of all disagreement, and each is a single message-level judgment
amplified across a large message: a newsletter where one model applied the whole message guard and
the other did not (50 blocks), one region boundary read differently (40 blocks), and one nested
forward where gpt-5.5 did not follow the new rule (20 blocks). Excluding those three, agreement is
98.5 percent, the same band as v3. The diffuse remainder is still DISCLAIMER: gpt-5.5 applies the
template shape reading more aggressively than gpt-5.6-sol, 400 blocks against 335.

Two lessons worth recording. Message-level conventions such as the whole message guard trade
diffuse noise for concentrated flips: most messages become exactly reproducible, and the rare
borderline message becomes all or nothing. And the weaker of the two strong models follows nuanced
region rules less reliably, which is an argument for scoring against gpt-5.6-sol alone and using
gpt-5.5 only as this consistency check.

## TypeSafe as a probabilistic annotator

`annotate --provider typesafe` labels the same blocks with TypeSafe's System One model (`jev-1.13.0`,
pinned). It is a third annotator for the agreement table, not a replacement for the OpenAI one, and
it does not touch the extractor: `extract()` never reaches it.

```bash
cp .env.example .env          # add TYPESAFE_API_KEY
email-content annotate --provider typesafe --paths data/relabel-paths.txt
email-content agreement --candidate jev-1.13.0@annotate-ts-v1 \
    --reference gpt-5.6-sol@annotate-v4,gpt-5.5@annotate-v4
email-content disagreements --model jev-1.13.0 --prompt-version annotate-ts-v1 --sort margin
```

### What is different

Each message is one request with the blocks as JSON state and one Choice question per block, over
the same seven labels. The answer is an option and a probability distribution. There is no field in
which text could come back, so "select, never generate" holds by protocol, as it does by schema on
the OpenAI path. Answers go through the same validation: unanswered blocks become `UNKNOWN` with
confidence zero, answers to questions never asked are discarded and counted, and an answer without
a usable distribution counts as unanswered.

The HOW TO DECIDE, QUOTE DEPTH and REGION WINS rules are carried in the option descriptions they
disambiguate (`src/annotate/typesafe-prompt.ts`), because every question is evaluated in isolation
and jev applies rules literally. The COST OF ERRORS and CONFIDENCE sections are left out on purpose:

- **The cost asymmetry is a decision rule in code**, not a request to the model. A block is labelled
  `REPLY_HISTORY` only if P(REPLY_HISTORY) > 10 x (P(NEW_CONTENT) + P(INLINE_QUOTE)); otherwise it
  falls back to the more likely authored label. The authored probabilities are summed because
  hiding is wrong if the block is either. The ratio of 10 is part of the `annotate-ts-v1`
  convention, so stored labels never mix ratios under one prompt version.
- **The raw distribution is stored** in `annotations.probabilities` (migration 3) next to the rule's
  outcome in `label`, with the margin between its top two labels in `annotations.margin`.
  `agreement --cost-ratio <n>` re-applies a different ratio to stored runs without paying for
  inference again.
- **Confidence is the model's own**, derived from the distribution, and `disagreements --sort
margin` orders review by the gap between the two most likely labels, so a reviewer starts with
  the blocks the annotator itself found ambiguous.

Blocks are addressed by array position (`blocks[3]`), and the state carries no block index at all,
so there is no second number to confuse with the position. A message whose questions would exceed
the per request token budget is split into several requests, each carrying the full state, sent in
parallel.

Runs are stored as `source = 'llm'`, `model = 'jev-1.13.0'`, `prompt_version = 'annotate-ts-v1'`, so
they never share a resume key or an evaluation with OpenAI runs.

### The adoption gate

`agreement` compares a candidate annotator against references on blocks they both labelled, matched
by path, MIME part and offsets so that a segmentation change between runs is reported as unmatched
rather than counted as disagreement. It reproduces the figures above: gpt-5.4-mini against gpt-5.5
under annotate-v2 is 80.5 percent of blocks and 85.0 percent of characters.

Under annotate-v4 the two strong models give the bar TypeSafe has to meet:

| candidate vs reference, annotate-v4 | blocks | agreement | by characters | expensive direction    |
| ----------------------------------- | -----: | --------: | ------------: | ---------------------- |
| gpt-5.5 vs gpt-5.6-sol              |  8,490 |     97.2% |         97.4% | 47 blocks, 6,005 chars |

The expensive direction is not zero even between strong models: gpt-5.5 labels 47 blocks history
that gpt-5.6-sol calls authored, 42 of them NEW_CONTENT. "Near zero" for a candidate therefore
means the `GATE` line of `agreement`, blocks that **every** reference calls authored and the
candidate would hide, with both strong models as references.

Continue past this gate only if agreement is in the strong-model range and the gate count is near
zero after the cost rule. If it lands near the gpt-5.4-mini level, record the result here and keep
the OpenAI annotator.

### Measured: jev-1.13.0 does not clear the gate

Run on 2026-09-28 over the same 452 messages and 8,490 blocks (every block aligned with the
reference), 10.2M input tokens, about 23k per message and 63 seconds wall time at concurrency 6.
The cost rule is re-applied at several ratios from the one stored run; ratio 1 is the model's
unbiased top choice.

| cost ratio | vs gpt-5.6-sol | by characters | vs gpt-5.5 | gate: both call authored, jev hides |
| ---------: | -------------: | ------------: | ---------: | ----------------------------------: |
|          1 |          77.0% |         80.3% |      75.4% |              45 blocks, 6,924 chars |
|          2 |          70.1% |         72.0% |      68.5% |              21 blocks, 4,678 chars |
|          3 |          65.3% |         67.3% |      63.8% |              14 blocks, 1,331 chars |
|         10 |          51.5% |         51.4% |      50.2% |                 5 blocks, 237 chars |

**Result: no-go.** Even its unbiased top choice agrees with the strong reference less often than
gpt-5.4-mini did (80.5 percent), the level this document already calls unusable. The OpenAI
annotator stays the reference.

The cost rule is not the problem, it only trades one error for another: jev's distributions are
soft (a typical history block reads P(REPLY_HISTORY) 0.65 to 0.86 with the rest on INLINE_QUOTE),
so any ratio that drives the gate toward zero leaves most history visible. The disagreements at
ratio 1 say where the model actually fails:

| gpt-5.6-sol said | jev said          | blocks |
| ---------------- | ----------------- | -----: |
| REPLY_HISTORY    | INLINE_QUOTE      |    693 |
| REPLY_HISTORY    | NEW_CONTENT       |    245 |
| REPLY_HISTORY    | SIGNATURE         |    224 |
| SIGNATURE        | NEW_CONTENT       |    223 |
| REPLY_HISTORY    | FORWARDED_CONTENT |    129 |
| REPLY_HISTORY    | DISCLAIMER        |    100 |

This is the region-over-content convention failing, the literal reading weakness documented for
jev 1.13: signatures, disclaimers and forwards inside quoted history are labelled by what they look
like, and depth 1 history by its quote markers. Per label, REPLY_HISTORY agrees 75.5 percent and
SIGNATURE 54.4 percent. By language, English reaches 81.9 percent and Estonian 75.6 percent, so it
is not mainly a language problem.

If this is revisited, the plan's Step 2 alternative is the one to try: split each block into a
region question (this message, deliberately quoted, attached history, forwarded) and a
within-region question (body, signature, disclaimer), combined in code, so the region is decided
before content type can pull the answer. It would need its own prompt version and this same gate.
