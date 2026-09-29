/**
 * Corpus feature extraction.
 *
 * Turns a parsed message into the flat, privacy safe record stored in the corpus database. The hard
 * rule here is that nothing derived from body text, subjects or addresses may leave this function
 * in readable form. Subjects and addresses become salted hashes, sender domains are kept because
 * they are needed for stratification, and body text is reduced to counts, ratios and a SimHash.
 */

import { detectHtmlHints, stripTagsToText } from '../canonical/html';
import { canonicaliseText, profileQuoting, type ReplyStyle } from '../canonical/text';
import { fingerprintClient, type ClientId } from '../detect/client';
import { loadPatterns } from '../detect/patterns';
import { classifyTraffic, type TrafficClass } from '../detect/traffic';
import { type MimePart, type ParsedMessage } from '../mime/model';
import { saltedHash, simhash64 } from '../util/hash';
import { estimateLanguage, type LanguageCode } from '../util/lang';
import { FORWARD_SUBJECT, REPLY_SUBJECT } from '../detect/subject';

export type BodyKind = 'both' | 'plain-only' | 'html-only' | 'none';

export interface MessageRecord {
    messageId: string | null;
    inReplyTo: string | null;
    referencesCount: number;
    referencesRoot: string | null;
    dateMs: number | null;
    fromDomain: string | null;
    fromHash: string | null;
    subjectHash: string | null;
    subjectPrefix: 'reply' | 'forward' | 'plain' | 'none';
    subjectLength: number;
    structure: string;
    bodyKind: BodyKind;
    charsets: string;
    encodings: string;
    partCount: number;
    attachmentCount: number;
    hasRfc822: boolean;
    textChars: number;
    htmlChars: number;
    flowed: boolean;
    client: ClientId;
    clientSource: string;
    traffic: TrafficClass;
    trafficSignals: string;
    isReply: boolean;
    isForward: boolean;
    quoteDepthMax: number;
    quotedRatio: number;
    replyStyle: ReplyStyle | 'unknown';
    /** Detector ids that fired, comma separated. Ids only, never matched text. */
    markers: string;
    htmlHints: string;
    blockquoteCount: number;
    tableCount: number;
    hasImage: boolean;
    suspectMalformedHtml: boolean;
    lang: LanguageCode;
    langScore: number;
    bodySimhash: string;
    warnings: string;
    /** True when plain and HTML disagree about whether the message contains quoted history. */
    quoteMarkingDisagrees: boolean;
}

function pickParts(message: ParsedMessage): { plain: MimePart[]; html: MimePart[]; attachments: number } {
    const plain: MimePart[] = [];
    const html: MimePart[] = [];
    let attachments = 0;
    for (const part of message.parts) {
        if (part.multipart) {
            continue;
        }
        const isText = part.contentType === 'text/plain' || part.contentType === 'text/html';
        if (isText && part.disposition !== 'attachment') {
            if (part.contentType === 'text/plain') {
                plain.push(part);
            } else {
                html.push(part);
            }
            continue;
        }
        if (part.rfc822) {
            continue;
        }
        attachments++;
    }
    return { plain, html, attachments };
}

function distinct(values: readonly (string | null)[]): string {
    const set = new Set<string>();
    for (const value of values) {
        if (value) {
            set.add(value.toLowerCase());
        }
    }
    return [...set].sort().join(',');
}

function extractDomain(address: string | null): string | null {
    if (!address) {
        return null;
    }
    const match = address.match(/@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/);
    return match?.[1] ? match[1].toLowerCase() : null;
}

function extractAddress(header: string | null): string | null {
    if (!header) {
        return null;
    }
    const angled = header.match(/<([^<>@\s]{1,64}@[^<>\s]{1,255})>/);
    if (angled?.[1]) {
        return angled[1].toLowerCase();
    }
    const bare = header.match(/([^<>\s,;"]{1,64}@[^<>\s,;"]{1,255})/);
    return bare?.[1] ? bare[1].toLowerCase() : null;
}

/** Which line level markers fired anywhere in the text. Ids only, no matched content. */
function detectMarkers(lines: readonly string[]): string[] {
    const patterns = loadPatterns();
    const fired = new Set<string>();
    // Cap the scan. Reply markers cluster near the top and bottom of a body, and a digest with tens
    // of thousands of lines would otherwise dominate the scan cost.
    const limit = 3000;
    const scan = lines.length > limit ? [...lines.slice(0, limit / 2), ...lines.slice(-limit / 2)] : lines;

    for (const line of scan) {
        if (line.length > 500) {
            continue;
        }
        for (const pattern of patterns.replyHeaders) {
            if (pattern.regex.test(line)) {
                fired.add(`reply:${pattern.id}`);
            }
        }
        for (const pattern of patterns.forwardHeaders) {
            if (pattern.regex.test(line)) {
                fired.add(`forward:${pattern.id}`);
            }
        }
        for (const pattern of patterns.quotedHeaderFields) {
            if (pattern.regex.test(line)) {
                fired.add(`field:${pattern.id}`);
            }
        }
        for (const pattern of patterns.signatureDelimiters) {
            if (pattern.regex.test(line)) {
                fired.add(`sigdelim:${pattern.id}`);
            }
        }
        for (const pattern of patterns.signaturePhrases) {
            if (pattern.regex.test(line)) {
                fired.add(`sig:${pattern.id}`);
            }
        }
    }
    return [...fired].sort();
}

function detectDisclaimers(text: string): string[] {
    const patterns = loadPatterns();
    // Disclaimers sit at the end. Scanning the tail keeps the cost bounded and avoids matching a
    // discussion that happens to mention confidentiality in the middle of a thread.
    const tail = text.length > 4000 ? text.slice(-4000) : text;
    const fired: string[] = [];
    for (const pattern of patterns.disclaimerPhrases) {
        if (pattern.regex.test(tail)) {
            fired.push(`disclaimer:${pattern.id}`);
        }
    }
    return fired;
}

/**
 * Build the corpus record for one parsed message.
 *
 * @param message parsed MIME structure
 * @param salt per database salt for the privacy preserving hashes
 */
export function analyzeMessage(message: ParsedMessage, salt: string): MessageRecord {
    const { plain, html, attachments } = pickParts(message);
    const headers = message.headers;

    const plainText = plain
        .map(part => part.decoded?.text || '')
        .filter(Boolean)
        .join('\n');
    const htmlSource = html
        .map(part => part.decoded?.text || '')
        .filter(Boolean)
        .join('\n');

    const canonical = canonicaliseText(plainText);
    const quoting = profileQuoting(canonical.lines);
    const hints = htmlSource ? detectHtmlHints(htmlSource) : null;

    // Language and markers come from whichever representation actually carries the content.
    const htmlProjection = htmlSource && !plainText ? stripTagsToText(htmlSource) : '';
    const analysisText = plainText || htmlProjection;

    const markers = detectMarkers(canonical.lines.map(line => line.content));
    if (htmlProjection) {
        markers.push(...detectMarkers(htmlProjection.split('\n')));
    }
    markers.push(...detectDisclaimers(analysisText));

    const bodyKind: BodyKind = plainText && htmlSource ? 'both' : plainText ? 'plain-only' : htmlSource ? 'html-only' : 'none';

    const subject = headers.subject || '';
    const subjectPrefix: MessageRecord['subjectPrefix'] = !subject
        ? 'none'
        : REPLY_SUBJECT.test(subject)
          ? 'reply'
          : FORWARD_SUBJECT.test(subject)
            ? 'forward'
            : 'plain';

    const rootPart = message.partsById.get(message.rootId);
    const boundary = rootPart?.contentTypeParams.boundary || null;
    const fingerprint = fingerprintClient(headers, htmlSource || null, boundary);
    const traffic = classifyTraffic(headers, message.rootHeaders);
    const language = estimateLanguage(analysisText);

    const hasQuoteInPlain = quoting.quotedLines > 0 || markers.some(id => id.startsWith('reply:'));
    const hasQuoteInHtml = Boolean(
        hints && (hints.hasBlockquote || hints.ids.some(id => id.includes('quote') || id.includes('Rply') || id.includes('separator')))
    );

    const fromAddress = extractAddress(headers.from);

    return {
        messageId: headers.messageId,
        inReplyTo: headers.inReplyTo,
        referencesCount: headers.references.length,
        referencesRoot: headers.references[0] ?? null,
        dateMs: headers.dateMs,
        fromDomain: extractDomain(headers.from),
        fromHash: fromAddress ? saltedHash(salt, fromAddress) : null,
        subjectHash: subject ? saltedHash(salt, subject.trim().toLowerCase().replace(REPLY_SUBJECT, '').replace(FORWARD_SUBJECT, '').trim()) : null,
        subjectPrefix,
        subjectLength: subject.length,
        structure: message.structure,
        bodyKind,
        charsets: distinct([...plain, ...html].map(part => part.decoded?.charsetUsed ?? part.charset)),
        encodings: distinct(message.parts.filter(part => !part.multipart).map(part => part.encoding)),
        partCount: message.parts.length,
        attachmentCount: attachments,
        hasRfc822: message.parts.some(part => part.rfc822),
        textChars: plainText.length,
        htmlChars: htmlSource.length,
        flowed: plain.some(part => part.flowed),
        client: fingerprint.client,
        clientSource: fingerprint.source,
        traffic: traffic.traffic,
        trafficSignals: traffic.signals.join(','),
        isReply: Boolean(headers.inReplyTo) || subjectPrefix === 'reply',
        isForward: subjectPrefix === 'forward' || markers.some(id => id.startsWith('forward:')),
        quoteDepthMax: quoting.maxDepth,
        quotedRatio: Number(quoting.quotedRatio.toFixed(4)),
        replyStyle: plainText ? quoting.style : 'unknown',
        markers: markers.sort().join(','),
        htmlHints: hints ? hints.ids.join(',') : '',
        blockquoteCount: hints?.blockquoteCount ?? 0,
        tableCount: hints?.tableCount ?? 0,
        hasImage: hints?.hasImage ?? false,
        suspectMalformedHtml: hints?.suspectMalformed ?? false,
        lang: language.lang,
        langScore: Number(language.score.toFixed(3)),
        bodySimhash: simhash64(analysisText),
        warnings: [...new Set(message.warnings.map(warning => warning.code))].sort().join(','),
        quoteMarkingDisagrees: bodyKind === 'both' && hasQuoteInPlain !== hasQuoteInHtml
    };
}
