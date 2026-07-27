/**
 * HTML helpers used by the corpus scanner.
 *
 * Full DOM based block segmentation belongs to the extraction pipeline and is intentionally not
 * done here. A corpus pass over 320k files runs this code once per message, and parsing every
 * newsletter into a DOM to compute aggregate statistics would dominate the whole scan. The client
 * hints this module looks for are literal class and id names, so a scan over the source is both
 * cheaper and more faithful than a DOM query, which would silently normalise malformed markup.
 */

/** Entities common in mail. Numeric references are handled separately. */
const NAMED_ENTITIES: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    ndash: '–',
    mdash: '—',
    lsquo: '‘',
    rsquo: '’',
    ldquo: '“',
    rdquo: '”',
    hellip: '…',
    bull: '•',
    middot: '·',
    laquo: '«',
    raquo: '»',
    copy: '©',
    reg: '®',
    trade: '™',
    euro: '€',
    pound: '£',
    deg: '°',
    szlig: 'ß',
    auml: 'ä',
    ouml: 'ö',
    uuml: 'ü',
    Auml: 'Ä',
    Ouml: 'Ö',
    Uuml: 'Ü',
    aring: 'å',
    Aring: 'Å',
    aelig: 'æ',
    oslash: 'ø',
    eacute: 'é',
    egrave: 'è',
    agrave: 'à',
    ccedil: 'ç',
    ntilde: 'ñ',
    shy: '­',
    zwnj: '‌',
    zwj: '‍'
};

/**
 * Decode HTML entities. Unknown entities are left as written rather than dropped.
 *
 * Both alternatives are length bounded so the pass stays linear on hostile input: a numeric
 * reference longer than twelve digits cannot name a code point, and an unbounded `+` there would
 * backtrack across the whole run of digits that follows an unterminated `&#`.
 */
export function decodeEntities(input: string): string {
    if (!input.includes('&')) {
        return input;
    }
    return input.replace(/&(#[xX]?[0-9a-fA-F]{1,12}|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (whole, body: string) => {
        if (body.charCodeAt(0) === 35) {
            const isHex = body[1] === 'x' || body[1] === 'X';
            const code = parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
            if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) {
                return whole;
            }
            try {
                return String.fromCodePoint(code);
            } catch {
                return whole;
            }
        }
        const named = NAMED_ENTITIES[body];
        return named === undefined ? whole : named;
    });
}

/** Elements whose content is code rather than prose, and must never reach the projection. */
const RAW_TEXT_TAGS = new Set(['script', 'style']);

/** Elements whose content is not rendered in the body, but is still prose if the close tag is lost. */
const HIDDEN_TAGS = new Set(['head', 'title', 'noscript', 'template']);

/** Elements that introduce a line break in the text projection. */
const BLOCK_BREAK_TAGS = new Set([
    'p',
    'div',
    'br',
    'tr',
    'li',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'table',
    'blockquote',
    'pre',
    'hr',
    'section',
    'article',
    'ul',
    'ol',
    'dd',
    'dt'
]);

/**
 * Longest markup construct scanned before the opening `<` is given up on.
 *
 * Real tags are far shorter. The cap exists so that a document consisting of `<` characters with no
 * closing delimiter cannot make the scanner re-read the suffix once per `<`.
 */
const MAX_TAG_LENGTH = 8192;

const CLOSE_TAG_CACHE = new Map<string, RegExp>();

function closeTagRegex(name: string): RegExp {
    let regex = CLOSE_TAG_CACHE.get(name);
    if (!regex) {
        // Global, so the search can be positioned with lastIndex. Slicing the remainder instead
        // would copy the rest of the document once per script or style element, which is quadratic
        // on a body full of them.
        regex = new RegExp(`</${name}(?:\\s[^>]*)?>`, 'gi');
        CLOSE_TAG_CACHE.set(name, regex);
    }
    return regex;
}

function isNameStart(code: number): boolean {
    return (code >= 97 && code <= 122) || (code >= 65 && code <= 90);
}

function isNameChar(code: number): boolean {
    return isNameStart(code) || (code >= 48 && code <= 57) || code === 45 || code === 58 || code === 95;
}

/**
 * End of a tag that opens at `from`, or -1 when no unquoted `>` appears within the cap.
 *
 * Quoted attribute values are tracked, so `<a title="a>b">` is one tag rather than a tag plus the
 * stray text `b">`.
 */
function tagEnd(html: string, from: number): number {
    const limit = Math.min(html.length, from + MAX_TAG_LENGTH);
    let quote = 0;
    for (let i = from; i < limit; i++) {
        const code = html.charCodeAt(i);
        if (quote) {
            if (code === quote) {
                quote = 0;
            }
            continue;
        }
        if (code === 34 || code === 39) {
            quote = code;
            continue;
        }
        if (code === 62) {
            return i;
        }
    }
    return -1;
}

/**
 * Cheap text projection of an HTML body.
 *
 * Good enough for language estimation, marker detection and length statistics. It is not a
 * replacement for the extraction pipeline's DOM walk, and it deliberately keeps blank lines so that
 * paragraph structure survives. It is emphatically **not** a sanitiser: it produces a non executing
 * textual view, and says nothing about whether the source markup is safe to render.
 *
 * Written as a character scanner rather than a chain of regular expressions because the obvious
 * `/<[^>]*>/g` form is quadratic on unmatched `<`: every one of them rescans to end of input looking
 * for a closing delimiter that is not there. Measured at 5.8 seconds on 128k `<` characters, and
 * doubling the input quadrupled it. This is the projection the malformed HTML fallback uses, so it
 * is reached by exactly the input that triggers the quadratic case.
 *
 * Every code unit is visited a constant number of times. A construct that never closes is charged
 * to the input it covers: the scanned window is emitted as visible text and the cursor moves past
 * it, rather than resuming one character later and reading the same suffix again. Emitting it keeps
 * the projection on the safe side of the project's asymmetry, and matches what the previous regular
 * expression did with an unterminated trailing tag.
 */
export function stripTagsToText(html: string): string {
    const out: string[] = [];
    const length = html.length;
    let i = 0;

    // Closing delimiter memos. The cursor only moves forward, so once a search for a closer finds
    // nothing after some position it will find nothing after any later position either. Without
    // this, a document of unterminated `<!--` openers searches the whole suffix once per opener,
    // which is the same quadratic shape the tag stripper was rewritten to remove.
    let noCommentClose = false;
    const noRawClose = new Set<string>();

    while (i < length) {
        const lt = html.indexOf('<', i);
        if (lt === -1) {
            out.push(html.slice(i));
            break;
        }
        if (lt > i) {
            out.push(html.slice(i, lt));
        }

        const next = html.charCodeAt(lt + 1);

        // Comments and declarations.
        if (next === 33) {
            if (html.startsWith('<!--', lt)) {
                const close = noCommentClose ? -1 : html.indexOf('-->', lt + 4);
                if (close === -1) {
                    noCommentClose = true;
                    // Unterminated. Keep the body as text: showing a comment is a cosmetic fault,
                    // hiding the rest of a message because one comment was never closed is not.
                    out.push(' ');
                    i = lt + 4;
                    continue;
                }
                out.push(' ');
                i = close + 3;
                continue;
            }
            // Doctypes, CDATA, and the downlevel-revealed conditional comments Word emits around
            // every bullet list: <![if !supportLists]>. Those are not HTML comments and survived
            // both the comment strip and the tag strip, so they appeared verbatim in extracted text.
            const close = tagEnd(html, lt + 2);
            if (close === -1) {
                out.push(html.slice(lt, Math.min(length, lt + MAX_TAG_LENGTH)));
                i = Math.min(length, lt + MAX_TAG_LENGTH);
                continue;
            }
            out.push(' ');
            i = close + 1;
            continue;
        }

        // Processing instructions, including the <?xml ... ?> prologue Word emits.
        if (next === 63) {
            const close = tagEnd(html, lt + 2);
            if (close === -1) {
                out.push(html.slice(lt, Math.min(length, lt + MAX_TAG_LENGTH)));
                i = Math.min(length, lt + MAX_TAG_LENGTH);
                continue;
            }
            out.push(' ');
            i = close + 1;
            continue;
        }

        const closing = next === 47;
        const nameStart = closing ? lt + 2 : lt + 1;
        if (!isNameStart(html.charCodeAt(nameStart))) {
            // Not markup at all: a bare "<" in prose, "a < b", "<3". Visible text.
            out.push('<');
            i = lt + 1;
            continue;
        }

        let nameEnd = nameStart;
        while (nameEnd < length && isNameChar(html.charCodeAt(nameEnd))) {
            nameEnd++;
        }
        const name = html.slice(nameStart, nameEnd).toLowerCase();

        const close = tagEnd(html, nameEnd);
        if (close === -1) {
            out.push(html.slice(lt, Math.min(length, lt + MAX_TAG_LENGTH)));
            i = Math.min(length, lt + MAX_TAG_LENGTH);
            continue;
        }

        if (!closing && (RAW_TEXT_TAGS.has(name) || HIDDEN_TAGS.has(name))) {
            let match: RegExpExecArray | null = null;
            if (!noRawClose.has(name)) {
                const regex = closeTagRegex(name);
                regex.lastIndex = close + 1;
                match = regex.exec(html);
                if (!match) {
                    noRawClose.add(name);
                }
            }
            if (match) {
                out.push(' ');
                i = match.index + match[0].length;
                continue;
            }
            if (RAW_TEXT_TAGS.has(name)) {
                // A script or style that is never closed swallows the rest of the document in a
                // renderer too, and its body is code, not authored prose.
                out.push(' ');
                break;
            }
            // head/title/noscript/template with no close tag: drop only the opening tag, so that
            // whatever follows stays visible.
            out.push(' ');
            i = close + 1;
            continue;
        }

        if (BLOCK_BREAK_TAGS.has(name)) {
            out.push('\n');
        }
        i = close + 1;
    }

    let text = out.join('');
    text = decodeEntities(text);
    text = text.replace(/\r\n?/g, '\n');
    // Includes U+00A0, which arrives constantly as &nbsp; and must collapse like a normal space.
    text = text.replace(/[ \t\u00a0]+/g, ' ');
    text = text.replace(/ *\n */g, '\n');
    text = text.replace(/\n{3,}/g, '\n\n');
    return text.trim();
}

/** Structural hints found in an HTML body, keyed by the id used in html-clients.json. */
export interface HtmlHints {
    ids: string[];
    hasBlockquote: boolean;
    blockquoteCount: number;
    hasTable: boolean;
    tableCount: number;
    hasImage: boolean;
    /** True when the markup contains an unclosed tag pattern that suggests malformed HTML. */
    suspectMalformed: boolean;
}

const HINT_PATTERNS: readonly { id: string; regex: RegExp }[] = [
    { id: 'gmail_quote', regex: /class="[^"]*\bgmail_quote\b/i },
    { id: 'gmail_quote_container', regex: /class="[^"]*\bgmail_quote_container\b/i },
    { id: 'gmail_attr', regex: /class="[^"]*\bgmail_attr\b/i },
    { id: 'gmail_signature', regex: /class="[^"]*\bgmail_signature\b/i },
    { id: 'owa_reply_separator', regex: /id="?divRplyFwdMsg/i },
    { id: 'owa_append_on_send', regex: /id="?appendonsend/i },
    { id: 'owa_element_to_proof', regex: /class="[^"]*elementToProof/i },
    { id: 'outlook_mso_normal', regex: /class="?[^"]*\bMsoNormal\b/i },
    { id: 'outlook_word_section', regex: /\bWordSection1\b/i },
    { id: 'outlook_nested_x_class', regex: /class="[^"]*\bx_[A-Za-z]/ },
    { id: 'apple_mail_cite', regex: /<blockquote[^>]+type="?cite/i },
    { id: 'apple_interchange_newline', regex: /Apple-interchange-newline/i },
    { id: 'apple_mail_signature', regex: /AppleMailSignature/i },
    { id: 'thunderbird_moz_cite', regex: /moz-cite-prefix/i },
    { id: 'thunderbird_signature', regex: /moz-signature/i },
    { id: 'proton_quote', regex: /protonmail_quote/i },
    { id: 'yahoo_quoted', regex: /yahoo_quoted/i },
    { id: 'zimbra_separator', regex: /id="?zwchr/i },
    { id: 'outlook_border_separator', regex: /border-top:\s*(solid|1px|1\.0pt)/i },
    { id: 'ms_outlook_mobile', regex: /ms-outlook-mobile|Outlook for (iOS|Android)/i }
];

/** Detect client structure hints without building a DOM. */
export function detectHtmlHints(html: string): HtmlHints {
    const head = html.length > 262144 ? html.slice(0, 262144) : html;
    const ids: string[] = [];
    for (const { id, regex } of HINT_PATTERNS) {
        if (regex.test(head)) {
            ids.push(id);
        }
    }
    const blockquoteCount = (head.match(/<blockquote\b/gi) || []).length;
    const tableCount = (head.match(/<table\b/gi) || []).length;
    return {
        ids,
        hasBlockquote: blockquoteCount > 0,
        blockquoteCount,
        hasTable: tableCount > 0,
        tableCount,
        hasImage: /<img\b/i.test(head),
        // A body element inside a table cell, or a closing tag with no opener nearby, is a decent
        // proxy for markup that needs a forgiving parser.
        suspectMalformed: /<\/(td|tr|table)>\s*<\/(html|body)>/i.test(head) || blockquoteCount !== (head.match(/<\/blockquote>/gi) || []).length
    };
}
