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
