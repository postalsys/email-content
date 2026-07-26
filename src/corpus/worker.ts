/**
 * Corpus scan worker.
 *
 * One message per task. Every failure mode is caught and reported as a result rather than as a
 * thrown error, so that a malformed file degrades to a row with status 'failed' instead of killing
 * the worker. The only thing that can still take a worker down is running out of memory or an
 * infinite loop, and the pool's task timeout covers both.
 */

import fs from 'node:fs';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { parseMessage } from '../mime/parse';
import { sha256 } from '../util/hash';
import { analyzeMessage, type MessageRecord } from './analyze';
import { type FileRecord, type FileStatus } from './store';

export interface ScanTask {
    /** Path relative to the corpus root. */
    relPath: string;
    size: number;
    mtime: number;
}

export interface ScanResult {
    file: FileRecord;
    message: MessageRecord | null;
}

interface WorkerConfig {
    root: string;
    salt: string;
    maxFileBytes: number;
    maxTextPartBytes: number;
}

const config = workerData as WorkerConfig;

function errorDetail(err: unknown): string {
    if (err instanceof Error) {
        return `${err.name}: ${err.message}`.slice(0, 300);
    }
    return String(err).slice(0, 300);
}

async function handle(task: ScanTask): Promise<ScanResult> {
    const absolute = path.join(config.root, task.relPath);
    const started = Date.now();

    const base: FileRecord = {
        path: task.relPath,
        size: task.size,
        mtime: task.mtime,
        sha256: null,
        status: 'ok' as FileStatus,
        errorCode: null,
        errorDetail: null,
        durationMs: null
    };

    if (task.size > config.maxFileBytes) {
        // Oversize messages are recorded, not silently dropped, so the corpus report can show how
        // much of the tail was skipped and why.
        return { file: { ...base, status: 'oversize', errorCode: 'oversize', durationMs: Date.now() - started }, message: null };
    }

    let raw: Buffer;
    try {
        raw = fs.readFileSync(absolute);
    } catch (err) {
        return { file: { ...base, status: 'failed', errorCode: 'read_error', errorDetail: errorDetail(err), durationMs: Date.now() - started }, message: null };
    }

    const hash = sha256(raw);

    try {
        const parsed = await parseMessage(raw, { maxTextPartBytes: config.maxTextPartBytes });
        const record = analyzeMessage(parsed, config.salt);
        return {
            file: { ...base, sha256: hash, status: 'ok', durationMs: Date.now() - started },
            message: record
        };
    } catch (err) {
        return {
            file: { ...base, sha256: hash, status: 'failed', errorCode: 'parse_error', errorDetail: errorDetail(err), durationMs: Date.now() - started },
            message: null
        };
    }
}

if (parentPort) {
    const port = parentPort;
    port.on('message', (envelope: { id: number; task: ScanTask }) => {
        handle(envelope.task).then(
            result => port.postMessage({ id: envelope.id, ok: true, result }),
            err => port.postMessage({ id: envelope.id, ok: false, error: errorDetail(err) })
        );
    });
}
