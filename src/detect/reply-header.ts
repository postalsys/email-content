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
 *
 * The bracketed forms exclude their own opening delimiter on both sides of the `@`, so an opener
 * is charged only for the text up to the next one. With `<[^>]*@[^>]*>` every `<` in a run of them
 * rescanned all the `@` characters that followed: cubic, 1.5 seconds on a 3,000 character line
 * and minutes on 20 KB.
 */
const ORIGINATOR_VALUE = /(@[\w-]+\.[\w.-]+|<[^<>@]*@[^<>]*>|mailto:|\[[^[\]@]*@[^[\]]*\])/i;

/**
 * Longest field value the originator and date checks run on. A real From: or Sent: value is far
 * shorter, and the attribution line detector already rejects lines past this length. A longer
 * value still continues the block, like any value that fails its check, but earns no role.
 */
const MAX_CHECKED_VALUE_LENGTH = 300;

/**
 * A date field carries something date shaped: a numeric date, a month name, or a clock time.
 *
 * The month stems cover the languages the quoted header field names already cover, because a Sent
 * field whose value the date check cannot read contributes no date role, and the block then only
 * qualifies through a subject field.
 */
const DATE_VALUE =
    /(\d{1,4}[./-]\d{1,2}[./-]\d{1,4}|\b\d{1,2}:\d{2}\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|mon|tue|wed|thu|fri|sat|sun|maj|okt|sty|lut|kwi|cze|lip|sie|wrz|paz|lis|gru|tammi|helmi|maalis|huhti|touko|kesä|heinä|elo|syys|loka|marras|joulu)[a-zäö]*\.?\b|(^|\s)(янв|фев|мар|апр|ма[йя]|июн|июл|авг|сен|окт|ноя|дек)|\b(esmaspäev|teisipäev|kolmapäev|neljapäev|reede|laupäev|pühapäev|montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\b)/i;

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
    // Clients that derive plain text from HTML write links out as "mailto:" URLs, and SnappyMail
    // puts one inside every attribution, fully URL encoded: '"Marta Kask" <marta@example.com
    // mailto:marta@example.com?to=%22Marta...%3E > schrieb:'. The URL says nothing about the line's
    // shape but pushes it past the length limits, so it is dropped before matching. The raw line is
    // bounded first so the replace stays cheap on hostile input.
    if (line.length > 2000) {
        return null;
    }
    // Only lines that contain a URL pay for the replace, and it has no leading whitespace class:
    // "\s*" before the literal was retried at every position of a long space run, quadratic in
    // its length (1 MB of such lines blocked for over a second).
    const trimmed = (/mailto:/i.test(line) ? line.replace(/ ?\bmailto:\S+/gi, '') : line).trim();
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

/**
 * A sentence announcing that the reply is written into the quoted text: "my answers are inline",
 * "Answers are in your letter". Evidence only; the rules decide what it changes, and only for
 * authored text above the history. Lines are bounded like attribution lines so a hostile
 * single-line body stays cheap.
 */
export function detectInlineAnnouncement(lines: readonly string[]): Evidence | null {
    const patterns = loadPatterns().inlineAnnouncements;
    for (const line of lines) {
        if (line.length > 2000) {
            continue;
        }
        const pattern = patterns.find(candidate => candidate.regex.test(line));
        if (pattern) {
            return { id: `announce:${pattern.id}`, kind: 'hint', strength: pattern.strength };
        }
    }
    return null;
}

/** Is this run of header-shaped lines convincing enough to anchor a region? */
function isStrong(roles: ReadonlySet<string>): boolean {
    // A convincing block names the originator plus at least a date or a subject, so that a
    // pasted "To: ... Cc: ..." address list on its own does not qualify. A transport field means a
    // raw header dump, which clients never produce in a reply, so it disqualifies the chain.
    return !roles.has('transport') && roles.size >= MIN_FIELDS && roles.has('originator') && (roles.has('date') || roles.has('subject'));
}

/**
 * A field line that is really source code or prose: a lowercase field name ("from:" in a JavaScript
 * object literal) or a value that ends in a comma. Client header blocks capitalise the field name
 * in every language the patterns cover and never end a value with a comma. Measured on the corpus:
 * a pasted nodemailer example hid the console output the sender asked about.
 */
function looksLikeCode(line: string, value: string): boolean {
    return /^[a-z]/.test(line) || value.endsWith(',');
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
        if (role === 'transport') {
            roles.add(role);
        } else if (looksLikeCode(line, value)) {
            // Continues the chain like any field line, but earns no role.
        } else if (role === 'originator' || role === 'date') {
            if (value.length <= MAX_CHECKED_VALUE_LENGTH && (role === 'originator' ? ORIGINATOR_VALUE : DATE_VALUE).test(value)) {
                roles.add(role);
            }
        } else {
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
