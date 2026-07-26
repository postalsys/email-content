/**
 * Corpus metadata store.
 *
 * node:sqlite is used rather than better-sqlite3 or DuckDB: it is built into Node 24, so there is
 * no native build step and no lockfile that can stop working in two years. The corpus is a few
 * hundred thousand rows of small metadata, which is well within its comfortable range.
 *
 * The store holds derived metadata only. Raw messages stay on disk, referenced by path, and are
 * never copied. See docs/threat-model.md for what the derived data can still reveal.
 */

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { PROCESSING_VERSION, EXTRACTOR_VERSION } from '../types';
import { newSalt } from '../util/hash';
import { MIGRATIONS } from './migrations';
import { type MessageRecord } from './analyze';

export type FileStatus = 'ok' | 'failed' | 'skipped' | 'oversize' | 'timeout';

export interface FileRecord {
    path: string;
    size: number;
    mtime: number;
    sha256: string | null;
    status: FileStatus;
    errorCode: string | null;
    errorDetail: string | null;
    durationMs: number | null;
}

export interface ScanRow {
    file: FileRecord;
    message: MessageRecord | null;
}

export interface RunOptions {
    root: string;
    [key: string]: unknown;
}

export class CorpusStore {
    private readonly db: DatabaseSync;
    private readonly insertFileStmt;
    private readonly insertMessageStmt;
    private readonly seenStmt;

    /** Per database salt for privacy preserving hashes. Created on first open. */
    readonly salt: string;

    constructor(file: string) {
        const dir = path.dirname(path.resolve(file));
        fs.mkdirSync(dir, { recursive: true });

        this.db = new DatabaseSync(file);
        this.db.exec('PRAGMA journal_mode = WAL');
        this.db.exec('PRAGMA synchronous = NORMAL');
        this.db.exec('PRAGMA foreign_keys = ON');
        this.migrate();

        this.salt = this.readOrCreateSalt();

        this.insertFileStmt = this.db.prepare(`
            INSERT INTO files (path, size, mtime, sha256, status, error_code, error_detail, duration_ms, scanned_at, run_id, processing_version)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(path) DO UPDATE SET
                size = excluded.size, mtime = excluded.mtime, sha256 = excluded.sha256,
                status = excluded.status, error_code = excluded.error_code, error_detail = excluded.error_detail,
                duration_ms = excluded.duration_ms, scanned_at = excluded.scanned_at, run_id = excluded.run_id,
                processing_version = excluded.processing_version
        `);

        this.insertMessageStmt = this.db.prepare(`
            INSERT INTO messages (
                path, message_id, in_reply_to, references_count, references_root, date_ms,
                from_domain, from_hash, subject_hash, subject_prefix, subject_length,
                structure, body_kind, charsets, encodings, part_count, attachment_count, has_rfc822,
                text_chars, html_chars, flowed, client, client_source, traffic, traffic_signals,
                is_reply, is_forward, quote_depth_max, quoted_ratio, reply_style, markers, html_hints,
                blockquote_count, table_count, has_image, suspect_malformed_html, lang, lang_score,
                body_simhash, warnings, quote_marking_disagrees
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(path) DO UPDATE SET
                message_id = excluded.message_id, in_reply_to = excluded.in_reply_to,
                references_count = excluded.references_count, references_root = excluded.references_root,
                date_ms = excluded.date_ms, from_domain = excluded.from_domain, from_hash = excluded.from_hash,
                subject_hash = excluded.subject_hash, subject_prefix = excluded.subject_prefix,
                subject_length = excluded.subject_length, structure = excluded.structure,
                body_kind = excluded.body_kind, charsets = excluded.charsets, encodings = excluded.encodings,
                part_count = excluded.part_count, attachment_count = excluded.attachment_count,
                has_rfc822 = excluded.has_rfc822, text_chars = excluded.text_chars, html_chars = excluded.html_chars,
                flowed = excluded.flowed, client = excluded.client, client_source = excluded.client_source,
                traffic = excluded.traffic, traffic_signals = excluded.traffic_signals, is_reply = excluded.is_reply,
                is_forward = excluded.is_forward, quote_depth_max = excluded.quote_depth_max,
                quoted_ratio = excluded.quoted_ratio, reply_style = excluded.reply_style, markers = excluded.markers,
                html_hints = excluded.html_hints, blockquote_count = excluded.blockquote_count,
                table_count = excluded.table_count, has_image = excluded.has_image,
                suspect_malformed_html = excluded.suspect_malformed_html, lang = excluded.lang,
                lang_score = excluded.lang_score, body_simhash = excluded.body_simhash,
                warnings = excluded.warnings, quote_marking_disagrees = excluded.quote_marking_disagrees
        `);

        this.seenStmt = this.db.prepare('SELECT size, mtime, processing_version FROM files WHERE path = ?');
    }

    private migrate(): void {
        const current = Number((this.db.prepare('PRAGMA user_version').get() as { user_version?: number })?.user_version ?? 0);
        for (const migration of MIGRATIONS) {
            if (migration.version <= current) {
                continue;
            }
            this.db.exec('BEGIN');
            try {
                this.db.exec(migration.sql);
                this.db.exec(`PRAGMA user_version = ${migration.version}`);
                this.db.exec('COMMIT');
            } catch (err) {
                this.db.exec('ROLLBACK');
                throw new Error(`migration ${migration.version} (${migration.name}) failed`, { cause: err });
            }
        }
    }

    private readOrCreateSalt(): string {
        const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('salt') as { value?: string } | undefined;
        if (row?.value) {
            return row.value;
        }
        const salt = newSalt();
        this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('salt', salt);
        return salt;
    }

    getMeta(key: string): string | null {
        const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value?: string } | undefined;
        return row?.value ?? null;
    }

    setMeta(key: string, value: string): void {
        this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
    }

    startRun(options: RunOptions): number {
        const stmt = this.db.prepare(`
            INSERT INTO runs (root, started_at, status, processing_version, extractor_version, options_json)
            VALUES (?, ?, 'running', ?, ?, ?)
        `);
        const result = stmt.run(options.root, Date.now(), PROCESSING_VERSION, EXTRACTOR_VERSION, JSON.stringify(options));
        return Number(result.lastInsertRowid);
    }

    finishRun(
        runId: number,
        status: 'completed' | 'interrupted' | 'failed',
        counts: { seen: number; processed: number; failed: number; skipped: number }
    ): void {
        this.db
            .prepare('UPDATE runs SET finished_at = ?, status = ?, files_seen = ?, files_processed = ?, files_failed = ?, files_skipped = ? WHERE id = ?')
            .run(Date.now(), status, counts.seen, counts.processed, counts.failed, counts.skipped, runId);
    }

    /**
     * True when this exact file has already been processed by the current processing version.
     * Resume relies on size and mtime rather than a hash, because hashing every file would mean
     * reading the whole corpus again just to decide what to skip.
     */
    isProcessed(relPath: string, size: number, mtime: number): boolean {
        const row = this.seenStmt.get(relPath) as { size?: number; mtime?: number; processing_version?: string } | undefined;
        if (!row) {
            return false;
        }
        return row.size === size && row.mtime === mtime && row.processing_version === PROCESSING_VERSION;
    }

    /** Write a batch inside a single transaction. */
    writeBatch(rows: readonly ScanRow[], runId: number): void {
        if (!rows.length) {
            return;
        }
        this.db.exec('BEGIN');
        try {
            const now = Date.now();
            for (const row of rows) {
                const file = row.file;
                this.insertFileStmt.run(
                    file.path,
                    file.size,
                    file.mtime,
                    file.sha256,
                    file.status,
                    file.errorCode,
                    file.errorDetail,
                    file.durationMs,
                    now,
                    runId,
                    PROCESSING_VERSION
                );
                const record = row.message;
                if (!record) {
                    continue;
                }
                this.insertMessageStmt.run(
                    file.path,
                    record.messageId,
                    record.inReplyTo,
                    record.referencesCount,
                    record.referencesRoot,
                    record.dateMs,
                    record.fromDomain,
                    record.fromHash,
                    record.subjectHash,
                    record.subjectPrefix,
                    record.subjectLength,
                    record.structure,
                    record.bodyKind,
                    record.charsets,
                    record.encodings,
                    record.partCount,
                    record.attachmentCount,
                    record.hasRfc822 ? 1 : 0,
                    record.textChars,
                    record.htmlChars,
                    record.flowed ? 1 : 0,
                    record.client,
                    record.clientSource,
                    record.traffic,
                    record.trafficSignals,
                    record.isReply ? 1 : 0,
                    record.isForward ? 1 : 0,
                    record.quoteDepthMax,
                    record.quotedRatio,
                    record.replyStyle,
                    record.markers,
                    record.htmlHints,
                    record.blockquoteCount,
                    record.tableCount,
                    record.hasImage ? 1 : 0,
                    record.suspectMalformedHtml ? 1 : 0,
                    record.lang,
                    record.langScore,
                    record.bodySimhash,
                    record.warnings,
                    record.quoteMarkingDisagrees ? 1 : 0
                );
            }
            this.db.exec('COMMIT');
        } catch (err) {
            this.db.exec('ROLLBACK');
            throw err;
        }
    }

    /** Execute a statement. Returns the driver result, including lastInsertRowid. */
    run(sql: string, ...params: (string | number | null)[]) {
        return this.db.prepare(sql).run(...params);
    }

    /** Run a function inside a transaction, rolling back on any throw. */
    transaction(fn: () => void): void {
        this.db.exec('BEGIN');
        try {
            fn();
            this.db.exec('COMMIT');
        } catch (err) {
            this.db.exec('ROLLBACK');
            throw err;
        }
    }

    /** Run an arbitrary read only query. Used by the stats and sampling commands. */
    query<T = Record<string, unknown>>(sql: string, ...params: (string | number | null)[]): T[] {
        return this.db.prepare(sql).all(...params) as T[];
    }

    queryOne<T = Record<string, unknown>>(sql: string, ...params: (string | number | null)[]): T | null {
        return (this.db.prepare(sql).get(...params) as T) ?? null;
    }

    close(): void {
        try {
            this.db.exec('PRAGMA optimize');
        } catch {
            // Best effort only. A failure here must not mask a successful scan.
        }
        this.db.close();
    }
}
