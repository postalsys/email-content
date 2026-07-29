/**
 * `email-content evaluate` subcommand.
 *
 * Scores the current extractor against a stored reference set. The reference is re-scored from
 * scratch every run, rather than reusing the baseline verdict captured at annotation time, so that
 * a change to the rules is actually measured instead of being compared against its own past
 * output.
 *
 * The reference here is LLM produced. It is treated as a reference, not as truth. Two strong
 * models given identical input agree on 98.6 percent of blocks under the current conventions
 * (docs/annotation.md), so that is the effective ceiling; the earlier 80 percent figure came from
 * pairing a strong model with a weak one and measured the weak model, not annotation noise.
 */

import fs from 'node:fs';
import path from 'node:path';
import { extract } from '../index';
import { CorpusStore } from '../corpus/store';
import { corpusThreadResolver } from '../corpus/thread-index';
import { evaluate, type EvaluationReport, type LabelledBlock } from '../eval/metrics';
import { parseMessage } from '../mime/parse';
import { blockIndexOf, LABELS, mimePartOf, type Label } from '../types';
import { flagBool, flagNonNegativeInt, flagString, type ParsedArgs } from './args';

interface ReferenceRow {
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

function pct(value: number): string {
    return `${(100 * value).toFixed(1)}%`;
}

function renderReport(report: EvaluationReport, title: string): string {
    const out: string[] = [];
    out.push(title);
    out.push(`  messages ${report.messages}, blocks ${report.blocks}, exact label agreement ${pct(report.exactAgreement)}`);
    out.push('');

    out.push('CONTENT RETENTION  (the headline numbers)');
    const r = report.retention;
    out.push(`  new content characters retained   ${pct(r.newContentCharRecall)}   (${r.newContentCharsRetained} of ${r.newContentChars})`);
    out.push(`  new content blocks retained       ${pct(r.newContentBlockRecall)}   (${r.newContentBlocksRetained} of ${r.newContentBlocks})`);
    out.push(`  hidden content genuinely history  ${pct(r.hiddenPrecision)}   (${r.hiddenCharsGenuinelyHistory} of ${r.hiddenChars})`);
    out.push(`  history still visible             ${pct(r.historyStillVisibleShare)}   (${r.historyCharsStillVisible} of ${r.historyChars})`);
    out.push('');

    out.push('PER LABEL');
    out.push('  label              support  predicted  precision  recall      f1');
    for (const metric of report.perLabel) {
        if (!metric.support && !metric.predicted) {
            continue;
        }
        out.push(
            `  ${metric.label.padEnd(18)} ${String(metric.support).padStart(7)} ${String(metric.predicted).padStart(10)} ` +
                `${pct(metric.precision).padStart(10)} ${pct(metric.recall).padStart(7)} ${pct(metric.f1).padStart(7)}`
        );
    }
    out.push('');

    out.push('CONFUSION  (rows: reference, columns: predicted)');
    const present = LABELS.filter(label => report.perLabel.find(metric => metric.label === label && (metric.support || metric.predicted)));
    out.push(`  ${' '.repeat(18)}${present.map(label => label.slice(0, 8).padStart(9)).join('')}`);
    for (const reference of present) {
        const cells = present.map(predicted => String(report.confusion.get(`${reference}|${predicted}`) ?? 0).padStart(9)).join('');
        out.push(`  ${reference.padEnd(18)}${cells}`);
    }
    out.push('');

    out.push('CATASTROPHIC ERRORS  (counted per message, never averaged)');
    const c = report.catastrophic;
    const line = (label: string, value: number) => `  ${label.padEnd(42)} ${String(value).padStart(5)}  ${pct(value / Math.max(1, c.messages))}`;
    out.push(line('all new content removed', c.allNewContentRemoved));
    out.push(line('inline answer removed', c.inlineAnswerRemoved));
    out.push(line('inline context removed', c.inlineContextRemoved));
    out.push(line('forwarded content discarded', c.forwardedDiscarded));
    out.push(line('only a footer retained', c.onlyFooterRetained));
    out.push(line('empty extraction from non empty message', c.emptyExtraction));
    out.push(line('mostly unknown content hidden', c.unknownHidden));
    out.push('');

    if (report.byGroup.length > 1) {
        out.push('BY GROUP');
        out.push('  group                     blocks  agreement  new content retained  history hidden');
        for (const group of report.byGroup.slice(0, 15)) {
            out.push(
                `  ${group.group.padEnd(24)} ${String(group.blocks).padStart(6)} ${pct(group.agreement).padStart(10)} ${pct(group.newContentCharRecall).padStart(21)} ${pct(
                    group.historyHiddenShare
                ).padStart(15)}`
            );
        }
        out.push('');
    }

    return out.join('\n');
}

export async function evaluateCommand(args: ParsedArgs): Promise<number> {
    const dbPath = flagString(args, 'db', 'data/corpus.sqlite');
    if (!fs.existsSync(dbPath)) {
        process.stderr.write(`no corpus database at ${dbPath}\n`);
        return 2;
    }

    const model = flagString(args, 'model', 'gpt-5.6-sol');
    const promptVersion = flagString(args, 'prompt-version', '');
    const useHistory = flagBool(args, 'history', false);
    const groupBy = flagString(args, 'group-by', 'client');
    const limit = flagNonNegativeInt(args, 'limit', 0);

    const store = new CorpusStore(dbPath);
    // Only a run that finished cleanly. An interrupted or failed run holds partial output that
    // looks exactly like a small corpus, and reading it as a baseline approves a release against
    // whatever fraction of the messages happened to finish.
    const root = store.latestCompletedRun()?.root;
    if (!root) {
        process.stderr.write('no completed scan run found\n');
        store.close();
        return 2;
    }

    // Latest annotation per (path, block) for the chosen model, so re-annotated messages do not
    // count twice. An explicit --prompt-version pins the reference to labels made under one
    // convention; without it, the newest label per block wins, whatever prompt produced it, and
    // messages labelled only under an older convention are still included. The annotation guide's
    // rule that runs made under different conventions must never be silently compared is the
    // reason the flag exists; use it whenever more than one prompt version is present.
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

    if (!reference.length) {
        process.stderr.write(`no annotations found for model ${model}. Run "annotate" first.\n`);
        store.close();
        return 2;
    }

    const byPath = new Map<string, ReferenceRow[]>();
    for (const row of reference) {
        const list = byPath.get(row.path);
        if (list) {
            list.push(row);
        } else {
            byPath.set(row.path, [row]);
        }
    }

    const paths = [...byPath.keys()].slice(0, limit || undefined);
    const resolver = useHistory ? corpusThreadResolver(store, root) : null;

    process.stderr.write(`evaluating ${paths.length} messages against ${model}${useHistory ? ', with thread history' : ''}\n`);

    const rows: LabelledBlock[] = [];
    let failures = 0;
    let withHistory = 0;

    for (const relPath of paths) {
        const references = byPath.get(relPath) as ReferenceRow[];
        let raw: Buffer;
        try {
            raw = fs.readFileSync(path.join(root, relPath));
        } catch {
            failures++;
            continue;
        }

        let historyDocuments: Awaited<ReturnType<NonNullable<typeof resolver>['resolve']>> | undefined;
        if (resolver) {
            try {
                const message = await parseMessage(raw);
                historyDocuments = await resolver.resolve(message.headers);
                if (historyDocuments.length) {
                    withHistory++;
                }
            } catch {
                historyDocuments = undefined;
            }
        }

        let result;
        try {
            result = await extract(raw, historyDocuments ? { historyDocuments } : {});
        } catch {
            failures++;
            continue;
        }

        // Map every reference block to the prediction covering it. Segments merge adjacent blocks,
        // so a block is matched by its index falling inside a segment's block range.
        //
        // Keyed per MIME part, not by block index alone. Block indices are section-local, so in a
        // multipart message with several body sections two segments legitimately start at index 0,
        // and a flat map silently kept only the last of them. Older annotations predate the part
        // being recorded; those fall back to a single unnamed bucket, which is exactly the previous
        // behaviour for the single section messages they came from.
        const predictions = new Map<string, Map<number, { label: Label; hidden: boolean }>>();
        const bucketFor = (part: string) => {
            let bucket = predictions.get(part);
            if (!bucket) {
                bucket = new Map();
                predictions.set(part, bucket);
            }
            return bucket;
        };
        for (const segment of [...result.segments, ...result.hiddenSegments]) {
            const blockIndex = blockIndexOf(segment.source);
            if (blockIndex !== null) {
                bucketFor(mimePartOf(segment.source) ?? '').set(blockIndex, { label: segment.type, hidden: segment.visibility === 'hide' });
            }
        }
        const ordered = new Map([...predictions].map(([part, bucket]) => [part, [...bucket.keys()].sort((a, b) => a - b)]));

        // Segments start at a block index and run to the next one, so fill forward within the part.
        const lookup = (part: string | null, index: number): { label: Label; hidden: boolean } | null => {
            // An annotation with no recorded part matches whichever part the output actually used,
            // which for a single section message is the only one there is.
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

        const first = references[0];
        const group =
            groupBy === 'history'
                ? historyDocuments?.length
                    ? 'history available'
                    : 'history unavailable'
                : groupBy === 'lang'
                  ? (first?.lang ?? 'unknown')
                  : groupBy === 'reply-style'
                    ? (first?.reply_style ?? 'unknown')
                    : (first?.client ?? 'unknown');

        for (const item of references) {
            const prediction = lookup(item.mime_part, item.block_index);
            rows.push({
                path: relPath,
                blockIndex: item.block_index,
                charCount: item.char_count,
                reference: item.label,
                // A block with no covering segment was dropped as empty, which is equivalent to
                // being shown as nothing. Treat it as UNKNOWN and visible rather than silently
                // excluding it from the score.
                predicted: prediction?.label ?? 'UNKNOWN',
                hidden: prediction?.hidden ?? false,
                group
            });
        }
    }

    store.close();

    if (failures) {
        process.stderr.write(`${failures} message(s) could not be evaluated\n`);
    }
    if (resolver) {
        process.stderr.write(`thread history available for ${withHistory} of ${paths.length} messages\n`);
    }

    const report = evaluate(rows);

    if (flagBool(args, 'json', false)) {
        process.stdout.write(`${JSON.stringify({ ...report, confusion: Object.fromEntries(report.confusion) }, null, 2)}\n`);
        return 0;
    }

    process.stdout.write(`${renderReport(report, `EVALUATION vs ${model}${useHistory ? ' (with history)' : ' (no history)'}`)}\n`);
    return 0;
}
