/**
 * Normalised internal representation of a parsed message.
 *
 * The MIME tree is preserved as a tree. Nothing is flattened into a single html/text pair, because
 * the extractor needs to know which text part is the alternative sibling of which html part, and
 * needs to be able to point at the exact bytes a segment came from.
 */

import { ConfigurationError, type Warning } from '../types';

export interface ByteRange {
    start: number;
    end: number;
}

export interface HeaderEntry {
    /** Lowercased field name. */
    key: string;
    /** Raw value as it appeared, unfolded but not decoded. */
    value: string;
    /** MIME encoded words decoded, best effort. Falls back to the raw value. */
    decoded: string;
}

/** Result of decoding a text part, with enough detail to judge how much to trust it. */
export interface DecodedText {
    /** Decoded, charset converted, flowed unfolded text. */
    text: string;
    /** Charset actually used, which may differ from the declared one. */
    charsetUsed: string;
    /** Charset as declared in the Content-Type header, if any. */
    charsetDeclared: string | null;
    /** Count of U+FFFD replacement characters produced by the decode. */
    replacementChars: number;
    /** True when the part exceeded the configured size cap and was cut short. */
    truncated: boolean;
}

export interface MimePart {
    /** IMAP style part path, for example "1.2". The root of a single part message is "TEXT". */
    partId: string;
    partNr: (number | string)[];
    /** Lowercased content type, for example "text/html". Never empty, defaults per RFC 2046. */
    contentType: string;
    contentTypeParams: Record<string, string>;
    charset: string | null;
    encoding: string | null;
    disposition: 'attachment' | 'inline' | null;
    filename: string | null;
    /** Multipart subtype ("alternative", "mixed", "related") or null for leaves. */
    multipart: string | null;
    /** True for a message/rfc822 container. */
    rfc822: boolean;
    /** True when this node is the root of an embedded message. */
    embeddedRoot: boolean;
    flowed: boolean;
    delSp: boolean;
    parentId: string | null;
    childIds: string[];
    /** Byte range of the raw header block within the original message. */
    headerRange: ByteRange;
    /** Byte range of the raw, still encoded body within the original message. Null for containers. */
    bodyRange: ByteRange | null;
    /** Raw encoded body size in bytes. */
    rawBodySize: number;
    /** All header lines of this part. */
    headers: HeaderEntry[];
    /** Decoded content, populated for text/plain and text/html only. */
    decoded: DecodedText | null;
}

/** Headers the analysis cares about, decoded and normalised. Any of them may be missing. */
export interface MessageHeaders {
    messageId: string | null;
    inReplyTo: string | null;
    references: string[];
    from: string | null;
    to: string | null;
    cc: string | null;
    date: string | null;
    /** Parsed date as epoch milliseconds, or null when absent or unparseable. */
    dateMs: number | null;
    subject: string | null;
    contentType: string | null;
    userAgent: string | null;
    xMailer: string | null;
    listId: string | null;
    listUnsubscribe: string | null;
    precedence: string | null;
    autoSubmitted: string | null;
}

export interface ParsedMessage {
    /** All parts keyed by partId, in document order. */
    parts: MimePart[];
    partsById: Map<string, MimePart>;
    rootId: string;
    headers: MessageHeaders;
    /** Every header line of the outermost message, for diagnostics and client fingerprinting. */
    rootHeaders: HeaderEntry[];
    warnings: Warning[];
    /** Total size of the raw message in bytes. */
    size: number;
    /** Compact structural signature, for example "m/alternative(P,H)". */
    structure: string;
}

export interface ParseOptions {
    /** Maximum decoded bytes retained per text part. Default 1 MiB. Recommended ceiling 32 MiB. */
    maxTextPartBytes?: number;
    /** Maximum number of parts before the walk stops recording. Default 500. Recommended ceiling 10,000. */
    maxParts?: number;
    /** Maximum raw header block size per part, passed to mailsplit. Default 1 MiB. Recommended ceiling 16 MiB. */
    maxHeadSize?: number;
    /** Treat message/rfc822 as an opaque leaf instead of descending into it. Default false. */
    ignoreEmbedded?: boolean;
    /**
     * Maximum raw message size accepted. Default 64 MiB.
     *
     * Per part limits do not bound total work: an attacker can submit many individually legal
     * parts. This is a circuit breaker over the whole input, not a sandbox, and the raw message has
     * already been allocated by the time it is checked. Reject oversized payloads at the transport
     * where you can.
     */
    maxMessageBytes?: number;
    /**
     * Maximum decoded text retained across every text part combined. Default 16 MiB.
     *
     * Once reached, later parts are not decoded and the result carries `input_limit_exceeded`.
     */
    maxTotalDecodedTextBytes?: number;
}

export const DEFAULT_PARSE_OPTIONS: Required<ParseOptions> = {
    maxTextPartBytes: 1024 * 1024,
    maxParts: 500,
    maxHeadSize: 1024 * 1024,
    ignoreEmbedded: false,
    maxMessageBytes: 64 * 1024 * 1024,
    maxTotalDecodedTextBytes: 16 * 1024 * 1024
};

function requirePositiveInteger(value: unknown, option: string): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
        throw new ConfigurationError(option, 'a positive safe integer');
    }
    return value;
}

/**
 * Validate caller supplied parse options and fill in the defaults.
 *
 * Rejects what is meaningless, and does not reject what is merely large. `NaN`, infinities,
 * negatives, zero and fractions are always programmer errors and always throw. Upper bounds are
 * documented as recommendations rather than enforced: a hard failure on a value the caller chose
 * deliberately is more likely to take down a consuming service than to protect it, and the host is
 * better placed than this library to know what its own memory budget is.
 */
export function validateParseOptions(input?: ParseOptions): Required<ParseOptions> {
    if (input === undefined || input === null) {
        return { ...DEFAULT_PARSE_OPTIONS };
    }
    if (typeof input !== 'object') {
        throw new ConfigurationError('parse', 'an object');
    }

    const options: Required<ParseOptions> = { ...DEFAULT_PARSE_OPTIONS };
    for (const key of ['maxTextPartBytes', 'maxParts', 'maxHeadSize', 'maxMessageBytes', 'maxTotalDecodedTextBytes'] as const) {
        if (input[key] !== undefined) {
            options[key] = requirePositiveInteger(input[key], `parse.${key}`);
        }
    }
    if (input.ignoreEmbedded !== undefined) {
        if (typeof input.ignoreEmbedded !== 'boolean') {
            throw new ConfigurationError('parse.ignoreEmbedded', 'a boolean');
        }
        options.ignoreEmbedded = input.ignoreEmbedded;
    }
    return options;
}
