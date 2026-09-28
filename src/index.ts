/**
 * Public library API.
 *
 * `extract()` is the whole product surface: raw message in, classified segments out, with every
 * segment traceable to a MIME part and a source range, and nothing ever discarded.
 */

import { parseMessage } from './mime/parse';
import { type ParseOptions, type ParsedMessage, validateParseOptions } from './mime/model';
import { planBody, reportableExclusions } from './mime/select';
import { loadPatterns } from './detect/patterns';
import { validateConfidenceConfig, type ConfidenceConfig } from './classify/confidence';
import { type HistoryDocument } from './match/history';
import { analyze, type BodySection } from './analyze';
import { EXTRACTOR_VERSION, type ExtractionResult, type Reason, type Warning } from './types';

export * from './types';
export { parseMessage } from './mime/parse';
export type { ParsedMessage, MimePart } from './mime/model';
export type { Block, BlockFeatures, BlockKind, Evidence } from './segment/types';
export { DEFAULT_CONFIDENCE, validateConfidenceConfig, type ConfidenceConfig } from './classify/confidence';
export { validateParseOptions, DEFAULT_PARSE_OPTIONS } from './mime/model';
export { buildHistoryDocument, matchBlocks, type HistoryDocument, type BlockMatch } from './match/history';
export { corpusThreadResolver, folderThreadResolver, type ThreadResolver } from './corpus/thread-index';
export { analyze, resolveHistory, senderTokensFrom, type BodySection, type MessageContent, type AnalyzeOptions, type AnalyzeResult } from './analyze';
export { planBody, reportableExclusions, type BodyPlan, type ExclusionReason, type PlannedSection, type SectionRole } from './mime/select';
export { loadPatterns, patternSource, PatternAssetError, type PatternSource } from './detect/patterns';
export { canonicalisePlainText } from './canonical/text';

/**
 * Classifier assets are validated when the package is required, not when a message arrives.
 *
 * Missing or corrupt pattern files are an installation defect. Discovering that on the thousandth
 * message, as one more degraded result, is far worse than discovering it at startup: every message
 * until then came back looking like new content, because nothing could be recognised as history.
 */
loadPatterns();

export interface ExtractOptions {
    parse?: ParseOptions;
    confidence?: Partial<ConfidenceConfig>;
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
                      // No MIME tree was produced, so there is no part to name. Inventing one, which
                      // this used to do, points a reviewer at a part that does not exist.
                      source: { kind: 'raw-message', start: 0, end: text.length }
                  }
              ]
            : [],
        hiddenSegments: [],
        overallConfidence: 0.5,
        warnings,
        originalAvailable: true,
        primaryRepresentation: 'none',
        extractorVersion: EXTRACTOR_VERSION,
        historyUsed: false,
        // Threading headers are exactly what a failed parse could not read. Reply status is left
        // false and the uncertainty is made observable, rather than guessed at with a substring
        // search over the raw bytes.
        isReply: false,
        canonicalText: {}
    } satisfies ExtractionResult;
}

export async function extract(raw: Buffer | string, options: ExtractOptions = {}): Promise<ExplainedResult> {
    // Assets first, then options. Both are checked outside the fail-soft path, because neither is
    // a property of the message and both would otherwise repeat silently on every one of them.
    loadPatterns();

    // Validated before any work, so a bad option fails on the first message rather than producing
    // subtly wrong results on every message.
    const parseOptions = validateParseOptions(options.parse);
    const confidence = validateConfidenceConfig(options.confidence);
    const buffer = typeof raw === 'string' ? Buffer.from(raw) : raw;

    if (buffer.length > parseOptions.maxMessageBytes) {
        // A circuit breaker the caller asked for. Not an error: an oversized message is input, and
        // input degrades rather than throwing. Nothing was read, so nothing is returned, and the
        // caller still holds the original.
        return degraded('', [
            { code: 'input_limit_exceeded', detail: `maxMessageBytes (${parseOptions.maxMessageBytes}), message was ${buffer.length}` },
            { code: 'extraction_degraded' },
            { code: 'reply_status_unknown' }
        ]);
    }

    let message: ParsedMessage;
    try {
        message = await parseMessage(buffer, parseOptions);
    } catch (err) {
        return degraded(buffer.toString('utf8'), [
            { code: 'mime_parse_error', detail: err instanceof Error ? err.message.slice(0, 200) : 'unknown' },
            { code: 'extraction_degraded' },
            { code: 'reply_status_unknown' }
        ]);
    }

    const plan = planBody(message);

    // A tree that failed to parse must not come back as nothing.
    //
    // `parseMessage()` never rejects: it records the failure as a warning and returns whatever it
    // salvaged. When it salvaged no parts at all, the body plan is empty, and the result used to be
    // zero segments plus `no_body_parts` even though the raw message plainly held text. That is the
    // same defect as the malformed HTML fallback, one stage earlier, and with the same shape: total
    // content loss whose only trace is a warning.
    if (!plan.sections.length && message.warnings.some(warning => warning.code === 'mime_parse_error')) {
        const text = buffer.toString('utf8');
        if (text.trim()) {
            return degraded(text, [
                ...message.warnings,
                { code: 'extraction_degraded', detail: 'no MIME body could be recovered' },
                { code: 'reply_status_unknown' }
            ]);
        }
    }

    // Every eligible inline body part the plan leaves out is named. Silent substitution is the
    // failure mode this replaced: a long inline footer used to displace a short authored reply with
    // nothing in the result to say so. Unused alternative members, attachments and embedded
    // messages are excluded by a written rule and are not reported, because they are not losses.
    const omissions: Warning[] = reportableExclusions(plan).map(entry => ({
        code: 'body_section_not_selected' as const,
        mimePart: entry.partId,
        detail: entry.reason
    }));

    // The whole plan goes through, in document order. Composition happens inside analyze() so that
    // a caller who already has a parsed multipart message can express exactly the same thing.
    const sections: BodySection[] = plan.sections.map(section => ({
        text: section.text?.decoded?.text ?? null,
        html: section.html?.decoded?.text ?? null,
        ...(section.text ? { textPartId: section.text.partId } : {}),
        ...(section.html ? { htmlPartId: section.html.partId } : {}),
        role: section.role
    }));

    const result = await analyze(
        {
            sections,
            subject: message.headers.subject,
            from: message.headers.from,
            inReplyTo: message.headers.inReplyTo,
            references: message.headers.references
        },
        {
            confidence,
            ...(options.history ? { history: options.history } : {}),
            ...(options.historyDocuments ? { historyDocuments: options.historyDocuments } : {}),
            ...(options.explain ? { explain: true } : {})
        }
    );

    // MIME level warnings belong to the message, not to the body analysis.
    const warnings: Warning[] = [...message.warnings, ...omissions, ...result.warnings];

    return {
        segments: result.segments,
        hiddenSegments: result.hiddenSegments,
        overallConfidence: result.overallConfidence,
        warnings,
        originalAvailable: true,
        primaryRepresentation: result.primaryRepresentation,
        extractorVersion: result.extractorVersion,
        historyUsed: result.historyUsed,
        isReply: result.isReply,
        canonicalText: result.canonicalText,
        // `satisfies` rather than a bare return: an omitted mandatory field then fails the build
        // instead of quietly disappearing from the public result, which is how `isReply` went
        // missing from this entry point while the README documented it.
        ...(result.diagnostics ? { diagnostics: { ...result.diagnostics, structure: message.structure } } : {})
    } satisfies ExplainedResult;
}
