/**
 * `email-content disagreements` subcommand.
 *
 * The point of annotating with a model is not the agreement percentage, it is this list. Blocks
 * where the deterministic baseline and the annotator disagree are where a human's attention is
 * worth spending, and they sort naturally by cost: a block the baseline hid but the annotator calls
 * authored is a candidate content loss bug, and everything else is a candidate tidiness bug.
 *
 * This command prints message content by design, because a reviewer has to read the block to judge
 * it. It is the only command that does so besides `extract`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { classifyBlocks } from '../classify/rules';
import { CorpusStore } from '../corpus/store';
import { parseMessage } from '../mime/parse';
import { segmentHtmlBlocks } from '../segment/html-blocks';
import { segmentTextBlocks } from '../segment/text-blocks';
import { type Block } from '../segment/types';
import { flagNonNegativeInt, flagPositiveInt, flagString, type ParsedArgs } from './args';

interface Row {
    path: string;
    block_index: number;
    representation: string;
    label: string;
    confidence: number;
    baseline_label: string | null;
    baseline_conf: number | null;
    baseline_reasons: string;
    char_count: number;
}

const DIRECTIONS: Record<string, string> = {
    expensive: "baseline_label = 'REPLY_HISTORY' AND label IN ('NEW_CONTENT', 'INLINE_QUOTE')",
    cheap: "label = 'REPLY_HISTORY' AND baseline_label IN ('NEW_CONTENT', 'INLINE_QUOTE')",
    footers: "baseline_label = 'NEW_CONTENT' AND label IN ('SIGNATURE', 'DISCLAIMER')",
    all: 'agrees = 0'
};

/** Rebuild the blocks of a message so the stored offsets can be resolved back to text. */
async function blocksFor(root: string, relPath: string): Promise<Block[]> {
    const message = await parseMessage(fs.readFileSync(path.join(root, relPath)));
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
    if (!best) {
        return [];
    }
    return best.representation === 'html' ? segmentHtmlBlocks(best.text, best.part).blocks : segmentTextBlocks(best.text, best.part).blocks;
}

export async function disagreementsCommand(args: ParsedArgs): Promise<number> {
    const dbPath = flagString(args, 'db', 'data/corpus.sqlite');
    if (!fs.existsSync(dbPath)) {
        process.stderr.write(`no corpus database at ${dbPath}\n`);
        return 2;
    }

    const direction = flagString(args, 'direction', 'expensive');
    const clause = DIRECTIONS[direction];
    if (!clause) {
        process.stderr.write(`unknown direction: ${direction}. Use one of ${Object.keys(DIRECTIONS).join(', ')}\n`);
        return 2;
    }

    const limit = flagPositiveInt(args, 'limit', 20);
    const context = flagNonNegativeInt(args, 'context', 2);

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

    const runFilter = flagNonNegativeInt(args, 'run', 0);
    const rows = store.query<Row>(
        `SELECT path, block_index, representation, label, confidence, baseline_label, baseline_conf, baseline_reasons, char_count
         FROM annotations
         WHERE ${clause} ${runFilter ? 'AND run_id = ' + runFilter : ''}
         ORDER BY char_count DESC
         LIMIT ?`,
        limit
    );

    if (!rows.length) {
        process.stdout.write(`no ${direction} disagreements recorded\n`);
        store.close();
        return 0;
    }

    const out: string[] = [];
    out.push(`${rows.length} ${direction} disagreement(s), largest first`);
    if (direction === 'expensive') {
        out.push('The baseline treated these as reply history. The annotator thought the sender wrote them.');
        out.push('Each one is a candidate content loss bug and should be judged by a human.');
    }
    out.push('');

    const cache = new Map<string, Block[]>();
    for (const row of rows) {
        let blocks = cache.get(row.path);
        if (!blocks) {
            try {
                blocks = await blocksFor(root, row.path);
            } catch {
                blocks = [];
            }
            cache.set(row.path, blocks);
        }
        const block = blocks.find(candidate => candidate.index === row.block_index);
        const decisions = blocks.length ? classifyBlocks(blocks) : [];

        out.push(`${row.path}  block #${row.block_index}  (${row.representation})`);
        out.push(`  baseline: ${row.baseline_label} ${row.baseline_conf?.toFixed(2) ?? '?'}   annotator: ${row.label} ${row.confidence.toFixed(2)}`);
        out.push(`  reasons:  ${row.baseline_reasons || 'none'}`);
        if (block) {
            out.push(`  depth:    quote=${block.features.quoteDepth} blockquote=${block.features.blockquoteDepth} kind=${block.kind}`);
        }

        // Neighbouring blocks are what make a decision judgeable: the same text means different
        // things above and below an attribution line.
        const from = Math.max(0, row.block_index - context);
        const to = Math.min(blocks.length - 1, row.block_index + context);
        for (let i = from; i <= to; i++) {
            const neighbour = blocks[i];
            if (!neighbour || neighbour.features.isAllBlank) {
                continue;
            }
            const decision = decisions.find(candidate => candidate.block.index === i);
            const marker = i === row.block_index ? '>>' : '  ';
            const text = neighbour.content.replace(/\s+/g, ' ').slice(0, 110);
            out.push(`  ${marker} #${String(i).padStart(2)} d${neighbour.features.quoteDepth} ${(decision?.label ?? '?').padEnd(17)} ${text}`);
        }
        out.push('');
    }

    process.stdout.write(`${out.join('\n')}\n`);
    store.close();
    return 0;
}
