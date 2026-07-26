/**
 * Thread reconstruction over a scanned corpus.
 *
 * Resolves a message's In-Reply-To and References to files that are actually present, so that
 * Stage 5 has something to match against. Measured over the working corpus, 90.9 percent of replies
 * resolve their direct parent this way.
 *
 * Ancestors are returned nearest first. The direct parent carries most of the value: it is what the
 * sender's client quoted from. Older ancestors matter for deeply nested threads, where the reply
 * contains several generations of history at once.
 */

import fs from 'node:fs';
import path from 'node:path';
import { buildHistoryDocument, type HistoryDocument } from '../match/history';
import { type MessageHeaders } from '../mime/model';
import { type CorpusStore } from './store';

export interface ThreadResolver {
    /** Load history documents for a message, nearest ancestor first. */
    resolve(headers: MessageHeaders, maxAncestors?: number): Promise<HistoryDocument[]>;
}

/** How many ancestors to load by default. Each one costs a file read and a parse. */
export const DEFAULT_MAX_ANCESTORS = 3;

/**
 * Build a resolver backed by a scanned corpus database.
 *
 * The lookup is a single indexed query per candidate Message-ID, so no in memory index of the whole
 * corpus is needed. That matters: a Message-ID map over 320k messages is tens of megabytes that
 * would otherwise be paid for on every process start.
 */
export function corpusThreadResolver(store: CorpusStore, root: string): ThreadResolver {
    const cache = new Map<string, HistoryDocument | null>();

    const load = async (messageId: string, isParent: boolean): Promise<HistoryDocument | null> => {
        const cached = cache.get(messageId);
        if (cached !== undefined) {
            return cached ? { ...cached, isParent } : null;
        }
        const row = store.queryOne<{ path: string }>('SELECT path FROM messages WHERE message_id = ? LIMIT 1', messageId);
        if (!row) {
            cache.set(messageId, null);
            return null;
        }
        try {
            const raw = fs.readFileSync(path.join(root, row.path));
            const document = await buildHistoryDocument(raw, row.path, isParent);
            cache.set(messageId, document);
            return document;
        } catch {
            cache.set(messageId, null);
            return null;
        }
    };

    return {
        async resolve(headers: MessageHeaders, maxAncestors = DEFAULT_MAX_ANCESTORS): Promise<HistoryDocument[]> {
            const documents: HistoryDocument[] = [];
            const seen = new Set<string>();

            if (headers.inReplyTo) {
                seen.add(headers.inReplyTo);
                const parent = await load(headers.inReplyTo, true);
                if (parent) {
                    documents.push(parent);
                }
            }

            // References run oldest first, so walk backwards for nearest ancestors.
            for (let i = headers.references.length - 1; i >= 0 && documents.length < maxAncestors; i--) {
                const reference = headers.references[i] as string;
                if (seen.has(reference)) {
                    continue;
                }
                seen.add(reference);
                const ancestor = await load(reference, false);
                if (ancestor) {
                    documents.push(ancestor);
                }
            }

            return documents;
        }
    };
}

/** Build a resolver from a folder of .eml files, for callers with no corpus database. */
export function folderThreadResolver(folder: string): ThreadResolver {
    let index: Map<string, string> | null = null;

    const buildIndex = async (): Promise<Map<string, string>> => {
        const map = new Map<string, string>();
        let entries: string[];
        try {
            entries = fs.readdirSync(folder).filter(name => /\.eml$/i.test(name));
        } catch {
            return map;
        }
        const { parseMessage } = await import('../mime/parse');
        for (const name of entries) {
            try {
                // Headers live at the front, so a bounded read is enough to index a folder.
                const handle = fs.openSync(path.join(folder, name), 'r');
                const buffer = Buffer.alloc(32768);
                const read = fs.readSync(handle, buffer, 0, buffer.length, 0);
                fs.closeSync(handle);
                const message = await parseMessage(buffer.subarray(0, read));
                if (message.headers.messageId) {
                    map.set(message.headers.messageId, name);
                }
            } catch {
                // A file that cannot be indexed simply is not available as history.
            }
        }
        return map;
    };

    return {
        async resolve(headers: MessageHeaders, maxAncestors = DEFAULT_MAX_ANCESTORS): Promise<HistoryDocument[]> {
            if (!index) {
                index = await buildIndex();
            }
            const documents: HistoryDocument[] = [];
            const wanted: { id: string; isParent: boolean }[] = [];
            if (headers.inReplyTo) {
                wanted.push({ id: headers.inReplyTo, isParent: true });
            }
            for (let i = headers.references.length - 1; i >= 0; i--) {
                const reference = headers.references[i] as string;
                if (reference !== headers.inReplyTo) {
                    wanted.push({ id: reference, isParent: false });
                }
            }

            for (const item of wanted) {
                if (documents.length >= maxAncestors) {
                    break;
                }
                const name = index.get(item.id);
                if (!name) {
                    continue;
                }
                try {
                    const raw = fs.readFileSync(path.join(folder, name));
                    documents.push(await buildHistoryDocument(raw, name, item.isParent));
                } catch {
                    // Unreadable ancestor, skip.
                }
            }
            return documents;
        }
    };
}
