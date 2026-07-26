/**
 * Public library API.
 *
 * `extract()` is the whole product surface: raw message in, classified segments out, with every
 * segment traceable to a MIME part and a source range, and nothing ever discarded.
 */

import { parseMessage } from './mime/parse';
import { type MimePart, type ParseOptions, type ParsedMessage } from './mime/model';
import { type ConfidenceConfig } from './classify/confidence';
import { type HistoryDocument } from './match/history';
import { analyze } from './analyze';
import { EXTRACTOR_VERSION, type ExtractionResult, type Reason, type Warning } from './types';

export * from './types';
export { parseMessage } from './mime/parse';
export type { ParsedMessage, MimePart } from './mime/model';
export type { Block, BlockFeatures, BlockKind, Evidence } from './segment/types';
export { DEFAULT_CONFIDENCE } from './classify/confidence';
export { buildHistoryDocument, matchBlocks, type HistoryDocument, type BlockMatch } from './match/history';
export { corpusThreadResolver, folderThreadResolver, type ThreadResolver } from './corpus/thread-index';
export { analyze, resolveHistory, senderTokensFrom, type MessageContent, type AnalyzeOptions, type AnalyzeResult } from './analyze';

export interface ExtractOptions {
    parse?: ParseOptions;
    confidence?: ConfidenceConfig;
    /**
     * Earlier messages in the thread, most recent first. Optional: extraction works without any
     * history, and history only ever adds evidence.
     */
    history?: readonly string[];
    /** Pre-built history documents, for callers that resolve threads themselves. */
    historyDocuments?: readonly HistoryDocument[];
    /** Keep block level diagnostics on the result. Used by `extract --explain` and the review app. */
    explain?: boolean;
}

export interface ExplainedResult extends ExtractionResult {
    /** Present when `explain` is set. */
    diagnostics?: {
        structure: string;
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

/**
 * Choose the text and HTML parts that hold the message body.
 *
 * The largest candidate of each type wins. A message can carry several text parts, for example a
 * gateway appended disclaimer in `multipart/mixed(alternative(P,H), P)`, and the body is the large
 * one. Attachments and parts inside a forwarded `message/rfc822` are excluded: an embedded message
 * is content to be classified, not the container's own body.
 */
function selectBodyParts(message: ParsedMessage): { text: MimePart | null; html: MimePart | null } {
    const insideEmbedded = new Set<string>();
    for (const part of message.parts) {
        if (!part.rfc822 && !part.embeddedRoot) {
            continue;
        }
        for (const other of message.parts) {
            let cursor: MimePart | undefined = other;
            while (cursor?.parentId) {
                if (cursor.parentId === part.partId) {
                    insideEmbedded.add(other.partId);
                    break;
                }
                cursor = message.partsById.get(cursor.parentId);
            }
        }
    }

    let text: MimePart | null = null;
    let html: MimePart | null = null;
    for (const part of message.parts) {
        if (part.disposition === 'attachment' || !part.decoded || insideEmbedded.has(part.partId)) {
            continue;
        }
        if (part.contentType === 'text/plain') {
            if (!text || part.decoded.text.length > (text.decoded?.text.length ?? 0)) {
                text = part;
            }
        } else if (part.contentType === 'text/html') {
            if (!html || part.decoded.text.length > (html.decoded?.text.length ?? 0)) {
                html = part;
            }
        }
    }
    return { text, html };
}

/**
 * Extract the conversationally relevant content of a raw RFC 5322 message.
 *
 * Parses the MIME tree, picks the body parts, then hands off to analyze(). Delegating rather than
 * duplicating the pipeline is deliberate: the two entry points must not be able to disagree about
 * the same message, and a rule added to one must reach the other for free.
 *
 * Never throws for malformed input. A failure produces a result in which the whole body is a single
 * visible UNKNOWN segment, plus a warning, because showing too much is always preferable to
 * showing nothing.
 */
function degraded(text: string, warnings: Warning[]): ExplainedResult {
    return {
        segments: text.trim()
            ? [
                  {
                      type: 'UNKNOWN',
                      text,
                      confidence: 0.5,
                      visibility: 'show',
                      reasons: ['degraded_to_unknown'],
                      source: { mimePart: 'TEXT', representation: 'text', blockIndex: 0, start: 0, end: text.length }
                  }
              ]
            : [],
        hiddenSegments: [],
        overallConfidence: 0.5,
        warnings,
        originalAvailable: true,
        primaryRepresentation: 'none',
        extractorVersion: EXTRACTOR_VERSION,
        historyUsed: false
    };
}

export async function extract(raw: Buffer | string, options: ExtractOptions = {}): Promise<ExplainedResult> {
    const buffer = typeof raw === 'string' ? Buffer.from(raw) : raw;

    let message: ParsedMessage;
    try {
        message = await parseMessage(buffer, options.parse);
    } catch (err) {
        return degraded(buffer.toString('utf8'), [
            { code: 'mime_parse_error', detail: err instanceof Error ? err.message.slice(0, 200) : 'unknown' },
            { code: 'extraction_degraded' }
        ]);
    }

    const parts = selectBodyParts(message);
    const result = await analyze(
        {
            text: parts.text?.decoded?.text ?? null,
            html: parts.html?.decoded?.text ?? null,
            subject: message.headers.subject,
            from: message.headers.from,
            inReplyTo: message.headers.inReplyTo,
            references: message.headers.references,
            ...(parts.text ? { textPartId: parts.text.partId } : {}),
            ...(parts.html ? { htmlPartId: parts.html.partId } : {})
        },
        {
            ...(options.confidence ? { confidence: options.confidence } : {}),
            ...(options.history ? { history: options.history } : {}),
            ...(options.historyDocuments ? { historyDocuments: options.historyDocuments } : {}),
            ...(options.explain ? { explain: true } : {})
        }
    );

    // MIME level warnings belong to the message, not to the body analysis.
    const warnings: Warning[] = [...message.warnings, ...result.warnings];

    return {
        segments: result.segments,
        hiddenSegments: result.hiddenSegments,
        overallConfidence: result.overallConfidence,
        warnings,
        originalAvailable: true,
        primaryRepresentation: result.primaryRepresentation,
        extractorVersion: result.extractorVersion,
        historyUsed: result.historyUsed,
        ...(result.diagnostics ? { diagnostics: { ...result.diagnostics, structure: message.structure } } : {})
    };
}
