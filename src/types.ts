/**
 * Public contract for the extraction pipeline.
 *
 * Everything a caller needs to reason about the output lives here. The guiding rule for the whole
 * project is asymmetric: losing genuine new content is far worse than showing redundant history,
 * so every type in this file is designed so that content can be demoted to a lower visibility
 * band but never dropped.
 */

/**
 * Version of the deterministic extraction logic, stamped into every result.
 *
 * Kept in step with the released package version by release-please, rather than bumped by hand.
 * Hand bumping did not survive contact with reality: extraction changed repeatedly while this
 * constant stayed at its initial value, so every stored result claimed a version that no longer
 * described the code that produced it.
 */
export const EXTRACTOR_VERSION = '0.0.2'; // x-release-please-version

/** Version of the corpus processing pipeline (scanner, feature extraction, storage schema). */
export const PROCESSING_VERSION = '0.0.2'; // x-release-please-version

/** Final block classification. */
export type Label = 'NEW_CONTENT' | 'INLINE_QUOTE' | 'REPLY_HISTORY' | 'FORWARDED_CONTENT' | 'SIGNATURE' | 'DISCLAIMER' | 'UNKNOWN';

export const LABELS: readonly Label[] = ['NEW_CONTENT', 'INLINE_QUOTE', 'REPLY_HISTORY', 'FORWARDED_CONTENT', 'SIGNATURE', 'DISCLAIMER', 'UNKNOWN'] as const;

/**
 * How a client should present a segment.
 *
 * `hide` is only ever assigned to high confidence REPLY_HISTORY or FORWARDED_CONTENT that is
 * backed by a structural anchor. `collapse` means recoverable with one interaction. Anything the
 * pipeline is unsure about stays `show`.
 */
export type Visibility = 'show' | 'collapse' | 'hide';

/** Which canonical representation a block came from. */
export type Representation = 'text' | 'html';

/**
 * Traceability back to the original message. Every segment must carry one of these so a reviewer
 * can always find the exact bytes the decision was made about.
 */
export interface SourceRef {
    /** IMAP style MIME part path, for example "1.2". "TEXT" for a single part message root. */
    mimePart: string;
    representation: Representation;
    /** Index of the block within its representation, in document order. */
    blockIndex: number;
    /** Character offsets into the decoded, canonicalised part content. */
    start: number;
    end: number;
    /** HTML only. Stable child index path from the body element, for example "0/2/1". */
    domPath?: string;
}

/**
 * Machine readable justification codes. Closed vocabulary: a decision that cannot name its reason
 * is not allowed to influence visibility.
 */
export type Reason =
    // structural anchors
    | 'preceded_by_reply_header'
    | 'preceded_by_forward_header'
    | 'inside_quote_container'
    | 'final_contiguous_quote_region'
    | 'no_new_content_after_region'
    | 'new_content_after_region'
    | 'interleaved_with_new_content'
    | 'contains_old_message_headers'
    | 'quote_depth_positive'
    | 'no_anchor_for_quote'
    // client specific containers
    | 'gmail_quote_container'
    | 'gmail_attr_line'
    | 'gmail_signature_container'
    | 'outlook_reply_separator'
    | 'outlook_mso_border_separator'
    | 'owa_element_to_proof'
    | 'apple_mail_cite'
    | 'thunderbird_moz_cite'
    | 'generic_blockquote'
    // signature and disclaimer
    | 'dash_dash_delimiter'
    | 'mobile_signature_phrase'
    | 'signature_position_and_length'
    | 'disclaimer_phrase'
    // history matching
    | 'matched_parent_message'
    | 'matched_thread_ancestor'
    | 'shingle_overlap_high'
    | 'no_history_available'
    // reconciliation
    | 'html_primary_representation'
    | 'text_primary_representation'
    | 'representations_disagree'
    | 'evidence_transferred_from_html'
    | 'evidence_transferred_from_text'
    // fallbacks
    | 'new_content_default'
    | 'ambiguous_kept_visible'
    | 'degraded_to_unknown';

/** A classified run of content. */
export interface Segment {
    type: Label;
    /** Plain text of the segment. Always present, always taken verbatim from the source. */
    text: string;
    /** Original HTML for HTML sourced segments. Never regenerated or rewritten. */
    html?: string;
    /** Calibrated in [0, 1]. */
    confidence: number;
    visibility: Visibility;
    reasons: Reason[];
    source: SourceRef;
}

/** Warning codes emitted during parsing or extraction. Never contains message content. */
export type WarningCode =
    | 'mime_parse_error'
    | 'mime_truncated'
    | 'missing_boundary'
    | 'max_nesting_exceeded'
    | 'max_parts_exceeded'
    | 'header_too_large'
    | 'unknown_charset'
    | 'charset_decode_replacement_chars'
    | 'transfer_encoding_error'
    | 'text_part_truncated'
    | 'html_parse_error'
    | 'no_body_parts'
    | 'non_contiguous_body'
    | 'extraction_degraded'
    | 'timeout';

export interface Warning {
    code: WarningCode;
    /** Human readable detail. Must never include message body text or addresses. */
    detail?: string;
    mimePart?: string;
}

/** Result of extracting one message. */
export interface ExtractionResult {
    /** Segments the client should render, in document order. */
    segments: Segment[];
    /** Segments the client may hide or collapse. Retained in full so nothing is ever lost. */
    hiddenSegments: Segment[];
    /** Message level confidence, the weakest link across hide decisions. */
    overallConfidence: number;
    warnings: Warning[];
    /** Always true. The pipeline never discards the source message. */
    originalAvailable: true;
    /** Which representation drove the final classification. */
    primaryRepresentation: Representation | 'none';
    extractorVersion: string;
    /** True when thread history was available and used. */
    historyUsed: boolean;
}
