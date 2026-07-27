/**
 * Stage 3: plain text block segmentation.
 *
 * Blocks tile the canonical text completely and without overlap. Every character belongs to exactly
 * one block, including blank lines and trailing whitespace, so that concatenating block texts
 * reproduces the input exactly. That is maintained by construction here, and asserted as a property
 * test, because it is what guarantees content cannot vanish between stages.
 *
 * Boundaries are placed at:
 *   - a change of quote depth
 *   - a blank line, which separates paragraphs
 *   - a reply attribution line, which becomes its own block
 *   - a forward marker, which becomes its own block
 *   - a signature delimiter, which becomes its own block
 *   - a rule separator
 *   - the start of an embedded header block
 */

import { canonicaliseText, type CanonicalText, type TextLine } from '../canonical/text';
import { detectDisclaimer } from '../detect/disclaimer';
import { detectForwardMarker } from '../detect/forward-header';
import { detectAttributionLine, detectQuotedHeaderBlock, detectRuleSeparator } from '../detect/reply-header';
import { detectSignatureDelimiter, detectSignaturePhrases, detectSignatureShape } from '../detect/signature';
import { computeFeatures } from './features';
import { type Block, type BlockKind, type Evidence } from './types';

interface Boundary {
    /** Line index where a new block starts. */
    line: number;
    /** Kind forced by the boundary, if any. */
    kind?: BlockKind;
    evidence?: Evidence;
    /** True when this boundary spans exactly one line. */
    single?: boolean;
}

/** Strip quote prefixes and trim surrounding blank lines for display and matching. */
function contentOf(lines: readonly TextLine[]): string {
    let start = 0;
    let end = lines.length;
    while (start < end && (lines[start] as TextLine).blank) {
        start++;
    }
    while (end > start && (lines[end - 1] as TextLine).blank) {
        end--;
    }
    return lines
        .slice(start, end)
        .map(line => line.content)
        .join('\n');
}

/**
 * Deepest quote level in a slice.
 *
 * A loop rather than `Math.max(...slice.map(...))`. Spreading an array into a call passes one
 * argument per element, and V8 throws `RangeError: Maximum call stack size exceeded` somewhere
 * above 125k arguments. A message of 130,000 short lines is large but perfectly legal, and it made
 * the whole analysis fall back to a single unclassified block.
 */
function maxDepth(lines: readonly TextLine[]): number {
    let depth = 0;
    for (const line of lines) {
        if (line.depth > depth) {
            depth = line.depth;
        }
    }
    return depth;
}

function classifyKind(lines: readonly TextLine[], forced: BlockKind | undefined): BlockKind {
    if (forced) {
        return forced;
    }
    const body = lines.filter(line => !line.blank);
    if (!body.length) {
        return 'blank';
    }
    if ((body[0] as TextLine).depth > 0) {
        return 'quote';
    }
    const contents = body.map(line => line.content.trim());
    if (contents.every(line => /^([-*+•‣◦]|\d+[.)])\s+/.test(line))) {
        return 'list';
    }
    // A run of lines with aligned pipe or multi-space columns reads as a table in plain text.
    if (contents.length > 1 && contents.every(line => line.includes('|') || /\S {3,}\S/.test(line))) {
        return 'table';
    }
    return 'paragraph';
}

/**
 * Segment a plain text part into blocks.
 *
 * @param raw decoded text of the part
 * @param mimePart part id for traceability
 */
export function segmentTextBlocks(raw: string, mimePart: string): { canonical: CanonicalText; blocks: Block[] } {
    const canonical = canonicaliseText(raw);
    const lines = canonical.lines;

    if (!lines.length) {
        return { canonical, blocks: [] };
    }

    const contents = lines.map(line => line.content);
    const boundaries = new Map<number, Boundary>();
    const addBoundary = (boundary: Boundary) => {
        const existing = boundaries.get(boundary.line);
        if (!existing || (boundary.evidence?.strength ?? 0) > (existing.evidence?.strength ?? 0)) {
            boundaries.set(boundary.line, boundary);
        }
    };

    // Line level anchors.
    for (const line of lines) {
        if (line.blank) {
            continue;
        }
        const attribution = detectAttributionLine(line.content);
        if (attribution) {
            addBoundary({ line: line.index, kind: 'reply_header', evidence: attribution, single: true });
            continue;
        }
        const forward = detectForwardMarker(line.content);
        if (forward) {
            addBoundary({ line: line.index, kind: 'forward_header', evidence: forward, single: true });
            continue;
        }
        const signature = detectSignatureDelimiter(line.content);
        if (signature) {
            addBoundary({ line: line.index, kind: 'separator', evidence: signature, single: true });
            continue;
        }
        const rule = detectRuleSeparator(line.content);
        if (rule) {
            addBoundary({ line: line.index, kind: 'separator', evidence: rule, single: true });
        }
    }

    // Embedded header blocks, scanning repeatedly so that several can be found in one body.
    let cursor = 0;
    while (cursor < lines.length) {
        const match = detectQuotedHeaderBlock(contents, cursor);
        if (!match) {
            break;
        }
        addBoundary({ line: match.startLine, kind: 'quoted_header_block', evidence: match.evidence });
        // The block ends after the last field line, so the next block starts there.
        if (match.endLine + 1 < lines.length) {
            const next = boundaries.get(match.endLine + 1);
            if (!next) {
                addBoundary({ line: match.endLine + 1 });
            }
        }
        cursor = match.endLine + 1;
    }

    // Structural boundaries: depth changes and blank line separations.
    let previousDepth = (lines[0] as TextLine).depth;
    let sawBlank = false;
    for (const line of lines) {
        if (line.index === 0) {
            continue;
        }
        if (line.blank) {
            sawBlank = true;
            continue;
        }
        const forcedSingleBefore = boundaries.get(line.index - 1)?.single;
        if (line.depth !== previousDepth || sawBlank || forcedSingleBefore) {
            if (!boundaries.has(line.index)) {
                addBoundary({ line: line.index });
            }
        }
        previousDepth = line.depth;
        sawBlank = false;
    }

    // A single line boundary must also close, so the following line starts a new block.
    for (const boundary of [...boundaries.values()]) {
        if (boundary.single && boundary.line + 1 < lines.length && !boundaries.has(boundary.line + 1)) {
            boundaries.set(boundary.line + 1, { line: boundary.line + 1 });
        }
    }

    const starts = [...new Set([0, ...boundaries.keys()])].sort((a, b) => a - b);

    const blocks: Block[] = [];
    for (let i = 0; i < starts.length; i++) {
        const startLine = starts[i] as number;
        const endLine = i + 1 < starts.length ? (starts[i + 1] as number) : lines.length;
        const slice = lines.slice(startLine, endLine);
        if (!slice.length) {
            continue;
        }
        const first = slice[0] as TextLine;
        const last = slice[slice.length - 1] as TextLine;
        // Include the newline that terminates the last line, unless this is the end of the text.
        const end = endLine < lines.length ? (lines[endLine] as TextLine).start : last.end;
        const boundary = boundaries.get(startLine);

        blocks.push({
            index: blocks.length,
            kind: classifyKind(slice, boundary?.kind),
            representation: 'text',
            mimePart,
            text: canonical.text.slice(first.start, end),
            content: contentOf(slice),
            start: first.start,
            end,
            features: computeFeatures(contentOf(slice), {
                index: blocks.length,
                total: starts.length,
                start: first.start,
                totalChars: canonical.text.length,
                quoteDepth: maxDepth(slice)
            }),
            evidence: boundary?.evidence ? [boundary.evidence] : []
        });
    }

    // Block level evidence, once positions are known.
    for (const block of blocks) {
        block.features.indexFromEnd = blocks.length - 1 - block.index;
        if (block.kind === 'blank') {
            continue;
        }
        const blockLines = block.content.split('\n');
        for (const evidence of detectSignaturePhrases(blockLines)) {
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

    return { canonical, blocks };
}
