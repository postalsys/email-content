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
export const EXTRACTOR_VERSION = '0.1.17'; // x-release-please-version

/** Version of the corpus processing pipeline (scanner, feature extraction, storage schema). */
export const PROCESSING_VERSION = '0.1.17'; // x-release-please-version

/**
 * Invalid caller configuration.
 *
 * Deliberately distinct from how malformed *messages* are handled. A bad message degrades and never
 * throws, because the sender chose the message and the caller cannot fix it. A bad option is the
 * programmer's own mistake, it will repeat on every message, and returning a plausible looking
 * degraded result for it would hide an operational fault behind what reads like ordinary output.
 *
 * Carries a stable code and the offending option name. It never carries the value, message content
 * or credentials, so it is safe to log.
 */
export class ConfigurationError extends Error {
    /** Stable machine readable code, for example `invalid_option`. */
    readonly code: string;
    /** Dotted path of the offending option, for example `confidence.hideThreshold`. */
    readonly option: string;

    constructor(option: string, expected: string, code = 'invalid_option') {
        super(`${option} must be ${expected}`);
        this.name = 'ConfigurationError';
        this.code = code;
        this.option = option;
    }
}

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
 *
 * Discriminated on `kind`, because the two cases genuinely know different things. A segment that
 * came from a MIME part can name it; a segment produced when MIME parsing failed outright knows
 * only a range in the raw message. The previous flat shape forced the second case to invent
 * `mimePart: 'TEXT', representation: 'text'`, which was false whenever the surviving content came
 * from HTML, and false in every particular when there was no MIME tree at all.
 */
export type SourceRef = MimeSourceRef | RawSourceRef;

/** A segment traced to a part of the parsed MIME tree. */
export interface MimeSourceRef {
    kind: 'mime-part';
    /** IMAP style MIME part path, for example "1.2". "TEXT" for a single part message root. */
    mimePart: string;
    representation: Representation;
    /** Index of the block within its own representation, in document order. */
    blockIndex: number;
    /** Character offsets into the decoded, canonicalised part content. */
    start: number;
    end: number;
    /** HTML only. Stable child index path from the body element, for example "0/2/1". */
    domPath?: string;
}

/**
 * A segment traced only to a range in the raw message.
 *
 * Emitted when MIME parsing failed and there is no part structure to point at. Naming a part here
 * would be a fabrication, and a traceability field that lies is worse than one that admits it does
 * not know.
 */
export interface RawSourceRef {
    kind: 'raw-message';
    /** Byte offsets into the raw message as supplied. */
    start: number;
    end: number;
}

/** The MIME part a segment came from, or null when only a raw message range is known. */
export function mimePartOf(source: SourceRef): string | null {
    return source.kind === 'mime-part' ? source.mimePart : null;
}

/** The block index within its representation, or null when only a raw message range is known. */
export function blockIndexOf(source: SourceRef): number | null {
    return source.kind === 'mime-part' ? source.blockIndex : null;
}

/**
 * Machine readable justification codes. Closed vocabulary: a decision that cannot name its reason
 * is not allowed to influence visibility.
 */
export type Reason =
    // structural anchors
    | 'preceded_by_reply_header'
    | 'preceded_by_forward_header'
    | 'forward_by_subject'
    | 'inside_quote_container'
    | 'final_contiguous_quote_region'
    | 'no_new_content_after_region'
    | 'new_content_after_region'
    | 'interleaved_with_new_content'
    | 'inline_answers_announced'
    | 'contains_old_message_headers'
    | 'authored_text_before_anchor'
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
    /**
     * Original HTML for HTML sourced segments. Never regenerated or rewritten.
     *
     * **UNTRUSTED. This is attacker controlled markup, copied verbatim from the message.**
     *
     * It can contain event handler attributes, remote images and stylesheets that leak the fact and
     * time of reading, forms, frames, unsafe SVG, `javascript:` and `data:` URLs, and tracking
     * links. Classification is not sanitisation: this library decides whether a span of the message
     * is new content, history or a footer, and says nothing whatsoever about whether it is safe to
     * render.
     *
     * Never assign it to `innerHTML`. Sanitise it with a maintained sanitiser after segmentation
     * and immediately before rendering, block remote resource loading, and serve it under a
     * restrictive Content Security Policy as defence in depth. See the security section of the
     * README.
     */
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
    /**
     * An eligible body part held markup but no user visible text: only scripts, styles, comments,
     * tracking pixels or bare tags. Distinct from `no_body_parts`, which means there was no body
     * part to look at, and precise enough for a caller to tell "nothing to show" from "we lost it".
     */
    | 'no_visible_body_text'
    /**
     * An eligible inline body part exists but is not represented in the result. `mimePart` names it
     * and `detail` carries the machine readable selection reason, from the closed set
     * `related_resource`, `max_depth_exceeded` and `later_section_not_selected`.
     *
     * Deliberately not `non_contiguous_body`, which means something else entirely: that the chunks
     * of a single MIME part arrived out of order during parsing.
     */
    | 'body_section_not_selected'
    | 'non_contiguous_body'
    | 'extraction_degraded'
    /**
     * An aggregate input limit stopped the work. `detail` names the option that fired.
     *
     * Never thrown, always reported: an oversized message is adversarial or malformed input, not a
     * programmer error, and this library's contract is that message input degrades rather than
     * throwing. Whatever the limit did allow through is still returned in full. The caller keeps
     * the original and can raise the limit or render it directly.
     */
    | 'input_limit_exceeded'
    /**
     * Reply status could not be determined, because MIME parsing failed and there were no headers
     * to read. `isReply` is `false` on such a result, which means "not known to be a reply" rather
     * than "known not to be one". Reply status is never guessed by searching the raw bytes.
     */
    | 'reply_status_unknown'
    | 'timeout';

export interface Warning {
    code: WarningCode;
    /** Human readable detail. Must never include message body text or addresses. */
    detail?: string;
    mimePart?: string;
}

/**
 * What every entry point returns.
 *
 * One contract, shared, because `extract()` and `analyze()` are the same pipeline entered at
 * different stages and must not be able to disagree about the same message. They diverged once:
 * `analyze()` returned `isReply` and `extract()` silently dropped it while the README showed it on
 * both.
 */
export interface ContentAnalysisResult {
    /** Segments the client should render, in document order. */
    segments: Segment[];
    /**
     * Segments the client may hide, retained in full so nothing is ever lost.
     *
     * Only ever holds segments whose visibility is `hide`. Segments marked `collapse` stay in
     * `segments`, because a collapsed segment is still rendered, just folded.
     */
    hiddenSegments: Segment[];
    /** Message level confidence, the weakest link across hide decisions. */
    overallConfidence: number;
    warnings: Warning[];
    /**
     * Always true, and a statement about behaviour rather than about this object.
     *
     * The library does not mutate or consume the caller's source, so the original is always still
     * recoverable. It is **not** embedded in this result: the caller must retain it.
     */
    originalAvailable: true;
    /**
     * Which representation drove the classification of the primary section.
     *
     * Not an inventory of every MIME representation retained. A message with several body sections
     * can carry segments from more than one part; this names the driver, not the whole source set.
     */
    primaryRepresentation: Representation | 'none';
    extractorVersion: string;
    /** True when thread history was available and used. */
    historyUsed: boolean;
    /**
     * True when the input looked like a reply, from threading headers or a subject prefix.
     *
     * `false` also covers "could not tell": when MIME parsing fails outright there are no headers
     * to read, and the result carries a `reply_status_unknown` warning to say so rather than
     * pretending the answer is known.
     */
    isReply: boolean;
    /**
     * The canonical plain text that segment offsets index into, keyed by MIME part id.
     *
     * A segment whose `source` is a `mime-part` with representation `text` reports `start`/`end`
     * into the canonicalised part text, not into the text the caller supplied (line endings, a BOM,
     * NUL characters and Unicode normalisation can all differ). Slice
     * `canonicalText[source.mimePart]` with those offsets. Holds an entry for every plain text part
     * whose representation reached the segments, and nothing else: HTML offsets index the HTML
     * source unchanged, and a degraded result (a fail-soft fallback) indexes the input as given.
     *
     * Sections that share a part id (several caller supplied sections without `textPartId` all
     * default to `TEXT`) cannot be told apart by offset; give them distinct ids. The same string is
     * available standalone through `canonicalisePlainText()`.
     */
    canonicalText: Record<string, string>;
}

/** Result of extracting one message. */
export type ExtractionResult = ContentAnalysisResult;
