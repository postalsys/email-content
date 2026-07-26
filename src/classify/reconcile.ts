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
 */

import { type Reason, type Representation } from '../types';
import { type BlockDecision } from './rules';

export interface RepresentationResult {
    representation: Representation;
    decisions: BlockDecision[];
    /** Total characters of authored content, used to spot a stub representation. */
    contentChars: number;
    /** True when the representation contains at least one structural anchor. */
    hasAnchor: boolean;
    /** Blocks matched against known history, if any was supplied. */
    matches?: readonly { blockIndex: number; containment: number; exact: boolean; isParent: boolean }[];
}

export interface ReconcileOutcome {
    primary: RepresentationResult;
    secondary: RepresentationResult | null;
    disagrees: boolean;
}

/** Fraction of characters classified as hidden or collapsed history. */
function historyShare(result: RepresentationResult): number {
    let history = 0;
    let total = 0;
    for (const decision of result.decisions) {
        const chars = decision.block.content.length;
        total += chars;
        if (decision.label === 'REPLY_HISTORY') {
            history += chars;
        }
    }
    return total > 0 ? history / total : 0;
}

/**
 * Choose which representation drives the output.
 *
 * HTML wins by default when both exist, because it is where the structure survives. Plain text
 * wins when the HTML is a stub, which happens with clients that send a token HTML wrapper around a
 * text body, and when only the plain part has an anchor.
 */
export function pickPrimary(text: RepresentationResult | null, html: RepresentationResult | null): ReconcileOutcome {
    if (text && !html) {
        return { primary: text, secondary: null, disagrees: false };
    }
    if (html && !text) {
        return { primary: html, secondary: null, disagrees: false };
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

    // Disagreement is measured on the share of content treated as history, not on block counts,
    // because the two representations rarely segment into the same number of blocks.
    const disagrees = Math.abs(historyShare(primary) - historyShare(secondary)) > 0.25;

    return { primary, secondary, disagrees };
}

/**
 * Apply cross representation evidence to the primary decisions.
 *
 * The only adjustment made is downward. Raising confidence because the other representation agrees
 * would let two copies of the same mistake reinforce each other, and the cost of a wrong hide is
 * much higher than the cost of a collapse that could have been a hide.
 */
export function reconcile(outcome: ReconcileOutcome, collapseCeiling = 0.9): BlockDecision[] {
    const { primary, secondary, disagrees } = outcome;
    const reason: Reason = primary.representation === 'html' ? 'html_primary_representation' : 'text_primary_representation';

    for (const decision of primary.decisions) {
        if (!decision.reasons.includes(reason)) {
            decision.reasons.push(reason);
        }
    }

    if (!secondary || !disagrees) {
        return primary.decisions;
    }

    for (const decision of primary.decisions) {
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

    return primary.decisions;
}
