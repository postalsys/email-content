/**
 * Stage 6: rule based sequence classification.
 *
 * Blocks are classified in context, never independently. The rules encode the four sequences that
 * matter, in the order they are resolved:
 *
 *   NEW_CONTENT, SIGNATURE, REPLY_HEADER, REPLY_HISTORY          top posting, the common case
 *   INLINE_QUOTE, NEW_CONTENT, INLINE_QUOTE, NEW_CONTENT         interleaved answers
 *   NEW_CONTENT, FORWARD_HEADER, FORWARDED_CONTENT               forwarding with a comment
 *   REPLY_HISTORY, NEW_CONTENT                                   bottom posting
 *
 * The load bearing rule is the anchor requirement. A quote region may only become REPLY_HISTORY
 * when something independent of the quoting itself says that it is history: an attribution line, a
 * client quote container, or a match against a message that already existed. Quote depth alone
 * gives INLINE_QUOTE or UNKNOWN, both of which stay visible.
 *
 * The reason a bare quote is not treated as history is the difference between the two examples in
 * the brief. Quoted questions with answers under them are context the reader needs. A trailing
 * quoted copy of the previous mail is noise. Only the surrounding structure tells them apart.
 */

import { type Label, type Reason } from '../types';
import { type Block } from '../segment/types';
import { DEFAULT_CONFIDENCE, type ConfidenceConfig } from './confidence';

export interface BlockDecision {
    block: Block;
    label: Label;
    confidence: number;
    reasons: Reason[];
}

export interface ClassifyOptions {
    config?: ConfidenceConfig;
    /**
     * Indices of blocks whose text was found in a known earlier message. Supplies the anchor for
     * blocks that have no structural evidence of their own.
     */
    historyMatchedIndices?: ReadonlySet<number>;
    /**
     * Blocks whose match against an earlier message was strong enough to stand on its own.
     *
     * A subset of `historyMatchedIndices`. Used only for unmarked history, below, where there is no
     * markup to corroborate and the match is the entire case.
     */
    historyStrongIndices?: ReadonlySet<number>;
    /**
     * Display name and local part of the sender, lowercased. A trailing short block containing the
     * sender's own name is strong evidence of a signature: it is how nearly every signature begins,
     * and unlike a greeting phrase it is language independent.
     */
    senderTokens?: readonly string[];
}

/**
 * Evidence ids that mark the first line of a signature rather than its body.
 *
 * A closing greeting or a "sent from my phone" line opens a signature. A phone number or a street
 * address sits inside one.
 */
/**
 * Confidence for history identified only by matching an earlier message, with no markup to back it.
 *
 * Deliberately under the default hide threshold of 0.95, so this signal can collapse a region but
 * can never hide one. Provenance says the text existed before; it says nothing about whether the
 * reader needs it, and the cost of being wrong has to stay recoverable.
 */
const UNMARKED_HISTORY_CONFIDENCE = 0.9;

const TOP_OF_SIGNATURE = new Set(['signature:best_regards', 'signature:sent_from_device', 'signature:sent_from_localised', 'signature:dash_dash_space']);

/** The signature evidence id on a block, if any. */
function topSignal(block: Block): string {
    for (const evidence of block.evidence) {
        if (evidence.kind === 'signature' && TOP_OF_SIGNATURE.has(evidence.id)) {
            return evidence.id;
        }
    }
    return '';
}

/** Highest strength evidence of a given kind attached to a block. */
function strengthOf(block: Block, kinds: readonly string[]): number {
    let best = 0;
    for (const evidence of block.evidence) {
        if (kinds.includes(evidence.kind) && evidence.strength > best) {
            best = evidence.strength;
        }
    }
    return best;
}

function hasWords(block: Block): boolean {
    return block.features.wordCount > 0 && !block.features.isAllBlank;
}

/** A quoted block, in either representation. */
function isQuote(block: Block): boolean {
    return block.kind === 'quote' || block.features.quoteDepth > 0 || block.features.blockquoteDepth > 0;
}

/** Client generated boilerplate that introduces a quote. Not authored by the sender. */
function isAnchorBlock(block: Block): boolean {
    return block.kind === 'reply_header' || block.kind === 'quoted_header_block';
}

interface Run {
    start: number;
    end: number;
    quoted: boolean;
}

/** Group blocks into alternating quoted and unquoted runs, ignoring blank blocks. */
function findRuns(blocks: readonly Block[]): Run[] {
    const runs: Run[] = [];
    for (const block of blocks) {
        if (block.features.isAllBlank) {
            continue;
        }
        const quoted = isQuote(block) || isAnchorBlock(block);
        const last = runs[runs.length - 1];
        if (last && last.quoted === quoted) {
            last.end = block.index;
        } else {
            runs.push({ start: block.index, end: block.index, quoted });
        }
    }
    return runs;
}

/**
 * Classify one representation's blocks.
 *
 * Runs in four passes so that later passes can see the whole picture: footers first, because they
 * bound where history can start; then anchors; then regions; then defaults.
 */
export function classifyBlocks(blocks: readonly Block[], options: ClassifyOptions = {}): BlockDecision[] {
    const config = options.config ?? DEFAULT_CONFIDENCE;
    const matched = options.historyMatchedIndices ?? new Set<number>();
    const senderTokens = options.senderTokens ?? [];

    const decisions: BlockDecision[] = blocks.map(block => ({
        block,
        label: 'NEW_CONTENT' as Label,
        confidence: 0.95,
        reasons: ['new_content_default' as Reason]
    }));

    const set = (index: number, label: Label, confidence: number, reasons: Reason[]) => {
        const decision = decisions[index];
        if (decision) {
            decision.label = label;
            decision.confidence = confidence;
            decision.reasons = reasons;
        }
    };

    // Pass 1: locate anchors.
    let replyAnchor = -1;
    let replyAnchorStrength = 0;
    let forwardAnchor = -1;
    let forwardAnchorStrength = 0;

    for (const block of blocks) {
        const forward = strengthOf(block, ['forward-anchor']);
        if (forward > 0 && forwardAnchor === -1) {
            forwardAnchor = block.index;
            forwardAnchorStrength = forward;
        }
        const reply = strengthOf(block, ['reply-anchor']);
        if (reply > 0 && replyAnchor === -1) {
            replyAnchor = block.index;
            replyAnchorStrength = reply;
        }
    }

    // A quote container in HTML is an anchor in its own right, but only when something corroborates
    // it.
    //
    // A client that quotes a message emits an attribution line with the container, or nests the
    // quoted text in a blockquote, or both. A container with neither is not reliably a quote
    // boundary: mailing list relays and some composers wrap arbitrary spans in a gmail_quote div,
    // and one message in the working corpus splits a single sentence across the container boundary.
    // Trusting that container would hide half a sentence of genuine content, so an uncorroborated
    // container is left as ordinary evidence and cannot anchor a hide.
    const hasAttribution = blocks.some(
        block => isAnchorBlock(block) || block.evidence.some(item => item.kind === 'attribution' || item.kind === 'reply-anchor')
    );
    const hasBlockquote = blocks.some(block => block.features.blockquoteDepth > 0);

    let containerAnchor = -1;
    let containerStrength = 0;
    if (hasAttribution || hasBlockquote) {
        for (const block of blocks) {
            const container = strengthOf(block, ['quote-container']);
            if (container >= config.minAnchorStrength && containerAnchor === -1) {
                containerAnchor = block.index;
                containerStrength = container;
            }
        }
    }
    if (containerAnchor !== -1 && (replyAnchor === -1 || containerAnchor < replyAnchor)) {
        replyAnchor = containerAnchor;
        replyAnchorStrength = Math.max(replyAnchorStrength, containerStrength);
    }

    // Some clients mark the boundary rather than wrapping the quote: Outlook Web emits an empty
    // #divRplyFwdMsg, Zimbra an #zwchr rule, Outlook desktop a bordered element. Everything after
    // such a separator is history, even though none of it is inside a blockquote.
    let separatorAnchor = -1;
    let separatorStrength = 0;
    for (const block of blocks) {
        const strength = strengthOf(block, ['separator']);
        if (strength >= config.minAnchorStrength) {
            separatorAnchor = block.index;
            separatorStrength = strength;
            break;
        }
    }

    // The plain text underscore rule is far too common to trust on its own. It only counts when an
    // embedded header block follows it closely, which is the shape Outlook actually produces.
    if (separatorAnchor === -1) {
        for (const block of blocks) {
            if (block.kind !== 'separator' || strengthOf(block, ['separator']) < 0.6) {
                continue;
            }
            let seen = 0;
            for (let i = block.index + 1; i < blocks.length && seen < 3; i++) {
                const candidate = blocks[i] as Block;
                if (candidate.features.isAllBlank) {
                    continue;
                }
                seen++;
                if (candidate.kind === 'quoted_header_block') {
                    separatorAnchor = block.index;
                    separatorStrength = 0.9;
                    break;
                }
            }
            if (separatorAnchor !== -1) {
                break;
            }
        }
    }

    // Pass 2: trailing footers, searched only within the region the sender actually authored.
    //
    // The footer scan has to know where history starts, which is why it runs after anchors. In a
    // top posted reply the signature sits between the new text and the quote, so a naive scan
    // backwards from the end of the message would hit the quoted history first and give up before
    // ever reaching the delimiter. Anything after the first anchor belongs to the quoted message
    // and is classified by the region rules instead.
    const firstQuoted = blocks.find(block => isQuote(block) && !block.features.isAllBlank)?.index ?? blocks.length;
    const authoredEnd = Math.min(
        firstQuoted,
        replyAnchor === -1 ? blocks.length : replyAnchor,
        separatorAnchor === -1 ? blocks.length : separatorAnchor,
        forwardAnchor === -1 ? blocks.length : forwardAnchor
    );

    // An RFC 3676 delimiter is the one high confidence signature signal. Everything from it to the
    // end of the authored region is the signature.
    for (let i = authoredEnd - 1; i >= 0; i--) {
        const block = blocks[i] as Block;
        if (isQuote(block)) {
            break;
        }
        // Match on the delimiter evidence, not on the block kind. In plain text a "-- " line is a
        // block of its own and comes out as kind 'separator', but in HTML it is the first line of a
        // paragraph that also holds the signature body. Requiring 'separator' meant the one high
        // confidence signature signal never fired on HTML at all.
        if (block.evidence.some(item => item.id === 'signature:dash_dash_space' && item.strength >= 0.9)) {
            for (let j = i; j < authoredEnd; j++) {
                set(j, 'SIGNATURE', 0.95, ['dash_dash_delimiter']);
            }
            break;
        }
    }

    // Trailing disclaimers, anywhere in the message.
    //
    // A gateway appends its legal footer to the outgoing message, so it lands after the quoted
    // history, outside the authored region the footer scan above covers. Measured against the
    // reference set, disclaimers sit at a mean relative position of 0.86 and 81 percent of them are
    // in the final quarter of the message, so bounding the scan to the authored region missed
    // essentially all of them.
    //
    // Only blocks still considered authored are converted, so this cannot pull anything out of a
    // history or forwarded region, and DISCLAIMER never hides, it only collapses.
    for (const block of blocks) {
        const decision = decisions[block.index];
        if (!decision || decision.label !== 'NEW_CONTENT') {
            continue;
        }
        const strength = strengthOf(block, ['disclaimer']);
        if (strength >= 0.7) {
            decision.label = 'DISCLAIMER';
            decision.confidence = Math.min(0.95, strength);
            decision.reasons = ['disclaimer_phrase'];
        }
    }

    // Then the signature region.
    //
    // A signature is not one block. In HTML it is typically a run of short blocks at the end of the
    // authored region, one line each: name, then title, then company, then phone, then links. Only
    // one of those carries anything a per block rule would recognise, which is why checking the
    // last block or two found almost nothing.
    //
    // So walk back from the end of the authored region collecting short blocks, stop at the first
    // real paragraph or quote, and accept the run if anything in it looks like a sign-off: contact
    // details, or a closing greeting, or a device phrase. The caps keep an unsigned message from
    // swallowing its own last paragraphs, and SIGNATURE only ever collapses, so the cost of being
    // wrong here is bounded.
    const MAX_SIGNATURE_BLOCKS = 6;
    const MAX_SIGNATURE_WORDS = 60;
    const MAX_BLOCK_WORDS = 25;

    let signatureStart = -1;
    let hasContact = false;
    let hasPhrase = false;
    let hasSenderName = false;
    let phraseStrength = 0;
    let words = 0;
    let collected = 0;

    for (let i = authoredEnd - 1; i >= 0 && collected < MAX_SIGNATURE_BLOCKS; i--) {
        const block = blocks[i] as Block;
        const decision = decisions[i];
        if (!decision) {
            continue;
        }
        if (block.features.isAllBlank) {
            continue;
        }
        if (decision.label === 'SIGNATURE') {
            signatureStart = i;
            continue;
        }
        if (isQuote(block) || isAnchorBlock(block) || decision.label === 'DISCLAIMER') {
            break;
        }
        if (block.features.wordCount > MAX_BLOCK_WORDS) {
            break;
        }
        words += block.features.wordCount;
        if (words > MAX_SIGNATURE_WORDS) {
            break;
        }
        if (block.features.hasEmailAddress || block.features.hasPhoneNumber || block.features.hasUrl) {
            hasContact = true;
        }
        const strength = strengthOf(block, ['signature']);
        if (strength > 0) {
            hasPhrase = true;
            phraseStrength = Math.max(phraseStrength, strength);
        }
        if (senderTokens.length && !hasSenderName) {
            const lowered = block.content.toLowerCase();
            if (senderTokens.some(token => lowered.includes(token))) {
                hasSenderName = true;
            }
        }
        signatureStart = i;
        collected++;

        // A closing greeting or a device phrase is the top of a signature, not part of the body
        // above it. Stop here, otherwise the scan keeps walking back over short sentences and
        // eventually swallows the message it was supposed to be signing.
        //
        // Only those two count. Contact lines, postal addresses and the generic shape heuristic are
        // signature *body*, and treating them as the top stopped the scan on the first line it saw,
        // which is why a six line corporate signature was recognised as no signature at all.
        if (TOP_OF_SIGNATURE.has(topSignal(block))) {
            break;
        }
    }

    // Two independent signals, or one very strong one. Requiring only "something looks like a
    // sign-off" labelled a quarter of the corpus's closing paragraphs as signature: precision was
    // 24 percent and it started collapsing real content.
    const strongPhrase = phraseStrength >= 0.9;

    // A signature signs something. If the candidate run starts at the first authored block there is
    // nothing above it to sign, and the message is a short note that happens to end in contact
    // details, not a signature block. Without this guard the region swallowed whole short messages
    // and left only a collapsed footer visible, which the corpus checks caught on 42 of 3,000
    // messages.
    let hasContentAbove = false;
    for (let i = 0; i < signatureStart; i++) {
        const block = blocks[i];
        const decision = decisions[i];
        if (block && decision && !block.features.isAllBlank && decision.label === 'NEW_CONTENT' && hasWords(block)) {
            hasContentAbove = true;
            break;
        }
    }

    // The sender's own name counts alongside contact details and sign-off phrases. Requiring two
    // signals still holds, so a message that merely mentions the sender's name in passing does not
    // become a signature.
    const signals = [hasContact, hasPhrase, hasSenderName].filter(Boolean).length;
    const accepted = hasContentAbove && (strongPhrase || signals >= 2);
    if (signatureStart !== -1 && accepted) {
        const confidence = phraseStrength >= 0.9 ? 0.95 : signals >= 3 ? 0.9 : signals >= 2 ? 0.85 : 0.76;
        const reason: Reason = phraseStrength >= 0.9 ? 'mobile_signature_phrase' : 'signature_position_and_length';
        for (let i = signatureStart; i < authoredEnd; i++) {
            const decision = decisions[i];
            const block = blocks[i];
            if (!decision || !block || decision.label === 'DISCLAIMER') {
                continue;
            }
            if (isQuote(block) || isAnchorBlock(block)) {
                break;
            }
            set(i, 'SIGNATURE', confidence, [reason]);
        }
    }

    // Pass 3: regions.
    const runs = findRuns(blocks);
    const quotedRuns = runs.filter(run => run.quoted);
    const contentRunsAfterFirstQuote = runs.filter(run => !run.quoted && quotedRuns.length > 0 && run.start > (quotedRuns[0] as Run).start);

    // Interleaved: more than one quoted run, with authored content between them. Every quoted run
    // is then context for the answer beside it, not disposable history.
    const interleaved =
        quotedRuns.length > 1 &&
        contentRunsAfterFirstQuote.some(run => {
            for (let i = run.start; i <= run.end; i++) {
                const decision = decisions[i];
                const block = blocks[i];
                if (!decision || !block) {
                    continue;
                }
                if (decision.label === 'NEW_CONTENT' && hasWords(block) && !isAnchorBlock(block)) {
                    return true;
                }
            }
            return false;
        });

    if (forwardAnchor !== -1) {
        // Everything from the forward marker to the end is forwarded material. It is collapsed and
        // kept, never hidden: the sender included it deliberately.
        for (let i = forwardAnchor; i < blocks.length; i++) {
            const decision = decisions[i];
            if (!decision || decision.label === 'DISCLAIMER') {
                continue;
            }
            set(i, 'FORWARDED_CONTENT', Math.min(0.95, forwardAnchorStrength), ['preceded_by_forward_header']);
        }
    }

    for (const run of quotedRuns) {
        if (forwardAnchor !== -1 && run.start >= forwardAnchor) {
            continue;
        }

        const anchored = replyAnchor !== -1 && replyAnchor <= run.end;
        const anchorStrength = anchored ? replyAnchorStrength : 0;

        // Is there authored content after this run that is not a footer?
        let newContentAfter = false;
        for (let i = run.end + 1; i < blocks.length; i++) {
            const decision = decisions[i];
            const block = blocks[i];
            if (!decision || !block || block.features.isAllBlank) {
                continue;
            }
            if (decision.label === 'SIGNATURE' || decision.label === 'DISCLAIMER') {
                continue;
            }
            if (isQuote(block) || isAnchorBlock(block)) {
                continue;
            }
            if (hasWords(block)) {
                newContentAfter = true;
                break;
            }
        }

        let label: Label;
        let confidence: number;
        const reasons: Reason[] = [];

        // Deepest quoting in this run. Depth 1 is the message being replied to; depth 2 or more is
        // a quote inside a quote, which someone else already quoted before this conversation
        // reached the sender.
        let runDepth = 0;
        for (let i = run.start; i <= run.end; i++) {
            const block = blocks[i];
            if (block) {
                runDepth = Math.max(runDepth, block.features.quoteDepth, block.features.blockquoteDepth);
            }
        }

        // Inline quoting is answering someone point by point, and it happens at depth 1: you quote
        // the person you are replying to and write underneath. Nested quoting is a chain, and a run
        // with an answer somewhere after it elsewhere in the message says nothing about whether this
        // particular nested run is context. Measured on the reference set, 220 of the blocks wrongly
        // called inline quote were at depth 2 or deeper.
        const eligibleForInline = runDepth <= 1;

        if (interleaved && eligibleForInline && newContentAfter) {
            // Answered here, so it is the context for that answer.
            label = 'INLINE_QUOTE';
            confidence = 0.9;
            reasons.push('interleaved_with_new_content', 'new_content_after_region');
        } else if (anchored) {
            label = 'REPLY_HISTORY';
            if (anchored) {
                reasons.push(replyAnchor === containerAnchor ? 'inside_quote_container' : 'preceded_by_reply_header');
            }
            if (newContentAfter) {
                // Bottom posting. The quote is still history, but the reader is depending on it for
                // context more often than in the top posted case, so it is collapsed rather than
                // hidden unless history matching confirmed it.
                reasons.push('new_content_after_region');
                confidence = 0.9;
            } else {
                reasons.push('final_contiguous_quote_region', 'no_new_content_after_region');
                confidence = Math.min(0.97, 0.6 + anchorStrength * 0.4);
            }
        } else if (newContentAfter && eligibleForInline) {
            // Quoted text with an answer under it and nothing saying it is history. This is the
            // inline question and answer shape, and the quote is the context for the answer.
            label = 'INLINE_QUOTE';
            confidence = 0.9;
            reasons.push('new_content_after_region', 'no_anchor_for_quote');
        } else {
            // Quoted text at the end of a message with no anchor at all. It looks like history but
            // nothing confirms it, so it stays visible.
            label = 'UNKNOWN';
            confidence = 0.5;
            reasons.push('no_anchor_for_quote', 'ambiguous_kept_visible');
        }

        for (let i = run.start; i <= run.end; i++) {
            const decision = decisions[i];
            const block = blocks[i];
            if (!decision || !block) {
                continue;
            }
            if (decision.label === 'SIGNATURE' || decision.label === 'DISCLAIMER') {
                continue;
            }
            // A generic blockquote alone is weaker evidence than a client specific container.
            const weakContainer =
                block.evidence.some(item => item.id === 'html:generic_blockquote') && strengthOf(block, ['quote-container']) < config.minAnchorStrength;
            const adjusted = label === 'REPLY_HISTORY' && weakContainer && !anchored ? Math.min(confidence, 0.8) : confidence;
            set(i, label, adjusted, [...reasons]);
        }
    }

    // Unmarked history after a strong anchor.
    //
    // Outlook and several other clients embed the previous message as plain paragraphs with no
    // quote prefix at all, introduced by "-----Original Message-----" and a From/Sent/To/Subject
    // block. Nothing in that text is marked as quoted, so the run rules above never see it and the
    // whole previous message stays visible as new content.
    //
    // The sweep is bounded deliberately: it runs from the anchor only as far as the first quoted
    // block. That is what keeps a bottom posted reply safe. In "On X wrote: / > quote / my answer",
    // the anchor is immediately followed by a quoted block, so the sweep covers the anchor alone
    // and the answer below is untouched.
    if (replyAnchor !== -1 && replyAnchorStrength >= config.minAnchorStrength && !interleaved) {
        let limit = blocks.length;
        for (let i = replyAnchor + 1; i < blocks.length; i++) {
            const block = blocks[i] as Block;
            if (isQuote(block)) {
                limit = i;
                break;
            }
        }

        // Corroboration: Outlook's shape is the separator followed closely by the embedded header
        // block. With it, this is safe to hide. Without it, the region is collapsed but stays
        // recoverable, because a lone anchor could in principle be text the sender typed.
        let corroborated = false;
        let seen = 0;
        for (let i = replyAnchor; i < blocks.length && seen < 4; i++) {
            const block = blocks[i] as Block;
            if (block.features.isAllBlank) {
                continue;
            }
            seen++;
            if (block.kind === 'quoted_header_block' || block.features.headerFieldLines >= 2) {
                corroborated = true;
                break;
            }
        }

        const reasons: Reason[] = corroborated
            ? ['preceded_by_reply_header', 'contains_old_message_headers', 'no_new_content_after_region']
            : ['preceded_by_reply_header', 'ambiguous_kept_visible'];

        const confidence = corroborated ? 0.96 : 0.9;
        for (let i = replyAnchor; i < limit; i++) {
            const decision = decisions[i];
            if (!decision) {
                continue;
            }
            if (decision.label === 'FORWARDED_CONTENT' || decision.label === 'INLINE_QUOTE') {
                continue;
            }
            // The attribution line was already classified by the run rules, which could not see the
            // unmarked history that follows it. Raising it to the sweep's confidence keeps the whole
            // region as one segment instead of splitting it at the anchor.
            if (decision.label === 'REPLY_HISTORY' && decision.confidence >= confidence) {
                continue;
            }
            decision.label = 'REPLY_HISTORY';
            decision.confidence = confidence;
            decision.reasons = [...reasons];
        }
    }

    // A client reply separator makes everything after it history, whether or not it is quoted.
    // Footers are left alone: a signature after the separator belongs to the quoted message and is
    // already inside the region, while one before it belongs to the sender.
    if (separatorAnchor !== -1 && !interleaved) {
        const reasons: Reason[] = ['outlook_reply_separator', 'final_contiguous_quote_region'];
        for (let i = separatorAnchor; i < blocks.length; i++) {
            const decision = decisions[i];
            const block = blocks[i];
            if (!decision || !block) {
                continue;
            }
            if (decision.label === 'FORWARDED_CONTENT' || decision.label === 'REPLY_HISTORY' || decision.label === 'INLINE_QUOTE') {
                continue;
            }
            decision.label = 'REPLY_HISTORY';
            decision.confidence = Math.min(0.96, 0.6 + separatorStrength * 0.4);
            decision.reasons = [...reasons];
        }
    }

    // An anchor line that sits outside any quoted run still belongs to the region it introduces.
    for (const block of blocks) {
        if (!isAnchorBlock(block)) {
            continue;
        }
        const decision = decisions[block.index];
        if (!decision || decision.label !== 'NEW_CONTENT') {
            continue;
        }
        const next = decisions[block.index + 1] ?? decisions[block.index + 2];
        if (next && (next.label === 'REPLY_HISTORY' || next.label === 'INLINE_QUOTE' || next.label === 'FORWARDED_CONTENT')) {
            set(block.index, next.label, next.confidence, [...next.reasons]);
        }
    }

    // Stage 5 evidence, applied strictly per block.
    //
    // A match proves provenance: this exact text existed before the message was written. It does
    // not prove function. So a match may confirm a region the structure already read as history,
    // and may rescue a quote that had no anchor at all, but it may never override a functional
    // judgment:
    //
    //   - INLINE_QUOTE is never promoted. Every inline quote appears in the parent by definition,
    //     so matching would hide exactly the context an answer depends on.
    //   - NEW_CONTENT is never promoted. A sender restating something from the parent is still
    //     writing it now.
    //
    // Applying this per block rather than per run matters. An earlier version promoted a whole run
    // when any block in it matched, which hid authored text sitting beside quoted text and produced
    // the only catastrophic failures measured on the reference set.
    for (const index of matched) {
        const decision = decisions[index];
        const block = blocks[index];
        if (!decision || !block) {
            continue;
        }
        if (decision.label === 'REPLY_HISTORY') {
            // Provenance alone does not license hiding. A quoted block with the sender's answer
            // underneath is still the context for that answer, and a forwarded message is still
            // something the sender chose to pass on, however certainly it existed before. Both stay
            // collapsed, so a match confirms without ever crossing the hide threshold on its own.
            const trailingRegion = decision.reasons.includes('no_new_content_after_region');
            const insideForward = forwardAnchor !== -1 && index >= forwardAnchor;
            const ceiling = trailingRegion && !insideForward ? 0.98 : 0.94;
            decision.confidence = Math.max(decision.confidence, ceiling);
            if (!decision.reasons.includes('matched_parent_message')) {
                decision.reasons.push('matched_parent_message');
            }
            continue;
        }
        if (decision.label === 'UNKNOWN' && (isQuote(block) || isAnchorBlock(block))) {
            decision.label = 'REPLY_HISTORY';
            decision.confidence = 0.96;
            decision.reasons = ['matched_parent_message', 'quote_depth_positive'];
        }
    }

    // Unmarked history that only the thread can identify.
    //
    // Outlook and several other clients paste the previous message as ordinary paragraphs: no quote
    // prefix, no blockquote, and sometimes no attribution line either. Nothing in the markup says
    // it is history, so every rule above leaves it as NEW_CONTENT, and it is the largest remaining
    // category. Measured over the 305 reference messages that have a resolvable parent, 78 percent
    // of the characters we show as new content but the reference calls history reproduce the parent
    // message.
    //
    // The rule the block above states, that NEW_CONTENT is never promoted because a sender
    // restating something is still writing it now, holds for a sentence quoted back at you. It does
    // not hold for a verbatim copy of the whole previous message. What separates them is not the
    // match, it is position: unmarked history follows what the sender wrote.
    //
    // Collapsed, never hidden. The match is strong evidence of provenance and no evidence at all of
    // intent, so the reader keeps it one interaction away. Measured on the reference set this
    // reclassifies 37,094 characters correctly against 3,138 incorrectly, and the incorrect ones
    // stay visible-on-request rather than disappearing.
    const strong = options.historyStrongIndices;
    if (strong?.size) {
        const promotable = new Set<number>();
        for (const index of strong) {
            const decision = decisions[index];
            const block = blocks[index];
            if (decision && block && decision.label === 'NEW_CONTENT' && hasWords(block) && !isQuote(block) && !isAnchorBlock(block)) {
                promotable.add(index);
            }
        }
        for (const index of promotable) {
            // Something the sender demonstrably wrote has to survive above this block. Without that
            // guard a reply whose every paragraph echoes the parent collapses in full, and the
            // whole-message safeguard has to undo it.
            let authoredAbove = false;
            for (let i = 0; i < index; i++) {
                const decision = decisions[i];
                const block = blocks[i];
                if (decision && block && decision.label === 'NEW_CONTENT' && hasWords(block) && !promotable.has(i)) {
                    authoredAbove = true;
                    break;
                }
            }
            if (!authoredAbove) {
                continue;
            }
            const decision = decisions[index] as BlockDecision;
            decision.label = 'REPLY_HISTORY';
            decision.confidence = UNMARKED_HISTORY_CONFIDENCE;
            decision.reasons = ['matched_parent_message', 'shingle_overlap_high'];
        }
    }

    // Pass 4: blank blocks carry no meaning of their own, so they inherit from their neighbour to
    // avoid gaps in a hidden region.
    for (let i = 0; i < decisions.length; i++) {
        const decision = decisions[i];
        const block = blocks[i];
        if (!decision || !block || !block.features.isAllBlank) {
            continue;
        }
        const previous = decisions[i - 1];
        const next = decisions[i + 1];
        if (previous && next && previous.label === next.label) {
            decision.label = previous.label;
            decision.confidence = Math.min(previous.confidence, next.confidence);
            decision.reasons = [...previous.reasons];
        } else if (previous) {
            decision.label = previous.label;
            decision.confidence = previous.confidence;
            decision.reasons = [...previous.reasons];
        }
    }

    // Final guard: a message must never come out as nothing but its own footer.
    //
    // The signature region can legitimately grow to cover everything a sender typed when the
    // message is short. That leaves a reader looking at a collapsed footer and no message, so if no
    // authored block survives, the footer is given back. Being wrong about a signature costs
    // tidiness; being wrong this way costs the whole message.
    const hasVisibleAuthored = decisions.some((decision, index) => {
        const block = blocks[index];
        return block && hasWords(block) && (decision.label === 'NEW_CONTENT' || decision.label === 'INLINE_QUOTE' || decision.label === 'UNKNOWN');
    });
    if (!hasVisibleAuthored) {
        for (let i = 0; i < decisions.length; i++) {
            const decision = decisions[i];
            const block = blocks[i];
            if (decision && block && decision.label === 'SIGNATURE' && hasWords(block)) {
                decision.label = 'NEW_CONTENT';
                decision.confidence = 0.7;
                decision.reasons = ['ambiguous_kept_visible'];
            }
        }
    }

    return decisions;
}
