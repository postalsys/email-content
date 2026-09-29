/**
 * Pattern precision audit.
 *
 * Aggregate agreement says how the extractor does overall; it cannot say which pattern to fix.
 * This groups reference-labelled blocks by the detector evidence they carry and by the reasons
 * behind their final decision, so a single pattern that fires on authored text stands out even
 * when the headline numbers look fine.
 *
 * Two views, because they answer different questions:
 *
 *   - Evidence: every block a pattern fired on, whatever the rules then did with it. This is the
 *     pattern's own precision, the thing a pattern file edit changes.
 *   - Reasons: every block whose final decision names a reason. This is the rule's precision, and
 *     for hiding reasons the rows that matter most, since a wrong hide is content loss.
 *
 * Evidence sits on the block that matched, usually the attribution line or separator itself, so
 * the evidence view measures whether the boundary was real, not how far the region after it ran.
 * The reason view covers the region.
 */

import { type Label } from '../types';

/** One reference-labelled block with what the extractor saw and decided. Never carries content. */
export interface AuditBlock {
    reference: Label;
    predicted: Label;
    hidden: boolean;
    chars: number;
    evidence: readonly { id: string; kind: string }[];
    reasons: readonly string[];
}

export interface AuditRow {
    key: string;
    /** Reference labels a hit is expected to carry, or null when the kind implies none. */
    expected: readonly Label[] | null;
    blocks: number;
    chars: number;
    /** Blocks whose reference label is in `expected`. */
    matching: number;
    /** Blocks precision is measured over: all of them, less those `neutral` excludes. */
    scored: number;
    /** Blocks the reference says the sender wrote: NEW_CONTENT or INLINE_QUOTE. */
    authored: number;
    /** Authored blocks the extractor hid. Each one is lost content. */
    authoredHidden: number;
    authoredHiddenChars: number;
    byReference: Partial<Record<Label, number>>;
}

export interface PatternAudit {
    blocks: number;
    evidence: AuditRow[];
    reasons: AuditRow[];
}

/**
 * The labels a hit of each evidence kind should land on, following docs/annotation-guide.md:
 * a boundary line belongs to the region it introduces, and a forward nested inside quoted history
 * is REPLY_HISTORY. A quote container legitimately holds inline quotes too. Kinds that only hint
 * are reported without a precision.
 */
const EXPECTED: Record<string, readonly Label[]> = {
    'reply-anchor': ['REPLY_HISTORY'],
    attribution: ['REPLY_HISTORY'],
    'forward-anchor': ['FORWARDED_CONTENT', 'REPLY_HISTORY'],
    'quote-container': ['REPLY_HISTORY', 'INLINE_QUOTE', 'FORWARDED_CONTENT'],
    signature: ['SIGNATURE'],
    disclaimer: ['DISCLAIMER']
};

/**
 * Reference labels that neither confirm nor refute a hit. A signature or disclaimer inside quoted
 * history belongs to the history (the guide labels it by the message that attached it), so the
 * pattern matching there is right about the shape and says nothing about the label. Without this,
 * every sign-off pattern reads as mostly wrong simply because most sign-offs are quoted.
 */
const NEUTRAL: Record<string, readonly Label[]> = {
    signature: ['REPLY_HISTORY', 'FORWARDED_CONTENT'],
    disclaimer: ['REPLY_HISTORY', 'FORWARDED_CONTENT']
};

function isAuthored(label: Label): boolean {
    return label === 'NEW_CONTENT' || label === 'INLINE_QUOTE';
}

interface Tally {
    row: AuditRow;
    neutral: readonly Label[];
}

function emptyTally(key: string, expected: readonly Label[] | null, neutral: readonly Label[] = []): Tally {
    return {
        row: { key, expected, blocks: 0, chars: 0, matching: 0, scored: 0, authored: 0, authoredHidden: 0, authoredHiddenChars: 0, byReference: {} },
        neutral
    };
}

function count({ row, neutral }: Tally, block: AuditBlock): void {
    row.blocks++;
    row.chars += block.chars;
    row.byReference[block.reference] = (row.byReference[block.reference] ?? 0) + 1;
    if (!neutral.includes(block.reference)) {
        row.scored++;
        if (row.expected?.includes(block.reference)) {
            row.matching++;
        }
    }
    if (isAuthored(block.reference)) {
        row.authored++;
        if (block.hidden) {
            row.authoredHidden++;
            row.authoredHiddenChars += block.chars;
        }
    }
}

/** Worst first: lost content, then the most authored hits, then volume. */
function byHarm(a: AuditRow, b: AuditRow): number {
    return b.authoredHiddenChars - a.authoredHiddenChars || b.authored - a.authored || b.blocks - a.blocks || a.key.localeCompare(b.key);
}

export function auditPatterns(blocks: readonly AuditBlock[]): PatternAudit {
    const evidence = new Map<string, Tally>();
    const reasons = new Map<string, Tally>();

    for (const block of blocks) {
        // A pattern that matched two lines of the same block still judged one block.
        const seen = new Set<string>();
        for (const item of block.evidence) {
            if (seen.has(item.id)) {
                continue;
            }
            seen.add(item.id);
            let row = evidence.get(item.id);
            if (!row) {
                row = emptyTally(item.id, EXPECTED[item.kind] ?? null, NEUTRAL[item.kind]);
                evidence.set(item.id, row);
            }
            count(row, block);
        }
        for (const reason of new Set(block.reasons)) {
            // A reason is scored against the label the rules gave it: the question is whether the
            // decision it justified was right.
            const key = `${reason} -> ${block.predicted}`;
            let row = reasons.get(key);
            if (!row) {
                row = emptyTally(key, [block.predicted]);
                reasons.set(key, row);
            }
            count(row, block);
        }
    }

    const rows = (tallies: Map<string, Tally>) => [...tallies.values()].map(tally => tally.row).sort(byHarm);
    return { blocks: blocks.length, evidence: rows(evidence), reasons: rows(reasons) };
}
