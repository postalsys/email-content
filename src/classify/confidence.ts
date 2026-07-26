/**
 * Stage 8: confidence and visibility.
 *
 * All thresholds live here so that calibration against the labelled set can move them without
 * touching detector or rule code. The numbers below are the deterministic baseline's starting
 * point, chosen conservatively; Phase 6 replaces them with calibrated values.
 */

import { type Label, type Visibility } from '../types';

export interface ConfidenceConfig {
    /** At or above this, high confidence history may be hidden outright. */
    hideThreshold: number;
    /** At or above this, content is collapsed but one interaction away. */
    collapseThreshold: number;
    /** Minimum anchor strength before hiding is permitted at all. */
    minAnchorStrength: number;
}

export const DEFAULT_CONFIDENCE: ConfidenceConfig = {
    hideThreshold: 0.95,
    collapseThreshold: 0.75,
    minAnchorStrength: 0.85
};

/**
 * Map a label and confidence to a visibility band.
 *
 * The asymmetry is deliberate and is the core safety mechanism:
 *   - only REPLY_HISTORY can ever be hidden outright
 *   - FORWARDED_CONTENT is collapsed at most, because it was included on purpose
 *   - INLINE_QUOTE stays visible, because it is the context an answer depends on
 *   - UNKNOWN always stays visible
 */
export function visibilityFor(label: Label, confidence: number, config: ConfidenceConfig = DEFAULT_CONFIDENCE): Visibility {
    switch (label) {
        case 'REPLY_HISTORY':
            if (confidence >= config.hideThreshold) {
                return 'hide';
            }
            return confidence >= config.collapseThreshold ? 'collapse' : 'show';
        case 'FORWARDED_CONTENT':
            return confidence >= config.collapseThreshold ? 'collapse' : 'show';
        case 'SIGNATURE':
        case 'DISCLAIMER':
            return confidence >= config.collapseThreshold ? 'collapse' : 'show';
        case 'INLINE_QUOTE':
        case 'NEW_CONTENT':
        case 'UNKNOWN':
        default:
            return 'show';
    }
}

/**
 * Message level confidence.
 *
 * The weakest hide or collapse decision, not the average. An average would let a long run of easy
 * blocks mask one risky decision, and the risky decision is the one that loses content.
 */
export function overallConfidence(decisions: readonly { confidence: number; visibility: Visibility }[]): number {
    const risky = decisions.filter(decision => decision.visibility !== 'show');
    if (!risky.length) {
        return 1;
    }
    return Math.min(...risky.map(decision => decision.confidence));
}
