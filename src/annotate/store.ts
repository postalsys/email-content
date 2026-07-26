/**
 * Annotation persistence.
 *
 * Every label carries its source, the model and prompt version that produced it, and the
 * deterministic baseline's verdict on the same block captured at the same moment. Storing the
 * baseline alongside is what makes a run reproducible as evidence: a later rule change cannot
 * silently rewrite what the disagreement was.
 */

import { type CorpusStore } from '../corpus/store';
import { EXTRACTOR_VERSION, type Label, type Reason } from '../types';

export interface AnnotationRow {
    path: string;
    representation: 'text' | 'html';
    blockIndex: number;
    mimePart: string;
    blockStart: number;
    blockEnd: number;
    charCount: number;
    source: 'llm' | 'human' | 'weak' | 'distant';
    label: Label;
    confidence: number;
    baselineLabel: Label | null;
    baselineConfidence: number | null;
    baselineReasons: readonly Reason[];
}

export interface AnnotationRunInfo {
    source: string;
    model: string | null;
    promptVersion: string | null;
    notes?: string;
}

export function startAnnotationRun(store: CorpusStore, info: AnnotationRunInfo): number {
    const result = store.run(
        `INSERT INTO annotation_runs (source, model, prompt_version, extractor_version, started_at, notes)
         VALUES (?, ?, ?, ?, ?, ?)`,
        info.source,
        info.model,
        info.promptVersion,
        EXTRACTOR_VERSION,
        Date.now(),
        info.notes ?? null
    );
    return Number(result.lastInsertRowid);
}

export function finishAnnotationRun(
    store: CorpusStore,
    runId: number,
    counts: { messages: number; blocks: number; failures: number; promptTokens: number; completionTokens: number }
): void {
    store.run(
        `UPDATE annotation_runs
         SET finished_at = ?, messages = ?, blocks = ?, failures = ?, prompt_tokens = ?, completion_tokens = ?
         WHERE id = ?`,
        Date.now(),
        counts.messages,
        counts.blocks,
        counts.failures,
        counts.promptTokens,
        counts.completionTokens,
        runId
    );
}

export function writeAnnotations(store: CorpusStore, runId: number, rows: readonly AnnotationRow[]): void {
    if (!rows.length) {
        return;
    }
    store.transaction(() => {
        for (const row of rows) {
            store.run(
                `INSERT INTO annotations (
                    run_id, path, representation, block_index, mime_part, block_start, block_end, char_count,
                    source, label, confidence, baseline_label, baseline_conf, baseline_reasons, agrees
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                runId,
                row.path,
                row.representation,
                row.blockIndex,
                row.mimePart,
                row.blockStart,
                row.blockEnd,
                row.charCount,
                row.source,
                row.label,
                row.confidence,
                row.baselineLabel,
                row.baselineConfidence,
                row.baselineReasons.join(','),
                row.baselineLabel === row.label ? 1 : 0
            );
        }
    });
}

/** Paths already annotated by this source and model, so a run can resume. */
export function annotatedPaths(store: CorpusStore, source: string, model: string | null): Set<string> {
    const rows = model
        ? store.query<{ path: string }>(
              'SELECT DISTINCT a.path AS path FROM annotations a JOIN annotation_runs r ON r.id = a.run_id WHERE a.source = ? AND r.model = ?',
              source,
              model
          )
        : store.query<{ path: string }>('SELECT DISTINCT path FROM annotations WHERE source = ?', source);
    return new Set(rows.map(row => row.path));
}
