/**
 * Evaluation metrics.
 *
 * Two rules shape this module.
 *
 * First, aggregate accuracy is close to meaningless here. The label distribution is skewed, so a
 * classifier that guessed NEW_CONTENT for everything would score respectably while being useless.
 * Per label precision and recall, and the catastrophic counts, are what matter.
 *
 * Second, the cost of errors is asymmetric by roughly ten to one. So the headline number is recall
 * of genuine new content, measured in characters rather than blocks, because losing one long
 * paragraph is worse than losing one short line.
 */

import { LABELS, type Label } from '../types';

export interface LabelledBlock {
    path: string;
    blockIndex: number;
    charCount: number;
    reference: Label;
    predicted: Label;
    /** Whether the prediction would actually be hidden from the reader. */
    hidden: boolean;
    /** Grouping key for per segment breakdowns, for example the client or the language. */
    group?: string;
}

export interface LabelMetrics {
    label: Label;
    support: number;
    predicted: number;
    truePositives: number;
    precision: number;
    recall: number;
    f1: number;
}

export interface RetentionMetrics {
    /** Characters the reference calls authored by the sender. */
    newContentChars: number;
    /** How many of those remain visible. This is the headline number. */
    newContentCharsRetained: number;
    newContentCharRecall: number;
    /** Blocks the reference calls authored, and how many remain visible. */
    newContentBlocks: number;
    newContentBlocksRetained: number;
    newContentBlockRecall: number;
    /** Of what was hidden, how much the reference agrees was history. */
    hiddenChars: number;
    hiddenCharsGenuinelyHistory: number;
    hiddenPrecision: number;
    /** History the reference identified that is still on screen. */
    historyChars: number;
    historyCharsStillVisible: number;
    historyStillVisibleShare: number;
}

export interface CatastrophicCounts {
    /** Messages where every authored block was hidden. */
    allNewContentRemoved: number;
    /** Messages where an authored block inside an interleaved reply was hidden. */
    inlineAnswerRemoved: number;
    /** Messages where quoted context was hidden while its answer stayed. */
    inlineContextRemoved: number;
    /** Messages where forwarded content was hidden. */
    forwardedDiscarded: number;
    /** Messages where the only visible content is a footer. */
    onlyFooterRetained: number;
    /** Messages producing nothing visible from a non empty body. */
    emptyExtraction: number;
    /** Messages where more than half the hidden characters were UNKNOWN in the reference. */
    unknownHidden: number;
    messages: number;
}

export interface EvaluationReport {
    blocks: number;
    messages: number;
    exactAgreement: number;
    perLabel: LabelMetrics[];
    confusion: Map<string, number>;
    retention: RetentionMetrics;
    catastrophic: CatastrophicCounts;
    byGroup: { group: string; blocks: number; agreement: number; newContentCharRecall: number; historyHiddenShare: number }[];
}

function labelMetrics(rows: readonly LabelledBlock[], label: Label): LabelMetrics {
    let truePositives = 0;
    let support = 0;
    let predicted = 0;
    for (const row of rows) {
        if (row.reference === label) {
            support++;
        }
        if (row.predicted === label) {
            predicted++;
        }
        if (row.reference === label && row.predicted === label) {
            truePositives++;
        }
    }
    const precision = predicted ? truePositives / predicted : 0;
    const recall = support ? truePositives / support : 0;
    return {
        label,
        support,
        predicted,
        truePositives,
        precision,
        recall,
        f1: precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0
    };
}

function retention(rows: readonly LabelledBlock[]): RetentionMetrics {
    let newContentChars = 0;
    let newContentCharsRetained = 0;
    let newContentBlocks = 0;
    let newContentBlocksRetained = 0;
    let hiddenChars = 0;
    let hiddenCharsGenuinelyHistory = 0;
    let historyChars = 0;
    let historyCharsStillVisible = 0;

    for (const row of rows) {
        if (row.reference === 'NEW_CONTENT') {
            newContentChars += row.charCount;
            newContentBlocks++;
            if (!row.hidden) {
                newContentCharsRetained += row.charCount;
                newContentBlocksRetained++;
            }
        }
        if (row.hidden) {
            hiddenChars += row.charCount;
            if (row.reference === 'REPLY_HISTORY') {
                hiddenCharsGenuinelyHistory += row.charCount;
            }
        }
        if (row.reference === 'REPLY_HISTORY') {
            historyChars += row.charCount;
            if (!row.hidden) {
                historyCharsStillVisible += row.charCount;
            }
        }
    }

    return {
        newContentChars,
        newContentCharsRetained,
        newContentCharRecall: newContentChars ? newContentCharsRetained / newContentChars : 1,
        newContentBlocks,
        newContentBlocksRetained,
        newContentBlockRecall: newContentBlocks ? newContentBlocksRetained / newContentBlocks : 1,
        hiddenChars,
        hiddenCharsGenuinelyHistory,
        hiddenPrecision: hiddenChars ? hiddenCharsGenuinelyHistory / hiddenChars : 1,
        historyChars,
        historyCharsStillVisible,
        historyStillVisibleShare: historyChars ? historyCharsStillVisible / historyChars : 0
    };
}

function catastrophic(rows: readonly LabelledBlock[]): CatastrophicCounts {
    const byMessage = new Map<string, LabelledBlock[]>();
    for (const row of rows) {
        const list = byMessage.get(row.path);
        if (list) {
            list.push(row);
        } else {
            byMessage.set(row.path, [row]);
        }
    }

    const counts: CatastrophicCounts = {
        allNewContentRemoved: 0,
        inlineAnswerRemoved: 0,
        inlineContextRemoved: 0,
        forwardedDiscarded: 0,
        onlyFooterRetained: 0,
        emptyExtraction: 0,
        unknownHidden: 0,
        messages: byMessage.size
    };

    for (const blocks of byMessage.values()) {
        const authored = blocks.filter(block => block.reference === 'NEW_CONTENT');
        const visible = blocks.filter(block => !block.hidden);

        if (authored.length && authored.every(block => block.hidden)) {
            counts.allNewContentRemoved++;
        }
        if (!visible.length && blocks.some(block => block.charCount > 0)) {
            counts.emptyExtraction++;
        }
        // A footer is a signature or a disclaimer, matching the benchmark's structural check, but
        // only a message that had something else to show can lose its point. An empty reply whose
        // entire authored content is its signature comes out as footer plus hidden history, and
        // that is the correct extraction, not a catastrophe; six such messages in the reference
        // set started tripping this counter the moment history hiding improved.
        if (authored.length && visible.length && visible.every(block => block.reference === 'SIGNATURE' || block.reference === 'DISCLAIMER')) {
            counts.onlyFooterRetained++;
        }
        if (blocks.some(block => block.reference === 'FORWARDED_CONTENT' && block.hidden)) {
            counts.forwardedDiscarded++;
        }
        if (blocks.some(block => block.reference === 'INLINE_QUOTE' && block.hidden)) {
            // Hiding an inline quote leaves its answer without the question it answers.
            counts.inlineContextRemoved++;
        }
        // An interleaved message is one with quoted context and authored replies alternating.
        const interleaved = blocks.some(block => block.reference === 'INLINE_QUOTE') && blocks.some(block => block.reference === 'NEW_CONTENT');
        if (interleaved && authored.some(block => block.hidden)) {
            counts.inlineAnswerRemoved++;
        }
        const hiddenChars = blocks.filter(block => block.hidden).reduce((sum, block) => sum + block.charCount, 0);
        const unknownHiddenChars = blocks.filter(block => block.hidden && block.reference === 'UNKNOWN').reduce((sum, block) => sum + block.charCount, 0);
        if (hiddenChars > 0 && unknownHiddenChars / hiddenChars > 0.5) {
            counts.unknownHidden++;
        }
    }

    return counts;
}

export function evaluate(rows: readonly LabelledBlock[]): EvaluationReport {
    const confusion = new Map<string, number>();
    let agreed = 0;
    for (const row of rows) {
        const key = `${row.reference}|${row.predicted}`;
        confusion.set(key, (confusion.get(key) ?? 0) + 1);
        if (row.reference === row.predicted) {
            agreed++;
        }
    }

    const groups = new Map<string, LabelledBlock[]>();
    for (const row of rows) {
        const key = row.group ?? 'all';
        const list = groups.get(key);
        if (list) {
            list.push(row);
        } else {
            groups.set(key, [row]);
        }
    }

    return {
        blocks: rows.length,
        messages: new Set(rows.map(row => row.path)).size,
        exactAgreement: rows.length ? agreed / rows.length : 0,
        perLabel: LABELS.map(label => labelMetrics(rows, label)),
        confusion,
        retention: retention(rows),
        catastrophic: catastrophic(rows),
        byGroup: [...groups]
            .map(([group, list]) => {
                const kept = retention(list);
                return {
                    group,
                    blocks: list.length,
                    agreement: list.filter(row => row.reference === row.predicted).length / list.length,
                    newContentCharRecall: kept.newContentCharRecall,
                    historyHiddenShare: 1 - kept.historyStillVisibleShare
                };
            })
            .sort((a, b) => b.blocks - a.blocks)
    };
}
