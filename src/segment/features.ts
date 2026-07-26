/**
 * Feature extraction for blocks.
 *
 * Every feature is a plain number, boolean or string list, and every one is dumped by
 * `extract --explain`. A feature that cannot be shown to a human cannot be debugged when it causes
 * content to disappear, and that is the failure mode this project cares most about.
 */

import { loadPatterns } from '../detect/patterns';
import { type BlockFeatures } from './types';

/**
 * Bounded on purpose. The unbounded form, [\w.+-]+@..., backtracks quadratically over a long run of
 * word characters that contains no @, which is exactly what a pasted log or a base64 blob looks
 * like. It took 21 seconds on a 200 KB block. The bounds are generous relative to real addresses.
 */
const EMAIL = /[\w.+-]{1,64}@[\w-]{1,63}\.[\w.-]{2,64}/;
const URL = /\b(?:https?:\/\/|www\.)\S+/i;
const PHONE = /(?:\+\d[\d\s().-]{7,}|\b\d{3}[\s.-]\d{3}[\s.-]\d{3,4}\b)/;

/**
 * Date-like patterns.
 *
 * Attribution lines nearly always carry a date, so this feature carries real weight. It covers ISO,
 * European and US numeric forms plus English month names, and deliberately stops there: a fully
 * multilingual date matcher would be large, and the attribution patterns already carry the language
 * specific work.
 */
const DATE =
    /(\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[./]\d{1,2}[./]\d{2,4}\b|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}\b|\b\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\b|\b\d{1,2}:\d{2}\b)/i;

/** Characters inspected when computing character class ratios. */
const CHARACTER_SAMPLE = 8192;

const UPPER_RE = /\p{Lu}/gu;
const LETTER_RE = /\p{L}/gu;
const PUNCTUATION_RE = /[\p{P}\p{S}]/gu;

/** Count regex matches without materialising the match array. */
function countMatches(text: string, regex: RegExp): number {
    regex.lastIndex = 0;
    let count = 0;
    while (regex.exec(text) !== null) {
        count++;
    }
    regex.lastIndex = 0;
    return count;
}

export interface FeatureContext {
    /** Zero based block index. */
    index: number;
    /** Total blocks in this representation. */
    total: number;
    /** Character offset of the block start. */
    start: number;
    /** Total characters in the representation. */
    totalChars: number;
    quoteDepth: number;
    blockquoteDepth?: number;
    elementCount?: number;
    tags?: string[];
    classes?: string[];
    hasTopBorder?: boolean;
    linkCount?: number;
    imageCount?: number;
}

function countHeaderFieldLines(lines: readonly string[]): number {
    const patterns = loadPatterns();
    let count = 0;
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.length > 300) {
            continue;
        }
        if (patterns.quotedHeaderFields.some(pattern => pattern.regex.test(trimmed))) {
            count++;
        }
    }
    return count;
}

/** Compute the feature vector for a block's de-prefixed content. */
export function computeFeatures(content: string, context: FeatureContext): BlockFeatures {
    const lines = content.split('\n');
    const nonBlank = lines.filter(line => line.trim().length > 0);
    const charCount = content.length;

    // Character class ratios are computed over a bounded prefix, in bulk.
    //
    // These are statistical features, so a sample is as informative as the whole block, and the
    // bound matters: the previous per character version tested three Unicode property regexes for
    // every character, which took 16 seconds on a 200 KB plain text body. That is a realistic body
    // size for a pasted log, and a library that hangs for 16 seconds on one is unusable.
    const sample = content.length > CHARACTER_SAMPLE ? content.slice(0, CHARACTER_SAMPLE) : content;
    const upper = countMatches(sample, UPPER_RE);
    const letters = countMatches(sample, LETTER_RE);
    const punctuation = countMatches(sample, PUNCTUATION_RE);

    const shortLines = nonBlank.filter(line => line.trim().length < 40).length;
    const words = content.split(/\s+/).filter(Boolean);

    return {
        position: context.totalChars > 0 ? context.start / context.totalChars : 0,
        indexFromEnd: Math.max(0, context.total - 1 - context.index),
        charCount,
        lineCount: lines.length,
        meanLineLength: nonBlank.length ? nonBlank.reduce((sum, line) => sum + line.length, 0) / nonBlank.length : 0,
        wordCount: words.length,
        quoteDepth: context.quoteDepth,
        blockquoteDepth: context.blockquoteDepth ?? 0,
        elementCount: context.elementCount ?? 0,
        linkCount: context.linkCount ?? 0,
        imageCount: context.imageCount ?? 0,
        hasQuestionMark: content.includes('?'),
        hasDate: DATE.test(content),
        hasEmailAddress: EMAIL.test(content),
        hasUrl: URL.test(content),
        hasPhoneNumber: PHONE.test(content),
        headerFieldLines: countHeaderFieldLines(lines),
        shortLineRatio: nonBlank.length ? shortLines / nonBlank.length : 0,
        upperCaseRatio: letters ? upper / letters : 0,
        punctuationRatio: charCount ? punctuation / charCount : 0,
        isAllBlank: nonBlank.length === 0,
        tags: context.tags ?? [],
        classes: context.classes ?? [],
        hasTopBorder: context.hasTopBorder ?? false
    };
}
