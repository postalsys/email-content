/**
 * Stage 3: HTML block segmentation.
 *
 * The DOM is walked with node-html-parser, which exposes a source `range` on every node. That is
 * the reason it is used here rather than a faster tag stripper: a block that cannot point back at
 * the exact source offsets it came from cannot be traced, and traceability is a requirement.
 *
 * Segmentation emits one block per run of inline content between block level elements. A container
 * such as a Gmail quote wrapper does not become a block itself; instead every block inside it
 * records its ancestry. That is deliberate, because interleaved replies put new content inside and
 * between quote containers, and a container-level decision cannot express that.
 *
 * Blocks tile the source: each block's range is extended backwards to the end of the previous
 * block, and the last block runs to the end of the document, so concatenating block texts
 * reproduces the HTML exactly.
 */

import { type HTMLElement, type Node, NodeType, parse } from 'node-html-parser';
import { loadPatterns, type SelectorPattern } from '../detect/patterns';
import { detectAttributionLine, detectQuotedHeaderBlock } from '../detect/reply-header';
import { detectForwardMarker } from '../detect/forward-header';
import { detectSignatureDelimiter, detectSignaturePhrases, detectSignatureShape } from '../detect/signature';
import { detectDisclaimer } from '../detect/disclaimer';
import { decodeEntities, stripTagsToText } from '../canonical/html';
import { computeFeatures } from './features';
import { type Block, type BlockKind, type Evidence } from './types';

/** Elements that break a run of inline content. */
const BLOCK_TAGS = new Set([
    'address',
    'article',
    'aside',
    'blockquote',
    'body',
    'center',
    'dd',
    'div',
    'dl',
    'dt',
    'fieldset',
    'figcaption',
    'figure',
    'footer',
    'form',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'header',
    'hr',
    'html',
    'li',
    'main',
    'nav',
    'ol',
    'p',
    'pre',
    'section',
    'table',
    'tbody',
    'td',
    'tfoot',
    'th',
    'thead',
    'tr',
    'ul'
]);

/** Elements whose content is never visible text. */
const INVISIBLE_TAGS = new Set(['script', 'style', 'head', 'title', 'noscript', 'template', 'meta', 'link']);

interface ParsedSelector {
    tag: string | null;
    className: string | null;
    id: string | null;
    attr: { name: string; value: string } | null;
}

/**
 * Parse the simple selector forms used in html-clients.json.
 *
 * Only `tag`, `tag.class`, `tag#id`, `tag[attr=value]` and their bare forms are supported. A full
 * CSS engine is not needed, and a hand written matcher makes the behaviour predictable, including
 * the Outlook Web nesting rule below.
 */
function parseSelector(selector: string): ParsedSelector {
    const attrMatch = selector.match(/^([a-z0-9-]*)\[([a-z-]+)=["']?([^\]"']+)["']?\]$/i);
    if (attrMatch) {
        return { tag: attrMatch[1] || null, className: null, id: null, attr: { name: attrMatch[2] as string, value: (attrMatch[3] as string).toLowerCase() } };
    }
    const idMatch = selector.match(/^([a-z0-9-]*)#([\w-]+)$/i);
    if (idMatch) {
        return { tag: idMatch[1] || null, className: null, id: (idMatch[2] as string).toLowerCase(), attr: null };
    }
    const classMatch = selector.match(/^([a-z0-9-]*)\.([\w-]+)$/i);
    if (classMatch) {
        return { tag: classMatch[1] || null, className: (classMatch[2] as string).toLowerCase(), id: null, attr: null };
    }
    return { tag: selector.toLowerCase() || null, className: null, id: null, attr: null };
}

const SELECTOR_CACHE = new Map<string, ParsedSelector>();

function selectorFor(selector: string): ParsedSelector {
    let parsed = SELECTOR_CACHE.get(selector);
    if (!parsed) {
        parsed = parseSelector(selector);
        SELECTOR_CACHE.set(selector, parsed);
    }
    return parsed;
}

/**
 * Class name comparison that tolerates the Outlook Web nesting prefix.
 *
 * When Outlook Web quotes a message it rewrites the quoted markup's class names with an `x_`
 * prefix, so a quoted Gmail reply arrives as `x_gmail_quote`. Stripping the prefix keeps the
 * detectors working one level deeper into the history, which is exactly where they are needed.
 */
function classMatches(classNames: readonly string[], wanted: string): boolean {
    for (const name of classNames) {
        const lowered = name.toLowerCase();
        if (lowered === wanted || lowered.replace(/^x_/, '') === wanted) {
            return true;
        }
    }
    return false;
}

function elementMatches(element: HTMLElement, selector: ParsedSelector): boolean {
    if (selector.tag && element.rawTagName?.toLowerCase() !== selector.tag) {
        return false;
    }
    if (selector.className) {
        const classes = String(element.getAttribute('class') || '')
            .split(/\s+/)
            .filter(Boolean);
        if (!classMatches(classes, selector.className)) {
            return false;
        }
    }
    if (selector.id) {
        const id = String(element.getAttribute('id') || '').toLowerCase();
        if (id !== selector.id && id.replace(/^x_/, '') !== selector.id) {
            return false;
        }
    }
    if (selector.attr) {
        const value = String(element.getAttribute(selector.attr.name) || '').toLowerCase();
        if (value !== selector.attr.value) {
            return false;
        }
    }
    return true;
}

/** Outlook and Word mark a reply boundary with a top border on an otherwise empty element. */
function hasTopBorder(element: HTMLElement): boolean {
    const style = String(element.getAttribute('style') || '');
    return /border-top\s*:\s*(?!none)[^;]+/i.test(style);
}

interface Ancestor {
    element: HTMLElement;
    matches: SelectorPattern[];
}

interface InlineRun {
    nodes: Node[];
    ancestors: Ancestor[];
}

function isElement(node: Node): node is HTMLElement {
    return node.nodeType === NodeType.ELEMENT_NODE;
}

/**
 * Markup that leaked into a text node.
 *
 * node-html-parser treats `<pre>` as a raw text element, so its children are never parsed and its
 * markup arrives as literal text. Per the HTML specification `<pre>` content is ordinary parsed
 * markup, and a browser renders a `<table>` inside a `<pre>` as a table, so the reader never saw
 * those angle brackets. Leaving them in would put raw HTML into the extracted text, which is
 * exactly what happened to Gmail signature tables wrapped in `<pre>`.
 *
 * Someone genuinely quoting HTML source escapes it as `&lt;table&gt;`, which is a text node with no
 * tags in it and is therefore untouched by this.
 */
const CONDITIONAL_COMMENT = /<!\[[^\]]*\]>/g;
const LEAKED_MARKUP = /<[a-z][a-z0-9]*(?:\s[^>]*)?>/i;

/** Leading lines of a block, for line anchored detectors. */
function firstLines(text: string, limit = 3): string[] {
    return text
        .split('\n', limit)
        .map(line => line.trim())
        .filter(Boolean);
}

/** Text projection of an inline run, with <br> and block boundaries becoming newlines. */
function projectText(nodes: readonly Node[]): string {
    let out = '';
    const visit = (node: Node) => {
        if (node.nodeType === NodeType.TEXT_NODE) {
            const raw = node.rawText ?? '';
            const cleaned = raw.replace(CONDITIONAL_COMMENT, '');
            out += LEAKED_MARKUP.test(cleaned) ? stripTagsToText(cleaned) : decodeEntities(cleaned);
            return;
        }
        if (!isElement(node)) {
            return;
        }
        const tag = node.rawTagName?.toLowerCase() ?? '';
        if (INVISIBLE_TAGS.has(tag)) {
            return;
        }
        if (tag === 'br') {
            out += '\n';
            return;
        }
        if (tag === 'img') {
            return;
        }
        for (const child of node.childNodes) {
            visit(child);
        }
    };
    for (const node of nodes) {
        visit(node);
    }
    // Collapse runs of spaces the way a renderer would, but keep explicit newlines.
    return out
        .replace(/\r\n?/g, '\n')
        .replace(/[^\S\n]+/g, ' ')
        .replace(/ *\n */g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/** Descendant nodes inspected per block. Bounds per block work on pathological subtrees. */
const MAX_SCAN_NODES = 2000;

function countTag(nodes: readonly Node[], tag: string): number {
    let count = 0;
    let budget = MAX_SCAN_NODES;
    const visit = (node: Node) => {
        if (budget-- <= 0) {
            return;
        }
        if (isElement(node)) {
            if (node.rawTagName?.toLowerCase() === tag) {
                count++;
            }
            for (const child of node.childNodes) {
                visit(child);
            }
        }
    };
    for (const node of nodes) {
        visit(node);
    }
    return count;
}

function collectTagsAndClasses(nodes: readonly Node[], ancestors: readonly Ancestor[]): { tags: string[]; classes: string[] } {
    const tags = new Set<string>();
    const classes = new Set<string>();
    let budget = MAX_SCAN_NODES;
    const addElement = (element: HTMLElement) => {
        const tag = element.rawTagName?.toLowerCase();
        if (tag) {
            tags.add(tag);
        }
        for (const name of String(element.getAttribute('class') || '').split(/\s+/)) {
            if (name) {
                classes.add(name.toLowerCase());
            }
        }
    };
    for (const ancestor of ancestors) {
        addElement(ancestor.element);
    }
    const visit = (node: Node) => {
        if (budget-- <= 0) {
            return;
        }
        if (isElement(node)) {
            addElement(node);
            for (const child of node.childNodes) {
                visit(child);
            }
        }
    };
    for (const node of nodes) {
        visit(node);
    }
    return { tags: [...tags], classes: [...classes] };
}

function evidenceFromAncestry(ancestors: readonly Ancestor[]): Evidence[] {
    const evidence = new Map<string, Evidence>();
    for (const ancestor of ancestors) {
        for (const pattern of ancestor.matches) {
            const kind: Evidence['kind'] =
                pattern.role === 'quote'
                    ? 'quote-container'
                    : pattern.role === 'attribution'
                      ? 'attribution'
                      : pattern.role === 'separator'
                        ? 'separator'
                        : pattern.role === 'signature'
                          ? 'signature'
                          : pattern.role === 'new'
                            ? 'new-content'
                            : 'hint';
            const id = `html:${pattern.id}`;
            const existing = evidence.get(id);
            if (!existing || existing.strength < pattern.strength) {
                evidence.set(id, { id, kind, strength: pattern.strength });
            }
        }
    }
    return [...evidence.values()];
}

function kindFor(nodes: readonly Node[], ancestors: readonly Ancestor[], text: string, evidence: readonly Evidence[]): BlockKind {
    if (!text.trim()) {
        const onlyImages = nodes.some(node => isElement(node) && node.rawTagName?.toLowerCase() === 'img');
        if (onlyImages) {
            return 'image';
        }
        const onlyRule = nodes.some(node => isElement(node) && node.rawTagName?.toLowerCase() === 'hr');
        return onlyRule ? 'separator' : 'blank';
    }
    // Checked before the embedded header block below, and the order matters: a forwarded message
    // begins with its marker and then repeats the original From/Date/Subject/To fields, so a header
    // block test would claim it first and turn every forward into reply history.
    // A forward marker is the same thing in HTML as in plain text, and must open a forwarded region
    // the same way. Without this, an HTML forward is invisible to the classifier and its contents
    // fall through to the reply history rules, which is how forwarded mail was being hidden.
    //
    // Matched per line, not against the whole block. In HTML the marker and the forwarded message's
    // headers usually collapse into one block, so a whole-block test against line anchored patterns
    // never fires.
    if (firstLines(text).some(line => detectForwardMarker(line))) {
        return 'forward_header';
    }

    // An embedded copy of the previous message's headers. Outlook and several webmail clients emit
    // From/Sent/To/Subject as one block, with <br> between the fields. This was wired into the plain
    // text segmenter only, so in HTML the strongest reply anchor there is went undetected and every
    // block after it stayed NEW_CONTENT. It was the single largest error cell against the reference.
    if (detectQuotedHeaderBlock(text.split('\n').map(line => line.trim())) !== null) {
        return 'quoted_header_block';
    }

    // A container the client marked as an attribution line, such as Gmail's gmail_attr, is the same
    // thing as a plain text "On ... wrote:" line and must anchor the region the same way.
    if (evidence.some(item => item.kind === 'attribution')) {
        return 'reply_header';
    }
    // Clients that use no marker class still emit the attribution as its own short element.
    if (text.length <= 300 && !text.includes('\n') && detectAttributionLine(text)) {
        return 'reply_header';
    }
    if (ancestors.some(ancestor => ancestor.element.rawTagName?.toLowerCase() === 'blockquote')) {
        return 'quote';
    }
    const tags = new Set(ancestors.map(ancestor => ancestor.element.rawTagName?.toLowerCase()));
    if (tags.has('li')) {
        return 'list';
    }
    if (tags.has('td') || tags.has('th')) {
        return 'table';
    }
    return 'paragraph';
}

export interface HtmlSegmentation {
    /** The source HTML, unchanged. All block offsets refer to this string. */
    source: string;
    blocks: Block[];
    /** True when parsing failed and a degraded single block was produced. */
    degraded: boolean;
}

/**
 * Segment an HTML part into blocks.
 *
 * @param html decoded HTML source of the part
 * @param mimePart part id for traceability
 */
/**
 * Unclosed block tags tolerated before the DOM parse is skipped.
 *
 * node-html-parser degrades badly on deeply unbalanced markup: 5,000 unclosed divs, which is only
 * 25 KB, take six and a half seconds inside the parser itself, before any of this module's code
 * runs. Size is not the signal, imbalance is. Real mail, including thoroughly broken real mail,
 * does not come close to this threshold.
 */
const MAX_UNCLOSED_TAGS = 500;

const OPEN_BLOCK_TAG = /<(?:div|table|tr|td|span|p|blockquote|ul|ol|li|font)\b/gi;
const CLOSE_BLOCK_TAG = /<\/(?:div|table|tr|td|span|p|blockquote|ul|ol|li|font)\b/gi;

function countPattern(text: string, regex: RegExp): number {
    regex.lastIndex = 0;
    let count = 0;
    while (regex.exec(text) !== null) {
        count++;
    }
    regex.lastIndex = 0;
    return count;
}

/** True when markup is unbalanced enough that parsing it is not worth the time. */
export function isPathologicalHtml(html: string): boolean {
    return countPattern(html, OPEN_BLOCK_TAG) - countPattern(html, CLOSE_BLOCK_TAG) > MAX_UNCLOSED_TAGS;
}

export function segmentHtmlBlocks(html: string, mimePart: string): HtmlSegmentation {
    const patterns = loadPatterns();

    let root: HTMLElement;
    try {
        if (isPathologicalHtml(html)) {
            // Degrade to a single visible block rather than spending seconds in the parser. Nothing
            // is lost: the caller still receives the whole body, just unsegmented.
            throw new Error('unbalanced markup');
        }
        root = parse(html, { comment: false });
    } catch {
        // A parse failure must still yield the content, as one unknown block.
        return {
            source: html,
            degraded: true,
            blocks: [
                {
                    index: 0,
                    kind: 'unknown',
                    representation: 'html',
                    mimePart,
                    text: html,
                    content: '',
                    start: 0,
                    end: html.length,
                    html,
                    features: computeFeatures('', { index: 0, total: 1, start: 0, totalChars: html.length, quoteDepth: 0 }),
                    evidence: []
                }
            ]
        };
    }

    const runs: { run: InlineRun; domPath: string }[] = [];

    /**
     * Depth cap.
     *
     * Real mail nests deeply: a long thread quoted by Outlook Web inside Gmail can reach thirty
     * levels. Five thousand unclosed divs is not real mail, and walking it made the per block
     * ancestor and descendant scans quadratic, taking six seconds. Beyond this depth the remaining
     * subtree is emitted as a single run rather than descended into, so content is still returned.
     */
    const MAX_DEPTH = 150;

    const walk = (node: HTMLElement, ancestors: Ancestor[], path: string) => {
        if (ancestors.length > MAX_DEPTH) {
            if (node.childNodes.length) {
                runs.push({ run: { nodes: [...node.childNodes], ancestors: [...ancestors] }, domPath: path });
            }
            return;
        }
        let pending: Node[] = [];
        let pendingIndex = 0;

        const flush = () => {
            if (pending.length) {
                runs.push({ run: { nodes: pending, ancestors: [...ancestors] }, domPath: `${path}/${pendingIndex}` });
                pending = [];
            }
        };

        node.childNodes.forEach((child, childIndex) => {
            if (isElement(child)) {
                const tag = child.rawTagName?.toLowerCase() ?? '';
                if (INVISIBLE_TAGS.has(tag)) {
                    return;
                }
                if (BLOCK_TAGS.has(tag)) {
                    flush();
                    const matches = patterns.htmlSelectors.filter(pattern => elementMatches(child, selectorFor(pattern.selector)));
                    if (hasTopBorder(child)) {
                        matches.push({
                            id: 'outlook_border_separator',
                            client: 'outlook-desktop',
                            role: 'separator',
                            strength: 0.6,
                            selector: '[style*=border-top]',
                            prevalence: 0.03
                        });
                    }
                    walk(child, [...ancestors, { element: child, matches }], `${path}/${childIndex}`);
                    return;
                }
            }
            if (!pending.length) {
                pendingIndex = childIndex;
            }
            pending.push(child);
        });

        flush();

        // An empty block element still carries structural meaning, for example an <hr> used as a
        // reply separator, so it becomes a block of its own.
        if (!node.childNodes.length) {
            const tag = node.rawTagName?.toLowerCase();
            if (tag === 'hr' || tag === 'br') {
                runs.push({ run: { nodes: [node], ancestors: [...ancestors] }, domPath: path });
            }
        }
    };

    walk(root, [], '');

    const blocks: Block[] = [];
    let previousEnd = 0;

    for (const { run, domPath } of runs) {
        const ranges = run.nodes.map(node => node.range).filter(Boolean) as [number, number][];
        if (!ranges.length) {
            continue;
        }
        const nodeStart = Math.min(...ranges.map(range => range[0]));
        const nodeEnd = Math.max(...ranges.map(range => range[1]));
        if (nodeEnd <= previousEnd) {
            continue;
        }
        // Extend backwards so that markup between blocks belongs to exactly one block.
        const start = Math.min(previousEnd, nodeStart);
        const text = projectText(run.nodes);
        const { tags, classes } = collectTagsAndClasses(run.nodes, run.ancestors);
        const blockquoteDepth = run.ancestors.filter(ancestor => ancestor.element.rawTagName?.toLowerCase() === 'blockquote').length;
        const evidence = evidenceFromAncestry(run.ancestors);
        const kind = kindFor(run.nodes, run.ancestors, text, evidence);
        if (kind === 'reply_header' && !evidence.some(item => item.kind === 'reply-anchor' || item.kind === 'attribution')) {
            const attribution = detectAttributionLine(text);
            if (attribution) {
                evidence.push(attribution);
            }
        }
        if (kind === 'quoted_header_block') {
            const match = detectQuotedHeaderBlock(text.split('\n').map(line => line.trim()));
            if (match) {
                evidence.push(match.evidence);
            }
        }
        if (kind === 'forward_header') {
            for (const line of firstLines(text)) {
                const forward = detectForwardMarker(line);
                if (forward) {
                    evidence.push(forward);
                    break;
                }
            }
        }

        blocks.push({
            index: blocks.length,
            kind,
            representation: 'html',
            mimePart,
            text: html.slice(start, nodeEnd),
            content: text,
            start,
            end: nodeEnd,
            html: html.slice(nodeStart, nodeEnd),
            domPath,
            features: computeFeatures(text, {
                index: blocks.length,
                total: runs.length,
                start,
                totalChars: html.length,
                quoteDepth: blockquoteDepth,
                blockquoteDepth,
                elementCount: run.nodes.filter(isElement).length,
                tags,
                classes,
                hasTopBorder: run.ancestors.some(ancestor => hasTopBorder(ancestor.element)),
                linkCount: countTag(run.nodes, 'a'),
                imageCount: countTag(run.nodes, 'img')
            }),
            evidence
        });
        previousEnd = nodeEnd;
    }

    // Trailing markup belongs to the last block, so that the blocks tile the whole document.
    if (blocks.length) {
        const last = blocks[blocks.length - 1] as Block;
        if (last.end < html.length) {
            last.end = html.length;
            last.text = html.slice(last.start, html.length);
        }
    } else if (html.length) {
        blocks.push({
            index: 0,
            kind: 'blank',
            representation: 'html',
            mimePart,
            text: html,
            content: '',
            start: 0,
            end: html.length,
            html,
            features: computeFeatures('', { index: 0, total: 1, start: 0, totalChars: html.length, quoteDepth: 0 }),
            evidence: []
        });
    }

    // Block level footer evidence, once positions are known.
    //
    // These detectors were originally wired into the plain text segmenter only, which meant HTML
    // blocks never received signature or disclaimer evidence at all. Since most messages are HTML
    // primary, that alone accounted for signature recall of 2.5 percent and disclaimer recall of
    // zero against the reference set.
    for (const block of blocks) {
        block.features.indexFromEnd = blocks.length - 1 - block.index;
        if (block.kind === 'blank' || block.features.isAllBlank) {
            continue;
        }
        const lines = block.content.split('\n');
        for (const line of lines) {
            const delimiter = detectSignatureDelimiter(line.trim());
            if (delimiter) {
                block.evidence.push(delimiter);
                break;
            }
        }
        for (const evidence of detectSignaturePhrases(lines)) {
            block.evidence.push(evidence);
        }
        const shape = detectSignatureShape(block.features);
        if (shape) {
            block.evidence.push(shape);
        }
        for (const evidence of detectDisclaimer(block.content, block.features)) {
            block.evidence.push(evidence);
        }
    }

    return { source: html, blocks, degraded: false };
}
