/**
 * `email-content benchmark` subcommand.
 *
 * Two jobs in one pass over a sample of the corpus: measure throughput and memory, and count the
 * catastrophic outcomes that matter more than any average. A benchmark that only reported
 * milliseconds per message would miss the failure this project exists to prevent.
 *
 * The catastrophic checks here are structural and need no labels, so they can run over hundreds of
 * thousands of messages. They are a floor, not a substitute for the labelled evaluation in Phase 4.
 */

import fs from 'node:fs';
import path from 'node:path';
import { extract } from '../index';
import { CorpusStore } from '../corpus/store';
import { type Label } from '../types';
import { flagNumber, flagString, type ParsedArgs } from './args';

interface Counters {
    messages: number;
    errors: number;
    emptyFromNonEmpty: number;
    everythingHidden: number;
    onlySignatureVisible: number;
    hiddenWithoutAnchor: number;
    forwardedHidden: number;
    hiddenChars: number;
    visibleChars: number;
    labels: Map<Label, number>;
    durations: number[];
}

const ANCHOR_REASONS = new Set([
    'preceded_by_reply_header',
    'preceded_by_forward_header',
    'inside_quote_container',
    'outlook_reply_separator',
    'matched_parent_message',
    'matched_thread_ancestor'
]);

function percentile(values: readonly number[], fraction: number): number {
    if (!values.length) {
        return 0;
    }
    const index = Math.min(values.length - 1, Math.max(0, Math.floor(values.length * fraction)));
    return values[index] ?? 0;
}

export async function benchmarkCommand(args: ParsedArgs): Promise<number> {
    const dbPath = flagString(args, 'db', 'data/corpus.sqlite');
    if (!fs.existsSync(dbPath)) {
        process.stderr.write(`no corpus database at ${dbPath}. Run "corpus scan" first.\n`);
        return 2;
    }

    const limit = flagNumber(args, 'sample', 2000);
    const traffic = flagString(args, 'traffic', 'human');
    const onlyReplies = flagString(args, 'replies', 'true') !== 'false';

    const store = new CorpusStore(dbPath);
    const root = store.queryOne<{ root: string }>('SELECT root FROM runs ORDER BY id DESC LIMIT 1')?.root;
    if (!root) {
        process.stderr.write('no completed scan run found\n');
        store.close();
        return 2;
    }

    // Ordering by path keeps the selection deterministic for a given database and filter.
    const where: string[] = ["f.status = 'ok'"];
    if (traffic !== 'all') {
        where.push(`m.traffic = '${traffic.replace(/'/g, '')}'`);
    }
    if (onlyReplies) {
        where.push('m.is_reply = 1');
    }
    const rows = store.query<{ path: string }>(
        `SELECT m.path AS path FROM messages m JOIN files f ON f.path = m.path WHERE ${where.join(' AND ')} ORDER BY m.path LIMIT ?`,
        limit
    );
    store.close();

    if (!rows.length) {
        process.stderr.write('no matching messages\n');
        return 1;
    }

    const counters: Counters = {
        messages: 0,
        errors: 0,
        emptyFromNonEmpty: 0,
        everythingHidden: 0,
        onlySignatureVisible: 0,
        hiddenWithoutAnchor: 0,
        forwardedHidden: 0,
        hiddenChars: 0,
        visibleChars: 0,
        labels: new Map(),
        durations: []
    };

    const rssStart = process.memoryUsage.rss();
    let rssPeak = rssStart;
    const started = Date.now();

    for (const row of rows) {
        let raw: Buffer;
        try {
            raw = fs.readFileSync(path.join(root, row.path));
        } catch {
            counters.errors++;
            continue;
        }

        const t0 = process.hrtime.bigint();
        let result;
        try {
            result = await extract(raw);
        } catch {
            counters.errors++;
            continue;
        }
        counters.durations.push(Number(process.hrtime.bigint() - t0) / 1e6);
        counters.messages++;

        const visible = result.segments;
        const hidden = result.hiddenSegments;
        const visibleChars = visible.reduce((sum, segment) => sum + segment.text.length, 0);
        const hiddenChars = hidden.reduce((sum, segment) => sum + segment.text.length, 0);
        counters.visibleChars += visibleChars;
        counters.hiddenChars += hiddenChars;

        for (const segment of [...visible, ...hidden]) {
            counters.labels.set(segment.type, (counters.labels.get(segment.type) ?? 0) + 1);
        }

        const hadContent = visibleChars + hiddenChars > 0;
        if (hadContent && visibleChars === 0) {
            counters.everythingHidden++;
        }
        if (hadContent && !visible.length) {
            counters.emptyFromNonEmpty++;
        }
        if (visible.length > 0 && visible.every(segment => segment.type === 'SIGNATURE' || segment.type === 'DISCLAIMER')) {
            counters.onlySignatureVisible++;
        }
        for (const segment of hidden) {
            if (!segment.reasons.some(reason => ANCHOR_REASONS.has(reason))) {
                counters.hiddenWithoutAnchor++;
            }
            if (segment.type === 'FORWARDED_CONTENT') {
                counters.forwardedHidden++;
            }
        }

        if (counters.messages % 250 === 0) {
            rssPeak = Math.max(rssPeak, process.memoryUsage.rss());
        }
    }

    rssPeak = Math.max(rssPeak, process.memoryUsage.rss());
    const elapsed = Date.now() - started;
    counters.durations.sort((a, b) => a - b);

    const out: string[] = [];
    const pct = (value: number) => `${((100 * value) / Math.max(1, counters.messages)).toFixed(2)}%`;

    out.push(`sample: ${counters.messages} messages (traffic=${traffic}, replies-only=${onlyReplies})`);
    out.push(`errors: ${counters.errors}`);
    out.push('');
    out.push('THROUGHPUT');
    out.push(`  total            ${(elapsed / 1000).toFixed(1)}s`);
    out.push(`  rate             ${((counters.messages / elapsed) * 1000).toFixed(0)} messages/s (single threaded)`);
    out.push(`  per message p50  ${percentile(counters.durations, 0.5).toFixed(2)} ms`);
    out.push(`  per message p90  ${percentile(counters.durations, 0.9).toFixed(2)} ms`);
    out.push(`  per message p99  ${percentile(counters.durations, 0.99).toFixed(2)} ms`);
    out.push(`  per message max  ${percentile(counters.durations, 1).toFixed(2)} ms`);
    out.push(`  rss delta        ${((rssPeak - rssStart) / (1024 * 1024)).toFixed(0)} MB`);
    out.push('');
    out.push('CONTENT');
    const totalChars = counters.visibleChars + counters.hiddenChars;
    out.push(
        `  visible characters ${counters.visibleChars.toLocaleString('en-US')} (${((100 * counters.visibleChars) / Math.max(1, totalChars)).toFixed(1)}%)`
    );
    out.push(`  hidden characters  ${counters.hiddenChars.toLocaleString('en-US')} (${((100 * counters.hiddenChars) / Math.max(1, totalChars)).toFixed(1)}%)`);
    out.push('');
    out.push('SEGMENT LABELS');
    for (const [label, count] of [...counters.labels].sort((a, b) => b[1] - a[1])) {
        out.push(`  ${label.padEnd(18)} ${String(count).padStart(7)}`);
    }
    out.push('');
    out.push('CATASTROPHIC CHECKS (structural, no labels required)');
    out.push(`  empty extraction from non empty message  ${counters.emptyFromNonEmpty} (${pct(counters.emptyFromNonEmpty)})`);
    out.push(`  all content hidden                       ${counters.everythingHidden} (${pct(counters.everythingHidden)})`);
    out.push(`  only a footer left visible               ${counters.onlySignatureVisible} (${pct(counters.onlySignatureVisible)})`);
    out.push(`  hidden without a structural anchor       ${counters.hiddenWithoutAnchor} (${pct(counters.hiddenWithoutAnchor)})`);
    out.push(`  forwarded content hidden                 ${counters.forwardedHidden} (${pct(counters.forwardedHidden)})`);

    process.stdout.write(`${out.join('\n')}\n`);

    // A non zero exit makes this usable as a regression gate.
    const failed = counters.emptyFromNonEmpty + counters.everythingHidden + counters.hiddenWithoutAnchor + counters.forwardedHidden;
    return failed === 0 ? 0 : 1;
}
