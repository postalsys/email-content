/**
 * Stage 1: MIME parsing.
 *
 * Built on @zone-eu/mailsplit rather than a full parser, because mailsplit is the only local option
 * that walks the tree non-destructively: it emits raw header bytes and raw body chunks in document
 * order, byte for byte, and gives every node an IMAP style part number. That is what makes the
 * traceability requirement satisfiable. postal-mime and mailparser both collapse the tree into a
 * single html/text pair and discard byte spans.
 *
 * Byte offsets are not exposed as a field by mailsplit, so this module reconstructs them by
 * accumulating chunk lengths in emission order. mailsplit's own round trip test asserts that the
 * concatenation of all chunks equals the input, which is what makes the running sum exact.
 *
 * Nothing in here throws for malformed input. Problems are recorded as warnings and the walk
 * continues, because a corpus run must never stop on one bad message.
 */

import { Splitter } from '@zone-eu/mailsplit';
import type MimeNodeType from '@zone-eu/mailsplit/lib/mime-node';
import { decodeFlowed } from './flowed';
import { type Warning } from '../types';
import { decodeCharset } from './charset';
import { extractMessageHeaders, parseHeaderValueSafe, toHeaderEntries } from './headers';
import { type DecodedText, type MimePart, type ParseOptions, type ParsedMessage, validateParseOptions } from './model';

/** Content types whose bodies are decoded and retained. Everything else is measured and dropped. */
const TEXT_TYPES = new Set(['text/plain', 'text/html']);

interface PendingPart {
    part: MimePart;
    node: MimeNodeType;
    /** Raw, still encoded body chunks. Only collected for text parts. */
    bodyChunks: Buffer[];
    bodyBytes: number;
    collecting: boolean;
    /** True when a non body chunk arrived between two body chunks. */
    nonContiguous: boolean;
}

function partIdOf(partNr: readonly (number | string)[] | false): string {
    if (!partNr || partNr.length === 0) {
        return 'TEXT';
    }
    return partNr.join('.');
}

function normaliseDisposition(value: string | false): 'attachment' | 'inline' | null {
    if (!value) {
        return null;
    }
    const lowered = String(value).toLowerCase();
    if (lowered.startsWith('attachment')) {
        return 'attachment';
    }
    if (lowered.startsWith('inline')) {
        return 'inline';
    }
    return null;
}

/** Decode one text part: transfer encoding, then charset, then format=flowed. */
async function decodeTextPart(pending: PendingPart, maxBytes: number, warnings: Warning[]): Promise<DecodedText> {
    const { part, node } = pending;
    const raw = Buffer.concat(pending.bodyChunks, pending.bodyBytes);

    let transferDecoded: Buffer;
    try {
        transferDecoded = await runDecoder(node, raw);
    } catch (err) {
        warnings.push({
            code: 'transfer_encoding_error',
            mimePart: part.partId,
            detail: `${part.encoding || 'unknown'}: ${errorLabel(err)}`
        });
        transferDecoded = raw;
    }

    let truncated = false;
    if (transferDecoded.length > maxBytes) {
        transferDecoded = transferDecoded.subarray(0, maxBytes);
        truncated = true;
        warnings.push({ code: 'text_part_truncated', mimePart: part.partId, detail: `capped at ${maxBytes} bytes` });
    }

    const decoded = decodeCharset(transferDecoded, part.charset);
    if (decoded.fellBack) {
        warnings.push({
            code: 'unknown_charset',
            mimePart: part.partId,
            detail: `declared ${part.charset || 'none'}, used ${decoded.charsetUsed}`
        });
    }
    if (decoded.replacementChars > 0) {
        warnings.push({
            code: 'charset_decode_replacement_chars',
            mimePart: part.partId,
            detail: `${decoded.replacementChars} replacement characters`
        });
    }

    let text = decoded.text;
    if (part.flowed && part.contentType === 'text/plain') {
        try {
            text = decodeFlowed(text, part.delSp);
        } catch {
            // Keep the unfolded text. A failed flowed decode is cosmetic, never a reason to lose content.
        }
    }

    return {
        text,
        charsetUsed: decoded.charsetUsed,
        charsetDeclared: part.charset,
        replacementChars: decoded.replacementChars,
        truncated
    };
}

/** Run mailsplit's transfer decoder over a buffer, using its public streaming interface. */
function runDecoder(node: MimeNodeType, raw: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        let decoder;
        try {
            decoder = node.getDecoder();
        } catch (err) {
            reject(err);
            return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        decoder.on('data', (chunk: Buffer) => {
            chunks.push(chunk);
            size += chunk.length;
        });
        decoder.on('error', reject);
        decoder.on('end', () => resolve(Buffer.concat(chunks, size)));
        decoder.end(raw);
    });
}

function errorLabel(err: unknown): string {
    if (err instanceof Error) {
        return err.message.slice(0, 200);
    }
    return String(err).slice(0, 200);
}

/** Compact structural signature such as "m/alternative(P,H)", used for corpus statistics. */
export function structureSignature(parts: readonly MimePart[], partsById: ReadonlyMap<string, MimePart>, rootId: string): string {
    const render = (id: string, depth: number): string => {
        if (depth > 12) {
            return '...';
        }
        const part = partsById.get(id);
        if (!part) {
            return '?';
        }
        if (part.multipart) {
            const children = part.childIds.map(child => render(child, depth + 1)).join(',');
            return `m/${part.multipart}(${children})`;
        }
        if (part.rfc822 && part.childIds.length) {
            return `rfc822[${part.childIds.map(child => render(child, depth + 1)).join(',')}]`;
        }
        if (part.contentType === 'text/plain') {
            return 'P';
        }
        if (part.contentType === 'text/html') {
            return 'H';
        }
        const major = part.contentType.split('/')[0] || 'unknown';
        return major;
    };
    return parts.length ? render(rootId, 0) : '(empty)';
}

/**
 * Parse a raw RFC 5322 message into the normalised internal representation.
 *
 * Never rejects on malformed input. The only rejection path is an internal stream error, and even
 * that is converted into a parsed message carrying a `mime_parse_error` warning.
 */
export async function parseMessage(raw: Buffer, options: ParseOptions = {}): Promise<ParsedMessage> {
    const opts = validateParseOptions(options);
    const warnings: Warning[] = [];
    const pendingParts: PendingPart[] = [];
    const partsById = new Map<string, PendingPart>();

    let offset = 0;
    let rootId = 'TEXT';
    let rootHeaderList: { key: string; line: string }[] = [];
    let truncatedTree = false;

    await new Promise<void>(resolve => {
        const splitter = new Splitter({
            maxHeadSize: opts.maxHeadSize,
            maxChildNodes: opts.maxParts,
            ignoreEmbedded: opts.ignoreEmbedded
        });

        let settled = false;
        const finish = () => {
            if (!settled) {
                settled = true;
                resolve();
            }
        };

        splitter.on('data', chunk => {
            if (chunk.type === 'node') {
                const node = chunk as MimeNodeType;
                let headerBytes: Buffer;
                try {
                    headerBytes = node.getHeaders();
                } catch (err) {
                    warnings.push({ code: 'mime_parse_error', detail: errorLabel(err) });
                    headerBytes = Buffer.alloc(0);
                }
                const headerStart = offset;
                offset += headerBytes.length;

                if (pendingParts.length >= opts.maxParts) {
                    if (!truncatedTree) {
                        truncatedTree = true;
                        warnings.push({ code: 'max_parts_exceeded', detail: `stopped after ${opts.maxParts} parts` });
                    }
                    return;
                }

                const headerList = node.headers ? node.headers.getList() : [];
                const entries = toHeaderEntries(headerList);
                const contentTypeHeader = entries.find(entry => entry.key === 'content-type');
                const ctParams = contentTypeHeader ? parseHeaderValueSafe(contentTypeHeader.value).params : {};

                const partId = partIdOf(node.partNr);
                const parentId = node.parentNode ? partIdOf(node.parentNode.partNr) : null;

                const part: MimePart = {
                    partId,
                    partNr: node.partNr ? [...node.partNr] : ['TEXT'],
                    contentType: node.contentType ? String(node.contentType).toLowerCase() : 'text/plain',
                    contentTypeParams: ctParams,
                    charset: node.charset ? String(node.charset) : null,
                    encoding: node.encoding ? String(node.encoding).toLowerCase() : null,
                    disposition: normaliseDisposition(node.disposition),
                    filename: node.filename ? String(node.filename) : null,
                    multipart: node.multipart ? String(node.multipart) : null,
                    rfc822: Boolean(node.rfc822),
                    embeddedRoot: Boolean(node.messageNode),
                    flowed: Boolean(node.flowed),
                    delSp: Boolean(node.delSp),
                    parentId,
                    childIds: [],
                    headerRange: { start: headerStart, end: offset },
                    bodyRange: null,
                    rawBodySize: 0,
                    headers: entries,
                    decoded: null
                };

                const pending: PendingPart = {
                    part,
                    node,
                    bodyChunks: [],
                    bodyBytes: 0,
                    collecting: TEXT_TYPES.has(part.contentType),
                    nonContiguous: false
                };

                if (node.root) {
                    rootId = partId;
                    rootHeaderList = headerList;
                }

                // Duplicate part ids can occur in pathological messages. Keep the first, so that
                // references from children stay stable.
                if (!partsById.has(partId)) {
                    partsById.set(partId, pending);
                    pendingParts.push(pending);
                    if (parentId) {
                        const parent = partsById.get(parentId);
                        if (parent) {
                            parent.part.childIds.push(partId);
                        }
                    }
                }
                return;
            }

            const value: Buffer = chunk.value;
            const start = offset;
            offset += value.length;

            if (chunk.type !== 'body' || !chunk.node) {
                return;
            }
            const owner = partsById.get(partIdOf(chunk.node.partNr));
            if (!owner) {
                return;
            }
            if (owner.part.bodyRange && owner.part.bodyRange.end !== start) {
                owner.nonContiguous = true;
            }
            owner.part.bodyRange = { start: owner.part.bodyRange ? owner.part.bodyRange.start : start, end: offset };
            owner.part.rawBodySize += value.length;
            if (owner.collecting) {
                // Guard against a single enormous text part exhausting memory. Collect a little more
                // than the cap so that the truncation warning is accurate.
                if (owner.bodyBytes < opts.maxTextPartBytes * 2) {
                    owner.bodyChunks.push(value);
                    owner.bodyBytes += value.length;
                }
            }
        });

        // The bundled typings narrow `on` to the 'data' event only, which shadows the inherited
        // Transform overloads and makes the class structurally incompatible with Transform. Register
        // lifecycle listeners through a minimal local view instead.
        const lifecycle = splitter as unknown as { on(event: string, listener: (arg?: unknown) => void): unknown };
        lifecycle.on('error', (err?: unknown) => {
            warnings.push({ code: 'mime_parse_error', detail: errorLabel(err) });
            finish();
        });
        lifecycle.on('end', finish);
        lifecycle.on('close', finish);

        try {
            splitter.end(raw);
        } catch (err) {
            warnings.push({ code: 'mime_parse_error', detail: errorLabel(err) });
            finish();
        }
    });

    // Aggregate budget across every text part. Per part caps do not bound total work: a thousand
    // individually legal parts add up to the same memory as one enormous one.
    let decodedBudget = opts.maxTotalDecodedTextBytes;
    let aggregateReported = false;

    for (const pending of pendingParts) {
        if (pending.nonContiguous) {
            warnings.push({ code: 'non_contiguous_body', mimePart: pending.part.partId });
        }
        if (pending.collecting && pending.bodyBytes > 0 && decodedBudget <= 0) {
            if (!aggregateReported) {
                aggregateReported = true;
                warnings.push({
                    code: 'input_limit_exceeded',
                    mimePart: pending.part.partId,
                    detail: `maxTotalDecodedTextBytes (${opts.maxTotalDecodedTextBytes})`
                });
            }
            pending.bodyChunks.length = 0;
            continue;
        }
        if (pending.collecting && pending.bodyBytes > 0) {
            pending.part.decoded = await decodeTextPart(pending, Math.min(opts.maxTextPartBytes, decodedBudget), warnings);
            decodedBudget -= pending.part.decoded.text.length;
        } else if (pending.collecting) {
            pending.part.decoded = {
                text: '',
                charsetUsed: pending.part.charset || 'utf-8',
                charsetDeclared: pending.part.charset,
                replacementChars: 0,
                truncated: false
            };
        }
        // Release references to raw chunks as soon as they are no longer needed.
        pending.bodyChunks.length = 0;
    }

    const parts = pendingParts.map(pending => pending.part);
    const byId = new Map(parts.map(part => [part.partId, part]));
    const rootHeaders = toHeaderEntries(rootHeaderList);

    if (!parts.length) {
        warnings.push({ code: 'mime_parse_error', detail: 'no MIME nodes produced' });
    }
    if (!parts.some(part => TEXT_TYPES.has(part.contentType))) {
        warnings.push({ code: 'no_body_parts' });
    }

    return {
        parts,
        partsById: byId,
        rootId,
        headers: extractMessageHeaders(rootHeaders),
        rootHeaders,
        warnings,
        size: raw.length,
        structure: structureSignature(parts, byId, rootId)
    };
}
