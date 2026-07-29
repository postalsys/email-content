/**
 * `email-content annotate` subcommand.
 *
 * Uses an LLM as a block annotator in place of a human, producing weak supervision at a scale
 * manual labelling cannot reach. The output is explicitly not a benchmark: it is stored as source
 * 'llm' with its model and prompt version, and its main product is the disagreement set, which is
 * where a human reviewer's time is actually worth spending.
 *
 * This command sends message content to a third party API. It is the only command that does, it is
 * opt in, and it fails closed when no key is configured.
 */

import fs from 'node:fs';
import path from 'node:path';
import { annotateBlocks, annotatableBlocks } from '../annotate/llm';
import { configFromEnv, OpenAIClient } from '../annotate/client';
import { PROMPT_VERSION } from '../annotate/prompt';
import { annotatedPaths, finishAnnotationRun, startAnnotationRun, writeAnnotations, type AnnotationRow } from '../annotate/store';
import { classifyBlocks } from '../classify/rules';
import { CorpusStore } from '../corpus/store';
import { parseMessage } from '../mime/parse';
import { segmentHtmlBlocks } from '../segment/html-blocks';
import { segmentTextBlocks } from '../segment/text-blocks';
import { type Block } from '../segment/types';
import { LABELS, type Label } from '../types';
import { flagBool, flagPositiveInt, flagString, type ParsedArgs } from './args';

interface Prepared {
    path: string;
    blocks: Block[];
    representation: 'text' | 'html';
    isReply: boolean;
}

/**
 * Segment a message the same way `extract()` does, so that labels line up with the pipeline being
 * evaluated. Kept simple on purpose: the largest text and HTML parts, HTML preferred when present.
 */
async function prepare(root: string, relPath: string): Promise<Prepared | null> {
    const raw = fs.readFileSync(path.join(root, relPath));
    const message = await parseMessage(raw);

    let best: { part: string; text: string; representation: 'text' | 'html' } | null = null;
    for (const part of message.parts) {
        if (!part.decoded || part.disposition === 'attachment') {
            continue;
        }
        if (part.contentType === 'text/html') {
            if (!best || best.representation === 'text' || part.decoded.text.length > best.text.length) {
                best = { part: part.partId, text: part.decoded.text, representation: 'html' };
            }
        } else if (part.contentType === 'text/plain' && (!best || (best.representation === 'text' && part.decoded.text.length > best.text.length))) {
            best = { part: part.partId, text: part.decoded.text, representation: 'text' };
        }
    }
    if (!best || !best.text.trim()) {
        return null;
    }

    const blocks = best.representation === 'html' ? segmentHtmlBlocks(best.text, best.part).blocks : segmentTextBlocks(best.text, best.part).blocks;

    return {
        path: relPath,
        blocks,
        representation: best.representation,
        isReply: Boolean(message.headers.inReplyTo) || /^\s*(re|vs|aw|sv)\s*:/i.test(message.headers.subject ?? '')
    };
}

/** Bounded concurrency over a list, preserving input order in the results. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
    const results = new Array<R>(items.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (cursor < items.length) {
            const index = cursor++;
            results[index] = await fn(items[index] as T, index);
        }
    });
    await Promise.all(workers);
    return results;
}

export async function annotateCommand(args: ParsedArgs): Promise<number> {
    const envFile = flagString(args, 'env', '.env');
    if (fs.existsSync(envFile)) {
        process.loadEnvFile(envFile);
    }

    const dbPath = flagString(args, 'db', 'data/corpus.sqlite');
    if (!fs.existsSync(dbPath)) {
        process.stderr.write(`no corpus database at ${dbPath}. Run "corpus scan" first.\n`);
        return 2;
    }

    const model = flagString(args, 'model', 'gpt-5.6-sol');
    const limit = flagPositiveInt(args, 'sample', 25);
    const concurrency = flagPositiveInt(args, 'concurrency', 4);
    const traffic = flagString(args, 'traffic', 'human');
    const seed = flagString(args, 'seed', 'annotate');
    const dryRun = flagBool(args, 'dry-run', false);

    let client: OpenAIClient | null = null;
    if (!dryRun) {
        try {
            client = new OpenAIClient(configFromEnv(model));
        } catch (err) {
            process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
            return 2;
        }
    }

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

    // Resume is scoped to the current prompt version: labels made under an older prompt are
    // different data, and treating them as already-done made a version bump silently no-op.
    const already = flagBool(args, 'resume', true) ? annotatedPaths(store, 'llm', model, PROMPT_VERSION) : new Set<string>();

    // Deterministic selection: hash the path with the seed and take the lowest values, so the same
    // seed always picks the same messages regardless of database order.
    const where = ["f.status = 'ok'", 'm.is_reply = 1'];
    if (traffic !== 'all') {
        where.push(`m.traffic = '${traffic.replace(/'/g, '')}'`);
    }
    const candidates = store
        .query<{ path: string }>(`SELECT m.path AS path FROM messages m JOIN files f ON f.path = m.path WHERE ${where.join(' AND ')} ORDER BY m.path`)
        .map(row => row.path)
        .filter(candidate => !already.has(candidate));

    // An explicit path list bypasses sampling. Re-labelling under a new prompt version has to hit
    // exactly the messages the old reference covers, or the two references stop being comparable.
    const pathsFile = flagString(args, 'paths', '');

    const strategy = flagString(args, 'strategy', 'stratified');
    let selected: string[];
    let strata = new Map<string, string>();
    if (pathsFile) {
        const known = new Set(candidates);
        const listed = fs
            .readFileSync(pathsFile, 'utf8')
            .split('\n')
            .map(line => line.trim())
            .filter(Boolean);
        selected = listed.filter(item => known.has(item));
        const skipped = listed.length - selected.length - listed.filter(item => already.has(item)).length;
        if (skipped > 0) {
            process.stderr.write(`${skipped} listed path(s) are not annotatable candidates and were skipped\n`);
        }
    } else if (strategy === 'stratified') {
        const { stratifiedSample } = await import('../corpus/sample');
        const sample = stratifiedSample(store, {
            count: limit,
            seed,
            traffic,
            repliesOnly: true,
            exclude: new Set([...already, ...(candidates.length ? [] : [])])
        });
        selected = sample.rows.map(row => row.path);
        strata = new Map(sample.rows.map(row => [row.path, row.stratum]));
        for (const item of sample.coverage) {
            if (item.taken < item.requested) {
                process.stderr.write(`  stratum ${item.id}: only ${item.taken} of ${item.requested} available\n`);
            }
        }
    } else {
        const { deterministicUnit } = await import('../util/hash');
        selected = candidates
            .map(candidate => ({ candidate, score: deterministicUnit(seed, candidate) }))
            .sort((a, b) => a.score - b.score)
            .slice(0, limit)
            .map(item => item.candidate);
    }
    void strata;

    if (!selected.length) {
        process.stderr.write('nothing to annotate\n');
        store.close();
        return 1;
    }

    process.stderr.write(`annotating ${selected.length} message(s) with ${model}, concurrency ${concurrency}\n`);
    if (already.size) {
        process.stderr.write(`skipping ${already.size} already annotated by this model\n`);
    }

    // A dry run must leave no trace in the database: an empty annotation_runs row looks like an
    // interrupted run to anything auditing the run history.
    const runId = dryRun ? -1 : startAnnotationRun(store, { source: 'llm', model, promptVersion: PROMPT_VERSION });

    let failures = 0;
    let blockCount = 0;
    let messageCount = 0;
    const rows: AnnotationRow[] = [];
    const started = Date.now();

    await mapLimit(selected, concurrency, async relPath => {
        let prepared: Prepared | null;
        try {
            prepared = await prepare(root, relPath);
        } catch {
            failures++;
            return;
        }
        if (!prepared || !annotatableBlocks(prepared.blocks).length) {
            return;
        }

        const baseline = classifyBlocks(prepared.blocks);
        const baselineByIndex = new Map(baseline.map(decision => [decision.block.index, decision]));

        if (dryRun) {
            messageCount++;
            blockCount += annotatableBlocks(prepared.blocks).length;
            return;
        }

        let result;
        try {
            result = await annotateBlocks(client as OpenAIClient, prepared.blocks, prepared.isReply);
        } catch (err) {
            failures++;
            process.stderr.write(`  failed: ${err instanceof Error ? err.message.slice(0, 120) : 'unknown'}\n`);
            return;
        }

        messageCount++;
        for (const label of result.labels) {
            const block = prepared.blocks.find(candidate => candidate.index === label.index);
            const decision = baselineByIndex.get(label.index);
            if (!block) {
                continue;
            }
            blockCount++;
            rows.push({
                path: relPath,
                representation: prepared.representation,
                blockIndex: label.index,
                mimePart: block.mimePart,
                blockStart: block.start,
                blockEnd: block.end,
                charCount: block.content.length,
                source: 'llm',
                label: label.label,
                confidence: label.confidence,
                baselineLabel: decision?.label ?? null,
                baselineConfidence: decision?.confidence ?? null,
                baselineReasons: decision?.reasons ?? []
            });
        }

        if (messageCount % 10 === 0) {
            process.stderr.write(`  ${messageCount}/${selected.length}\n`);
        }
    });

    if (!dryRun) {
        writeAnnotations(store, runId, rows);
        finishAnnotationRun(store, runId, {
            messages: messageCount,
            blocks: blockCount,
            failures,
            promptTokens: client?.usage.promptTokens ?? 0,
            completionTokens: client?.usage.completionTokens ?? 0
        });
    }

    const elapsed = (Date.now() - started) / 1000;
    process.stderr.write(`done in ${elapsed.toFixed(1)}s, ${messageCount} messages, ${blockCount} blocks, ${failures} failures\n`);
    if (client) {
        process.stderr.write(
            `tokens: ${client.usage.promptTokens} prompt + ${client.usage.completionTokens} completion over ${client.usage.requests} requests\n`
        );
    }

    if (dryRun) {
        process.stdout.write(`dry run: would annotate ${messageCount} messages, ${blockCount} blocks\n`);
        store.close();
        return 0;
    }

    process.stdout.write(`\n${renderAgreement(store, runId)}\n`);
    store.close();
    return 0;
}

/**
 * Compare the LLM labels against the deterministic baseline.
 *
 * The headline number is not overall agreement, which is inflated by the many easy blocks. It is
 * the disagreement breakdown, and in particular the cell where the baseline hid content the model
 * considers newly written: that is the shape of a content loss bug.
 */
export function renderAgreement(store: CorpusStore, runId: number): string {
    const rows = store.query<{ label: Label; baseline_label: Label | null; char_count: number; confidence: number; baseline_reasons: string }>(
        'SELECT label, baseline_label, char_count, confidence, baseline_reasons FROM annotations WHERE run_id = ?',
        runId
    );

    if (!rows.length) {
        return 'no annotations recorded';
    }

    const matrix = new Map<string, number>();
    let agreed = 0;
    let agreedChars = 0;
    let totalChars = 0;

    for (const row of rows) {
        const baseline = row.baseline_label ?? 'NONE';
        matrix.set(`${baseline}|${row.label}`, (matrix.get(`${baseline}|${row.label}`) ?? 0) + 1);
        totalChars += row.char_count;
        if (baseline === row.label) {
            agreed++;
            agreedChars += row.char_count;
        }
    }

    const out: string[] = [];
    out.push('AGREEMENT WITH RULE BASELINE');
    out.push(`  blocks              ${rows.length}`);
    out.push(`  exact label match   ${agreed} (${((100 * agreed) / rows.length).toFixed(1)}%)`);
    out.push(`  by characters       ${((100 * agreedChars) / Math.max(1, totalChars)).toFixed(1)}%`);
    out.push('');

    out.push('CONFUSION (rows: baseline, columns: llm)');
    const labels: (Label | 'NONE')[] = ['NONE', ...LABELS];
    const present = labels.filter(label => rows.some(row => (row.baseline_label ?? 'NONE') === label) || rows.some(row => row.label === label));
    const short = (label: string) => label.slice(0, 8).padStart(8);
    out.push(`  ${' '.repeat(18)}${present.map(short).join(' ')}`);
    for (const baseline of present) {
        const cells = present.map(llm => String(matrix.get(`${baseline}|${llm}`) ?? 0).padStart(8));
        out.push(`  ${baseline.padEnd(18)}${cells.join(' ')}`);
    }
    out.push('');

    // The asymmetric cost cell: the baseline hid or collapsed something the model calls authored.
    const hidden = rows.filter(row => row.baseline_label === 'REPLY_HISTORY' && (row.label === 'NEW_CONTENT' || row.label === 'INLINE_QUOTE'));
    const shown = rows.filter(row => row.label === 'REPLY_HISTORY' && (row.baseline_label === 'NEW_CONTENT' || row.baseline_label === 'INLINE_QUOTE'));

    out.push('ASYMMETRIC COST VIEW');
    out.push(
        `  baseline said history, llm said authored   ${hidden.length} blocks, ${hidden.reduce((sum, row) => sum + row.char_count, 0)} chars   <- the expensive direction`
    );
    out.push(
        `  baseline said authored, llm said history   ${shown.length} blocks, ${shown.reduce((sum, row) => sum + row.char_count, 0)} chars   <- the cheap direction`
    );
    out.push('');
    out.push('Both are candidates for human review. Neither is proof: these are weak labels, and the');
    out.push('model is wrong often enough that a disagreement means "look here", not "fix the rules".');

    return out.join('\n');
}
