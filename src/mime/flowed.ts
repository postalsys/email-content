/**
 * format=flowed decoding that respects quote depth (RFC 3676).
 *
 * libmime's decoder joins any line ending in a space with the next raw line. That is right for
 * unquoted text and wrong for quoted text, where RFC 3676 section 4.5 says a soft break only joins
 * lines of the same quote depth, and the continuation's own quote markers are not part of the
 * content. Roundcube writes an empty quoted line as "> " (quote marker plus stuffing), and the old
 * decode glued the next quoted line onto it raw, turning "> Also, ..." into "> > Also, ...": depth
 * 2 history that could never be read as an inline answer. Measured on test/fixtures/clients.
 *
 * Linear: every line is visited once and each paragraph is joined once.
 */

interface FlowedLine {
    depth: number;
    content: string;
    flowed: boolean;
}

function parseLine(raw: string, delSp: boolean): FlowedLine {
    let depth = 0;
    while (depth < raw.length && raw.charCodeAt(depth) === 62 /* > */) {
        depth++;
    }
    let content = raw.slice(depth);
    // Space stuffing: one space right after the quote markers, or at the start of an unquoted
    // line, belongs to the encoding, not the text (RFC 3676 section 4.4).
    if (content.startsWith(' ')) {
        content = content.slice(1);
    }
    // A signature separator is never flowed, whatever its trailing space suggests.
    const flowed = content.endsWith(' ') && content !== '-- ';
    if (flowed && delSp) {
        content = content.slice(0, -1);
    }
    return { depth, content, flowed };
}

function render(depth: number, content: string): string {
    if (!depth) {
        return content;
    }
    const marker = '>'.repeat(depth);
    return content ? `${marker} ${content}` : marker;
}

export function decodeFlowed(text: string, delSp = false): string {
    const out: string[] = [];
    let depth = -1;
    let pieces: string[] = [];
    let open = false;

    const close = () => {
        if (depth !== -1) {
            out.push(render(depth, pieces.join('')));
        }
        pieces = [];
        depth = -1;
        open = false;
    };

    for (const raw of text.split(/\r?\n/)) {
        const line = parseLine(raw, delSp);
        // Join only a soft break followed by a line at the same depth; anything else ends the
        // paragraph, and a flowed line at a depth change is treated as fixed.
        if (!(open && line.depth === depth)) {
            close();
            depth = line.depth;
        }
        pieces.push(line.content);
        open = line.flowed;
        if (!open) {
            close();
        }
    }
    close();
    return out.join('\n');
}
