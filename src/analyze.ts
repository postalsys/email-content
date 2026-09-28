/**
 * Content first API.
 *
 * `extract()` takes a raw RFC 5322 message and does its own MIME parsing. Most callers do not have
 * one: they have already parsed the message, with mailparser, postal-mime, EmailEngine or an IMAP
 * client, and hold `{ text, html, subject }`. Re-serialising that back into a message just to parse
 * it again would be wasteful and lossy.
 *
 * `analyze()` is the same pipeline entered one stage later. Stage 1 is skipped, Stages 2 to 8 are
 * identical, and the result has the same shape. Everything the extractor decides is derived from
 * the bodies themselves, so nothing is lost by not having the envelope.
 */

import { stripTagsToText } from './canonical/html';
import { loadPatterns } from './detect/patterns';
import { segmentHtmlBlocks } from './segment/html-blocks';
import { segmentTextBlocks } from './segment/text-blocks';
import { type Block, type Evidence } from './segment/types';
import { classifyBlocks } from './classify/rules';
import { pickPrimary, reconcileSection, type PrimaryChoice, type RepresentationInfo } from './classify/reconcile';
import { overallConfidence, validateConfidenceConfig, visibilityFor, type ConfidenceConfig } from './classify/confidence';
import {
    buildHistoryDocument,
    buildHistoryDocumentFromContent,
    matchBlocks,
    matchedIndices,
    strongMatchedIndices,
    type HistoryDocument
} from './match/history';
import { normaliseForMatch } from './match/normalize';
import { buildShingleIndex, containment, CONTAINMENT_THRESHOLD, isMatchable } from './match/shingle';
import { ConfigurationError, EXTRACTOR_VERSION, mimePartOf, type ContentAnalysisResult, type Reason, type Segment, type Warning } from './types';

/**
 * One structurally independent piece of a message body.
 *
 * A `multipart/mixed` message can carry several. The commonest shape in the working corpus,
 * `multipart/mixed(alternative(P,H), P)` at 3.1 percent of 320,377 messages, is an authored body
 * followed by a separately encoded gateway footer. They are not alternative renderings of each
 * other, and choosing between them deletes one.
 *
 * `text` and `html` within one section *are* alternative renderings, and at most one of them
 * reaches the output.
 */
export interface BodySection {
    /** Plain text of this section, already transfer and charset decoded. */
    text?: string | null;
    /** HTML of this section, already transfer and charset decoded. */
    html?: string | null;
    /** MIME part ids, when the caller knows them, purely for traceability in the output. */
    textPartId?: string;
    htmlPartId?: string;
    /**
     * Where the section sits. Derived internally by `extract()`; optional for external callers, who
     * may supply at most one `primary`. Evidence only: an appended section is classified normally,
     * because gateways append substantive text as often as they append disclaimers.
     */
    role?: 'primary' | 'appended';
}

/** A message body, in whichever representations are available. */
export interface MessageContent {
    /** Plain text body, already transfer and charset decoded. */
    text?: string | null;
    /** HTML body, already transfer and charset decoded. */
    html?: string | null;
    /**
     * Ordered body sections, when the message has more than one.
     *
     * Array position is the canonical order; there is deliberately no second ordering field to
     * disagree with it. Mutually exclusive with the single `text`/`html`/`textPartId`/`htmlPartId`
     * fields above, which are sugar for exactly one section. Supplying both is rejected rather than
     * guessed at.
     *
     * This is the shared path, not an `extract()` private. Building multi section composition
     * inside `extract()` would give the raw message entry point a capability the content first one
     * cannot express, and the two entry points must not be able to disagree about the same message.
     */
    sections?: readonly BodySection[];
    /** Subject line. Optional, and never allowed to change a label on its own. */
    subject?: string | null;
    /** Sender, as a display name and/or address. Used only as signature evidence. */
    from?: string | null;
    /** Threading hints. Optional, used only to note whether the message looks like a reply. */
    inReplyTo?: string | null;
    references?: readonly string[];
    /** MIME part ids, when the caller knows them, purely for traceability in the output. */
    textPartId?: string;
    htmlPartId?: string;
}

export interface AnalyzeOptions {
    confidence?: Partial<ConfidenceConfig>;
    /**
     * Maximum characters of body content analysed, across every section. Default 8,000,000.
     *
     * A circuit breaker for the content first entry point, where there is no raw message to bound.
     * Sections past the limit are not analysed and the result carries `input_limit_exceeded`.
     */
    maxContentChars?: number;
    /**
     * Earlier messages in the thread, nearest first. Each may be raw RFC 5322 or already split
     * content. History is optional and only ever adds evidence.
     */
    history?: readonly (MessageContent | string | Buffer)[];
    /** Pre-built history documents, for callers that resolve and cache threads themselves. */
    historyDocuments?: readonly HistoryDocument[];
    explain?: boolean;
}

/**
 * Result of analysing one message body.
 *
 * Extends the shared contract rather than restating it, so the two entry points cannot drift apart
 * again. `extract()` used to build its own object and silently drop `isReply`.
 */
export interface AnalyzeResult extends ContentAnalysisResult {
    diagnostics?: {
        primaryPart: string | null;
        blocks: {
            index: number;
            kind: string;
            label: string;
            confidence: number;
            reasons: Reason[];
            evidence: { id: string; kind: string; strength: number }[];
            features: Record<string, unknown>;
            preview: string;
        }[];
    };
}

const REPLY_SUBJECT = /^\s*(re|aw|sv|vs|vast|antw|res|odp|ответ)\s*(\[\d+\])?\s*:/i;

function contentChars(blocks: readonly Block[]): number {
    return blocks.reduce((sum, block) => sum + block.content.length, 0);
}

function hasAnchor(blocks: readonly Block[], minAnchorStrength: number): boolean {
    return blocks.some(block =>
        block.evidence.some(
            evidence =>
                evidence.kind === 'reply-anchor' ||
                evidence.kind === 'forward-anchor' ||
                (evidence.kind === 'quote-container' && evidence.strength >= minAnchorStrength)
        )
    );
}

/**
 * Name tokens from a From header, for signature detection.
 *
 * Takes the display name words and the address local part, keeping tokens long enough to be
 * distinctive. Short tokens are dropped because a two letter name fragment matches everywhere.
 */
export function senderTokensFrom(from: string | null | undefined): string[] {
    if (!from) {
        return [];
    }
    const display = from.replace(/<[^>]*>/g, ' ').replace(/["']/g, ' ');
    const local = (from.match(/([\w.+-]{1,64})@/) || [])[1] ?? '';
    const tokens = new Set<string>();
    for (const token of `${display} ${local.replace(/[._+-]+/g, ' ')}`.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
        if (token.length >= 3) {
            tokens.add(token);
        }
    }
    return [...tokens];
}

/** Confidence assigned to anything the pipeline could not classify. Never 1, never 0. */
const DEGRADED_CONFIDENCE = 0.5;

function representationInfo(blocks: Block[], representation: 'text' | 'html', degraded: boolean, minAnchorStrength: number): RepresentationInfo {
    return {
        representation,
        blocks,
        contentChars: contentChars(blocks),
        // A representation that failed to segment has no evidence, so it has no anchors either.
        hasAnchor: degraded ? false : hasAnchor(blocks, minAnchorStrength),
        degraded
    };
}

/** Evidence that a section arrived as a later MIME sibling rather than as the message body. */
const APPENDED_SECTION_EVIDENCE: Evidence = { id: 'mime:appended_section', kind: 'hint', strength: 0.5 };

/**
 * One body section, segmented, with its representation already chosen.
 *
 * Choosing before classification is what lets every section be classified as one sequence. See
 * `docs/adr-001-document-global-classification.md`.
 */
interface SegmentedSection {
    choice: PrimaryChoice;
    role: 'primary' | 'appended';
    /** Position of this section's blocks in the document sequence. */
    start: number;
    end: number;
}

/** Merge adjacent decisions carrying the same label, so the output is regions rather than lines. */
function toSegments(decisions: ReturnType<typeof classifyBlocks>, config: ConfidenceConfig): Segment[] {
    const segments: Segment[] = [];

    for (const decision of decisions) {
        const block = decision.block;
        const previous = segments[segments.length - 1];
        const visibility = visibilityFor(decision.label, decision.confidence, config);

        if (previous && previous.type === decision.label && previous.visibility === visibility && mimePartOf(previous.source) === block.mimePart) {
            previous.text = previous.text ? `${previous.text}\n${block.content}` : block.content;
            if (block.html) {
                previous.html = (previous.html ?? '') + block.html;
            }
            previous.source.end = block.end;
            previous.confidence = Math.min(previous.confidence, decision.confidence);
            for (const reason of decision.reasons) {
                if (!previous.reasons.includes(reason)) {
                    previous.reasons.push(reason);
                }
            }
            continue;
        }

        if (block.features.isAllBlank && !previous) {
            continue;
        }

        segments.push({
            type: decision.label,
            text: block.content,
            ...(block.html ? { html: block.html } : {}),
            confidence: decision.confidence,
            visibility,
            reasons: [...decision.reasons],
            source: {
                kind: 'mime-part',
                mimePart: block.mimePart,
                representation: block.representation,
                // The section-local index, not the document-global one the classifier ran on. A
                // reader following this back wants the block's position inside its own MIME part.
                blockIndex: block.sourceIndex ?? block.index,
                start: block.start,
                end: block.end,
                ...(block.domPath ? { domPath: block.domPath } : {})
            }
        });
    }

    return segments.filter(segment => segment.text.trim().length > 0);
}

function trimmedOrEmpty(value: string | null | undefined): string {
    return typeof value === 'string' && value.trim() ? value : '';
}

/**
 * Are two adjacent sections the same content in two representations?
 *
 * Some clients emit `multipart/mixed(H, P)` where they meant `multipart/alternative`: 158 messages
 * in the working corpus, most of them in that order. Structure alone cannot tell that apart from a
 * genuine plain text sibling next to a genuine HTML one, and guessing wrong in the merging direction
 * deletes a section. So the question is settled by content: shingle containment either way, at the
 * same threshold history matching uses. No match means both are kept, and the cost of that is a
 * body that appears twice rather than one that disappears.
 */
function isSameContentAlternative(a: BodySection, b: BodySection): boolean {
    const aText = trimmedOrEmpty(a.text);
    const aHtml = trimmedOrEmpty(a.html);
    const bText = trimmedOrEmpty(b.text);
    const bHtml = trimmedOrEmpty(b.html);

    let plain: string;
    let markup: string;
    if (aText && !aHtml && bHtml && !bText) {
        plain = aText;
        markup = bHtml;
    } else if (aHtml && !aText && bText && !bHtml) {
        plain = bText;
        markup = aHtml;
    } else {
        return false;
    }

    const left = buildShingleIndex(normaliseForMatch(plain));
    const right = buildShingleIndex(normaliseForMatch(stripTagsToText(markup)));
    if (!isMatchable(left) || !isMatchable(right)) {
        // Too short to judge. Keeping both is the safe answer.
        return false;
    }
    return containment(left, right).containment >= CONTAINMENT_THRESHOLD || containment(right, left).containment >= CONTAINMENT_THRESHOLD;
}

function mergeEquivalentSections(sections: readonly BodySection[]): BodySection[] {
    const merged: BodySection[] = [];
    for (const section of sections) {
        const previous = merged[merged.length - 1];
        if (previous && isSameContentAlternative(previous, section)) {
            merged[merged.length - 1] = {
                text: previous.text ?? section.text ?? null,
                html: previous.html ?? section.html ?? null,
                ...((previous.textPartId ?? section.textPartId) ? { textPartId: previous.textPartId ?? section.textPartId } : {}),
                ...((previous.htmlPartId ?? section.htmlPartId) ? { htmlPartId: previous.htmlPartId ?? section.htmlPartId } : {}),
                ...(previous.role ? { role: previous.role } : {})
            };
            continue;
        }
        merged.push(section);
    }
    return merged;
}

/**
 * Resolve the caller's input into an ordered list of body sections.
 *
 * The single `text`/`html` pair is sugar for exactly one section, normalised here so that both
 * entry points and both call shapes run the identical composition below.
 */
function normaliseSections(content: MessageContent): BodySection[] {
    const hasLegacyContent = trimmedOrEmpty(content.text) !== '' || trimmedOrEmpty(content.html) !== '';

    if (content.sections) {
        if (hasLegacyContent) {
            throw new ConfigurationError('sections', 'the only body input; supplying text or html alongside it is ambiguous', 'conflicting_body_input');
        }
        if (content.sections.filter(section => section.role === 'primary').length > 1) {
            throw new ConfigurationError('sections', 'a list with at most one section whose role is "primary"', 'invalid_section_role');
        }
        return mergeEquivalentSections(content.sections.filter(section => trimmedOrEmpty(section.text) || trimmedOrEmpty(section.html)));
    }

    if (!hasLegacyContent) {
        return [];
    }
    return [
        {
            text: content.text ?? null,
            html: content.html ?? null,
            ...(content.textPartId ? { textPartId: content.textPartId } : {}),
            ...(content.htmlPartId ? { htmlPartId: content.htmlPartId } : {}),
            role: 'primary'
        }
    ];
}

/** Characters of body content analysed by default, across every section. */
const DEFAULT_MAX_CONTENT_CHARS = 8_000_000;

function validateMaxContentChars(value: number | undefined): number {
    if (value === undefined) {
        return DEFAULT_MAX_CONTENT_CHARS;
    }
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
        throw new ConfigurationError('maxContentChars', 'a positive safe integer');
    }
    return value;
}

/**
 * Drop sections once the aggregate content budget is spent.
 *
 * Whole sections rather than a character cut: a half section would be classified against structure
 * that is not there, and a confident wrong answer about truncated input is worse than an honest
 * refusal. Everything the budget did allow through is analysed and returned in full, and the
 * warning names the option so the caller can raise it.
 */
function limitSections(sections: readonly BodySection[], maxContentChars: number, warnings: Warning[]): BodySection[] {
    const kept: BodySection[] = [];
    let used = 0;
    for (const section of sections) {
        const size = (section.text?.length ?? 0) + (section.html?.length ?? 0);
        if (kept.length && used + size > maxContentChars) {
            warnings.push({ code: 'input_limit_exceeded', detail: `maxContentChars (${maxContentChars})` });
            break;
        }
        used += size;
        kept.push(section);
        if (used > maxContentChars) {
            warnings.push({ code: 'input_limit_exceeded', detail: `maxContentChars (${maxContentChars})` });
            break;
        }
    }
    return kept;
}

/** Turn whatever the caller supplied as history into searchable documents. */
export async function resolveHistory(options: AnalyzeOptions): Promise<HistoryDocument[]> {
    if (options.historyDocuments?.length) {
        return [...options.historyDocuments];
    }
    const documents: HistoryDocument[] = [];
    for (let i = 0; i < (options.history?.length ?? 0); i++) {
        const item = (options.history as readonly (MessageContent | string | Buffer)[])[i];
        try {
            if (typeof item === 'string' || Buffer.isBuffer(item)) {
                documents.push(await buildHistoryDocument(item, `history-${i}`, i === 0));
            } else if (item) {
                documents.push(buildHistoryDocumentFromContent(item.text ?? '', item.html ?? '', `history-${i}`, i === 0));
            }
        } catch {
            // An unusable ancestor simply contributes no evidence.
        }
    }
    return documents;
}

/**
 * Analyse an already parsed message body.
 *
 * Never throws. A body that cannot be segmented is returned whole as a single visible `UNKNOWN`
 * segment, because showing too much is always preferable to showing nothing.
 *
 * Segment offsets from a plain text part index its canonical text, which the result carries as
 * `canonicalText[mimePart]`, so a caller can slice exactly what it was given.
 */
export async function analyze(content: MessageContent, options: AnalyzeOptions = {}): Promise<AnalyzeResult> {
    // Classifier assets are loaded here, outside the fail-soft block below.
    //
    // Detectors call `loadPatterns()` lazily, which put its "no patterns could be loaded" assertion
    // inside the per message catch: a broken installation came back as one more degraded result
    // among many, and every message looked like new content because nothing could be detected as
    // history. A missing package asset is an installation defect and has to fail like one.
    loadPatterns();

    // Validated before any work. An invalid threshold is a programmer error that would otherwise
    // repeat silently on every message, so it throws here rather than degrading a result.
    const config = validateConfidenceConfig(options.confidence);
    const maxContentChars = validateMaxContentChars(options.maxContentChars);
    const warnings: Warning[] = [];

    const sections = limitSections(normaliseSections(content), maxContentChars, warnings);
    const isReply = Boolean(content.inReplyTo) || (content.references?.length ?? 0) > 0 || REPLY_SUBJECT.test(content.subject ?? '');

    const base = {
        originalAvailable: true as const,
        extractorVersion: EXTRACTOR_VERSION,
        isReply,
        canonicalText: {} as Record<string, string>
    };

    const empty = {
        ...base,
        segments: [],
        hiddenSegments: [],
        overallConfidence: 1,
        primaryRepresentation: 'none' as const,
        historyUsed: false
    };

    if (!sections.length) {
        return { ...empty, warnings: [{ code: 'no_body_parts' }] };
    }

    const senderTokens = senderTokensFrom(content.from);
    let history: HistoryDocument[] = [];
    try {
        history = await resolveHistory(options);
    } catch {
        // History is optional evidence. Failing to build it is never fatal.
    }

    try {
        // Segment every section and choose its representation, before anything is classified.
        const segmented: SegmentedSection[] = [];
        const documentBlocks: Block[] = [];
        const canonicalText: Record<string, string> = {};

        for (const section of sections) {
            const sectionText = typeof section.text === 'string' ? section.text : '';
            const sectionHtml = typeof section.html === 'string' ? section.html : '';

            let textInfo: RepresentationInfo | null = null;
            let htmlInfo: RepresentationInfo | null = null;
            let canonical: { mimePart: string; text: string } | null = null;

            if (sectionText.trim()) {
                const textPartId = section.textPartId ?? 'TEXT';
                const { canonical: canonicalForm, blocks } = segmentTextBlocks(sectionText, textPartId);
                canonical = { mimePart: textPartId, text: canonicalForm.text };
                textInfo = representationInfo(blocks, 'text', false, config.minAnchorStrength);
            }
            if (sectionHtml.trim()) {
                const htmlPartId = section.htmlPartId ?? 'HTML';
                const result = segmentHtmlBlocks(sectionHtml, htmlPartId);
                if (result.degraded) {
                    warnings.push({ code: 'html_parse_error', mimePart: htmlPartId });
                }
                htmlInfo = representationInfo(result.blocks, 'html', result.degraded, config.minAnchorStrength);
            }
            if (!textInfo && !htmlInfo) {
                continue;
            }

            const choice = pickPrimary(textInfo, htmlInfo);
            if (canonical && choice.primary.representation === 'text') {
                // Already computed by segmentation; handed back so a caller slicing segment offsets
                // does not have to recompute it and risk disagreeing with it.
                canonicalText[canonical.mimePart] = canonical.text;
            }
            const start = documentBlocks.length;
            for (const block of choice.primary.blocks) {
                // Section-local index preserved for traceability; the array position becomes the
                // decision index, which is what the classifier indexes its own arrays with.
                block.sourceIndex = block.index;
                block.index = documentBlocks.length;
                if (section.role === 'appended') {
                    block.evidence.push(APPENDED_SECTION_EVIDENCE);
                }
                documentBlocks.push(block);
            }
            segmented.push({ choice, role: section.role ?? 'primary', start, end: documentBlocks.length });
        }

        if (!documentBlocks.length) {
            return { ...empty, warnings: [...warnings, { code: 'no_body_parts' }] };
        }

        // Positional features are document-global, so that an appended gateway footer cannot stop
        // the primary section's signature from being the last thing the sender wrote.
        for (const block of documentBlocks) {
            block.features.indexFromEnd = documentBlocks.length - 1 - block.index;
        }

        const matches = history.length ? matchBlocks(documentBlocks, history) : [];
        const decisions = classifyBlocks(documentBlocks, {
            config,
            historyMatchedIndices: matchedIndices(matches),
            historyStrongIndices: strongMatchedIndices(matches),
            senderTokens
        });

        for (const section of segmented) {
            const slice = decisions.slice(section.start, section.end);
            if (section.choice.primary.degraded) {
                // A degraded parse has lost exactly the structure the visibility rules depend on,
                // so its decisions are replaced rather than trusted. Letting reply-header, quote
                // region and footer reasoning act on its flattened projection would let it infer
                // hidden regions from evidence it no longer has.
                for (const decision of slice) {
                    decision.label = 'UNKNOWN';
                    decision.confidence = DEGRADED_CONFIDENCE;
                    decision.reasons = ['degraded_to_unknown'];
                }
                continue;
            }
            const secondary = section.choice.secondary;
            const secondaryMatches = secondary ? matchBlocks(secondary.blocks, history) : [];
            const secondaryDecisions = secondary
                ? classifyBlocks(secondary.blocks, {
                      config,
                      historyMatchedIndices: matchedIndices(secondaryMatches),
                      historyStrongIndices: strongMatchedIndices(secondaryMatches),
                      senderTokens
                  })
                : null;
            reconcileSection(section.choice.primary.representation, slice, secondaryDecisions);
        }

        const segments = toSegments(decisions, config);
        const primary = (segmented[0] as SegmentedSection).choice.primary;

        if (!segments.length) {
            // A body part existed and yielded nothing a reader would have seen: scripts, styles,
            // comments, a tracking pixel, or markup that could not be parsed. An empty result with
            // no explanation is indistinguishable from content loss, so name the case. Additive,
            // and never a substitute for returning content that does exist.
            warnings.push({ code: 'no_visible_body_text', mimePart: decisions[0]?.block.mimePart ?? primary.representation.toUpperCase() });
        }

        const visible = segments.filter(segment => segment.visibility !== 'hide');
        const hidden = segments.filter(segment => segment.visibility === 'hide');
        const anyDegraded = segmented.some(section => section.choice.primary.degraded);

        // Invariant: a message with body text always yields something visible.
        const bodyHasText = decisions.some(decision => decision.block.content.trim().length > 0);
        if (bodyHasText && !visible.length) {
            warnings.push({ code: 'extraction_degraded', detail: 'no visible segment survived classification' });
            for (const segment of segments) {
                segment.visibility = 'show';
                segment.type = 'UNKNOWN';
                segment.reasons.push('degraded_to_unknown');
            }
            return {
                ...base,
                segments,
                hiddenSegments: [],
                overallConfidence: DEGRADED_CONFIDENCE,
                warnings,
                primaryRepresentation: primary.representation,
                historyUsed: history.length > 0,
                canonicalText,
                ...(options.explain ? { diagnostics: buildDiagnostics(documentBlocks, decisions) } : {})
            };
        }

        return {
            ...base,
            segments: visible,
            hiddenSegments: hidden,
            // A degraded section never reports full confidence, including when its projection was
            // empty and there is nothing to report confidence about. Claiming 1 for a body the
            // pipeline could not read would be the most misleading number in the result.
            overallConfidence: anyDegraded ? Math.min(DEGRADED_CONFIDENCE, overallConfidence(segments)) : overallConfidence(segments),
            warnings,
            primaryRepresentation: primary.representation,
            historyUsed: history.length > 0,
            canonicalText,
            ...(options.explain ? { diagnostics: buildDiagnostics(documentBlocks, decisions) } : {})
        };
    } catch (err) {
        // Whatever went wrong, the caller still gets their content back, whole and visible.
        //
        // The source reference names the representation and part the surviving text actually came
        // from. It used to be hardcoded to `TEXT`/`text` even when the content was HTML, which is a
        // traceability bug of the same family as losing the content outright: a reviewer following
        // it lands on a part that never held this text.
        const first = sections[0];
        const text = typeof first?.text === 'string' ? first.text : '';
        const html = typeof first?.html === 'string' ? first.html : '';
        const fromText = Boolean(text.trim());
        const fallback = fromText ? text : html;
        return {
            ...base,
            segments: fallback.trim()
                ? [
                      {
                          type: 'UNKNOWN',
                          text: fallback,
                          confidence: DEGRADED_CONFIDENCE,
                          visibility: 'show',
                          reasons: ['degraded_to_unknown'],
                          source: {
                              kind: 'mime-part',
                              mimePart: (fromText ? first?.textPartId : first?.htmlPartId) ?? (fromText ? 'TEXT' : 'HTML'),
                              representation: fromText ? 'text' : 'html',
                              blockIndex: 0,
                              start: 0,
                              end: fallback.length
                          }
                      }
                  ]
                : [],
            hiddenSegments: [],
            overallConfidence: DEGRADED_CONFIDENCE,
            warnings: [...warnings, { code: 'extraction_degraded', detail: err instanceof Error ? err.message.slice(0, 200) : 'unknown' }],
            primaryRepresentation: 'none',
            historyUsed: history.length > 0
        };
    }
}

function buildDiagnostics(blocks: readonly Block[], decisions: ReturnType<typeof classifyBlocks>): NonNullable<AnalyzeResult['diagnostics']> {
    return {
        primaryPart: blocks[0]?.mimePart ?? null,
        blocks: decisions.map(decision => ({
            index: decision.block.index,
            kind: decision.block.kind,
            label: decision.label,
            confidence: decision.confidence,
            reasons: decision.reasons,
            evidence: decision.block.evidence.map(item => ({ id: item.id, kind: item.kind, strength: item.strength })),
            features: decision.block.features as unknown as Record<string, unknown>,
            preview: decision.block.content.slice(0, 120)
        }))
    };
}
