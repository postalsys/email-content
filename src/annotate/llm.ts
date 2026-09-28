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
import { applyCostRule, sanitizeProbabilities, type LabelProbabilities } from './probabilities';
import { PROMPT_VERSION, RESPONSE_SCHEMA, renderUserPrompt, SYSTEM_PROMPT, type PromptBlock } from './prompt';
import { type SystemOneClient, type SystemOneRequest } from './typesafe-client';
import { parseQuestionId, planRequests, TYPESAFE_PROMPT_VERSION } from './typesafe-prompt';

/** Characters of each block sent to the model. Enough for a decision, bounded for cost. */
export const MAX_BLOCK_CHARS = 700;

/** Blocks per message. Longer messages are truncated with a recorded flag. */
export const MAX_BLOCKS = 60;

export interface LlmLabel {
    index: number;
    label: Label;
    confidence: number;
    /** Full distribution, from annotators that return one. The label is derived from it. */
    probabilities?: LabelProbabilities;
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
 * Close the loop on what was sent: every sent block comes back exactly once, in index order.
 *
 * A block the model declined to label, or answered unusably, is UNKNOWN with confidence zero, which
 * stays visible. Silently dropping it would let an omission look like agreement later.
 */
function finish(
    sent: readonly PromptBlock[],
    accepted: Map<number, LlmLabel>,
    spurious: number[],
    meta: { model: string; promptVersion: string; blocksTotal: number }
): AnnotationResult {
    const labels = [...accepted.values()];
    const missing: number[] = [];
    for (const block of sent) {
        if (!accepted.has(block.index)) {
            missing.push(block.index);
            labels.push({ index: block.index, label: 'UNKNOWN', confidence: 0 });
        }
    }
    labels.sort((a, b) => a.index - b.index);
    return { ...meta, labels, missing, spurious, blocksSent: sent.length };
}

function clampConfidence(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.5;
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
    const meta = { model: client.model, promptVersion: PROMPT_VERSION, blocksTotal: candidates.length };

    if (!sent.length) {
        return finish(sent, new Map(), [], meta);
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
    const accepted = new Map<number, LlmLabel>();
    const spurious: number[] = [];

    for (const item of response.labels ?? []) {
        if (!expected.has(item.index) || accepted.has(item.index)) {
            spurious.push(item.index);
            continue;
        }
        accepted.set(item.index, { index: item.index, label: item.label, confidence: clampConfidence(item.confidence) });
    }

    return finish(sent, accepted, spurious, meta);
}

/**
 * Annotate one message's blocks with TypeSafe: one Choice question per block.
 *
 * The stored label is the cost rule applied to the returned distribution at DEFAULT_COST_RATIO, not
 * the model's top choice, and the raw distribution is kept alongside so other ratios can be applied
 * later without re-running inference. An answer without a usable distribution is treated as
 * missing: the cost rule cannot be checked against it, so it must not be allowed to hide anything.
 *
 * @param client configured TypeSafe client
 * @param blocks blocks from the primary representation
 * @param isReply whether the message carries threading headers
 */
export async function annotateBlocksWithTypeSafe(client: SystemOneClient, blocks: readonly Block[], isReply: boolean): Promise<AnnotationResult> {
    const candidates = annotatableBlocks(blocks);
    const sent = toPromptBlocks(candidates);
    const requests = planRequests(sent, isReply);
    // Independent: each request carries the full state and its own share of the questions.
    const responses = await Promise.all(requests.map(request => client.ask(request)));

    const accepted = new Map<number, LlmLabel>();
    const spurious: number[] = [];
    responses.forEach((response, i) => {
        const asked = (requests[i] as SystemOneRequest).questions;
        for (const [id, answer] of Object.entries(response.answers)) {
            // Matched against what this request asked. Anything else is counted and discarded,
            // exactly like an invented index on the OpenAI path.
            const index = parseQuestionId(id);
            if (index === null || !Object.hasOwn(asked, id) || accepted.has(index)) {
                spurious.push(index ?? -1);
                continue;
            }
            const probabilities = sanitizeProbabilities(answer?.probabilities);
            if (!probabilities) {
                continue;
            }
            accepted.set(index, { index, label: applyCostRule(probabilities), confidence: clampConfidence(answer.confidence), probabilities });
        }
    });

    return finish(sent, accepted, spurious, { model: client.model, promptVersion: TYPESAFE_PROMPT_VERSION, blocksTotal: candidates.length });
}
