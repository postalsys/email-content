/**
 * Label probability distributions from a probabilistic annotator, and the decision rule applied to
 * them.
 *
 * The OpenAI annotator is asked, in its prompt, to treat hiding authored text as ten times worse
 * than leaving history visible. An annotator that returns a full distribution does not need to be
 * asked to be biased: the raw distribution is stored unbiased and the asymmetry is applied here, in
 * code, where it can be tuned and re-applied without re-running inference.
 */

import { LABELS, type Label } from '../types';

export type LabelProbabilities = Partial<Record<Label, number>>;

/**
 * Hiding authored text is treated as this many times worse than leaving history visible. Part of
 * the `annotate-ts-v1` convention: stored labels always use it, so changing it means a new prompt
 * version. Other ratios are applied at read time, from the stored distribution.
 */
export const DEFAULT_COST_RATIO = 10;

/**
 * Labels whose content was written for this message and must stay visible. Hiding one of these is
 * the expensive error every cost rule, gate and disagreement filter is built around.
 */
export const AUTHORED_LABELS: ReadonlySet<Label> = new Set<Label>(['NEW_CONTENT', 'INLINE_QUOTE']);

/**
 * Keep only known labels with finite values, clamped into [0, 1]. Returns null when nothing usable
 * is left, so a malformed answer is recorded as missing rather than as a confident zero.
 */
export function sanitizeProbabilities(raw: unknown): LabelProbabilities | null {
    if (!raw || typeof raw !== 'object') {
        return null;
    }
    const out: LabelProbabilities = {};
    let any = false;
    for (const label of LABELS) {
        const value = (raw as Record<string, unknown>)[label];
        if (typeof value === 'number' && Number.isFinite(value)) {
            out[label] = Math.min(1, Math.max(0, value));
            any = true;
        }
    }
    return any ? out : null;
}

/** Most probable label. Ties go to the earlier label in LABELS, which puts NEW_CONTENT first. */
export function topLabel(probabilities: LabelProbabilities): Label {
    let best: Label = 'UNKNOWN';
    let bestValue = -1;
    for (const label of LABELS) {
        const value = probabilities[label] ?? 0;
        if (value > bestValue) {
            best = label;
            bestValue = value;
        }
    }
    return best;
}

/**
 * Apply the cost asymmetry to a distribution.
 *
 * Hiding a block wrongly costs `ratio` times the probability that it was authored, summed over
 * AUTHORED_LABELS since hiding is wrong if it is any of them. Leaving it visible wrongly costs the
 * probability that it was history. So REPLY_HISTORY survives only when
 * P(REPLY_HISTORY) > ratio * (P(NEW_CONTENT) + P(INLINE_QUOTE)); otherwise the block falls back to
 * whichever authored label is more likely. Every other label is taken as is, since none of them
 * hides anything.
 */
export function applyCostRule(probabilities: LabelProbabilities, ratio: number = DEFAULT_COST_RATIO): Label {
    const top = topLabel(probabilities);
    if (top !== 'REPLY_HISTORY') {
        return top;
    }
    let authoredMass = 0;
    let fallback: Label = 'NEW_CONTENT';
    for (const label of AUTHORED_LABELS) {
        const value = probabilities[label] ?? 0;
        authoredMass += value;
        if (value > (probabilities[fallback] ?? 0)) {
            fallback = label;
        }
    }
    return (probabilities.REPLY_HISTORY ?? 0) > ratio * authoredMass ? 'REPLY_HISTORY' : fallback;
}

/**
 * Gap between the two most probable labels. Small means genuinely ambiguous, which is what review
 * triage should sort by instead of a model's self reported confidence.
 */
export function probabilityMargin(probabilities: LabelProbabilities): number {
    let first = 0;
    let second = 0;
    for (const label of LABELS) {
        const value = probabilities[label] ?? 0;
        if (value > first) {
            second = first;
            first = value;
        } else if (value > second) {
            second = value;
        }
    }
    return first - second;
}

/** Parse the JSON stored in `annotations.probabilities`. Null for rows written without one. */
export function parseStoredProbabilities(json: string | null | undefined): LabelProbabilities | null {
    if (!json) {
        return null;
    }
    try {
        return sanitizeProbabilities(JSON.parse(json));
    } catch {
        return null;
    }
}
