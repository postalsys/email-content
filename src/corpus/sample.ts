/**
 * Stratified sampling over the corpus.
 *
 * Uniform random sampling of this corpus would produce a set that is almost entirely Gmail top
 * posts in English, because that is what the corpus mostly is. The structures that actually break
 * an extractor, interleaved replies, Outlook's unmarked history, malformed HTML, plain text only
 * mail, are each a percent or two, and a random sample of a few hundred messages would contain a
 * handful of each at best.
 *
 * So strata are defined by the structural properties that change how extraction behaves, each gets
 * a quota, and a random control slice is included alongside so that unbiased numbers remain
 * available. Selection within a stratum is deterministic: the same seed always picks the same
 * messages, regardless of database order.
 */

import { deterministicUnit } from '../util/hash';
import { type CorpusStore } from './store';

export interface Stratum {
    id: string;
    /** SQL predicate over the messages table, aliased m, joined to files as f. */
    predicate: string;
    /** Share of the total sample to allocate. Normalised across strata. */
    weight: number;
    description: string;
}

/**
 * The strata that matter, with the reason each one exists.
 *
 * Weights are not proportional to prevalence. They are proportional to how much is learned per
 * message, which for a rare structure is a great deal more.
 */
export const DEFAULT_STRATA: readonly Stratum[] = [
    { id: 'interleaved', predicate: "m.reply_style = 'interleaved'", weight: 3, description: 'inline question and answer, the highest cost failure mode' },
    { id: 'bottom-post', predicate: "m.reply_style = 'bottom'", weight: 2, description: 'answer below the quote' },
    { id: 'top-and-trailing', predicate: "m.reply_style = 'top-and-trailing'", weight: 2, description: 'top post with something after the quote' },
    { id: 'plain-only', predicate: "m.body_kind = 'plain-only'", weight: 2, description: 'no HTML to fall back on' },
    { id: 'html-only', predicate: "m.body_kind = 'html-only'", weight: 2, description: 'no plain text to fall back on' },
    { id: 'representations-disagree', predicate: 'm.quote_marking_disagrees = 1', weight: 2, description: 'plain and HTML tell different stories' },
    {
        id: 'outlook',
        predicate: "m.client IN ('outlook-desktop', 'outlook-web', 'outlook-mobile')",
        weight: 3,
        description: 'unmarked history, separators, nested x_ classes'
    },
    { id: 'gmail', predicate: "m.client = 'gmail'", weight: 2, description: 'the most common client' },
    { id: 'apple-mail', predicate: "m.client IN ('apple-mail', 'apple-mail-mobile')", weight: 2, description: 'blockquote type=cite' },
    { id: 'thunderbird', predicate: "m.client = 'thunderbird'", weight: 2, description: 'moz-cite-prefix' },
    { id: 'unknown-client', predicate: "m.client = 'unknown'", weight: 2, description: 'no client fingerprint at all' },
    { id: 'deep-quote', predicate: 'm.quote_depth_max >= 3', weight: 2, description: 'deeply nested threads' },
    { id: 'forwarded', predicate: 'm.is_forward = 1', weight: 2, description: 'forwarded content must never be lost' },
    { id: 'tables', predicate: 'm.table_count > 2', weight: 1, description: 'table heavy layout' },
    { id: 'malformed-html', predicate: 'm.suspect_malformed_html = 1', weight: 1, description: 'markup that needs a forgiving parser' },
    { id: 'legacy-charset', predicate: "m.charsets NOT LIKE '%utf-8%' AND m.charsets != ''", weight: 1, description: 'legacy charset decoding' },
    { id: 'non-english', predicate: "m.lang NOT IN ('en', 'unknown')", weight: 2, description: 'multilingual attribution lines' },
    { id: 'has-warnings', predicate: "m.warnings != ''", weight: 1, description: 'messages the parser complained about' },
    { id: 'random-control', predicate: '1 = 1', weight: 4, description: 'unbiased slice for honest aggregate numbers' }
];

export interface SampleOptions {
    /** Total messages wanted. */
    count: number;
    seed: string;
    /** Restrict to a traffic class, or 'all'. */
    traffic?: string;
    /** Only messages that look like replies. */
    repliesOnly?: boolean;
    /** Exclude these paths, for example ones already annotated. */
    exclude?: ReadonlySet<string>;
    strata?: readonly Stratum[];
}

export interface SampleRow {
    path: string;
    stratum: string;
}

export interface SampleResult {
    rows: SampleRow[];
    /** How many were taken from each stratum, and how many were available. */
    coverage: { id: string; requested: number; taken: number; available: number; description: string }[];
}

/**
 * Draw a stratified sample.
 *
 * Strata overlap by design: a message can be an Outlook interleaved reply in Estonian. It is
 * assigned to the first stratum that claims it, so the rarer strata listed earlier fill first, and
 * no message appears twice.
 */
export function stratifiedSample(store: CorpusStore, options: SampleOptions): SampleResult {
    const strata = options.strata ?? DEFAULT_STRATA;
    const exclude = options.exclude ?? new Set<string>();
    const totalWeight = strata.reduce((sum, stratum) => sum + stratum.weight, 0);

    const base: string[] = ["f.status = 'ok'"];
    if (options.traffic && options.traffic !== 'all') {
        base.push(`m.traffic = '${options.traffic.replace(/'/g, '')}'`);
    }
    if (options.repliesOnly !== false) {
        base.push('m.is_reply = 1');
    }

    const chosen = new Set<string>();
    const rows: SampleRow[] = [];
    const coverage: SampleResult['coverage'] = [];

    for (const stratum of strata) {
        const quota = Math.max(1, Math.round((options.count * stratum.weight) / totalWeight));
        const candidates = store
            .query<{ path: string }>(
                `SELECT m.path AS path FROM messages m JOIN files f ON f.path = m.path WHERE ${[...base, stratum.predicate].join(' AND ')}`
            )
            .map(row => row.path)
            .filter(path => !exclude.has(path) && !chosen.has(path));

        // Deterministic: hash each path with the seed and take the lowest values.
        const ranked = candidates
            .map(path => ({ path, score: deterministicUnit(`${options.seed}:${stratum.id}`, path) }))
            .sort((a, b) => a.score - b.score)
            .slice(0, quota);

        for (const item of ranked) {
            chosen.add(item.path);
            rows.push({ path: item.path, stratum: stratum.id });
        }

        coverage.push({
            id: stratum.id,
            requested: quota,
            taken: ranked.length,
            available: candidates.length,
            description: stratum.description
        });
    }

    return { rows, coverage };
}
