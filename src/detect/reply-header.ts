/**
 * Reply attribution detection.
 *
 * Two shapes are handled, and the difference matters:
 *
 *   1. A single attribution line: "On Mon, 13 Jan 2025 at 09:15, Bob wrote:". One line, strong.
 *   2. An embedded copy of the previous message's headers, which Outlook and several webmail
 *      clients emit as consecutive From/Sent/To/Subject lines.
 *
 * The second shape needs care. A single "From:" line is not evidence of anything, because ordinary
 * prose starts that way often enough to matter. Only a run of consecutive field lines including a
 * date-like or subject field counts, and even then the strength is capped below the single line
 * attribution, because a person pasting an address block looks identical.
 */

import { loadPatterns } from './patterns';
import { type Evidence } from '../segment/types';

/** Longest run of blank lines tolerated inside an embedded header block. */
const MAX_GAP = 1;

/** Minimum distinct fields before a run of header-like lines counts as an anchor. */
const MIN_FIELDS = 3;

/**
 * An embedded From: line carries an actual address, in one form or another. Prose that happens to
 * begin with "From:" does not.
 *
 * This check is what separates a real Outlook header block from a sentence like
 * "From: the address that sent the message", which appears in `text-mentions-headers.eml` and in
 * real support mail often enough to matter. Without it, an instruction list describing email
 * headers is classified as reply history and disappears.
 */
const ORIGINATOR_VALUE = /(@[\w-]+\.[\w.-]+|<[^>]*@[^>]*>|mailto:|\[[^\]]*@[^\]]*\])/i;

/** A date field carries something date shaped: a numeric date, a month name, or a clock time. */
const DATE_VALUE =
    /(\d{1,4}[./-]\d{1,2}[./-]\d{1,4}|\b\d{1,2}:\d{2}\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?\b|\b(esmaspäev|teisipäev|kolmapäev|neljapäev|reede|laupäev|pühapäev|montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\b)/i;

function valueOf(line: string): string {
    const colon = line.indexOf(':');
    return colon === -1 ? '' : line.slice(colon + 1).trim();
}

export interface ReplyHeaderMatch {
    /** First line index of the anchor, inclusive. */
    startLine: number;
    /** Last line index of the anchor, inclusive. */
    endLine: number;
    evidence: Evidence;
}

/**
 * Detect a single line attribution.
 *
 * Lines longer than 300 characters are rejected: a genuine attribution line is short, and a long
 * one is almost always a paragraph that happens to end in "wrote:".
 */
export function detectAttributionLine(line: string): Evidence | null {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length > 300) {
        return null;
    }
    const patterns = loadPatterns();
    let best: Evidence | null = null;
    for (const pattern of patterns.replyHeaders) {
        if (!pattern.regex.test(trimmed)) {
            continue;
        }
        if (!best || pattern.strength > best.strength) {
            best = { id: `reply:${pattern.id}`, kind: 'reply-anchor', strength: pattern.strength };
        }
    }
    return best;
}

/** Is this run of header-shaped lines convincing enough to anchor a region? */
function isStrong(roles: ReadonlySet<string>): boolean {
    // A convincing block names the originator plus at least a date or a subject, so that a
    // pasted "To: ... Cc: ..." address list on its own does not qualify.
    return roles.size >= MIN_FIELDS && roles.has('originator') && (roles.has('date') || roles.has('subject'));
}

/**
 * Detect an embedded header block starting at or after `from`.
 *
 * Returns the first match found, scanning forward. The caller supplies de-prefixed line content so
 * that a header block inside a quote is detected the same way as one outside it.
 *
 * Single pass, deliberately. The obvious implementation restarts an inner forward scan at every
 * candidate line, which is quadratic: 12,000 consecutive `Cc:` lines never form a strong block but
 * make the inner scan traverse almost the whole remaining input from every outer position, and
 * measured at 4.8 seconds of blocked event loop on that input. Inbound mail is attacker controlled,
 * so that is a denial of service, not a slow path.
 *
 * The single pass is exactly equivalent, not an approximation. Lines partition into *chains*:
 * maximal runs of header-shaped lines joined by blank gaps of at most `MAX_GAP`, terminated by any
 * other line or by a longer blank run. The set of roles collected from a start inside a chain is a
 * subset of the set collected from the chain's own start, and strength is monotone under superset,
 * so if the chain start is not strong no later start in that chain can be, and if it is strong it
 * is also the earliest strong start. Checking each chain once therefore returns the same match the
 * restarting scan did.
 */
export function detectQuotedHeaderBlock(lines: readonly string[], from = 0): ReplyHeaderMatch | null {
    const patterns = loadPatterns();

    const evidence: Evidence = {
        id: 'reply:quoted_header_block',
        kind: 'reply-anchor',
        // Below a single line attribution on purpose: a person can paste this shape.
        strength: 0.88
    };

    // Start of the chain currently being accumulated, which may be a blank line: the restarting
    // scan reported the outer index it began at, and that index is allowed to sit on the at most
    // MAX_GAP blank lines that lead into the first field.
    let chainStart = -1;
    let roles = new Set<string>();
    let last = -1;
    let gap = 0;

    for (let j = Math.max(0, from); j < lines.length; j++) {
        const line = (lines[j] ?? '').trim();

        if (!line) {
            if (chainStart === -1) {
                chainStart = j;
                gap = 1;
                continue;
            }
            gap++;
            if (gap <= MAX_GAP) {
                continue;
            }
            // The blank run is now too long to be an internal gap. Close the chain, then begin a
            // new tentative one far enough into the blank run that exactly MAX_GAP blanks can still
            // precede a following field line, which is where the restarting scan would have found
            // its next viable start.
            if (isStrong(roles) && last >= chainStart) {
                return { startLine: chainStart, endLine: last, evidence };
            }
            roles = new Set<string>();
            last = -1;
            chainStart = j - MAX_GAP + 1;
            gap = MAX_GAP;
            continue;
        }

        const matched = patterns.quotedHeaderFields.find(pattern => pattern.regex.test(line));
        if (!matched) {
            // Ordinary content terminates the chain outright.
            if (isStrong(roles) && last >= chainStart && chainStart !== -1) {
                return { startLine: chainStart, endLine: last, evidence };
            }
            roles = new Set<string>();
            last = -1;
            chainStart = -1;
            gap = 0;
            continue;
        }

        if (chainStart === -1) {
            chainStart = j;
        }
        gap = 0;
        const role = matched.role || matched.id;
        const value = valueOf(line);
        // Only fields whose value looks like a real header value count towards the threshold.
        // The line still continues the block either way, so a "Subject:" with unusual content
        // does not truncate an otherwise convincing header block.
        if (role === 'originator' ? ORIGINATOR_VALUE.test(value) : role === 'date' ? DATE_VALUE.test(value) : true) {
            roles.add(role);
        }
        last = j;
    }

    if (chainStart !== -1 && isStrong(roles) && last >= chainStart) {
        return { startLine: chainStart, endLine: last, evidence };
    }

    return null;
}

/**
 * Detect the Outlook style horizontal rule, a long run of underscores on its own line.
 *
 * Weak on its own. It is only meaningful when an embedded header block follows within a few lines,
 * which the segmenter checks.
 */
export function detectRuleSeparator(line: string): Evidence | null {
    const trimmed = line.trim();
    if (/^_{10,}$/.test(trimmed)) {
        return { id: 'reply:outlook_underscore_rule', kind: 'separator', strength: 0.6 };
    }
    if (/^[*=~]{10,}$/.test(trimmed)) {
        return { id: 'separator:symbol_rule', kind: 'separator', strength: 0.35 };
    }
    return null;
}
