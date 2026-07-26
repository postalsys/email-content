/**
 * Aggregate corpus statistics.
 *
 * Everything here is a count, a ratio or a percentile. No subject, address or body text is read,
 * and the only free text that reaches the report is a MIME structure signature and detector ids,
 * both of which are drawn from a closed vocabulary. That is what makes the report safe to paste
 * into a document or an issue.
 */

import { type CorpusStore } from './store';

export interface Distribution {
    label: string;
    count: number;
    share: number;
}

export interface CorpusStats {
    generatedAt: string;
    files: {
        total: number;
        ok: number;
        failed: number;
        oversize: number;
        timeout: number;
        skipped: number;
    };
    errors: Distribution[];
    sizeBytes: { p10: number; p50: number; p90: number; p99: number; max: number; total: number };
    parseWarnings: Distribution[];
    bodyKind: Distribution[];
    structures: Distribution[];
    charsets: Distribution[];
    encodings: Distribution[];
    traffic: Distribution[];
    clients: Distribution[];
    clientSources: Distribution[];
    subjectPrefix: Distribution[];
    replyStyle: Distribution[];
    quoteDepth: Distribution[];
    markers: Distribution[];
    htmlHints: Distribution[];
    languages: Distribution[];
    duplicates: {
        distinctSha256: number;
        filesInDuplicateGroups: number;
        distinctSimhash: number;
        filesInNearDuplicateGroups: number;
    };
    threading: {
        withMessageId: number;
        withInReplyTo: number;
        parentResolvedInCorpus: number;
        withReferences: number;
        ancestorResolvedInCorpus: number;
    };
    humanSlice: {
        total: number;
        replies: number;
        repliesWithParentInCorpus: number;
        bothRepresentations: number;
        quoteMarkingDisagrees: number;
    };
    contentAgreement: {
        messagesWithBoth: number;
        quoteMarkingDisagrees: number;
    };
}

interface CountRow {
    /** SQLite returns integers for numeric columns, so this is not always a string. */
    label: string | number | null;
    count: number;
}

function toDistribution(rows: readonly CountRow[], total: number, limit = 25): Distribution[] {
    return rows
        .filter(row => row.count > 0)
        .sort((a, b) => b.count - a.count)
        .slice(0, limit)
        .map(row => ({
            label: row.label === null || row.label === '' ? '(none)' : String(row.label),
            count: row.count,
            share: total ? row.count / total : 0
        }));
}

/**
 * Expand a comma separated column into per token counts.
 *
 * Grouping in SQL first keeps this cheap: a few thousand distinct combinations are fetched instead
 * of one row per message.
 */
function expandMultiValue(store: CorpusStore, column: string, total: number, limit = 30): Distribution[] {
    const rows = store.query<{ value: string | null; count: number }>(`SELECT ${column} AS value, COUNT(*) AS count FROM messages GROUP BY ${column}`);
    const counts = new Map<string, number>();
    for (const row of rows) {
        const raw = row.value || '';
        if (!raw) {
            counts.set('(none)', (counts.get('(none)') || 0) + row.count);
            continue;
        }
        for (const token of raw.split(',')) {
            const key = token.trim();
            if (key) {
                counts.set(key, (counts.get(key) || 0) + row.count);
            }
        }
    }
    return toDistribution(
        [...counts].map(([label, count]) => ({ label, count })),
        total,
        limit
    );
}

function groupCounts(store: CorpusStore, column: string, table = 'messages'): CountRow[] {
    return store.query<CountRow>(`SELECT ${column} AS label, COUNT(*) AS count FROM ${table} GROUP BY ${column}`);
}

function percentile(store: CorpusStore, fraction: number, total: number): number {
    if (!total) {
        return 0;
    }
    const offset = Math.min(total - 1, Math.max(0, Math.floor(total * fraction)));
    const row = store.queryOne<{ size: number }>('SELECT size FROM files ORDER BY size LIMIT 1 OFFSET ?', offset);
    return row?.size ?? 0;
}

export function computeStats(store: CorpusStore): CorpusStats {
    const fileTotal = store.queryOne<{ count: number }>('SELECT COUNT(*) AS count FROM files')?.count ?? 0;
    const statusRows = groupCounts(store, 'status', 'files');
    const statusOf = (status: string) => statusRows.find(row => row.label === status)?.count ?? 0;

    const messageTotal = store.queryOne<{ count: number }>('SELECT COUNT(*) AS count FROM messages')?.count ?? 0;

    const withMessageId =
        store.queryOne<{ count: number }>("SELECT COUNT(*) AS count FROM messages WHERE message_id IS NOT NULL AND message_id != ''")?.count ?? 0;
    const withInReplyTo = store.queryOne<{ count: number }>('SELECT COUNT(*) AS count FROM messages WHERE in_reply_to IS NOT NULL')?.count ?? 0;
    const parentResolved =
        store.queryOne<{ count: number }>(
            'SELECT COUNT(*) AS count FROM messages m WHERE m.in_reply_to IS NOT NULL AND EXISTS (SELECT 1 FROM messages p WHERE p.message_id = m.in_reply_to)'
        )?.count ?? 0;
    const withReferences = store.queryOne<{ count: number }>('SELECT COUNT(*) AS count FROM messages WHERE references_count > 0')?.count ?? 0;
    const ancestorResolved =
        store.queryOne<{ count: number }>(
            'SELECT COUNT(*) AS count FROM messages m WHERE m.references_root IS NOT NULL AND EXISTS (SELECT 1 FROM messages p WHERE p.message_id = m.references_root)'
        )?.count ?? 0;

    const humanTotal = store.queryOne<{ count: number }>("SELECT COUNT(*) AS count FROM messages WHERE traffic = 'human'")?.count ?? 0;
    const humanReplies = store.queryOne<{ count: number }>("SELECT COUNT(*) AS count FROM messages WHERE traffic = 'human' AND is_reply = 1")?.count ?? 0;
    const humanRepliesResolved =
        store.queryOne<{ count: number }>(
            "SELECT COUNT(*) AS count FROM messages m WHERE m.traffic = 'human' AND m.in_reply_to IS NOT NULL AND EXISTS (SELECT 1 FROM messages p WHERE p.message_id = m.in_reply_to)"
        )?.count ?? 0;
    const humanBoth = store.queryOne<{ count: number }>("SELECT COUNT(*) AS count FROM messages WHERE traffic = 'human' AND body_kind = 'both'")?.count ?? 0;
    const humanDisagree =
        store.queryOne<{ count: number }>("SELECT COUNT(*) AS count FROM messages WHERE traffic = 'human' AND quote_marking_disagrees = 1")?.count ?? 0;

    const distinctSha = store.queryOne<{ count: number }>('SELECT COUNT(DISTINCT sha256) AS count FROM files WHERE sha256 IS NOT NULL')?.count ?? 0;
    const inDupGroups =
        store.queryOne<{ count: number }>(
            'SELECT COALESCE(SUM(c), 0) AS count FROM (SELECT COUNT(*) AS c FROM files WHERE sha256 IS NOT NULL GROUP BY sha256 HAVING c > 1)'
        )?.count ?? 0;
    const distinctSimhash =
        store.queryOne<{ count: number }>(
            "SELECT COUNT(DISTINCT body_simhash) AS count FROM messages WHERE body_simhash IS NOT NULL AND body_simhash != '0000000000000000'"
        )?.count ?? 0;
    const inNearDupGroups =
        store.queryOne<{ count: number }>(
            "SELECT COALESCE(SUM(c), 0) AS count FROM (SELECT COUNT(*) AS c FROM messages WHERE body_simhash IS NOT NULL AND body_simhash != '0000000000000000' GROUP BY body_simhash HAVING c > 1)"
        )?.count ?? 0;

    const bothRepresentations = store.queryOne<{ count: number }>("SELECT COUNT(*) AS count FROM messages WHERE body_kind = 'both'")?.count ?? 0;
    const disagree = store.queryOne<{ count: number }>('SELECT COUNT(*) AS count FROM messages WHERE quote_marking_disagrees = 1')?.count ?? 0;

    const totalBytes = store.queryOne<{ total: number }>('SELECT COALESCE(SUM(size), 0) AS total FROM files')?.total ?? 0;

    return {
        generatedAt: new Date().toISOString(),
        files: {
            total: fileTotal,
            ok: statusOf('ok'),
            failed: statusOf('failed'),
            oversize: statusOf('oversize'),
            timeout: statusOf('timeout'),
            skipped: statusOf('skipped')
        },
        errors: toDistribution(
            groupCounts(store, 'error_code', 'files').filter(row => row.label),
            fileTotal
        ),
        sizeBytes: {
            p10: percentile(store, 0.1, fileTotal),
            p50: percentile(store, 0.5, fileTotal),
            p90: percentile(store, 0.9, fileTotal),
            p99: percentile(store, 0.99, fileTotal),
            max: store.queryOne<{ size: number }>('SELECT MAX(size) AS size FROM files')?.size ?? 0,
            total: totalBytes
        },
        parseWarnings: expandMultiValue(store, 'warnings', messageTotal),
        bodyKind: toDistribution(groupCounts(store, 'body_kind'), messageTotal),
        structures: toDistribution(groupCounts(store, 'structure'), messageTotal, 25),
        charsets: expandMultiValue(store, 'charsets', messageTotal, 20),
        encodings: expandMultiValue(store, 'encodings', messageTotal, 12),
        traffic: toDistribution(groupCounts(store, 'traffic'), messageTotal),
        clients: toDistribution(groupCounts(store, 'client'), messageTotal, 25),
        clientSources: toDistribution(groupCounts(store, 'client_source'), messageTotal),
        subjectPrefix: toDistribution(groupCounts(store, 'subject_prefix'), messageTotal),
        replyStyle: toDistribution(groupCounts(store, 'reply_style'), messageTotal),
        quoteDepth: toDistribution(groupCounts(store, 'quote_depth_max'), messageTotal, 10),
        markers: expandMultiValue(store, 'markers', messageTotal, 30),
        htmlHints: expandMultiValue(store, 'html_hints', messageTotal, 25),
        languages: toDistribution(groupCounts(store, 'lang'), messageTotal, 15),
        duplicates: {
            distinctSha256: distinctSha,
            filesInDuplicateGroups: inDupGroups,
            distinctSimhash,
            filesInNearDuplicateGroups: inNearDupGroups
        },
        threading: {
            withMessageId,
            withInReplyTo,
            parentResolvedInCorpus: parentResolved,
            withReferences,
            ancestorResolvedInCorpus: ancestorResolved
        },
        humanSlice: {
            total: humanTotal,
            replies: humanReplies,
            repliesWithParentInCorpus: humanRepliesResolved,
            bothRepresentations: humanBoth,
            quoteMarkingDisagrees: humanDisagree
        },
        contentAgreement: {
            messagesWithBoth: bothRepresentations,
            quoteMarkingDisagrees: disagree
        }
    };
}

function pct(value: number, total: number): string {
    if (!total) {
        return '0.0%';
    }
    return `${((100 * value) / total).toFixed(1)}%`;
}

function bytes(value: number): string {
    if (value >= 1024 * 1024 * 1024) {
        return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
    }
    if (value >= 1024 * 1024) {
        return `${(value / (1024 * 1024)).toFixed(1)} MB`;
    }
    if (value >= 1024) {
        return `${(value / 1024).toFixed(1)} KB`;
    }
    return `${value} B`;
}

function table(title: string, rows: readonly Distribution[]): string {
    if (!rows.length) {
        return `### ${title}\n\nNo data.\n`;
    }
    const lines = ['### ' + title, '', '| value | count | share |', '| --- | ---: | ---: |'];
    for (const row of rows) {
        lines.push(`| \`${row.label.replace(/\|/g, '\\|')}\` | ${row.count.toLocaleString('en-US')} | ${(row.share * 100).toFixed(1)}% |`);
    }
    lines.push('');
    return lines.join('\n');
}

/** Render the statistics as a Markdown report. Safe to share: contains no message content. */
export function renderReport(stats: CorpusStats, root: string): string {
    const files = stats.files;
    const messages = stats.files.ok;
    const out: string[] = [];

    out.push('# Corpus report', '');
    out.push(`Generated ${stats.generatedAt} from \`${root}\`.`, '');
    out.push(
        'This report contains aggregate statistics only. No subject lines, addresses or body text are',
        'stored or displayed. Detector names come from a closed vocabulary defined in',
        '`src/detect/patterns/`.',
        ''
    );

    out.push('## Files', '');
    out.push('| metric | value |', '| --- | ---: |');
    out.push(`| files scanned | ${files.total.toLocaleString('en-US')} |`);
    out.push(`| parsed successfully | ${files.ok.toLocaleString('en-US')} (${pct(files.ok, files.total)}) |`);
    out.push(`| parse failures | ${files.failed.toLocaleString('en-US')} (${pct(files.failed, files.total)}) |`);
    out.push(`| oversize, not parsed | ${files.oversize.toLocaleString('en-US')} |`);
    out.push(`| timed out | ${files.timeout.toLocaleString('en-US')} |`);
    out.push(`| total bytes | ${bytes(stats.sizeBytes.total)} |`);
    out.push(
        `| size p10 / p50 / p90 / p99 / max | ${bytes(stats.sizeBytes.p10)} / ${bytes(stats.sizeBytes.p50)} / ${bytes(stats.sizeBytes.p90)} / ${bytes(stats.sizeBytes.p99)} / ${bytes(stats.sizeBytes.max)} |`
    );
    out.push('');

    if (stats.errors.length) {
        out.push(table('Failure reasons', stats.errors));
    }

    out.push('## Threading', '');
    out.push('| metric | value | share |', '| --- | ---: | ---: |');
    out.push(`| messages with Message-ID | ${stats.threading.withMessageId.toLocaleString('en-US')} | ${pct(stats.threading.withMessageId, messages)} |`);
    out.push(`| messages with In-Reply-To | ${stats.threading.withInReplyTo.toLocaleString('en-US')} | ${pct(stats.threading.withInReplyTo, messages)} |`);
    out.push(
        `| **parent present in corpus** | ${stats.threading.parentResolvedInCorpus.toLocaleString('en-US')} | ${pct(stats.threading.parentResolvedInCorpus, stats.threading.withInReplyTo)} of replies |`
    );
    out.push(`| messages with References | ${stats.threading.withReferences.toLocaleString('en-US')} | ${pct(stats.threading.withReferences, messages)} |`);
    out.push(
        `| thread root present in corpus | ${stats.threading.ancestorResolvedInCorpus.toLocaleString('en-US')} | ${pct(stats.threading.ancestorResolvedInCorpus, stats.threading.withReferences)} of those |`
    );
    out.push('');
    out.push(
        'Parent resolution is what makes distant supervision possible: when the parent message is in',
        'the corpus, any text the extractor hides can be checked against text that demonstrably',
        'existed before, without a human labelling it.',
        ''
    );

    out.push('## Human conversation slice', '');
    out.push('| metric | value | share |', '| --- | ---: | ---: |');
    out.push(`| classified human | ${stats.humanSlice.total.toLocaleString('en-US')} | ${pct(stats.humanSlice.total, messages)} of all |`);
    out.push(`| human replies | ${stats.humanSlice.replies.toLocaleString('en-US')} | ${pct(stats.humanSlice.replies, stats.humanSlice.total)} of human |`);
    out.push(
        `| human replies with parent in corpus | ${stats.humanSlice.repliesWithParentInCorpus.toLocaleString('en-US')} | ${pct(stats.humanSlice.repliesWithParentInCorpus, stats.humanSlice.replies)} of human replies |`
    );
    out.push(
        `| human, both plain and HTML | ${stats.humanSlice.bothRepresentations.toLocaleString('en-US')} | ${pct(stats.humanSlice.bothRepresentations, stats.humanSlice.total)} |`
    );
    out.push(
        `| human, plain and HTML disagree on quoting | ${stats.humanSlice.quoteMarkingDisagrees.toLocaleString('en-US')} | ${pct(stats.humanSlice.quoteMarkingDisagrees, stats.humanSlice.bothRepresentations)} of those |`
    );
    out.push('');

    out.push('## Duplicates', '');
    out.push('| metric | value |', '| --- | ---: |');
    out.push(`| distinct file hashes | ${stats.duplicates.distinctSha256.toLocaleString('en-US')} of ${files.total.toLocaleString('en-US')} |`);
    out.push(`| files in exact duplicate groups | ${stats.duplicates.filesInDuplicateGroups.toLocaleString('en-US')} |`);
    out.push(`| distinct body SimHashes | ${stats.duplicates.distinctSimhash.toLocaleString('en-US')} |`);
    out.push(`| files sharing a body SimHash | ${stats.duplicates.filesInNearDuplicateGroups.toLocaleString('en-US')} |`);
    out.push('');
    out.push('SimHash collisions are a lower bound on near duplicates: only identical hashes are counted here, not small Hamming distances.', '');

    out.push('## Structure', '');
    out.push(table('Body composition', stats.bodyKind));
    out.push(table('MIME structures', stats.structures));
    out.push(table('Charsets', stats.charsets));
    out.push(table('Transfer encodings', stats.encodings));
    out.push(table('Parse warnings', stats.parseWarnings));

    out.push('## Traffic and clients', '');
    out.push(table('Traffic class', stats.traffic));
    out.push(table('Composing client', stats.clients));
    out.push(table('Client evidence source', stats.clientSources));

    out.push('## Reply structure', '');
    out.push(table('Subject prefix', stats.subjectPrefix));
    out.push(table('Plain text reply style', stats.replyStyle));
    out.push(table('Maximum quote depth', stats.quoteDepth));
    out.push(table('Line level markers detected', stats.markers));
    out.push(table('HTML structure hints', stats.htmlHints));

    out.push('## Language', '');
    out.push(table('Estimated language', stats.languages));

    out.push('## Plain text and HTML agreement', '');
    out.push(`Messages carrying both representations: ${stats.contentAgreement.messagesWithBoth.toLocaleString('en-US')}.`, '');
    out.push(
        `Quote marking disagrees between the two in ${stats.contentAgreement.quoteMarkingDisagrees.toLocaleString('en-US')} of them ` +
            `(${pct(stats.contentAgreement.quoteMarkingDisagrees, stats.contentAgreement.messagesWithBoth)}).`,
        ''
    );
    out.push(
        'Disagreement is the norm rather than the exception, and it is almost always the plain part',
        'that has lost the quote markers. That is why HTML is the primary representation when both',
        'are present.',
        ''
    );

    return out.join('\n');
}
