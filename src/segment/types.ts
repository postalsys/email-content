/**
 * Block model shared by both segmenters.
 *
 * A block is a contiguous run of a single representation. Blocks tile their representation
 * completely: concatenating every block's `text` in order reproduces the canonical text exactly.
 * That property is what makes the lossless reconstruction invariant testable, so it is maintained
 * by construction rather than checked afterwards.
 */

import { type Representation } from '../types';

/** Structural kind assigned during segmentation, before final classification. */
export type BlockKind =
    | 'paragraph'
    | 'quote'
    | 'reply_header'
    | 'forward_header'
    | 'quoted_header_block'
    | 'signature_candidate'
    | 'disclaimer_candidate'
    | 'list'
    | 'table'
    | 'separator'
    | 'image'
    | 'blank'
    | 'unknown';

/** A single piece of evidence produced by a detector. Detectors never emit verdicts. */
export interface Evidence {
    /** Detector id, matching a pattern id or a selector id. */
    id: string;
    /** What the evidence suggests. */
    kind: 'reply-anchor' | 'forward-anchor' | 'quote-container' | 'attribution' | 'separator' | 'signature' | 'disclaimer' | 'new-content' | 'hint';
    /** How strongly, in [0, 1]. */
    strength: number;
}

/**
 * Inspectable feature vector.
 *
 * Every field here is dumped by `extract --explain`, and every field is a candidate input to a
 * learned model later. Nothing is computed that cannot be shown to a human.
 */
export interface BlockFeatures {
    /** Normalised position of the block start within the representation, in [0, 1]. */
    position: number;
    /** Index from the end, so that trailing structures are easy to express. */
    indexFromEnd: number;
    charCount: number;
    lineCount: number;
    /** Mean characters per non blank line. */
    meanLineLength: number;
    wordCount: number;
    quoteDepth: number;
    /** Nesting depth inside blockquote elements. HTML only. */
    blockquoteDepth: number;
    /** Number of HTML elements this block spans. HTML only. */
    elementCount: number;
    linkCount: number;
    imageCount: number;
    hasQuestionMark: boolean;
    hasDate: boolean;
    hasEmailAddress: boolean;
    hasUrl: boolean;
    hasPhoneNumber: boolean;
    /** Lines that look like an embedded message header field. */
    headerFieldLines: number;
    /** Fraction of lines that are shorter than 40 characters, a signature-like shape. */
    shortLineRatio: number;
    /** Fraction of characters that are uppercase letters. */
    upperCaseRatio: number;
    /** Fraction of characters that are punctuation or symbols. */
    punctuationRatio: number;
    isAllBlank: boolean;
    /** HTML tag names present, lowercased and deduplicated. */
    tags: string[];
    /** HTML class names present, lowercased and deduplicated. */
    classes: string[];
    /** True when the block has a top border, which several clients use as a reply separator. */
    hasTopBorder: boolean;
    /**
     * Non-blank lines above an embedded header block inside this same block that are not
     * themselves a separator or attribution line. HTML only: the plain text segmenter starts a new
     * block at the header, but an HTML block is a DOM run and cannot be split, so a sign-off and
     * the "-----Original Message-----" that follows it arrive as one block.
     */
    authoredLinesBeforeAnchor: number;
}

export interface Block {
    /**
     * Document-global decision index: position in the sequence the classifier sees.
     *
     * A message can hold several independent body sections, and they are classified as one linear
     * sequence so that positional rules such as "the last block" keep meaning what they say. The
     * classifier indexes its own arrays with this, so it always equals the array position.
     */
    index: number;
    /**
     * Section-local source index: position within this block's own representation.
     *
     * Present when the block was renumbered into a document sequence. This is what a segment
     * reports, so traceability still points at a block of a specific MIME part.
     */
    sourceIndex?: number;
    kind: BlockKind;
    representation: Representation;
    /** MIME part this block came from, for example "1.2". */
    mimePart: string;
    /**
     * Exact slice of the canonical representation, including quote prefixes and trailing blank
     * lines. Concatenating this across all blocks reproduces the canonical text.
     */
    text: string;
    /** Display and matching text: quote prefixes removed, surrounding blank lines trimmed. */
    content: string;
    /** Offsets into the canonical representation. */
    start: number;
    end: number;
    /** Original HTML source for HTML blocks. Never regenerated. */
    html?: string;
    /** Stable child index path from the document root, for example "0/2/1". HTML only. */
    domPath?: string;
    features: BlockFeatures;
    evidence: Evidence[];
}
