/**
 * Token shingle matching with rolling hashes.
 *
 * Stage 5's middle tier. Exact normalised comparison catches text that was quoted verbatim;
 * shingles catch text that was quoted with an edit, a truncation, or an interleaved insertion,
 * which clients and people both do.
 *
 * A shingle is a window of consecutive tokens. Two texts sharing most of their shingles share most
 * of their content regardless of where it moved to. The hash is rolling, so building the index for
 * a parent message costs one pass over its tokens.
 */

import { fnv1a32, fnv1a32b } from '../util/hash';
import { MIN_MATCH_TOKENS, tokenise } from './normalize';

/** Tokens per shingle. Long enough to be specific, short enough to survive small edits. */
export const SHINGLE_SIZE = 5;

export interface ShingleIndex {
    hashes: Set<number>;
    tokenCount: number;
}

/**
 * Build a shingle index over normalised text.
 *
 * The rolling hash is a simple polynomial over per token 32 bit hashes. Collisions are possible and
 * harmless at this scale: a collision inflates a similarity score slightly, and the containment
 * threshold plus the corroboration rules downstream absorb that.
 */
export function buildShingleIndex(normalised: string): ShingleIndex {
    const tokens = tokenise(normalised);
    const hashes = new Set<number>();
    if (tokens.length < SHINGLE_SIZE) {
        // Short text is indexed as a single shingle so it can still match exactly.
        if (tokens.length > 0) {
            hashes.add(hashTokens(tokens, 0, tokens.length));
        }
        return { hashes, tokenCount: tokens.length };
    }
    for (let i = 0; i + SHINGLE_SIZE <= tokens.length; i++) {
        hashes.add(hashTokens(tokens, i, SHINGLE_SIZE));
    }
    return { hashes, tokenCount: tokens.length };
}

function hashTokens(tokens: readonly string[], start: number, length: number): number {
    let hash = 0x811c9dc5;
    for (let i = start; i < start + length; i++) {
        const token = tokens[i] as string;
        hash = (Math.imul(hash, 31) + fnv1a32(token)) >>> 0;
        hash = (hash ^ fnv1a32b(token)) >>> 0;
    }
    return hash >>> 0;
}

export interface ContainmentResult {
    /** Share of the block's shingles that also appear in the reference. */
    containment: number;
    /** Shingles compared. Zero means the block was too short to judge. */
    shingles: number;
}

/**
 * How much of `block` is contained in `reference`.
 *
 * Containment rather than Jaccard similarity, deliberately: a quoted paragraph is a small part of a
 * large parent message, so symmetric similarity would be near zero for a perfect quote. What
 * matters is whether everything in this block already existed.
 */
export function containment(block: ShingleIndex, reference: ShingleIndex): ContainmentResult {
    if (block.hashes.size === 0) {
        return { containment: 0, shingles: 0 };
    }
    let hits = 0;
    for (const hash of block.hashes) {
        if (reference.hashes.has(hash)) {
            hits++;
        }
    }
    return { containment: hits / block.hashes.size, shingles: block.hashes.size };
}

/** Containment at or above this counts as a match, once the block is long enough to judge. */
export const CONTAINMENT_THRESHOLD = 0.8;

/** True when a block is long enough for a containment score to mean anything. */
export function isMatchable(index: ShingleIndex): boolean {
    return index.tokenCount >= MIN_MATCH_TOKENS;
}
