/**
 * Streaming corpus scanner.
 *
 * Requirements this design answers, in order of importance:
 *   - one malformed message must never stop a run, so every failure becomes a row
 *   - bounded memory, so files are streamed and results are flushed in batches
 *   - resumable, so an interrupted run skips what it already recorded
 *   - deterministic, so the same seed always produces the same sample
 *   - no message content in any log line
 *
 * Backpressure is driven from here rather than inside the pool: the scanner keeps a bounded window
 * of in flight tasks and awaits a completion before dispatching more. That keeps peak memory
 * proportional to the window size rather than to the corpus size.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { deterministicUnit } from '../util/hash';
import { WorkerPool, WorkerRestartBudgetError } from '../util/worker-pool';
import { CorpusStore, type RunStatus, type ScanRow } from './store';
import { type ScanResult, type ScanTask } from './worker';

export interface ScanOptions {
    root: string;
    dbPath: string;
    /** Number of worker threads. Defaults to cores minus two, minimum one. */
    concurrency?: number;
    /** Deterministic sample size. Zero or undefined scans everything. */
    sample?: number;
    /** Seed for deterministic sampling. */
    seed?: string;
    /** Skip files already recorded by this processing version. Default true. */
    resume?: boolean;
    /** Files larger than this are recorded as oversize and not parsed. Default 32 MiB. */
    maxFileBytes?: number;
    /** Decoded text retained per part. Default 1 MiB. */
    maxTextPartBytes?: number;
    /** Per file timeout in milliseconds. Default 30000. */
    timeoutMs?: number;
    /** Rows buffered before a database write. Default 500. */
    batchSize?: number;
    /** Filename filter. Default matches .eml case insensitively. */
    pattern?: RegExp;
    /** Called with progress updates. */
    onProgress?: (progress: ScanProgress) => void;
    /** Progress callback interval in milliseconds. Default 1000. */
    progressIntervalMs?: number;
}

export interface ScanProgress {
    seen: number;
    total: number;
    processed: number;
    failed: number;
    skipped: number;
    elapsedMs: number;
    filesPerSecond: number;
    etaMs: number | null;
    rssBytes: number;
}

export interface ScanSummary extends ScanProgress {
    runId: number;
    /**
     * How the run ended. Only `completed` may be consumed as a baseline.
     *
     * `aborted` is a signal or a worker crash loop; `failed` is a database or write error. Both
     * leave partial output that looks exactly like a small corpus, which is why the state is
     * recorded explicitly rather than inferred from the row count.
     */
    status: RunStatus;
}

interface Candidate {
    relPath: string;
    size: number;
    mtime: number;
}

/**
 * Walk a directory tree and yield candidate files.
 *
 * Uses opendir so that a directory with 320k entries is streamed rather than materialised as one
 * large array by readdir. Unreadable entries are skipped silently: a permission error on one file
 * is not a reason to abort a corpus walk.
 */
export async function* walkFiles(root: string, pattern: RegExp): AsyncGenerator<Candidate> {
    const stack: string[] = [''];
    while (stack.length) {
        const relDir = stack.pop() as string;
        const absDir = path.join(root, relDir);
        let dir: fs.Dir;
        try {
            dir = fs.opendirSync(absDir);
        } catch {
            continue;
        }
        try {
            for await (const entry of dir) {
                const relPath = relDir ? path.join(relDir, entry.name) : entry.name;
                if (entry.isDirectory()) {
                    stack.push(relPath);
                    continue;
                }
                if (!entry.isFile() || !pattern.test(entry.name)) {
                    continue;
                }
                try {
                    const stat = fs.statSync(path.join(root, relPath));
                    yield { relPath, size: stat.size, mtime: Math.floor(stat.mtimeMs) };
                } catch {
                    // Vanished between readdir and stat. Nothing to record.
                }
            }
        } catch {
            // Directory iteration failed midway. Keep whatever was yielded and move on.
        }
    }
}

/**
 * Select a deterministic sample.
 *
 * Each path is mapped to a uniform value by hashing it with the seed, and the lowest `count` values
 * win. The result depends only on the path set and the seed, never on iteration order, so a sample
 * is reproducible across machines and across partial runs.
 */
export function selectSample(candidates: readonly Candidate[], count: number, seed: string): Candidate[] {
    if (!count || count >= candidates.length) {
        return [...candidates];
    }
    const scored = candidates.map(candidate => ({ candidate, score: deterministicUnit(seed, candidate.relPath) }));
    scored.sort((a, b) => a.score - b.score || (a.candidate.relPath < b.candidate.relPath ? -1 : 1));
    return scored.slice(0, count).map(item => item.candidate);
}

function resolveWorkerPath(): string {
    return path.join(__dirname, 'worker.js');
}

export async function scanCorpus(options: ScanOptions): Promise<ScanSummary> {
    const root = path.resolve(options.root);
    const pattern = options.pattern ?? /\.eml$/i;
    const concurrency = Math.max(1, options.concurrency ?? Math.max(1, os.availableParallelism() - 2));
    const batchSize = options.batchSize ?? 500;
    const timeoutMs = options.timeoutMs ?? 30000;
    const maxFileBytes = options.maxFileBytes ?? 32 * 1024 * 1024;
    const maxTextPartBytes = options.maxTextPartBytes ?? 1024 * 1024;
    const progressIntervalMs = options.progressIntervalMs ?? 1000;
    const resume = options.resume !== false;

    const store = new CorpusStore(options.dbPath);

    // The candidate list is collected first so that sampling is deterministic and progress can
    // report a real total. Only path, size and mtime are held, roughly 100 bytes per file, which is
    // about 32 MB for the full corpus. Message bodies are never held.
    const candidates: Candidate[] = [];
    for await (const candidate of walkFiles(root, pattern)) {
        candidates.push(candidate);
    }
    candidates.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));

    const selected = options.sample ? selectSample(candidates, options.sample, options.seed ?? 'default') : candidates;

    const runId = store.startRun({
        root,
        concurrency,
        sample: options.sample ?? null,
        seed: options.seed ?? null,
        resume,
        maxFileBytes,
        maxTextPartBytes,
        timeoutMs,
        total: selected.length
    });

    /** First failure that made the run untrustworthy. Set once, rethrown after cleanup. */
    let fatal: Error | null = null;
    let interrupted = false;

    const pool = new WorkerPool<ScanTask, ScanResult>({
        workerPath: resolveWorkerPath(),
        size: concurrency,
        taskTimeoutMs: timeoutMs,
        // Generous relative to the working set of one message, tight enough that the whole pool
        // stays well under a gigabyte.
        maxOldGenerationSizeMb: 192,
        workerData: { root, salt: store.salt, maxFileBytes, maxTextPartBytes }
    });
    pool.on('worker-error', (err: Error) => {
        // Individual worker errors are reported through the failed counter; there is nothing
        // actionable to print per occurrence during a long run. A spent restart budget is different:
        // the pool has given up, no further task can succeed, and the run must stop rather than
        // grind out a database full of worker_error rows that looks like a scanned corpus.
        if (err instanceof WorkerRestartBudgetError) {
            fatal = fatal ?? err;
            interrupted = true;
        }
    });

    const started = Date.now();
    let seen = 0;
    let processed = 0;
    let failed = 0;
    let skipped = 0;
    let batch: ScanRow[] = [];

    const flush = () => {
        if (!batch.length) {
            return;
        }
        const rows = batch;
        batch = [];
        store.writeBatch(rows, runId);
    };

    const progress = (): ScanProgress => {
        const elapsedMs = Date.now() - started;
        const done = processed + failed;
        const rate = elapsedMs > 0 ? (done / elapsedMs) * 1000 : 0;
        const remaining = selected.length - seen;
        return {
            seen,
            total: selected.length,
            processed,
            failed,
            skipped,
            elapsedMs,
            filesPerSecond: rate,
            etaMs: rate > 0 ? (remaining / rate) * 1000 : null,
            rssBytes: process.memoryUsage.rss()
        };
    };

    let lastProgress = 0;
    const maybeReport = () => {
        if (!options.onProgress) {
            return;
        }
        const now = Date.now();
        if (now - lastProgress >= progressIntervalMs) {
            lastProgress = now;
            options.onProgress(progress());
        }
    };

    const onSignal = () => {
        interrupted = true;
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);

    const window = concurrency * 4;
    const inFlight = new Set<Promise<void>>();

    try {
        for (const candidate of selected) {
            if (interrupted) {
                break;
            }
            seen++;

            if (resume && store.isProcessed(candidate.relPath, candidate.size, candidate.mtime)) {
                skipped++;
                maybeReport();
                continue;
            }

            const task: ScanTask = { relPath: candidate.relPath, size: candidate.size, mtime: candidate.mtime };
            const promise = pool
                .submit(task)
                .then(result => {
                    batch.push({ file: result.file, message: result.message });
                    if (result.file.status === 'ok') {
                        processed++;
                    } else {
                        failed++;
                    }
                })
                .catch((err: Error) => {
                    // A rejected task means the worker died or timed out. Record it and continue.
                    failed++;
                    batch.push({
                        file: {
                            path: candidate.relPath,
                            size: candidate.size,
                            mtime: candidate.mtime,
                            sha256: null,
                            status: err.name === 'WorkerTimeoutError' ? 'timeout' : 'failed',
                            errorCode: err.name === 'WorkerTimeoutError' ? 'timeout' : 'worker_error',
                            errorDetail: err.message.slice(0, 300),
                            durationMs: null
                        },
                        message: null
                    });
                })
                .then(() => {
                    if (batch.length >= batchSize) {
                        flush();
                    }
                    maybeReport();
                });

            inFlight.add(promise);
            void promise.finally(() => inFlight.delete(promise));

            if (inFlight.size >= window) {
                await Promise.race(inFlight);
            }
        }

        await Promise.all(inFlight);
        flush();
    } catch (err) {
        // A write or database failure marks the run failed. Swallowing it, which is what an empty
        // catch in a cleanup path does, produces a database that looks like a small clean corpus.
        fatal = fatal ?? (err instanceof Error ? err : new Error(String(err)));
    } finally {
        process.off('SIGINT', onSignal);
        process.off('SIGTERM', onSignal);
        try {
            await pool.close();
        } catch (err) {
            fatal = fatal ?? (err instanceof Error ? err : new Error(String(err)));
        }
        try {
            flush();
        } catch (err) {
            fatal = fatal ?? (err instanceof Error ? err : new Error(String(err)));
        }

        const final = progress();
        const status: RunStatus = fatal ? 'failed' : interrupted ? 'aborted' : 'completed';
        try {
            store.finishRun(runId, status, {
                seen: final.seen,
                processed: final.processed,
                failed: final.failed,
                skipped: final.skipped
            });
        } catch (err) {
            // The run state itself could not be written, so the row still says `running`. That is
            // already the "do not trust me" state, but the caller must still hear about it.
            fatal = fatal ?? (err instanceof Error ? err : new Error(String(err)));
        }
        try {
            store.close();
        } catch (err) {
            fatal = fatal ?? (err instanceof Error ? err : new Error(String(err)));
        }
    }

    if (fatal) {
        throw fatal;
    }

    const final = progress();
    return { ...final, runId, status: interrupted ? 'aborted' : 'completed' };
}
