/**
 * LLM block annotator.
 *
 * Produces labels for an already segmented message. It does not replace the segmenter: the model
 * only ever sees blocks the deterministic pipeline produced, and only ever returns labels for those
 * block indices. That keeps the annotation aligned with the pipeline it is meant to evaluate, and
 * keeps generated text out of the system entirely.
 *
 * These labels are weak supervision, not ground truth. They are stored with their model and prompt
 * version, kept separate from human labels, and are meant for bootstrapping, disagreement mining
 * and sampling, exactly as the project's plan requires of any non human label source.
 */

import { type Block } from '../segment/types';
import { type Label } from '../types';
import { type CompletionClient } from './client';
import { PROMPT_VERSION, RESPONSE_SCHEMA, renderUserPrompt, SYSTEM_PROMPT, type PromptBlock } from './prompt';

/** Characters of each block sent to the model. Enough for a decision, bounded for cost. */
export const MAX_BLOCK_CHARS = 700;

/** Blocks per message. Longer messages are truncated with a recorded flag. */
export const MAX_BLOCKS = 60;

export interface LlmLabel {
    index: number;
    label: Label;
    confidence: number;
}

export interface AnnotationResult {
    labels: LlmLabel[];
    model: string;
    promptVersion: string;
    /** Blocks that were sent but came back unlabelled, defaulted to UNKNOWN. */
    missing: number[];
    /** Indices the model invented that do not exist. Discarded. */
    spurious: number[];
    blocksSent: number;
    blocksTotal: number;
}

/** Blocks worth spending a token on. Blank blocks carry no decision. */
export function annotatableBlocks(blocks: readonly Block[]): Block[] {
    return blocks.filter(block => block.content.trim().length > 0);
}

function toPromptBlocks(blocks: readonly Block[]): PromptBlock[] {
    return blocks.slice(0, MAX_BLOCKS).map(block => {
        const text = block.content.trim();
        const truncated = text.length > MAX_BLOCK_CHARS;
        return {
            index: block.index,
            text: truncated ? `${text.slice(0, MAX_BLOCK_CHARS)}...` : text,
            truncated,
            // Both representations reduce to one nesting number: ">" depth in plain text,
            // blockquote nesting in HTML. Without it the annotator cannot tell a quoted greeting
            // from a freshly written one.
            quoteDepth: Math.max(block.features.quoteDepth, block.features.blockquoteDepth)
        };
    });
}

/**
 * Annotate one message's blocks.
 *
 * @param client configured OpenAI client
 * @param blocks blocks from the primary representation
 * @param isReply whether the message carries threading headers
 */
export async function annotateBlocks(client: CompletionClient, blocks: readonly Block[], isReply: boolean): Promise<AnnotationResult> {
    const candidates = annotatableBlocks(blocks);
    const sent = toPromptBlocks(candidates);

    if (!sent.length) {
        return {
            labels: [],
            model: client.model,
            promptVersion: PROMPT_VERSION,
            missing: [],
            spurious: [],
            blocksSent: 0,
            blocksTotal: candidates.length
        };
    }

    const response = await client.complete<{ labels: { index: number; label: Label; confidence: number }[] }>({
        system: SYSTEM_PROMPT,
        user: renderUserPrompt(sent, isReply),
        schemaName: 'block_labels',
        schema: RESPONSE_SCHEMA
    });

    // Validate against the blocks we actually sent. The schema constrains shape and label values,
    // but nothing stops the model returning an index we never asked about, or omitting one.
    const expected = new Set(sent.map(block => block.index));
    const seen = new Set<number>();
    const labels: LlmLabel[] = [];
    const spurious: number[] = [];

    for (const item of response.labels ?? []) {
        if (!expected.has(item.index) || seen.has(item.index)) {
            spurious.push(item.index);
            continue;
        }
        seen.add(item.index);
        labels.push({
            index: item.index,
            label: item.label,
            confidence: Number.isFinite(item.confidence) ? Math.min(1, Math.max(0, item.confidence)) : 0.5
        });
    }

    // A block the model declined to label is UNKNOWN, which stays visible. Silently dropping it
    // would let an omission look like agreement later.
    const missing: number[] = [];
    for (const index of expected) {
        if (!seen.has(index)) {
            missing.push(index);
            labels.push({ index, label: 'UNKNOWN', confidence: 0 });
        }
    }

    labels.sort((a, b) => a.index - b.index);

    return {
        labels,
        model: client.model,
        promptVersion: PROMPT_VERSION,
        missing,
        spurious,
        blocksSent: sent.length,
        blocksTotal: candidates.length
    };
}
