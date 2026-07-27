/**
 * Stage 7: plain text and HTML reconciliation.
 *
 * Measured over the full corpus, 79.2 percent of messages carry both representations, and among
 * human replies that carry both, a quarter disagree about whether the message contains quoted
 * history at all. The disagreement is almost always in the same direction: the HTML part has a
 * quote container and the plain part is a flattened render where the quote markers are simply gone.
 *
 * So HTML is the primary representation when both exist and the HTML actually carries structure.
 * The plain part is still classified independently, and its verdict is used two ways: to confirm,
 * which raises nothing but costs nothing, and to contradict, which caps confidence so that a
 * disputed region is collapsed rather than hidden.
 *
 * Selection runs *before* classification, and that ordering is load bearing. A message can hold
 * several independent body sections, and the classifier has to see all of them as one linear
 * sequence for its positional rules to mean anything. Choosing the representation first is what
 * makes that possible, and it is possible because selection needs only length, anchor presence and
 * whether segmentation degraded. None of those are labels. See
 * `docs/adr-001-document-global-classification.md`.
 */

import { type Reason, type Representation } from '../types';
import { type Block } from '../segment/types';
import { type BlockDecision } from './rules';

/** One representation of one body section, before any classification has run. */
export interface RepresentationInfo {
    representation: Representation;
    blocks: Block[];
    /** Total characters of authored content, used to spot a stub representation. */
    contentChars: number;
    /** True when the representation contains at least one structural anchor. */
    hasAnchor: boolean;
    /** True when segmentation failed and the representation is one unclassified block. */
    degraded: boolean;
}

export interface PrimaryChoice {
    primary: RepresentationInfo;
    /** The other representation of the same section, when it is worth cross checking against. */
    secondary: RepresentationInfo | null;
}

/** Fraction of characters classified as history. */
function historyShare(decisions: readonly BlockDecision[]): number {
    let history = 0;
    let total = 0;
    for (const decision of decisions) {
        const chars = decision.block.content.length;
        total += chars;
        if (decision.label === 'REPLY_HISTORY') {
            history += chars;
        }
    }
    return total > 0 ? history / total : 0;
}

/**
 * Choose which representation of one section drives the output.
 *
 * HTML wins by default when both exist, because it is where the structure survives. Plain text
 * wins when the HTML is a stub, which happens with clients that send a token HTML wrapper around a
 * text body, and when only the plain part has an anchor.
 */
export function pickPrimary(text: RepresentationInfo | null, html: RepresentationInfo | null): PrimaryChoice {
    if (text && !html) {
        return { primary: text, secondary: null };
    }
    if (html && !text) {
        return { primary: html, secondary: null };
    }
    if (!text || !html) {
        throw new Error('reconcile called with no representations');
    }

    // A representation with almost no content is a stub, not a real alternative.
    const htmlIsStub = html.contentChars * 4 < text.contentChars;
    const textIsStub = text.contentChars * 4 < html.contentChars;

    let primary = html;
    let secondary = text;
    if (htmlIsStub && !textIsStub) {
        primary = text;
        secondary = html;
    } else if (!html.hasAnchor && text.hasAnchor && !textIsStub) {
        primary = text;
        secondary = html;
    }

    // Degrading is not the same as winning.
    //
    // A representation that could not be segmented is one undifferentiated block. It knows nothing
    // about quote structure, so letting it drive the output turns a message whose plain text part
    // classified perfectly well into a single UNKNOWN blob. That did not happen before only by
    // accident: the degraded HTML block carried no content at all, so the stub test above caught
    // it. Giving that block its real projected text removes the accident, which is why the rule has
    // to be written down. Stated symmetrically, so it stays correct if the text segmenter ever
    // grows a degraded path of its own.
    const isStub = (result: RepresentationInfo) => (result === text ? textIsStub : htmlIsStub);
    if (primary.degraded && !secondary.degraded && !isStub(secondary)) {
        const displaced = primary;
        primary = secondary;
        secondary = displaced;
    }

    // A degraded secondary has no opinion to contradict with. Its single block is UNKNOWN by
    // construction, so measuring it against the primary would manufacture a disagreement out of the
    // fact that it never got to disagree.
    if (secondary.degraded) {
        return { primary, secondary: null };
    }

    return { primary, secondary };
}

/**
 * Apply cross representation evidence to one section's decisions, in place.
 *
 * The only adjustment made is downward. Raising confidence because the other representation agrees
 * would let two copies of the same mistake reinforce each other, and the cost of a wrong hide is
 * much higher than the cost of a collapse that could have been a hide.
 *
 * Scoped to one section on purpose. The comparison only means something between two renderings of
 * the same content; measuring one section against another section's alternative would compare
 * unrelated things.
 */
export function reconcileSection(
    primaryRepresentation: Representation,
    primaryDecisions: readonly BlockDecision[],
    secondaryDecisions: readonly BlockDecision[] | null,
    collapseCeiling = 0.9
): void {
    const reason: Reason = primaryRepresentation === 'html' ? 'html_primary_representation' : 'text_primary_representation';

    for (const decision of primaryDecisions) {
        if (!decision.reasons.includes(reason)) {
            decision.reasons.push(reason);
        }
    }

    if (!secondaryDecisions) {
        return;
    }

    // Disagreement is measured on the share of content treated as history, not on block counts,
    // because the two representations rarely segment into the same number of blocks.
    if (Math.abs(historyShare(primaryDecisions) - historyShare(secondaryDecisions)) <= 0.25) {
        return;
    }

    for (const decision of primaryDecisions) {
        if (decision.label !== 'REPLY_HISTORY') {
            continue;
        }
        if (decision.reasons.includes('matched_parent_message')) {
            // History matching is evidence about the world, not about markup. A disagreement
            // between two renderings of the same message does not weaken it.
            continue;
        }
        decision.confidence = Math.min(decision.confidence, collapseCeiling);
        if (!decision.reasons.includes('representations_disagree')) {
            decision.reasons.push('representations_disagree');
        }
    }
}
