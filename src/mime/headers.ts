/**
 * Header extraction helpers.
 *
 * Nothing in the pipeline may depend on a header being present. Every accessor returns null rather
 * than throwing, and every decode is wrapped so that a malformed encoded word cannot abort a parse.
 */

import libmime from 'libmime';
import { type HeaderEntry, type MessageHeaders } from './model';

/** Decode MIME encoded words, falling back to the raw value on any failure. */
export function decodeWordsSafe(value: string): string {
    try {
        return libmime.decodeWords(value);
    } catch {
        return value;
    }
}

/** Parse a structured header value such as Content-Type into a value plus parameters. */
export function parseHeaderValueSafe(value: string): { value: string; params: Record<string, string> } {
    try {
        const parsed = libmime.parseHeaderValue(value);
        return { value: String(parsed.value || ''), params: parsed.params || {} };
    } catch {
        return { value, params: {} };
    }
}

/**
 * Convert mailsplit's raw header lines into normalised entries.
 *
 * mailsplit returns `{ key, line }` where `line` still contains the field name and any folded
 * continuations joined with CRLF. Lines with no colon at all are kept with an empty key so that
 * malformed input is still visible to diagnostics.
 */
export function toHeaderEntries(list: readonly { key: string; line: string }[]): HeaderEntry[] {
    const entries: HeaderEntry[] = [];
    for (const item of list) {
        const line = String(item.line || '');
        const colon = line.indexOf(':');
        const key = String(item.key || '').toLowerCase();
        const rawValue = colon === -1 ? '' : line.slice(colon + 1);
        // Unfold: a folded continuation is CRLF followed by whitespace.
        const value = rawValue.replace(/\r?\n[ \t]+/g, ' ').trim();
        entries.push({ key, value, decoded: decodeWordsSafe(value) });
    }
    return entries;
}

function first(entries: readonly HeaderEntry[], key: string): HeaderEntry | null {
    for (const entry of entries) {
        if (entry.key === key) {
            return entry;
        }
    }
    return null;
}

function firstValue(entries: readonly HeaderEntry[], key: string): string | null {
    const entry = first(entries, key);
    return entry ? entry.value || null : null;
}

function firstDecoded(entries: readonly HeaderEntry[], key: string): string | null {
    const entry = first(entries, key);
    return entry ? entry.decoded || null : null;
}

/** Strip angle brackets and surrounding whitespace from a Message-ID style value. */
export function normaliseMessageId(value: string | null): string | null {
    if (!value) {
        return null;
    }
    const match = value.match(/<([^>]+)>/);
    const id = (match?.[1] ?? value).trim().toLowerCase();
    return id || null;
}

/** Extract every angle bracketed id from a References style header. */
export function parseReferences(value: string | null): string[] {
    if (!value) {
        return [];
    }
    const matches = value.match(/<[^>\s]+>/g);
    if (matches) {
        return matches.map(item => item.slice(1, -1).trim().toLowerCase()).filter(Boolean);
    }
    // Some clients emit bare, whitespace separated ids.
    return value
        .split(/\s+/)
        .map(item => item.trim().toLowerCase())
        .filter(item => item.includes('@'));
}

function parseDateMs(value: string | null): number | null {
    if (!value) {
        return null;
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
}

/** Collect the headers the analysis pipeline uses. All fields are optional by design. */
export function extractMessageHeaders(entries: readonly HeaderEntry[]): MessageHeaders {
    const dateRaw = firstValue(entries, 'date');
    return {
        messageId: normaliseMessageId(firstValue(entries, 'message-id')),
        inReplyTo: normaliseMessageId(firstValue(entries, 'in-reply-to')),
        references: parseReferences(firstValue(entries, 'references')),
        from: firstDecoded(entries, 'from'),
        to: firstDecoded(entries, 'to'),
        cc: firstDecoded(entries, 'cc'),
        date: dateRaw,
        dateMs: parseDateMs(dateRaw),
        subject: firstDecoded(entries, 'subject'),
        contentType: firstValue(entries, 'content-type'),
        userAgent: firstValue(entries, 'user-agent'),
        xMailer: firstValue(entries, 'x-mailer'),
        listId: firstValue(entries, 'list-id'),
        listUnsubscribe: firstValue(entries, 'list-unsubscribe'),
        precedence: firstValue(entries, 'precedence'),
        autoSubmitted: firstValue(entries, 'auto-submitted')
    };
}
