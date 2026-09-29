/**
 * `email-content audit` subcommand.
 *
 * Per pattern and per rule precision against the stored reference labels, so a pattern that fires
 * on authored text can be found and fixed by name. See src/eval/pattern-audit.ts for what the two
 * views measure.
 *
 * Prints pattern ids, reason codes and counts only, never message content.
 */

import fs from 'node:fs';
import path from 'node:path';
import { extract } from '../index';
import { CorpusStore } from '../corpus/store';
import { corpusThreadResolver } from '../corpus/thread-index';
import { auditPatterns, type AuditBlock, type AuditRow } from '../eval/pattern-audit';
import { loadReference, segmentLookup } from '../eval/reference';
import { parseMessage } from '../mime/parse';
import { LABELS } from '../types';
import { flagBool, flagNonNegativeInt, flagString, type ParsedArgs } from './args';

function pct(value: number, total: number): string {
    return total ? `${((100 * value) / total).toFixed(1)}%` : '-';
}

function renderRows(title: string, rows: readonly AuditRow[], minBlocks: number): string[] {
    const out = [title, `  ${'key'.padEnd(52)} blocks  precision  authored  lost  lost chars  reference labels`];
    for (const row of rows) {
        if (row.blocks < minBlocks && !row.authoredHidden) {
            continue;
        }
        const labels = LABELS.filter(label => row.byReference[label])
            .map(label => `${label.slice(0, 5)}:${row.byReference[label]}`)
            .join(' ');
        out.push(
            `  ${row.key.slice(0, 52).padEnd(52)} ${String(row.blocks).padStart(6)} ${(row.expected ? pct(row.matching, row.scored) : '-').padStart(10)} ` +
                `${String(row.authored).padStart(9)} ${String(row.authoredHidden).padStart(5)} ${String(row.authoredHiddenChars).padStart(11)}  ${labels}`
        );
    }
    out.push('');
    return out;
}

export async function auditCommand(args: ParsedArgs): Promise<number> {
    const dbPath = flagString(args, 'db', 'data/corpus.sqlite');
    if (!fs.existsSync(dbPath)) {
        process.stderr.write(`no corpus database at ${dbPath}\n`);
        return 2;
    }

    const model = flagString(args, 'model', 'gpt-5.6-sol');
    const promptVersion = flagString(args, 'prompt-version', '');
    const useHistory = flagBool(args, 'history', false);
    const minBlocks = flagNonNegativeInt(args, 'min', 5);

    const store = new CorpusStore(dbPath);
    const root = store.latestCompletedRun()?.root;
    if (!root) {
        process.stderr.write('no completed scan run found\n');
        store.close();
        return 2;
    }
    const byPath = loadReference(store, model, promptVersion);
    if (!byPath.size) {
        process.stderr.write(`no annotations found for model ${model}. Run "annotate" first.\n`);
        store.close();
        return 2;
    }
    const resolver = useHistory ? corpusThreadResolver(store, root) : null;

    process.stderr.write(`auditing ${byPath.size} messages against ${model}${useHistory ? ', with thread history' : ''}\n`);

    const blocks: AuditBlock[] = [];
    let failures = 0;
    let unaligned = 0;

    for (const [relPath, references] of byPath) {
        let result;
        try {
            const raw = fs.readFileSync(path.join(root, relPath));
            let historyDocuments: Awaited<ReturnType<NonNullable<typeof resolver>['resolve']>> | undefined;
            if (resolver) {
                try {
                    historyDocuments = await resolver.resolve((await parseMessage(raw)).headers);
                } catch {
                    historyDocuments = undefined;
                }
            }
            result = await extract(raw, { explain: true, ...(historyDocuments?.length ? { historyDocuments } : {}) });
        } catch {
            failures++;
            continue;
        }

        const diagnostics = result.diagnostics?.blocks ?? [];
        const primary = result.diagnostics?.primaryPart ?? '';
        const byCoordinates = new Map(diagnostics.map(block => [`${block.mimePart}|${block.sourceIndex}`, block]));
        const { lookup, emitted } = segmentLookup(result.segments, result.hiddenSegments);

        for (const reference of references) {
            if (!emitted(reference.mime_part)) {
                unaligned++;
                continue;
            }
            // Same fallback as the segment lookup: an annotation without a part belongs to the
            // only part a single section message has.
            const block = byCoordinates.get(`${reference.mime_part ?? primary}|${reference.block_index}`);
            if (!block) {
                unaligned++;
                continue;
            }
            // Nothing left to show or hide; evaluate skips these too.
            if (block.features.isAllBlank === true) {
                continue;
            }
            const covering = lookup(reference.mime_part, reference.block_index);
            blocks.push({
                reference: reference.label,
                predicted: covering?.label ?? 'UNKNOWN',
                hidden: covering?.hidden ?? false,
                chars: reference.char_count,
                evidence: block.evidence,
                reasons: block.reasons
            });
        }
    }
    store.close();

    if (failures) {
        process.stderr.write(`${failures} message(s) could not be audited\n`);
    }
    if (unaligned) {
        // Annotations made before a segmentation change can point at blocks that no longer exist.
        process.stderr.write(
            `${unaligned} annotated block(s) belong to a part the extractor did not emit, or no longer align with the current segmentation, and were skipped\n`
        );
    }

    const audit = auditPatterns(blocks);

    if (flagBool(args, 'json', false)) {
        process.stdout.write(`${JSON.stringify(audit, null, 2)}\n`);
        return 0;
    }

    const out = [`PATTERN AUDIT vs ${model}${useHistory ? ' (with history)' : ' (no history)'}`, `  blocks ${audit.blocks}`, ''];
    out.push(
        '  precision: share of hits whose reference label is one the evidence kind implies',
        '  authored:  hits the reference says the sender wrote (NEW_CONTENT or INLINE_QUOTE)',
        '  lost:      authored hits the extractor hid',
        ''
    );
    out.push(...renderRows('EVIDENCE  (pattern precision, worst first)', audit.evidence, minBlocks));
    out.push(...renderRows('REASONS  (rule precision against the label the rule assigned)', audit.reasons, minBlocks));
    process.stdout.write(`${out.join('\n')}\n`);
    return 0;
}
