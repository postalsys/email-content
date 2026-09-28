/**
 * The TypeSafe annotation questions.
 *
 * The same conventions as the OpenAI prompt (`prompt.ts`, docs/annotation-guide.md), reshaped for a
 * model that answers typed questions instead of following a system prompt:
 *
 *   - One Choice question per block, over the same closed label set. The answer is an option name
 *     and a probability distribution, so "select, never generate" holds by the protocol itself:
 *     there is no field in which text could come back.
 *   - The HOW TO DECIDE, QUOTE DEPTH and REGION WINS rules live in the option descriptions they
 *     disambiguate, because each question is evaluated in isolation and only sees its own criteria.
 *   - The COST OF ERRORS and CONFIDENCE sections are deliberately absent. Asking the model to be
 *     biased would bake the bias into the distribution; instead the raw distribution is stored and
 *     the asymmetry is applied in code (`probabilities.ts`).
 *
 * Versioned separately from the OpenAI prompt so runs under the two never share a resume key or get
 * silently compared as one convention.
 */

import { type Label } from '../types';
import { type ChoiceQuestion, type SystemOneRequest } from './typesafe-client';
import { type PromptBlock } from './prompt';

export const TYPESAFE_PROMPT_VERSION = 'annotate-ts-v1';

/**
 * Option descriptions. Objects rather than strings because the confusable pairs (REPLY_HISTORY vs
 * INLINE_QUOTE, SIGNATURE vs REPLY_HISTORY, DISCLAIMER vs NEW_CONTENT) need a stated boundary in
 * both directions, and jev reads literally: an unstated rule is not applied.
 */
export const LABEL_CRITERIA: Readonly<Record<Label, Record<string, string | string[]>>> = {
    NEW_CONTENT: {
        what: 'Text the sender wrote themselves in this message.',
        includes: [
            'Greetings, answers, questions and closing words the sender wrote now, at quote depth 0',
            'Text the sender pasted in that merely looks like an email',
            'Boilerplate, when the message has no authored text at all outside it: then the boilerplate is the content, as in a newsletter'
        ],
        not_this: [
            'Any block at quote depth 2 or more: that is REPLY_HISTORY',
            "The sender's name and contact block: that is SIGNATURE",
            'System attached notices and service footers in a message that also has authored text: that is DISCLAIMER'
        ]
    },
    INLINE_QUOTE: {
        what: 'Older text the sender quoted on purpose, usually at quote depth 1, in order to answer it here point by point.',
        giveaway: "The sender's own new text comes after it and responds to it, often alternating several times.",
        not_this: [
            'A quote that runs uninterrupted to the end of the message as one copy of the previous mail: that is REPLY_HISTORY',
            'Any block at quote depth 2 or more: that is REPLY_HISTORY'
        ]
    },
    REPLY_HISTORY: {
        what: "A copy of an earlier message that the sender's mail client attached automatically, usually the whole previous message sitting at the end.",
        includes: [
            'The attribution line that opens it, such as "On <date>, <person> wrote:", "-----Original Message-----" or an embedded From:/Sent:/To:/Subject: block',
            'Every block at quote depth 2 or more, including greetings, thanks, questions and sign-offs, because someone wrote them in an earlier message',
            'Signatures, "--" delimiters, legal notices and forwards that sit inside that earlier message',
            'An earlier message embedded without quote markers, as plain paragraphs after an attribution line',
            'A hard wrapped quoted line whose continuation lost its quote marker'
        ],
        not_this: ['A depth 1 quote that the sender answers below it: that is INLINE_QUOTE']
    },
    FORWARDED_CONTENT: {
        what: 'A message the sender forwarded on purpose in this message.',
        includes: [
            'The forward marker that opens it, such as "Begin forwarded message:" or "---------- Forwarded message ----------"',
            'Everything inside the forwarded message, including its signatures and confidentiality notices'
        ],
        not_this: ['A forward that appears inside quoted reply history, since the earlier correspondent forwarded it: that is REPLY_HISTORY']
    },
    SIGNATURE: {
        what: 'The sign-off block of this sender, in this message: name, role, company, phone, links, "Sent from my phone".',
        not_this: ['A signature inside quoted history: that is REPLY_HISTORY', 'A signature inside a forwarded message: that is FORWARDED_CONTENT']
    },
    DISCLAIMER: {
        what: 'Boilerplate a system, gateway or template attached to this message independently of what the sender wrote.',
        includes: [
            'Confidentiality and liability notices, virus scanning notices',
            'Company registration and VAT numbers, registered office addresses',
            'Unsubscribe and preference footers, "powered by" branding',
            'Templated promotional or navigational footers: subscribe invitations, app download links, social media links, help and support pointers'
        ],
        not_this: [
            'Boilerplate inside quoted history: that is REPLY_HISTORY',
            'Boilerplate inside a forwarded message: that is FORWARDED_CONTENT',
            'Boilerplate in a message with no authored text anywhere else: that is NEW_CONTENT'
        ]
    },
    UNKNOWN: {
        what: 'It is genuinely impossible to tell which message this block belongs to.',
        not_this: ['A block whose place in the message is clear, however short it is']
    }
};

/**
 * Question for the block at `position` in `state.blocks`.
 *
 * The path is the array position, not the block index: jev resolves `blocks[3]` as the fourth
 * element, and block indices skip the blank blocks that are never sent. For the same reason the
 * state carries no index field at all, so there is no second number the model could confuse with
 * the position. One hop, named directly, per the jev 1.13 guidance on indirection.
 */
export function blockQuestion(position: number): ChoiceQuestion {
    return {
        type: 'choice',
        instructions: {
            question: `Which part of this email message does \`blocks[${position}]\` belong to?`,
            how_to_judge:
                'Judge by which message the block was written in, never by what its text looks like. Greetings, signatures and legal footers occur inside every part of a message. Read the blocks before and after it to see where it sits.',
            state_fields:
                '`blocks` is the whole message split into blocks, in order. `quote_depth` is the quote nesting the message shows: 0 not quoted, 1 quoted once, 2 or more quoted inside a quote. `truncated` means the text was cut short. `is_reply` says whether the message replies to an earlier one.'
        },
        criteria: LABEL_CRITERIA
    };
}

/** Question id for a block. Ids are never sent to the model, only used to match answers. */
export function questionId(index: number): string {
    return `b${index}`;
}

/** Inverse of `questionId`. Null for anything that is not one. */
export function parseQuestionId(id: string): number | null {
    const index = /^b(\d+)$/.exec(id)?.[1];
    return index === undefined ? null : Number(index);
}

/** The state: exactly what the OpenAI prompt sends (block text, quote depth, reply flag), as JSON. */
export function buildState(
    blocks: readonly PromptBlock[],
    isReply: boolean
): { is_reply: boolean; blocks: { quote_depth: number; truncated: boolean; text: string }[] } {
    return {
        is_reply: isReply,
        blocks: blocks.map(block => ({ quote_depth: block.quoteDepth, truncated: block.truncated, text: block.text }))
    };
}

/**
 * Tokens allowed per request, below the documented 64k so the estimate below can be wrong by a
 * margin without a request being rejected.
 */
export const REQUEST_TOKEN_BUDGET = 56000;

/**
 * Deliberately pessimistic characters per token. English runs near four, but the corpus is largely
 * Estonian and also holds Cyrillic and CJK text, which tokenise much denser. Overestimating only
 * costs an extra request; underestimating costs a rejected message.
 */
const CHARS_PER_TOKEN = 2;

function estimateTokens(value: unknown): number {
    return Math.ceil(JSON.stringify(value).length / CHARS_PER_TOKEN);
}

/**
 * Split one message's questions into requests that fit the token budget.
 *
 * Every request carries the full state, because a block cannot be labelled without its neighbours.
 * Only the questions are divided. With the 60 block, 700 character caps the state is at most about
 * 21k estimated tokens, inside the documented 32k limit for state plus one question.
 */
export function planRequests(blocks: readonly PromptBlock[], isReply: boolean): SystemOneRequest[] {
    if (!blocks.length) {
        return [];
    }
    const state = buildState(blocks, isReply);
    const perQuestion = estimateTokens(blockQuestion(blocks.length - 1));
    const perRequest = Math.max(1, Math.floor((REQUEST_TOKEN_BUDGET - estimateTokens(state)) / perQuestion));

    const requests: SystemOneRequest[] = [];
    for (let from = 0; from < blocks.length; from += perRequest) {
        const questions: Record<string, ChoiceQuestion> = {};
        blocks.slice(from, from + perRequest).forEach((block, offset) => {
            questions[questionId(block.index)] = blockQuestion(from + offset);
        });
        requests.push({ state, questions });
    }
    return requests;
}
