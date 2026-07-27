/**
 * `email-content benchmark` subcommand.
 *
 * Two jobs in one pass over a sample of the corpus: measure throughput and memory, and count the
 * catastrophic outcomes that matter more than any average. A benchmark that only reported
 * milliseconds per message would miss the failure this project exists to prevent.
 *
 * The catastrophic checks here are structural and need no labels, so they can run over hundreds of
 * thousands of messages. They are a floor, not a substitute for the labelled evaluation in Phase 4.
 *
 * Whether the input had content is decided by `src/eval/oracle.ts`, which re-parses the message and
 * never touches the extraction selection path. Deriving it from the output instead, which is what
 * this file used to do, made the headline catastrophic counter unable to see total content loss.
 */

import fs from 'node:fs';
import path from 'node:path';
import { extract } from '../index';
import { parseMessage } from '../mime/parse';
import { CorpusStore } from '../corpus/store';
import { coverageOf, inventoryVisibleInput, requiredCoverageGroups } from '../eval/oracle';
import { mimePartOf, type Label, type Reason, type Segment, type WarningCode } from '../types';
import { flagOptionalString, flagPositiveInt, flagString, type ParsedArgs } from './args';

/** Reasons that count as a structural anchor for hiding content. */
const ANCHOR_REASONS = new Set<Reason>([
    'preceded_by_reply_header',
    'preceded_by_forward_header',
    'inside_quote_container',
    'outlook_reply_separator',
    'matched_parent_message',
    'matched_thread_ancestor'
]);

/** Everything the structural gate can decide about one message. */
export interface MessageCheck {
    /** Visible body characters counted from the input, independently of extraction. */
    inputVisibleChars: number;
    visibleChars: number;
    hiddenChars: number;
    labels: Label[];
    warnings: WarningCode[];
    /** The message had visible body text and extraction returned nothing at all. */
    emptyFromNonEmpty: boolean;
    /** The message had visible body text and every segment was hidden. */
    everythingHidden: boolean;
    /** Something is visible, but all of it is a signature or a disclaimer. */
    onlyFooterVisible: boolean;
    /** At least one hidden segment names no structural or history reason. */
    hiddenWithoutAnchor: boolean;
    /** Forwarded content was hidden rather than collapsed. */
    forwardedHidden: boolean;
    /** HTML degraded to the malformed fallback and still produced no output. */
    degradedWithEmptyOutput: boolean;
    /** Required MIME coverage groups with no member anywhere in the output. */
    missingCoverageGroups: number;
    /** Alternative members deliberately not emitted. Reported apart from missing groups. */
    alternativesNotEmitted: number;
    /** Required groups represented only by hidden segments. */
    coverageHiddenOnly: number;
}

/**
 * Run the structural gate over one raw message.
 *
 * Exported so the committed fixture gate and its tests exercise exactly the code the corpus run
 * uses, rather than a re-implementation that could drift from it.
 */
export async function checkMessage(raw: Buffer): Promise<MessageCheck> {
    // Independent parse. The extractor's own view of the message is never consulted here.
    const parsed = await parseMessage(raw);
    const inventory = inventoryVisibleInput(parsed);
    const groups = requiredCoverageGroups(parsed);
    const result = await extract(raw);

    const visible = result.segments;
    const hidden = result.hiddenSegments;
    const visibleChars = visible.reduce((sum, segment) => sum + segment.text.length, 0);
    const hiddenChars = hidden.reduce((sum, segment) => sum + segment.text.length, 0);
    const warnings = result.warnings.map(warning => warning.code);
    const partsOf = (segments: readonly Segment[]) =>
        new Set(segments.map(segment => mimePartOf(segment.source)).filter((part): part is string => part !== null));
    const coverage = coverageOf(groups, partsOf(visible), partsOf(hidden));

    return {
        missingCoverageGroups: coverage.missing.length,
        alternativesNotEmitted: coverage.alternativesNotEmitted.length,
        coverageHiddenOnly: coverage.hiddenOnly.length,
        inputVisibleChars: inventory.visibleChars,
        visibleChars,
        hiddenChars,
        labels: [...visible, ...hidden].map(segment => segment.type),
        warnings,
        emptyFromNonEmpty: inventory.hasVisibleText && visibleChars + hiddenChars === 0,
        everythingHidden: inventory.hasVisibleText && visibleChars === 0,
        onlyFooterVisible: visible.length > 0 && visible.every(segment => segment.type === 'SIGNATURE' || segment.type === 'DISCLAIMER'),
        hiddenWithoutAnchor: hidden.some(segment => !segment.reasons.some(reason => ANCHOR_REASONS.has(reason))),
        forwardedHidden: hidden.some(segment => segment.type === 'FORWARDED_CONTENT'),
        degradedWithEmptyOutput: warnings.includes('html_parse_error') && visibleChars + hiddenChars === 0
    };
}

interface Counters {
    messages: number;
    errors: number;
    nonEmptyInputs: number;
    emptyFromNonEmpty: number;
    missingCoverageGroups: number;
    messagesMissingCoverage: number;
    alternativesNotEmitted: number;
    coverageHiddenOnly: number;
    everythingHidden: number;
    onlySignatureVisible: number;
    hiddenWithoutAnchor: number;
    forwardedHidden: number;
    degradedWithEmptyOutput: number;
    hiddenChars: number;
    visibleChars: number;
    labels: Map<Label, number>;
    warnings: Map<WarningCode, number>;
    durations: number[];
}

function newCounters(): Counters {
    return {
        messages: 0,
        errors: 0,
        nonEmptyInputs: 0,
        emptyFromNonEmpty: 0,
        missingCoverageGroups: 0,
        messagesMissingCoverage: 0,
        alternativesNotEmitted: 0,
        coverageHiddenOnly: 0,
        everythingHidden: 0,
        onlySignatureVisible: 0,
        hiddenWithoutAnchor: 0,
        forwardedHidden: 0,
        degradedWithEmptyOutput: 0,
        hiddenChars: 0,
        visibleChars: 0,
        labels: new Map(),
        warnings: new Map(),
        durations: []
    };
}

function record(counters: Counters, check: MessageCheck): void {
    counters.messages++;
    counters.visibleChars += check.visibleChars;
    counters.hiddenChars += check.hiddenChars;
    if (check.inputVisibleChars > 0) {
        counters.nonEmptyInputs++;
    }
    for (const label of check.labels) {
        counters.labels.set(label, (counters.labels.get(label) ?? 0) + 1);
    }
    // Per message, not per occurrence: a per warning tally divided by the message count is not a
    // percentage of anything, which is the bug the old hidden-without-anchor rate had.
    for (const code of new Set(check.warnings)) {
        counters.warnings.set(code, (counters.warnings.get(code) ?? 0) + 1);
    }
    counters.missingCoverageGroups += check.missingCoverageGroups;
    counters.alternativesNotEmitted += check.alternativesNotEmitted;
    counters.coverageHiddenOnly += check.coverageHiddenOnly;
    if (check.missingCoverageGroups > 0) {
        counters.messagesMissingCoverage++;
    }
    if (check.emptyFromNonEmpty) {
        counters.emptyFromNonEmpty++;
    }
    if (check.everythingHidden) {
        counters.everythingHidden++;
    }
    if (check.onlyFooterVisible) {
        counters.onlySignatureVisible++;
    }
    if (check.hiddenWithoutAnchor) {
        counters.hiddenWithoutAnchor++;
    }
    if (check.forwardedHidden) {
        counters.forwardedHidden++;
    }
    if (check.degradedWithEmptyOutput) {
        counters.degradedWithEmptyOutput++;
    }
}

function percentile(values: readonly number[], fraction: number): number {
    if (!values.length) {
        return 0;
    }
    const index = Math.min(values.length - 1, Math.max(0, Math.floor(values.length * fraction)));
    return values[index] ?? 0;
}

/** Resolve the list of message files to run, either from a directory or from the corpus database. */
function resolveInputs(args: ParsedArgs): { files: string[]; label: string } | { error: string; code: number } {
    const dir = flagOptionalString(args, 'dir');
    if (dir) {
        if (!fs.existsSync(dir)) {
            return { error: `no such directory: ${dir}`, code: 2 };
        }
        const files = fs
            .readdirSync(dir)
            .filter(name => name.endsWith('.eml'))
            .sort()
            .map(name => path.join(dir, name));
        return { files, label: `dir=${dir}` };
    }

    const dbPath = flagString(args, 'db', 'data/corpus.sqlite');
    if (!fs.existsSync(dbPath)) {
        return { error: `no corpus database at ${dbPath}. Run "corpus scan" first, or pass --dir.`, code: 2 };
    }

    const limit = flagPositiveInt(args, 'sample', 2000);
    const traffic = flagString(args, 'traffic', 'human');
    const onlyReplies = flagString(args, 'replies', 'true') !== 'false';

    const store = new CorpusStore(dbPath);
    try {
        // Only a run that finished cleanly. An interrupted or failed run holds partial output that
        // looks exactly like a small corpus, and reading it as a baseline approves a release against
        // whatever fraction of the messages happened to finish.
        const root = store.latestCompletedRun()?.root;
        if (!root) {
            return { error: 'no completed scan run found', code: 2 };
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
        return { files: rows.map(row => path.join(root, row.path)), label: `traffic=${traffic}, replies-only=${onlyReplies}` };
    } finally {
        store.close();
    }
}

export async function benchmarkCommand(args: ParsedArgs): Promise<number> {
    const inputs = resolveInputs(args);
    if ('error' in inputs) {
        process.stderr.write(`${inputs.error}\n`);
        return inputs.code;
    }
    if (!inputs.files.length) {
        process.stderr.write('no matching messages\n');
        return 1;
    }

    const counters = newCounters();
    const rssStart = process.memoryUsage.rss();
    let rssPeak = rssStart;
    const started = Date.now();

    for (const file of inputs.files) {
        let raw: Buffer;
        try {
            raw = fs.readFileSync(file);
        } catch {
            counters.errors++;
            continue;
        }

        const t0 = process.hrtime.bigint();
        let check: MessageCheck;
        try {
            check = await checkMessage(raw);
        } catch {
            counters.errors++;
            continue;
        }
        counters.durations.push(Number(process.hrtime.bigint() - t0) / 1e6);
        record(counters, check);

        if (counters.messages % 250 === 0) {
            rssPeak = Math.max(rssPeak, process.memoryUsage.rss());
        }
    }

    rssPeak = Math.max(rssPeak, process.memoryUsage.rss());
    const elapsed = Date.now() - started;
    counters.durations.sort((a, b) => a - b);

    const out: string[] = [];
    const pct = (value: number) => `${((100 * value) / Math.max(1, counters.messages)).toFixed(2)}%`;

    out.push(`sample: ${counters.messages} messages (${inputs.label})`);
    out.push(`errors: ${counters.errors}`);
    out.push('');
    out.push('THROUGHPUT');
    out.push(`  total            ${(elapsed / 1000).toFixed(1)}s`);
    out.push(`  rate             ${((counters.messages / Math.max(1, elapsed)) * 1000).toFixed(0)} messages/s (single threaded)`);
    out.push(`  per message p50  ${percentile(counters.durations, 0.5).toFixed(2)} ms`);
    out.push(`  per message p90  ${percentile(counters.durations, 0.9).toFixed(2)} ms`);
    out.push(`  per message p99  ${percentile(counters.durations, 0.99).toFixed(2)} ms`);
    out.push(`  per message max  ${percentile(counters.durations, 1).toFixed(2)} ms`);
    out.push(`  rss delta        ${((rssPeak - rssStart) / (1024 * 1024)).toFixed(0)} MB`);
    out.push('');
    out.push('CONTENT');
    const totalChars = counters.visibleChars + counters.hiddenChars;
    out.push(`  non empty inputs   ${counters.nonEmptyInputs} (${pct(counters.nonEmptyInputs)})`);
    out.push(
        `  visible characters ${counters.visibleChars.toLocaleString('en-US')} (${((100 * counters.visibleChars) / Math.max(1, totalChars)).toFixed(1)}%)`
    );
    out.push(`  hidden characters  ${counters.hiddenChars.toLocaleString('en-US')} (${((100 * counters.hiddenChars) / Math.max(1, totalChars)).toFixed(1)}%)`);
    out.push('');
    out.push('SEGMENT LABELS');
    for (const [label, count] of [...counters.labels].sort((a, b) => b[1] - a[1])) {
        out.push(`  ${label.padEnd(18)} ${String(count).padStart(7)}`);
    }
    if (counters.warnings.size) {
        out.push('');
        out.push('MESSAGES BY WARNING');
        for (const [code, count] of [...counters.warnings].sort((a, b) => b[1] - a[1])) {
            out.push(`  ${code.padEnd(34)} ${String(count).padStart(7)} (${pct(count)})`);
        }
    }
    out.push('');
    out.push('CATASTROPHIC CHECKS (structural, no labels required)');
    out.push(`  empty extraction from non empty message  ${counters.emptyFromNonEmpty} (${pct(counters.emptyFromNonEmpty)})`);
    out.push(`  all content hidden                       ${counters.everythingHidden} (${pct(counters.everythingHidden)})`);
    out.push(`  only a footer left visible               ${counters.onlySignatureVisible} (${pct(counters.onlySignatureVisible)})`);
    out.push(`  hidden without a structural anchor       ${counters.hiddenWithoutAnchor} (${pct(counters.hiddenWithoutAnchor)})`);
    out.push(`  forwarded content hidden                 ${counters.forwardedHidden} (${pct(counters.forwardedHidden)})`);
    out.push(`  degraded HTML with empty output          ${counters.degradedWithEmptyOutput} (${pct(counters.degradedWithEmptyOutput)})`);
    out.push(`  messages missing a MIME coverage group   ${counters.messagesMissingCoverage} (${pct(counters.messagesMissingCoverage)})`);
    out.push('');
    out.push('MIME COVERAGE (informational, not failures)');
    out.push(`  missing required groups                  ${counters.missingCoverageGroups}`);
    out.push(`  alternative members not emitted          ${counters.alternativesNotEmitted}`);
    out.push(`  groups represented only by hidden text   ${counters.coverageHiddenOnly}`);

    process.stdout.write(`${out.join('\n')}\n`);

    // A non zero exit makes this usable as a regression gate.
    const failed =
        counters.emptyFromNonEmpty +
        counters.everythingHidden +
        counters.hiddenWithoutAnchor +
        counters.forwardedHidden +
        counters.degradedWithEmptyOutput +
        counters.messagesMissingCoverage;
    return failed === 0 ? 0 : 1;
}
