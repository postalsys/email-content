/**
 * `email-content corpus ...` subcommands.
 *
 * Progress goes to stderr so that stdout stays clean for piping. No line printed here can contain
 * message content: only counts, rates and file paths relative to the corpus root.
 */

import fs from 'node:fs';
import path from 'node:path';
import { scanCorpus, type ScanProgress } from '../corpus/scanner';
import { computeStats, renderReport } from '../corpus/stats';
import { CorpusStore } from '../corpus/store';
import { flagBool, flagNumber, flagOptionalString, flagString, type ParsedArgs } from './args';

const DEFAULT_DB = 'data/corpus.sqlite';

function formatDuration(ms: number): string {
    const seconds = Math.round(ms / 1000);
    if (seconds < 60) {
        return `${seconds}s`;
    }
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
        return `${minutes}m ${seconds % 60}s`;
    }
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function renderProgress(progress: ScanProgress): string {
    const pct = progress.total ? ((100 * progress.seen) / progress.total).toFixed(1) : '0.0';
    const eta = progress.etaMs === null ? 'unknown' : formatDuration(progress.etaMs);
    const rss = (progress.rssBytes / (1024 * 1024)).toFixed(0);
    return (
        `  ${progress.seen.toLocaleString('en-US')}/${progress.total.toLocaleString('en-US')} (${pct}%)  ` +
        `ok=${progress.processed.toLocaleString('en-US')} failed=${progress.failed} skipped=${progress.skipped}  ` +
        `${progress.filesPerSecond.toFixed(0)}/s  eta ${eta}  rss ${rss}MB`
    );
}

async function scan(args: ParsedArgs): Promise<number> {
    const root = args.positional[0];
    if (!root) {
        process.stderr.write('usage: email-content corpus scan <folder> [--db path] [--sample N] [--seed S] [--concurrency N] [--no-resume]\n');
        return 2;
    }
    if (!fs.existsSync(root)) {
        process.stderr.write(`corpus root not found: ${root}\n`);
        return 2;
    }

    const dbPath = flagString(args, 'db', DEFAULT_DB);
    const isTty = process.stderr.isTTY;
    let lastLength = 0;

    process.stderr.write(`Scanning ${path.resolve(root)}\n`);
    process.stderr.write(`Database ${path.resolve(dbPath)}\n`);

    const summary = await scanCorpus({
        root,
        dbPath,
        sample: flagNumber(args, 'sample', 0),
        seed: flagString(args, 'seed', 'default'),
        concurrency: flagNumber(args, 'concurrency', 0) || undefined,
        resume: flagBool(args, 'resume', true),
        maxFileBytes: flagNumber(args, 'max-file-mb', 32) * 1024 * 1024,
        timeoutMs: flagNumber(args, 'timeout', 30000),
        batchSize: flagNumber(args, 'batch', 500),
        onProgress: progress => {
            const line = renderProgress(progress);
            if (isTty) {
                process.stderr.write(`\r${line.padEnd(lastLength)}`);
                lastLength = line.length;
            } else {
                process.stderr.write(`${line}\n`);
            }
        }
    });

    if (isTty) {
        process.stderr.write('\n');
    }
    process.stderr.write(
        `${summary.status}: ${summary.processed.toLocaleString('en-US')} parsed, ${summary.failed} failed, ${summary.skipped} skipped in ${formatDuration(summary.elapsedMs)} ` +
            `(${summary.filesPerSecond.toFixed(0)} files/s)\n`
    );
    return summary.status === 'completed' ? 0 : 1;
}

function stats(args: ParsedArgs): number {
    const dbPath = flagString(args, 'db', DEFAULT_DB);
    if (!fs.existsSync(dbPath)) {
        process.stderr.write(`no corpus database at ${dbPath}. Run "corpus scan" first.\n`);
        return 2;
    }
    const store = new CorpusStore(dbPath);
    try {
        const computed = computeStats(store);
        if (flagBool(args, 'json', false)) {
            process.stdout.write(`${JSON.stringify(computed, null, 2)}\n`);
            return 0;
        }
        const root = store.queryOne<{ root: string }>('SELECT root FROM runs ORDER BY id DESC LIMIT 1')?.root ?? 'unknown';
        const report = renderReport(computed, root);
        const out = flagOptionalString(args, 'out');
        if (out) {
            fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
            fs.writeFileSync(out, report);
            process.stderr.write(`wrote ${out}\n`);
        } else {
            process.stdout.write(report);
        }
        return 0;
    } finally {
        store.close();
    }
}

function threads(args: ParsedArgs): number {
    const dbPath = flagString(args, 'db', DEFAULT_DB);
    if (!fs.existsSync(dbPath)) {
        process.stderr.write(`no corpus database at ${dbPath}. Run "corpus scan" first.\n`);
        return 2;
    }
    const store = new CorpusStore(dbPath);
    try {
        const rows = store.query<{ label: string; count: number }>(`
            SELECT CASE
                WHEN m.in_reply_to IS NULL THEN 'no-in-reply-to'
                WHEN EXISTS (SELECT 1 FROM messages p WHERE p.message_id = m.in_reply_to) THEN 'parent-in-corpus'
                ELSE 'parent-missing'
            END AS label, COUNT(*) AS count
            FROM messages m GROUP BY label
        `);
        const total = rows.reduce((sum, row) => sum + row.count, 0);
        for (const row of rows.sort((a, b) => b.count - a.count)) {
            const share = total ? ((100 * row.count) / total).toFixed(1) : '0.0';
            process.stdout.write(`${row.label.padEnd(20)} ${String(row.count).padStart(8)}  ${share.padStart(5)}%\n`);
        }
        return 0;
    } finally {
        store.close();
    }
}

export async function corpusCommand(sub: string | undefined, args: ParsedArgs): Promise<number> {
    switch (sub) {
        case 'scan':
            return scan(args);
        case 'stats':
            return stats(args);
        case 'threads':
            return threads(args);
        default:
            process.stderr.write('usage: email-content corpus <scan|stats|threads> [options]\n');
            return 2;
    }
}
