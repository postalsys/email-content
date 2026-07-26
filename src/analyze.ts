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

import { segmentHtmlBlocks } from './segment/html-blocks';
import { segmentTextBlocks } from './segment/text-blocks';
import { type Block } from './segment/types';
import { classifyBlocks } from './classify/rules';
import { pickPrimary, reconcile, type RepresentationResult } from './classify/reconcile';
import { DEFAULT_CONFIDENCE, overallConfidence, visibilityFor, type ConfidenceConfig } from './classify/confidence';
import { buildHistoryDocument, buildHistoryDocumentFromContent, matchBlocks, matchedIndices, type HistoryDocument } from './match/history';
import { EXTRACTOR_VERSION, type Reason, type Segment, type Warning } from './types';

/** A message body, in whichever representations are available. */
export interface MessageContent {
    /** Plain text body, already transfer and charset decoded. */
    text?: string | null;
    /** HTML body, already transfer and charset decoded. */
    html?: string | null;
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
    confidence?: ConfidenceConfig;
    /**
     * Earlier messages in the thread, nearest first. Each may be raw RFC 5322 or already split
     * content. History is optional and only ever adds evidence.
     */
    history?: readonly (MessageContent | string | Buffer)[];
    /** Pre-built history documents, for callers that resolve and cache threads themselves. */
    historyDocuments?: readonly HistoryDocument[];
    explain?: boolean;
}

export interface AnalyzeResult {
    /** Segments the client should render, in document order. */
    segments: Segment[];
    /** Segments the client may hide or collapse. Retained in full so nothing is ever lost. */
    hiddenSegments: Segment[];
    overallConfidence: number;
    warnings: Warning[];
    originalAvailable: true;
    primaryRepresentation: 'text' | 'html' | 'none';
    extractorVersion: string;
    historyUsed: boolean;
    /** True when the input looked like a reply, from threading headers or a subject prefix. */
    isReply: boolean;
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

function hasAnchor(blocks: readonly Block[]): boolean {
    return blocks.some(block =>
        block.evidence.some(
            evidence =>
                evidence.kind === 'reply-anchor' || evidence.kind === 'forward-anchor' || (evidence.kind === 'quote-container' && evidence.strength >= 0.85)
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

function buildRepresentation(
    blocks: Block[],
    representation: 'text' | 'html',
    config: ConfidenceConfig,
    history: readonly HistoryDocument[],
    senderTokens: readonly string[]
): RepresentationResult {
    const matches = history.length ? matchBlocks(blocks, history) : [];
    return {
        representation,
        decisions: classifyBlocks(blocks, { config, historyMatchedIndices: matchedIndices(matches), senderTokens }),
        contentChars: contentChars(blocks),
        hasAnchor: hasAnchor(blocks),
        matches
    };
}

/** Merge adjacent decisions carrying the same label, so the output is regions rather than lines. */
function toSegments(decisions: ReturnType<typeof classifyBlocks>, config: ConfidenceConfig): Segment[] {
    const segments: Segment[] = [];

    for (const decision of decisions) {
        const block = decision.block;
        const previous = segments[segments.length - 1];
        const visibility = visibilityFor(decision.label, decision.confidence, config);

        if (previous && previous.type === decision.label && previous.visibility === visibility && previous.source.mimePart === block.mimePart) {
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
                mimePart: block.mimePart,
                representation: block.representation,
                blockIndex: block.index,
                start: block.start,
                end: block.end,
                ...(block.domPath ? { domPath: block.domPath } : {})
            }
        });
    }

    return segments.filter(segment => segment.text.trim().length > 0);
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
 */
export async function analyze(content: MessageContent, options: AnalyzeOptions = {}): Promise<AnalyzeResult> {
    const config = options.confidence ?? DEFAULT_CONFIDENCE;
    const warnings: Warning[] = [];

    const text = typeof content.text === 'string' ? content.text : '';
    const html = typeof content.html === 'string' ? content.html : '';
    const isReply = Boolean(content.inReplyTo) || (content.references?.length ?? 0) > 0 || REPLY_SUBJECT.test(content.subject ?? '');

    const base = {
        originalAvailable: true as const,
        extractorVersion: EXTRACTOR_VERSION,
        isReply
    };

    if (!text.trim() && !html.trim()) {
        return {
            ...base,
            segments: [],
            hiddenSegments: [],
            overallConfidence: 1,
            warnings: [{ code: 'no_body_parts' }],
            primaryRepresentation: 'none',
            historyUsed: false
        };
    }

    const senderTokens = senderTokensFrom(content.from);
    let history: HistoryDocument[] = [];
    try {
        history = await resolveHistory(options);
    } catch {
        // History is optional evidence. Failing to build it is never fatal.
    }

    try {
        let textResult: RepresentationResult | null = null;
        let htmlResult: RepresentationResult | null = null;
        let primaryBlocks: Block[] = [];

        if (text.trim()) {
            const segmented = segmentTextBlocks(text, content.textPartId ?? 'TEXT');
            textResult = buildRepresentation(segmented.blocks, 'text', config, history, senderTokens);
            primaryBlocks = segmented.blocks;
        }

        if (html.trim()) {
            const segmented = segmentHtmlBlocks(html, content.htmlPartId ?? 'HTML');
            if (segmented.degraded) {
                warnings.push({ code: 'html_parse_error' });
            }
            htmlResult = buildRepresentation(segmented.blocks, 'html', config, history, senderTokens);
            if (!textResult) {
                primaryBlocks = segmented.blocks;
            }
        }

        if (!textResult && !htmlResult) {
            return {
                ...base,
                segments: [],
                hiddenSegments: [],
                overallConfidence: 1,
                warnings: [...warnings, { code: 'no_body_parts' }],
                primaryRepresentation: 'none',
                historyUsed: false
            };
        }

        const outcome = pickPrimary(textResult, htmlResult);
        if (outcome.primary === htmlResult && htmlResult) {
            primaryBlocks = htmlResult.decisions.map(decision => decision.block);
        } else if (textResult) {
            primaryBlocks = textResult.decisions.map(decision => decision.block);
        }

        const decisions = reconcile(outcome);
        const segments = toSegments(decisions, config);

        const visible = segments.filter(segment => segment.visibility !== 'hide');
        const hidden = segments.filter(segment => segment.visibility === 'hide');

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
                overallConfidence: 0.5,
                warnings,
                primaryRepresentation: outcome.primary.representation,
                historyUsed: history.length > 0,
                ...(options.explain ? { diagnostics: buildDiagnostics(primaryBlocks, decisions) } : {})
            };
        }

        return {
            ...base,
            segments: visible,
            hiddenSegments: hidden,
            overallConfidence: overallConfidence(segments),
            warnings,
            primaryRepresentation: outcome.primary.representation,
            historyUsed: history.length > 0,
            ...(options.explain ? { diagnostics: buildDiagnostics(primaryBlocks, decisions) } : {})
        };
    } catch (err) {
        const fallback = text || html;
        return {
            ...base,
            segments: fallback.trim()
                ? [
                      {
                          type: 'UNKNOWN',
                          text: fallback,
                          confidence: 0.5,
                          visibility: 'show',
                          reasons: ['degraded_to_unknown'],
                          source: { mimePart: 'TEXT', representation: 'text', blockIndex: 0, start: 0, end: fallback.length }
                      }
                  ]
                : [],
            hiddenSegments: [],
            overallConfidence: 0.5,
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
