# ADR 001: document-global classification across MIME sections

Status: accepted. Supersedes nothing. Required before the section aware body plan could be built.

## Context

`multipart/mixed` carries ordered sibling content, and all of it can belong to the visible message.
The most common shape in the working corpus is `multipart/mixed(alternative(P,H), P)` at 3.1 percent
of 320,377 messages: an authored body followed by a separately encoded gateway footer. Selecting one
part per representation, which is what the extractor did, silently deletes the other.

Retaining every section is therefore mandatory. The question this record answers is _where the
classifier runs_ once there is more than one section, because several rules are positional and key
off "the last block in this representation":

- `indexFromEnd`, assigned per representation during segmentation;
- `signature_position_and_length`, which walks back from the end of the authored region;
- `final_contiguous_quote_region` and `no_new_content_after_region`, which ask whether authored
  content follows a quoted run.

Segmenting and classifying each MIME part independently would give every section its own last block.
An appended gateway footer would then stop the primary section's signature from being final, and
signature and disclaimer recall are precisely the metrics the HTML detector wiring most recently
repaired. This is a live regression risk, not a theoretical one.

Merely recomputing `indexFromEnd` is not sufficient. `classifyBlocks()` interleaves structural,
footer, quote-region, unmarked-history and whole-message safeguard passes, and each of those reads
positions across the entire block array it was handed.

## Options considered

1. **Section-local structural passes, then a document-global footer and region pass.** Splits
   `classifyBlocks()` in two. Every pass would need to declare which index space it works in, and
   the interleaving between passes, which exists for good measured reasons, would have to be
   preserved across the split. High risk of quietly changing single-section behaviour, which is
   99.5 percent of mail.

2. **Reconcile alternatives first, then classify one document-level block sequence.** Choose the
   representation per section before classification, concatenate the chosen blocks of every section
   in document order, and run the existing classifier once over that sequence.

3. **Explicit local and global decision phases over a document/section model.** The most general,
   and the largest change. Justified only if some rule genuinely needs section-local scope, and no
   current rule does.

## Decision

**Option 2.**

Reconciliation moves ahead of classification, which is possible because choosing a primary
representation needs only content length, anchor presence and whether segmentation degraded. None of
those requires labels. Only the _disagreement_ check needs both representations classified, and that
is a confidence adjustment applied afterwards rather than a selection input.

The result is that the classifier keeps seeing exactly one linear block sequence, which is what
every one of its positional rules already assumes. A single-section message produces a sequence
identical to the one it produced before, so the common case is unchanged by construction rather than
by careful reimplementation.

## Consequences

### Two index spaces

- **Document-global decision index** (`Block.index`). Position in the concatenated sequence.
  `classifyBlocks()` uses it to index its own arrays, so it must equal the array position.
- **Section-local source index** (`Block.sourceIndex`). Position within the block's own
  representation, assigned by the segmenter and preserved for traceability. This is what
  `SourceRef.blockIndex` reports, so a segment still points at a block of a specific MIME part and a
  reviewer can find the exact bytes.

`features.indexFromEnd` is recomputed over the document sequence. Everything else in the feature
vector stays section-local: `position`, `charCount` and the rest describe the block within its own
part, and reinterpreting them document-wide would change their meaning without improving anything.

### Alternatives never duplicate

Reconciliation happens per section and before classification, so at most one representation of a
section reaches the output. The unused alternative is recorded as an intentional exclusion, not as a
missing section.

Two sibling sections in a `multipart/mixed` where one is plain-only and the other HTML-only are a
separate case: 158 messages in the corpus, most of them `mixed(H,P)`, are clients that used `mixed`
where they meant `alternative`. Those are merged into one section, but only when a shingle
containment test says the two really are the same content. Structure alone is not enough: merging
two genuinely distinct siblings would drop one of them, and that is the failure this whole change
exists to prevent. No match means both are kept, and the cost of that is a duplicated body rather
than a lost one.

### Reconciliation relative to document-global rules

Order is: segment each section, choose each section's representation, concatenate, classify once,
then apply the cross-representation confidence cap per section. The cap stays section-local because
it compares two renderings of _that_ section; comparing a section against another section's
alternative would be meaningless.

Independent sections are never reconciled against each other. An appended text-only footer is not an
alternative representation of the primary HTML body, and treating it as one would delete it.

### Segments are never merged across MIME parts

`toSegments()` already refuses to merge adjacent decisions whose `source.mimePart` differs. That
stays. Merging across parts would produce a segment whose single source reference could not describe
where its text came from, and traceability is a requirement rather than a nicety.

### Embedded messages

`message/rfc822` is not body. A forwarded message attached as `message/rfc822` is content the caller
renders as an attachment, and its parts are excluded from the body plan with the machine readable
reason `embedded_message`. This is a product decision, recorded here because Step 2 required it to
be explicit: the alternative, treating embedded messages as conversational content, would put a
whole quoted thread into the body of every forward and is a larger change than this record covers.

### Appended sections carry evidence, not a label

An appended sibling gets `mime:appended_section` evidence and is otherwise classified normally.
Gateways append substantive text as often as they append disclaimers, so MIME position is evidence
and never a verdict. The existing disclaimer and signature rules collapse such a section when the
content supports it, and leave it visible when it does not.
