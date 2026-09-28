/**
 * `email-content agreement` subcommand.
 *
 * Measures one annotator against others on the blocks they both labelled. This is the decision
 * gate for adopting a new annotator: its agreement with the strong-model reference, and above all
 * the count of blocks it would hide that every reference calls authored.
 *
 * Reads labels and counts only. Prints no message content.
 */

import fs from 'node:fs';
import { compareAnnotators, type AgreementReport, type AnnotatedBlock } from '../annotate/agreement';
import { parseStoredProbabilities } from '../annotate/probabilities';
import { pct } from '../corpus/stats';
import { CorpusStore } from '../corpus/store';
import { type Label } from '../types';
import { flagBool, flagNumberInRange, flagString, type ParsedArgs } from './args';

interface AnnotatorSpec {
    name: string;
    model: string;
    promptVersion: string | null;
}

/** `model@prompt-version`, or a bare model to take every prompt version's latest label. */
export function parseSpec(spec: string): AnnotatorSpec {
    const at = spec.lastIndexOf('@');
    const model = at === -1 ? spec : spec.slice(0, at);
    const promptVersion = at === -1 ? null : spec.slice(at + 1) || null;
    return { name: spec, model, promptVersion };
}

interface Row {
    path: string;
    representation: string;
    block_index: number;
    mime_part: string | null;
    block_start: number | null;
    block_end: number | null;
    char_count: number;
    label: Label;
    probabilities: string | null;
    lang: string | null;
}

/** Runs belonging to an annotator, as a WHERE fragment over annotation_runs aliased `r`. */
function specWhere(spec: AnnotatorSpec): { sql: string; params: string[] } {
    return spec.promptVersion
        ? { sql: "r.source = 'llm' AND r.model = ? AND r.prompt_version = ?", params: [spec.model, spec.promptVersion] }
        : { sql: "r.source = 'llm' AND r.model = ?", params: [spec.model] };
}

/**
 * Labels for one annotator. Only the candidate needs distributions, and only when a cost ratio is
 * re-applied; only references need a language, since per language figures are keyed on them.
 */
function loadBlocks(store: CorpusStore, spec: AnnotatorSpec, need: { probabilities: boolean; lang: boolean }): AnnotatedBlock[] {
    const where = specWhere(spec);
    // Run order, so that later runs overwrite earlier ones per block in compareAnnotators.
    const rows = store.query<Row>(
        `SELECT a.path, a.representation, a.block_index, a.mime_part, a.block_start, a.block_end, a.char_count, a.label,
                ${need.probabilities ? 'a.probabilities' : 'NULL'} AS probabilities, ${need.lang ? 'm.lang' : 'NULL'} AS lang
         FROM annotations a
         JOIN annotation_runs r ON r.id = a.run_id
         ${need.lang ? 'LEFT JOIN messages m ON m.path = a.path' : ''}
         WHERE a.source = 'llm' AND ${where.sql}
         ORDER BY a.run_id, a.id`,
        ...where.params
    );
    return rows.map(row => ({
        path: row.path,
        representation: row.representation,
        blockIndex: row.block_index,
        mimePart: row.mime_part,
        blockStart: row.block_start,
        blockEnd: row.block_end,
        charCount: row.char_count,
        label: row.label,
        probabilities: parseStoredProbabilities(row.probabilities),
        lang: row.lang
    }));
}

interface RunCost {
    messages: number;
    promptTokens: number;
    wallMs: number;
}

function runCost(store: CorpusStore, spec: AnnotatorSpec): RunCost {
    const where = specWhere(spec);
    const row = store.queryOne<{ messages: number | null; tokens: number | null; wall: number | null }>(
        `SELECT SUM(messages) AS messages, SUM(prompt_tokens) AS tokens, SUM(finished_at - started_at) AS wall
         FROM annotation_runs r
         WHERE r.finished_at IS NOT NULL AND ${where.sql}`,
        ...where.params
    );
    return { messages: row?.messages ?? 0, promptTokens: row?.tokens ?? 0, wallMs: row?.wall ?? 0 };
}

export function renderAgreementReport(candidate: string, report: AgreementReport, cost: RunCost): string {
    const out: string[] = [];
    out.push(`AGREEMENT: ${candidate}`);
    out.push(`  candidate blocks ${report.candidateBlocks}, without any reference label ${report.unmatched}`);
    if (report.costRatio !== null) {
        out.push(`  cost rule re-applied at ratio ${report.costRatio} to ${report.rescored} block(s) with a stored distribution`);
    }
    if (cost.messages) {
        out.push(
            `  cost: ${Math.round(cost.promptTokens / cost.messages)} prompt tokens and ${(cost.wallMs / cost.messages).toFixed(0)} ms wall time per message, over ${cost.messages} messages`
        );
    }
    out.push('');

    for (const ref of report.references) {
        out.push(`vs ${ref.name}`);
        out.push(`  shared blocks       ${ref.shared}`);
        out.push(`  exact label match   ${ref.agreed} (${pct(ref.agreed, ref.shared)})`);
        out.push(`  by characters       ${pct(ref.agreedChars, ref.sharedChars)}`);
        out.push(`  candidate hides what reference calls authored   ${ref.expensive.blocks} blocks, ${ref.expensive.chars} chars   <- expensive`);
        out.push(`  candidate shows what reference calls history    ${ref.cheap.blocks} blocks, ${ref.cheap.chars} chars   <- cheap`);
        if (ref.pairs.length) {
            out.push('  top disagreements (reference -> candidate)');
            for (const pair of ref.pairs.slice(0, 8)) {
                out.push(`    ${pair.reference.padEnd(18)} -> ${pair.candidate.padEnd(18)} ${String(pair.blocks).padStart(6)}`);
            }
        }
        out.push('  per reference label');
        for (const item of ref.perLabel) {
            out.push(`    ${item.label.padEnd(18)} ${String(item.support).padStart(6)}  ${pct(item.agreed, item.support).padStart(6)}`);
        }
        out.push('  per language');
        for (const item of ref.perLang) {
            out.push(`    ${item.lang.padEnd(18)} ${String(item.shared).padStart(6)}  ${pct(item.agreed, item.shared).padStart(6)}`);
        }
        out.push('');
    }

    if (report.references.length) {
        const c = report.consensusExpensive;
        out.push(`GATE: blocks every reference calls authored and the candidate would hide`);
        out.push(`  ${c.blocks} blocks, ${c.chars} chars, of ${c.shared} blocks labelled by all references`);
        out.push('');
    }
    out.push('For scale: two strong models agree on 97.6% of blocks, a weak one on 80.5% (docs/annotation.md).');
    return out.join('\n');
}

export async function agreementCommand(args: ParsedArgs): Promise<number> {
    const dbPath = flagString(args, 'db', 'data/corpus.sqlite');
    if (!fs.existsSync(dbPath)) {
        process.stderr.write(`no corpus database at ${dbPath}\n`);
        return 2;
    }

    const candidateFlag = flagString(args, 'candidate', '');
    const references = flagString(args, 'reference', '')
        .split(',')
        .map(item => item.trim())
        .filter(Boolean)
        .map(parseSpec);
    if (!candidateFlag || !references.length) {
        process.stderr.write('usage: agreement --candidate <model@version> --reference <model@version>[,<model@version>...]\n');
        return 2;
    }
    const candidate = parseSpec(candidateFlag);
    const costRatio = args.flags.has('cost-ratio') ? flagNumberInRange(args, 'cost-ratio', 10, 1, 1000) : null;

    const store = new CorpusStore(dbPath);
    try {
        const candidateBlocks = loadBlocks(store, candidate, { probabilities: costRatio !== null, lang: false });
        if (!candidateBlocks.length) {
            process.stderr.write(`no annotations found for ${candidate.name}\n`);
            return 1;
        }
        const report = compareAnnotators(
            candidateBlocks,
            references.map(reference => ({ name: reference.name, blocks: loadBlocks(store, reference, { probabilities: false, lang: true }) })),
            costRatio
        );
        const cost = runCost(store, candidate);

        if (flagBool(args, 'json', false)) {
            process.stdout.write(`${JSON.stringify({ candidate: candidate.name, ...report, cost }, null, 2)}\n`);
        } else {
            process.stdout.write(`${renderAgreementReport(candidate.name, report, cost)}\n`);
        }
        return 0;
    } finally {
        store.close();
    }
}
