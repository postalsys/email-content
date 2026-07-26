/**
 * Stage 5: matching blocks against messages that already existed.
 *
 * This is the strongest evidence the pipeline can have. Every other signal is an inference from
 * markup or wording: an attribution line suggests a quote follows, a blockquote suggests its
 * contents are old. A match against the actual parent message is not an inference. The text
 * demonstrably existed before this message was written, so it cannot be something the sender just
 * wrote.
 *
 * In the working corpus 90.9 percent of replies resolve their In-Reply-To to a message that is also
 * present, which makes this unusually available here. It remains strictly optional: extraction
 * works with no history at all, and history only ever adds evidence.
 *
 * The matcher is deliberately conservative in one direction. A match can promote a block to
 * REPLY_HISTORY, which hides it, so short blocks are never matched, and a high containment
 * threshold is required. A non match never demotes anything.
 */

import { parseMessage } from '../mime/parse';
import { canonicaliseText } from '../canonical/text';
import { stripTagsToText } from '../canonical/html';
import { type Block } from '../segment/types';
import { buildShingleIndex, containment, CONTAINMENT_THRESHOLD, isMatchable, type ShingleIndex } from './shingle';
import { normaliseForMatch } from './normalize';

export interface HistoryDocument {
    /** Identifier for diagnostics, typically a path or Message-ID. */
    id: string;
    /** Normalised text of the whole message, all representations concatenated. */
    normalised: string;
    index: ShingleIndex;
    /** True when this is the direct parent rather than an older ancestor. */
    isParent: boolean;
}

export interface BlockMatch {
    blockIndex: number;
    documentId: string;
    isParent: boolean;
    containment: number;
    /** True when the normalised text appeared verbatim. */
    exact: boolean;
}

/**
 * Build a searchable document from a raw earlier message.
 *
 * Both representations are folded into one text projection. Which representation the earlier
 * message used has nothing to do with which one the reply quoted from, and clients routinely quote
 * the HTML of a message into the plain text of a reply.
 */
export async function buildHistoryDocument(raw: Buffer | string, id: string, isParent: boolean): Promise<HistoryDocument> {
    const buffer = typeof raw === 'string' ? Buffer.from(raw) : raw;
    const message = await parseMessage(buffer);

    const parts: string[] = [];
    for (const part of message.parts) {
        if (!part.decoded || part.disposition === 'attachment') {
            continue;
        }
        if (part.contentType === 'text/plain') {
            parts.push(canonicaliseText(part.decoded.text).text);
        } else if (part.contentType === 'text/html') {
            parts.push(stripTagsToText(part.decoded.text));
        }
    }

    const normalised = normaliseForMatch(parts.join('\n'));
    return { id, normalised, index: buildShingleIndex(normalised), isParent };
}

/**
 * Build a searchable document from already parsed content.
 *
 * The counterpart to buildHistoryDocument for callers that never had a raw message. Both
 * representations are folded together for the same reason: which one the earlier message used has
 * nothing to do with which one the reply quoted from.
 */
export function buildHistoryDocumentFromContent(text: string, html: string, id: string, isParent: boolean): HistoryDocument {
    const parts: string[] = [];
    if (text) {
        parts.push(canonicaliseText(text).text);
    }
    if (html) {
        parts.push(stripTagsToText(html));
    }
    const normalised = normaliseForMatch(parts.join('\n'));
    return { id, normalised, index: buildShingleIndex(normalised), isParent };
}

/**
 * Match blocks against known history.
 *
 * Returns one match per block at most, preferring the direct parent over older ancestors, and
 * higher containment over lower.
 */
export function matchBlocks(blocks: readonly Block[], history: readonly HistoryDocument[]): BlockMatch[] {
    if (!history.length) {
        return [];
    }

    const matches: BlockMatch[] = [];

    for (const block of blocks) {
        const normalised = normaliseForMatch(block.content);
        if (!normalised) {
            continue;
        }
        const index = buildShingleIndex(normalised);
        if (!isMatchable(index)) {
            // Too short to judge. "Thanks" appearing in the parent proves nothing about this block.
            continue;
        }

        let best: BlockMatch | null = null;
        for (const document of history) {
            // Tier one: the normalised text appears verbatim in the earlier message.
            const exact = document.normalised.includes(normalised);
            const score = exact ? 1 : containment(index, document.index).containment;
            if (score < CONTAINMENT_THRESHOLD) {
                continue;
            }
            const candidate: BlockMatch = {
                blockIndex: block.index,
                documentId: document.id,
                isParent: document.isParent,
                containment: score,
                exact
            };
            if (!best || betterMatch(candidate, best)) {
                best = candidate;
            }
        }

        if (best) {
            matches.push(best);
        }
    }

    return matches;
}

function betterMatch(candidate: BlockMatch, current: BlockMatch): boolean {
    if (candidate.isParent !== current.isParent) {
        return candidate.isParent;
    }
    return candidate.containment > current.containment;
}

/** Convenience view for the classifier, which only needs to know which indices matched. */
export function matchedIndices(matches: readonly BlockMatch[]): Set<number> {
    return new Set(matches.map(match => match.blockIndex));
}
