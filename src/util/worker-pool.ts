/**
 * Fixed size worker pool with per task timeouts.
 *
 * Adapted from the pool in @postalsys/email-text-tools (lib/worker-pool.js), simplified for batch
 * work: the corpus scanner knows how many workers it wants and drives its own backpressure, so the
 * elastic sizing and idle reaping of the original are not needed. What is kept is the important
 * part, a task timeout that terminates and replaces the worker, so that one pathological message
 * cannot wedge a scan of 320k files.
 */

import { Worker } from 'node:worker_threads';
import { EventEmitter } from 'node:events';

export interface WorkerPoolOptions {
    workerPath: string;
    size: number;
    /** Per task timeout in milliseconds. */
    taskTimeoutMs: number;
    /** Optional data passed to every worker at startup. */
    workerData?: unknown;
    /**
     * Old generation heap cap per worker, in MiB.
     *
     * Worker threads share the parent process, so their heaps all count towards its RSS. Without a
     * cap, sixteen workers each growing to a comfortable default is more than a gigabyte of
     * resident memory for a job whose working set is one message at a time. Exceeding the cap
     * terminates that worker, which the pool treats like any other worker failure.
     */
    maxOldGenerationSizeMb?: number;
    /**
     * Worker respawns allowed before the pool gives up. Default 50 plus ten per worker.
     *
     * Respawning without a budget turns a worker that dies during startup into an infinite loop:
     * spawn, crash, spawn, forever, producing no results and no error. The budget converts that
     * into a bounded failure that names the tasks in flight when it tripped.
     */
    maxRestarts?: number;
}

/** The pool gave up replacing workers. Carries the ids of the tasks that were in flight. */
export class WorkerRestartBudgetError extends Error {
    readonly restarts: number;

    constructor(restarts: number) {
        super(`worker pool gave up after ${restarts} restarts; workers are crashing faster than they can do work`);
        this.name = 'WorkerRestartBudgetError';
        this.restarts = restarts;
    }
}

interface Envelope<TTask> {
    id: number;
    task: TTask;
}

interface Reply<TResult> {
    id: number;
    ok: boolean;
    result?: TResult;
    error?: string;
}

interface Slot<TResult> {
    worker: Worker;
    busy: boolean;
    current: {
        id: number;
        resolve: (value: TResult) => void;
        reject: (err: Error) => void;
        timer: NodeJS.Timeout;
    } | null;
}

interface Queued<TTask, TResult> {
    envelope: Envelope<TTask>;
    resolve: (value: TResult) => void;
    reject: (err: Error) => void;
}

export class WorkerTimeoutError extends Error {
    constructor(ms: number) {
        super(`worker task timed out after ${ms}ms`);
        this.name = 'WorkerTimeoutError';
    }
}

/**
 * Emits 'worker-error' with the underlying error whenever a worker dies unexpectedly. Callers may
 * log it; the pool itself recovers by spawning a replacement.
 */
export class WorkerPool<TTask, TResult> extends EventEmitter {
    private readonly options: WorkerPoolOptions;
    private readonly slots: Slot<TResult>[] = [];
    private readonly queue: Queued<TTask, TResult>[] = [];
    private nextId = 1;
    private closing = false;
    private restarts = 0;
    private readonly maxRestarts: number;
    /** Set once the restart budget is spent. Every queued and future task fails with it. */
    private brokenBy: WorkerRestartBudgetError | null = null;

    constructor(options: WorkerPoolOptions) {
        super();
        this.options = options;
        this.maxRestarts = options.maxRestarts ?? 50 + 10 * Math.max(1, options.size);
        for (let i = 0; i < Math.max(1, options.size); i++) {
            this.spawn();
        }
    }

    private spawn(): Slot<TResult> {
        const worker = new Worker(this.options.workerPath, {
            workerData: this.options.workerData,
            resourceLimits: this.options.maxOldGenerationSizeMb ? { maxOldGenerationSizeMb: this.options.maxOldGenerationSizeMb } : undefined
        });
        const slot: Slot<TResult> = { worker, busy: false, current: null };

        worker.on('message', (reply: Reply<TResult>) => {
            const current = slot.current;
            if (!current || current.id !== reply.id) {
                return;
            }
            clearTimeout(current.timer);
            slot.current = null;
            slot.busy = false;
            if (reply.ok) {
                current.resolve(reply.result as TResult);
            } else {
                current.reject(new Error(reply.error || 'worker failed'));
            }
            this.drainQueue();
        });

        worker.on('error', err => {
            this.emit('worker-error', err);
            this.fail(slot, err instanceof Error ? err : new Error(String(err)));
            this.replace(slot);
        });

        worker.on('exit', code => {
            if (this.closing || !this.slots.includes(slot)) {
                return;
            }
            // A worker that exits while holding a task takes the task down with it. Rejecting here
            // rather than letting the per task timer expire turns a crash into an immediate failure
            // instead of one that costs the whole timeout before anyone notices.
            this.fail(slot, new Error(`worker exited with code ${code} while running a task`));
            this.replace(slot);
        });

        this.slots.push(slot);
        return slot;
    }

    private replace(slot: Slot<TResult>): void {
        const index = this.slots.indexOf(slot);
        if (index !== -1) {
            this.slots.splice(index, 1);
        }
        slot.busy = false;
        void slot.worker.terminate().catch(() => undefined);
        if (this.closing || this.brokenBy) {
            return;
        }

        // Circuit breaker. A worker that dies during startup would otherwise be replaced forever,
        // producing no results, no error and no end.
        this.restarts++;
        if (this.restarts > this.maxRestarts) {
            this.brokenBy = new WorkerRestartBudgetError(this.restarts);
            this.emit('worker-error', this.brokenBy);
            this.failQueue(this.brokenBy);
            return;
        }

        this.spawn();
        this.drainQueue();
    }

    /** Reject whatever a slot was running, if anything. */
    private fail(slot: Slot<TResult>, err: Error): void {
        const current = slot.current;
        if (!current) {
            return;
        }
        clearTimeout(current.timer);
        slot.current = null;
        slot.busy = false;
        current.reject(err);
    }

    /** Reject everything in flight and waiting, so a broken pool stops a run instead of stalling it. */
    private failQueue(err: Error): void {
        while (this.queue.length) {
            (this.queue.shift() as Queued<TTask, TResult>).reject(err);
        }
        for (const slot of this.slots) {
            this.fail(slot, err);
        }
    }

    private dispatch(slot: Slot<TResult>, item: Queued<TTask, TResult>): void {
        slot.busy = true;
        const timer = setTimeout(() => {
            const current = slot.current;
            slot.current = null;
            if (current) {
                current.reject(new WorkerTimeoutError(this.options.taskTimeoutMs));
            }
            // The worker is stuck in whatever wedged it, so it cannot be reused.
            this.replace(slot);
        }, this.options.taskTimeoutMs);
        // A pending timer must not hold the process open on its own.
        timer.unref?.();

        slot.current = { id: item.envelope.id, resolve: item.resolve, reject: item.reject, timer };
        slot.worker.postMessage(item.envelope);
    }

    private drainQueue(): void {
        while (this.queue.length) {
            const slot = this.slots.find(candidate => !candidate.busy);
            if (!slot) {
                return;
            }
            const item = this.queue.shift();
            if (!item) {
                return;
            }
            this.dispatch(slot, item);
        }
    }

    /** Number of tasks accepted but not yet completed. */
    get inFlight(): number {
        return this.queue.length + this.slots.filter(slot => slot.busy).length;
    }

    submit(task: TTask): Promise<TResult> {
        if (this.closing) {
            return Promise.reject(new Error('worker pool is closing'));
        }
        if (this.brokenBy) {
            return Promise.reject(this.brokenBy);
        }
        return new Promise<TResult>((resolve, reject) => {
            const item: Queued<TTask, TResult> = { envelope: { id: this.nextId++, task }, resolve, reject };
            const slot = this.slots.find(candidate => !candidate.busy);
            if (slot) {
                this.dispatch(slot, item);
            } else {
                this.queue.push(item);
            }
        });
    }

    async close(): Promise<void> {
        this.closing = true;
        while (this.queue.length) {
            this.queue.shift()?.reject(new Error('worker pool is closing'));
        }
        const slots = [...this.slots];
        this.slots.length = 0;
        await Promise.all(
            slots.map(slot => {
                if (slot.current) {
                    clearTimeout(slot.current.timer);
                }
                return slot.worker.terminate().catch(() => undefined);
            })
        );
    }
}
