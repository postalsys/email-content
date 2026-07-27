/**
 * Stage 8: confidence and visibility.
 *
 * All thresholds live here so that calibration against the labelled set can move them without
 * touching detector or rule code. The numbers below are the deterministic baseline's starting
 * point, chosen conservatively; Phase 6 replaces them with calibrated values.
 */

import { ConfigurationError, type Label, type Visibility } from '../types';

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

function requireUnitInterval(value: unknown, option: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
        throw new ConfigurationError(option, 'a finite number between 0 and 1');
    }
    return value;
}

/**
 * Validate caller supplied confidence thresholds and fill in the defaults.
 *
 * Rejects, never clamps. Clamping hides a configuration mistake and makes the pipeline behave
 * differently from what the caller asked for, on every message, silently. `NaN` is the case that
 * matters most: every comparison against it is false, so a `NaN` threshold does not merely shift
 * behaviour, it makes the visibility bands stop working while everything still looks fine.
 *
 * Takes a partial. The previous signature required a complete object, so a caller wanting to move
 * one threshold had to copy the other two and then own them forever.
 */
export function validateConfidenceConfig(input?: Partial<ConfidenceConfig>): ConfidenceConfig {
    if (input === undefined || input === null) {
        return DEFAULT_CONFIDENCE;
    }
    if (typeof input !== 'object') {
        throw new ConfigurationError('confidence', 'an object');
    }

    const config: ConfidenceConfig = { ...DEFAULT_CONFIDENCE };
    if (input.hideThreshold !== undefined) {
        config.hideThreshold = requireUnitInterval(input.hideThreshold, 'confidence.hideThreshold');
    }
    if (input.collapseThreshold !== undefined) {
        config.collapseThreshold = requireUnitInterval(input.collapseThreshold, 'confidence.collapseThreshold');
    }
    if (input.minAnchorStrength !== undefined) {
        config.minAnchorStrength = requireUnitInterval(input.minAnchorStrength, 'confidence.minAnchorStrength');
    }

    // Inverted bands would make `collapse` unreachable and turn every collapse decision into a
    // hide, which is the direction that loses content.
    if (config.collapseThreshold > config.hideThreshold) {
        throw new ConfigurationError('confidence.collapseThreshold', 'less than or equal to confidence.hideThreshold', 'inverted_thresholds');
    }

    // `minAnchorStrength` is deliberately not compared against either threshold. Anchor strength
    // measures how good the structural evidence is; the thresholds measure how confident the
    // classification is. They are different dimensions and ordering them would be meaningless.
    return config;
}

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
    // A loop, not `Math.min(...)`: spreading a segment array into a call passes one argument per
    // element and blows V8's argument limit on a large enough message.
    let lowest = Infinity;
    for (const decision of decisions) {
        if (decision.visibility !== 'show' && decision.confidence < lowest) {
            lowest = decision.confidence;
        }
    }
    return lowest === Infinity ? 1 : lowest;
}
