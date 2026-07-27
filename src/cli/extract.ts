/**
 * `email-content extract` subcommand.
 *
 * Human readable output shows the classification, the confidence and the reasons, so that a
 * surprising decision can be understood without a debugger. Message content is printed here, which
 * is fine and necessary: the operator asked for this specific message.
 */

import fs from 'node:fs';
import { extract } from '../index';
import { type HistoryDocument } from '../match/history';
import { mimePartOf, type Segment } from '../types';
import { flagBool, flagOptionalString, flagPositiveInt, type ParsedArgs } from './args';

const LABEL_WIDTH = 18;

function truncate(text: string, limit: number): string {
    const collapsed = text.replace(/\s+/g, ' ').trim();
    return collapsed.length > limit ? `${collapsed.slice(0, limit - 1)}…` : collapsed;
}

function renderSegment(segment: Segment, index: number, full: boolean): string {
    const origin = mimePartOf(segment.source) ?? 'raw message';
    const head = `${String(index).padStart(2)}. ${segment.type.padEnd(LABEL_WIDTH)} ${segment.confidence.toFixed(2)}  ${segment.visibility.padEnd(8)} part ${origin} [${segment.source.start}..${segment.source.end}]`;
    const reasons = `    reasons: ${segment.reasons.join(', ') || 'none'}`;
    const body = full
        ? segment.text
              .split('\n')
              .map(line => `    | ${line}`)
              .join('\n')
        : `    | ${truncate(segment.text, 100)}`;
    return `${head}\n${reasons}\n${body}`;
}

export async function extractCommand(args: ParsedArgs): Promise<number> {
    const file = args.positional[0];
    if (!file) {
        process.stderr.write('usage: email-content extract <message.eml> [--json] [--explain] [--full]\n');
        return 2;
    }
    if (!fs.existsSync(file)) {
        process.stderr.write(`file not found: ${file}\n`);
        return 2;
    }

    const explain = flagBool(args, 'explain', false);
    const raw = fs.readFileSync(file);

    // Stage 5 evidence, when the caller can point at earlier messages. Either a corpus database,
    // which resolves the thread by Message-ID, or a folder of .eml files to index.
    let historyDocuments: HistoryDocument[] = [];
    const historySource = flagOptionalString(args, 'history');
    if (historySource) {
        const { parseMessage } = await import('../mime/parse');
        const message = await parseMessage(raw);
        const isDatabase = /\.sqlite$/i.test(historySource);
        if (isDatabase) {
            const { CorpusStore } = await import('../corpus/store');
            const { corpusThreadResolver } = await import('../corpus/thread-index');
            const store = new CorpusStore(historySource);
            // Only a run that finished cleanly. An interrupted or failed run holds partial output that
            // looks exactly like a small corpus, and reading it as a baseline approves a release against
            // whatever fraction of the messages happened to finish.
            const root = store.latestCompletedRun()?.root;
            if (root) {
                historyDocuments = await corpusThreadResolver(store, root).resolve(message.headers);
            }
            store.close();
        } else {
            const { folderThreadResolver } = await import('../corpus/thread-index');
            historyDocuments = await folderThreadResolver(historySource).resolve(message.headers);
        }
        process.stderr.write(`history: resolved ${historyDocuments.length} earlier message(s)\n`);
    }

    const result = await extract(raw, {
        explain,
        historyDocuments,
        parse: { maxTextPartBytes: flagPositiveInt(args, 'max-text-kb', 1024) * 1024 }
    });

    if (flagBool(args, 'json', false)) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return 0;
    }

    const full = flagBool(args, 'full', false);
    const out: string[] = [];

    out.push(`primary representation: ${result.primaryRepresentation}`);
    out.push(`overall confidence: ${result.overallConfidence.toFixed(3)}`);
    out.push(`history used: ${result.historyUsed}`);
    if (result.warnings.length) {
        out.push(`warnings: ${result.warnings.map(warning => warning.code).join(', ')}`);
    }
    out.push('');

    out.push(`VISIBLE (${result.segments.length})`);
    result.segments.forEach((segment, index) => out.push(renderSegment(segment, index, full)));

    if (result.hiddenSegments.length) {
        out.push('', `HIDDEN (${result.hiddenSegments.length}, retained and recoverable)`);
        result.hiddenSegments.forEach((segment, index) => out.push(renderSegment(segment, index, full)));
    }

    if (explain && result.diagnostics) {
        out.push('', `DIAGNOSTICS  structure=${result.diagnostics.structure} part=${result.diagnostics.primaryPart}`);
        for (const block of result.diagnostics.blocks) {
            const evidence = block.evidence.map(item => `${item.id}@${item.strength}`).join(' ') || 'none';
            out.push(`  #${String(block.index).padStart(2)} ${block.kind.padEnd(20)} -> ${block.label.padEnd(LABEL_WIDTH)} ${block.confidence.toFixed(2)}`);
            out.push(`      evidence: ${evidence}`);
            out.push(`      reasons:  ${block.reasons.join(', ')}`);
            out.push(`      text:     ${truncate(block.preview, 100)}`);
        }
    }

    process.stdout.write(`${out.join('\n')}\n`);
    return 0;
}
