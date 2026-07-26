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

/** Decode HTML entities. Unknown entities are left as written rather than dropped. */
export function decodeEntities(input: string): string {
    if (!input.includes('&')) {
        return input;
    }
    return input.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (whole, body: string) => {
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

/** Elements whose content is never user visible text. */
const INVISIBLE = /<(script|style|head|title|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

/** Elements that introduce a line break in the text projection. */
const BLOCK_BREAK = /<\/?(p|div|br|tr|li|h[1-6]|table|blockquote|pre|hr|section|article|ul|ol|dd|dt)\b[^>]*>/gi;

/**
 * Cheap text projection of an HTML body.
 *
 * Good enough for language estimation, marker detection and length statistics. It is not a
 * replacement for the extraction pipeline's DOM walk, and it deliberately keeps blank lines so that
 * paragraph structure survives.
 */
export function stripTagsToText(html: string): string {
    let text = html.replace(INVISIBLE, ' ');
    text = text.replace(/<!--[\s\S]*?-->/g, ' ');
    // Word and Outlook emit downlevel-revealed conditional comments, which are not HTML comments
    // and survive both the comment strip and the tag strip: <![if !supportLists]>. Left in, they
    // appear verbatim in the extracted text of every Word authored bullet list.
    text = text.replace(/<!\[[^\]]*\]>/g, ' ');
    text = text.replace(BLOCK_BREAK, '\n');
    text = text.replace(/<[^>]*>/g, '');
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
