/**
 * Loading the stored LLM reference labels, shared by `evaluate` and `audit`.
 *
 * Both commands must read the same reference, or a pattern that looks precise in one report and
 * harmful in the other is only a difference in which annotations were counted.
 */

import { type CorpusStore } from '../corpus/store';
import { blockIndexOf, mimePartOf, type Label, type Segment } from '../types';

export interface ReferenceRow {
    path: string;
    block_index: number;
    /** MIME part the block came from. Null on annotations made before it was recorded. */
    mime_part: string | null;
    label: Label;
    char_count: number;
    client: string | null;
    lang: string | null;
    reply_style: string | null;
}

/**
 * Latest annotation per (path, block) for the chosen model, grouped by message, so re-annotated
 * messages do not count twice. An explicit prompt version pins the reference to labels made under
 * one convention; without it, the newest label per block wins, whatever prompt produced it, and
 * messages labelled only under an older convention are still included. The annotation guide's rule
 * that runs made under different conventions must never be silently compared is the reason the
 * option exists; use it whenever more than one prompt version is present.
 */
export function loadReference(store: CorpusStore, model: string, promptVersion = ''): Map<string, ReferenceRow[]> {
    const versionClause = promptVersion ? ' AND r.prompt_version = ?' : '';
    const versionClauseInner = promptVersion ? ' AND r2.prompt_version = ?' : '';
    const params: string[] = promptVersion ? [model, promptVersion, promptVersion] : [model];
    const reference = store.query<ReferenceRow>(
        `SELECT a.path, a.block_index, a.mime_part, a.label, a.char_count, m.client, m.lang, m.reply_style
         FROM annotations a
         JOIN annotation_runs r ON r.id = a.run_id
         JOIN messages m ON m.path = a.path
         WHERE r.model = ? AND a.source = 'llm'${versionClause}
           AND a.id = (SELECT MAX(a2.id) FROM annotations a2
                       JOIN annotation_runs r2 ON r2.id = a2.run_id
                       WHERE a2.path = a.path AND a2.block_index = a.block_index AND r2.model = r.model${versionClauseInner})
         ORDER BY a.path, a.block_index`,
        ...params
    );

    const byPath = new Map<string, ReferenceRow[]>();
    for (const row of reference) {
        const list = byPath.get(row.path);
        if (list) {
            list.push(row);
        } else {
            byPath.set(row.path, [row]);
        }
    }
    return byPath;
}

export interface CoveringPrediction {
    label: Label;
    hidden: boolean;
}

/**
 * Map a stored (part, block index) to the output segment covering it. Segments merge adjacent
 * blocks, so a block is matched by its index falling inside a segment's block range.
 *
 * Keyed per MIME part, not by block index alone. Block indices are section-local, so in a multipart
 * message with several body sections two segments legitimately start at index 0, and a flat map
 * silently kept only the last of them. Older annotations predate the part being recorded; those
 * fall back to the first part the output used, which is exactly the previous behaviour for the
 * single section messages they came from.
 */
export function segmentLookup(...segmentLists: readonly (readonly Segment[])[]): (part: string | null, index: number) => CoveringPrediction | null {
    const predictions = new Map<string, Map<number, CoveringPrediction>>();
    for (const segment of segmentLists.flat()) {
        const blockIndex = blockIndexOf(segment.source);
        if (blockIndex === null) {
            continue;
        }
        const part = mimePartOf(segment.source) ?? '';
        let bucket = predictions.get(part);
        if (!bucket) {
            bucket = new Map();
            predictions.set(part, bucket);
        }
        bucket.set(blockIndex, { label: segment.type, hidden: segment.visibility === 'hide' });
    }
    const ordered = new Map([...predictions].map(([part, bucket]) => [part, [...bucket.keys()].sort((a, b) => a - b)]));

    // Segments start at a block index and run to the next one, so fill forward within the part.
    return (part, index) => {
        const key = part !== null && predictions.has(part) ? part : (predictions.keys().next().value ?? '');
        const starts = ordered.get(key) ?? [];
        let best: number | null = null;
        for (const start of starts) {
            if (start <= index) {
                best = start;
            } else {
                break;
            }
        }
        return best === null ? null : (predictions.get(key)?.get(best) ?? null);
    };
}
