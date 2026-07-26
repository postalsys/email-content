/**
 * Stage 2: plain text canonicalisation.
 *
 * Offsets in the rest of the pipeline are character offsets into the canonical string produced
 * here, not byte offsets into the raw message. Traceability back to the file is via the owning MIME
 * part's byte range. That split is deliberate: transfer decoding, charset conversion and line
 * ending normalisation all change lengths, and maintaining a byte level offset map through three
 * lossy transforms would be fragile for no practical gain.
 *
 * What this module does NOT do is unwrap hard wrapped lines. Unwrapping changes offsets and can
 * merge a quoted line with a new one, which is exactly the mistake that loses content. Wrapping is
 * recorded as a per line property and resolved later, in the matching projection only.
 */

/** A single canonical line with its quote depth stripped out. */
export interface TextLine {
    /** Zero based index into the line array. */
    index: number;
    /** Character offset of the line start within the canonical text. */
    start: number;
    /** Character offset just past the line content, excluding the newline. */
    end: number;
    /** The line exactly as it appears in the canonical text, including any quote prefix. */
    raw: string;
    /** The line with its quote prefix removed. */
    content: string;
    /** Number of leading quote markers. Zero for unquoted lines. */
    depth: number;
    /** True when the line has no non whitespace content after prefix removal. */
    blank: boolean;
    /** True when this unquoted line was re-attached as the wrapped tail of the quote above it. */
    wrapContinuation?: boolean;
}

export interface CanonicalText {
    /** Normalised text. All offsets in the pipeline refer to this string. */
    text: string;
    lines: TextLine[];
}

export type ReplyStyle = 'none' | 'top' | 'bottom' | 'interleaved' | 'top-and-trailing' | 'quote-only';

export interface QuoteProfile {
    maxDepth: number;
    quotedLines: number;
    totalLines: number;
    /** Share of non blank lines that carry a quote prefix. */
    quotedRatio: number;
    style: ReplyStyle;
    /** Non blank unquoted lines before the first quoted line. */
    contentBefore: number;
    /** Non blank unquoted lines between the first and last quoted line. */
    contentBetween: number;
    /** Non blank unquoted lines after the last quoted line. */
    contentAfter: number;
}

/**
 * Quote prefix matcher.
 *
 * Accepts the common forms: ">", "> ", ">>", "> > ", and up to three leading spaces before the
 * first marker, which several clients add when re-wrapping. It deliberately does not accept "|"
 * or ":" as quote markers: both appear far too often in ordinary text, tables and code, and a
 * false positive here promotes new content into history.
 */
const QUOTE_PREFIX = /^[ \t]{0,3}((?:>[ \t]?)+)/;

/** Split a line into its quote depth and remaining content. */
export function splitQuotePrefix(line: string): { depth: number; content: string } {
    const match = QUOTE_PREFIX.exec(line);
    if (!match || !match[1]) {
        return { depth: 0, content: line };
    }
    const prefix = match[1];
    let depth = 0;
    for (let i = 0; i < prefix.length; i++) {
        if (prefix[i] === '>') {
            depth++;
        }
    }
    return { depth, content: line.slice(match[0].length) };
}

/**
 * Normalise decoded part text into the canonical form used by every later stage.
 *
 * Line endings become LF, a BOM is dropped, NUL bytes and lone carriage returns are removed, and
 * the result is NFC normalised so that visually identical text compares equal during history
 * matching. Nothing else is altered: no trimming, no whitespace collapsing, no unwrapping.
 */
export function canonicaliseText(input: string): CanonicalText {
    let text = input;
    if (text.charCodeAt(0) === 0xfeff) {
        text = text.slice(1);
    }
    text = text.replace(/\r\n?/g, '\n').replace(/\0/g, '');
    try {
        text = text.normalize('NFC');
    } catch {
        // Extremely long or malformed input can defeat NFC. The unnormalised text is still usable.
    }

    const lines: TextLine[] = [];
    let offset = 0;
    let index = 0;
    while (offset <= text.length) {
        let newline = text.indexOf('\n', offset);
        if (newline === -1) {
            newline = text.length;
        }
        const raw = text.slice(offset, newline);
        const { depth, content } = splitQuotePrefix(raw);
        lines.push({
            index,
            start: offset,
            end: newline,
            raw,
            content,
            depth,
            blank: content.trim().length === 0
        });
        index++;
        if (newline === text.length) {
            break;
        }
        offset = newline + 1;
    }

    reattachWrapContinuations(lines);
    return { text, lines };
}

/**
 * Re-attach quoted lines whose wrapped continuation lost its quote prefix.
 *
 * Some clients hard wrap a quoted paragraph and fail to re-apply the ">" marker to the continuation:
 *
 *     > First of all, sorry for the delay in giving some final information
 *     about the
 *     > course. After carefully seeing your preferences, plus my
 *
 * "about the" is the tail of the quoted sentence, not something the sender wrote. Left alone it
 * looks like unquoted content sitting between two quoted lines, which reads as an interleaved reply
 * and makes the whole quoted message look like inline context that must stay visible. One message
 * in the working corpus produced 30 such fragments and defeated the classifier completely.
 *
 * The test is deliberately narrow, because promoting real content into a quote is the expensive
 * direction of error. All of these must hold: the line is short, it is immediately adjacent to
 * quoted lines above and below with no blank line between, both neighbours are at the same depth,
 * and the quoted line above ends mid sentence. A genuine inline reply is separated by a blank line
 * and follows a quote that ended properly.
 *
 * Only the depth is adjusted. Offsets and raw text are untouched, so block tiling still reproduces
 * the input exactly.
 */
function reattachWrapContinuations(lines: TextLine[]): void {
    const MAX_CONTINUATION_CHARS = 60;

    for (let i = 1; i < lines.length - 1; i++) {
        const line = lines[i] as TextLine;
        if (line.depth !== 0 || line.blank || line.raw.length > MAX_CONTINUATION_CHARS) {
            continue;
        }
        const previous = lines[i - 1] as TextLine;
        const next = lines[i + 1] as TextLine;
        if (previous.depth === 0 || previous.blank || next.depth !== previous.depth || next.blank) {
            continue;
        }
        // A quoted line that ended a sentence was not cut off mid flow, so what follows is new.
        if (/[.!?:;)\]"']\s*$/.test(previous.content)) {
            continue;
        }
        line.depth = previous.depth;
        line.wrapContinuation = true;
    }
}

/**
 * Describe how quoting is laid out in a plain text body.
 *
 * The style categories are positional only. They describe where unquoted content sits relative to
 * quoted content and make no claim about intent, because a trailing block after a quote is just as
 * likely to be a signature as a genuine bottom posted answer. Deciding that is the classifier's
 * job, not this function's.
 */
export function profileQuoting(lines: readonly TextLine[]): QuoteProfile {
    const totalLines = lines.length;
    let quotedLines = 0;
    let maxDepth = 0;
    let nonBlank = 0;
    let firstQuote = -1;
    let lastQuote = -1;

    for (const line of lines) {
        if (line.depth > 0) {
            quotedLines++;
            maxDepth = Math.max(maxDepth, line.depth);
            if (firstQuote === -1) {
                firstQuote = line.index;
            }
            lastQuote = line.index;
        }
        if (!line.blank) {
            nonBlank++;
        }
    }

    if (firstQuote === -1) {
        return {
            maxDepth: 0,
            quotedLines: 0,
            totalLines,
            quotedRatio: 0,
            style: 'none',
            contentBefore: nonBlank,
            contentBetween: 0,
            contentAfter: 0
        };
    }

    let contentBefore = 0;
    let contentBetween = 0;
    let contentAfter = 0;
    for (const line of lines) {
        if (line.depth > 0 || line.blank) {
            continue;
        }
        if (line.index < firstQuote) {
            contentBefore++;
        } else if (line.index > lastQuote) {
            contentAfter++;
        } else {
            contentBetween++;
        }
    }

    let style: ReplyStyle;
    if (contentBetween > 0) {
        style = 'interleaved';
    } else if (contentBefore > 0 && contentAfter > 0) {
        style = 'top-and-trailing';
    } else if (contentBefore > 0) {
        style = 'top';
    } else if (contentAfter > 0) {
        style = 'bottom';
    } else {
        style = 'quote-only';
    }

    return {
        maxDepth,
        quotedLines,
        totalLines,
        quotedRatio: nonBlank ? quotedLines / nonBlank : 0,
        style,
        contentBefore,
        contentBetween,
        contentAfter
    };
}
