import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzeMessage } from '../src/corpus/analyze';
import { selectSample } from '../src/corpus/scanner';
import { CorpusStore } from '../src/corpus/store';
import { WorkerPool, WorkerRestartBudgetError } from '../src/util/worker-pool';
import { parseMessage } from '../src/mime/parse';
import { deterministicUnit, NEAR_DUPLICATE_THRESHOLD, simhash64, simhashDistance } from '../src/util/hash';
import { readFixture } from './helpers';

/**
 * node:sqlite arrived in Node 22.5. The corpus tooling requires it; the extraction library does not.
 * On an older runtime these tests are skipped rather than failed, so the suite still means something
 * on the oldest Node the library supports.
 */
const HAS_SQLITE = (() => {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('node:sqlite');
        return true;
    } catch {
        return false;
    }
})();

function tempDb(): string {
    return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'email-content-test-')), 'corpus.sqlite');
}

describe('deterministic sampling', () => {
    const candidates = Array.from({ length: 1000 }, (_, i) => ({ relPath: `file-${i}.eml`, size: 100 + i, mtime: i }));

    it('returns the same sample for the same seed', () => {
        const a = selectSample(candidates, 50, 'seed-one');
        const b = selectSample(candidates, 50, 'seed-one');
        assert.deepEqual(
            a.map(item => item.relPath),
            b.map(item => item.relPath)
        );
        assert.equal(a.length, 50);
    });

    it('returns a different sample for a different seed', () => {
        const a = selectSample(candidates, 50, 'seed-one').map(item => item.relPath);
        const b = selectSample(candidates, 50, 'seed-two').map(item => item.relPath);
        assert.notDeepEqual(a, b);
    });

    it('is independent of input order', () => {
        const shuffled = [...candidates].reverse();
        const a = selectSample(candidates, 25, 'stable')
            .map(item => item.relPath)
            .sort();
        const b = selectSample(shuffled, 25, 'stable')
            .map(item => item.relPath)
            .sort();
        assert.deepEqual(a, b);
    });

    it('returns everything when the sample is larger than the corpus', () => {
        assert.equal(selectSample(candidates, 5000, 'x').length, candidates.length);
        assert.equal(selectSample(candidates, 0, 'x').length, candidates.length);
    });

    it('spreads selection roughly uniformly', () => {
        const sample = selectSample(candidates, 200, 'uniform');
        const firstHalf = sample.filter(item => Number(item.relPath.match(/\d+/)?.[0]) < 500).length;
        // A uniform sample of 200 should land near 100 in each half. Wide bounds, this only needs
        // to catch a badly skewed hash.
        assert.ok(firstHalf > 70 && firstHalf < 130, `first half had ${firstHalf}`);
    });

    it('produces stable unit values', () => {
        assert.equal(deterministicUnit('seed', 'key'), deterministicUnit('seed', 'key'));
        assert.notEqual(deterministicUnit('seed', 'key'), deterministicUnit('seed', 'other'));
    });
});

describe('simhash', () => {
    it('is identical for identical text', () => {
        assert.equal(simhash64('the quick brown fox'), simhash64('the quick brown fox'));
    });

    it('stays within the near duplicate threshold for template variants', () => {
        // Sized like the real case this exists for: a templated transactional mail where only a few
        // fields differ between copies.
        const base =
            'Dear customer, your invoice INV-1001 is ready for payment. The total amount due is 249.00 EUR and payment is due within 14 days of the invoice date. ' +
            'You can view and download the invoice from your account dashboard at any time. If you have questions about this invoice please reply to this message.';
        const baseHash = simhash64(base);

        const variants = [
            base.replace('1001', '1002'),
            base.replace('1001', '1002').replace('249.00', '319.50'),
            base.replace('Dear customer', 'Dear Ms Johnson')
        ];
        for (const variant of variants) {
            const distance = simhashDistance(baseHash, simhash64(variant));
            assert.ok(distance <= NEAR_DUPLICATE_THRESHOLD, `distance was ${distance}`);
        }
    });

    it('is far apart for unrelated text', () => {
        const a = simhash64(
            'Dear customer, your invoice INV-1001 is ready for payment. The total amount due is 249.00 EUR and payment is due within 14 days of the invoice date.'
        );
        const b = simhash64(
            'Kubernetes pod eviction due to memory pressure on node three. The scheduler moved four workloads to other nodes and the alert has now cleared.'
        );
        const distance = simhashDistance(a, b);
        assert.ok(distance > NEAR_DUPLICATE_THRESHOLD * 2, `distance was ${distance}`);
    });

    it('handles empty input', () => {
        assert.equal(simhash64(''), '0000000000000000');
    });
});

describe('analyzeMessage', () => {
    it('records structure and client without leaking content', async () => {
        const parsed = await parseMessage(readFixture('gmail-top-post.eml'));
        const record = analyzeMessage(parsed, 'test-salt');

        assert.equal(record.structure, 'm/alternative(P,H)');
        assert.equal(record.bodyKind, 'both');
        assert.equal(record.client, 'gmail');
        assert.equal(record.traffic, 'human');
        assert.equal(record.isReply, true);
        assert.equal(record.subjectPrefix, 'reply');
        assert.equal(record.replyStyle, 'top');
        assert.ok(record.markers.includes('reply:'));
        assert.ok(record.htmlHints.includes('gmail_quote'));

        // Nothing recoverable from the message should appear in the record.
        const serialised = JSON.stringify(record);
        assert.ok(!serialised.includes('wait until Monday'));
        assert.ok(!serialised.includes('alice@example.com'));
        assert.ok(!serialised.includes('Deploy window'));
        // The sender domain is kept deliberately, for stratification.
        assert.equal(record.fromDomain, 'example.com');
    });

    it('produces stable hashes for the same salt and different ones otherwise', async () => {
        const parsed = await parseMessage(readFixture('gmail-top-post.eml'));
        const a = analyzeMessage(parsed, 'salt-a');
        const b = analyzeMessage(parsed, 'salt-a');
        const c = analyzeMessage(parsed, 'salt-b');
        assert.equal(a.fromHash, b.fromHash);
        assert.notEqual(a.fromHash, c.fromHash);
    });

    it('detects interleaved plain text replies', async () => {
        const parsed = await parseMessage(readFixture('plain-inline-reply.eml'));
        const record = analyzeMessage(parsed, 'salt');
        assert.equal(record.replyStyle, 'interleaved');
        assert.equal(record.quoteDepthMax, 1);
    });

    it('detects forwarded messages', async () => {
        const parsed = await parseMessage(readFixture('forwarded-with-comment.eml'));
        const record = analyzeMessage(parsed, 'salt');
        assert.equal(record.isForward, true);
        assert.ok(record.markers.includes('forward:'));
    });

    it('does not treat prose containing header names as a reply', async () => {
        const parsed = await parseMessage(readFixture('text-mentions-headers.eml'));
        const record = analyzeMessage(parsed, 'salt');
        assert.equal(record.isReply, false);
        assert.equal(record.quoteDepthMax, 0);
        assert.equal(record.replyStyle, 'none');
    });
});

describe('CorpusStore', { skip: HAS_SQLITE ? false : 'node:sqlite requires Node 22.5 or later' }, () => {
    it('creates the schema, is idempotent, and round trips a batch', async () => {
        const dbPath = tempDb();
        const store = new CorpusStore(dbPath);
        const runId = store.startRun({ root: '/tmp' });

        const parsed = await parseMessage(readFixture('gmail-top-post.eml'));
        const record = analyzeMessage(parsed, store.salt);

        store.writeBatch(
            [
                {
                    file: {
                        path: 'a/b.eml',
                        size: 1221,
                        mtime: 1000,
                        sha256: 'abc',
                        status: 'ok',
                        errorCode: null,
                        errorDetail: null,
                        durationMs: 3
                    },
                    message: record
                }
            ],
            runId
        );

        assert.equal(store.isProcessed('a/b.eml', 1221, 1000), true);
        assert.equal(store.isProcessed('a/b.eml', 9999, 1000), false);
        assert.equal(store.isProcessed('missing.eml', 1, 1), false);

        const row = store.queryOne<{ client: string; structure: string }>('SELECT client, structure FROM messages WHERE path = ?', 'a/b.eml');
        assert.equal(row?.client, 'gmail');
        assert.equal(row?.structure, 'm/alternative(P,H)');

        // Writing the same row again must not duplicate it.
        store.writeBatch(
            [
                {
                    file: { path: 'a/b.eml', size: 1221, mtime: 1000, sha256: 'abc', status: 'ok', errorCode: null, errorDetail: null, durationMs: 3 },
                    message: record
                }
            ],
            runId
        );
        assert.equal(store.queryOne<{ count: number }>('SELECT COUNT(*) AS count FROM files')?.count, 1);

        store.finishRun(runId, 'completed', { seen: 1, processed: 1, failed: 0, skipped: 0 });
        const salt = store.salt;
        store.close();

        // Re-opening keeps the salt, so hashes stay comparable across runs.
        const reopened = new CorpusStore(dbPath);
        assert.equal(reopened.salt, salt);
        assert.equal(reopened.queryOne<{ count: number }>('SELECT COUNT(*) AS count FROM messages')?.count, 1);
        reopened.close();
    });
});

/**
 * Operability of the evaluation infrastructure.
 *
 * The scanner is not the extraction runtime, but a corpus run that failed halfway and looks
 * successful can approve a bad release. Every case here is about telling a partial result from a
 * complete one.
 */
describe('corpus run state', { skip: HAS_SQLITE ? false : 'node:sqlite requires Node 22.5 or later' }, () => {
    function tempStore(): { store: CorpusStore; dir: string } {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-content-runs-'));
        return { store: new CorpusStore(path.join(dir, 'corpus.sqlite')), dir };
    }

    it('never offers an unfinished run as a baseline', () => {
        const { store, dir } = tempStore();
        try {
            // A run whose process died leaves its row saying `running` forever.
            store.startRun({ root: '/corpus/crashed' });
            assert.equal(store.latestCompletedRun(), null, 'a running run was offered as a baseline');

            const aborted = store.startRun({ root: '/corpus/aborted' });
            store.finishRun(aborted, 'aborted', { seen: 10, processed: 4, failed: 0, skipped: 0 });
            assert.equal(store.latestCompletedRun(), null, 'an aborted run was offered as a baseline');

            const failed = store.startRun({ root: '/corpus/failed' });
            store.finishRun(failed, 'failed', { seen: 10, processed: 4, failed: 6, skipped: 0 });
            assert.equal(store.latestCompletedRun(), null, 'a failed run was offered as a baseline');

            const good = store.startRun({ root: '/corpus/good' });
            store.finishRun(good, 'completed', { seen: 10, processed: 10, failed: 0, skipped: 0 });
            assert.equal(store.latestCompletedRun()?.root, '/corpus/good');

            // A later failed run must not shadow the last good one.
            const later = store.startRun({ root: '/corpus/later-failure' });
            store.finishRun(later, 'failed', { seen: 3, processed: 1, failed: 2, skipped: 0 });
            assert.equal(store.latestCompletedRun()?.root, '/corpus/good');
        } finally {
            store.close();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('writes a batch all or nothing', () => {
        const { store, dir } = tempStore();
        try {
            const runId = store.startRun({ root: '/corpus' });
            const good = {
                file: { path: 'ok.eml', size: 10, mtime: 1, sha256: null, status: 'ok' as const, errorCode: null, errorDetail: null, durationMs: 1 },
                message: null
            };
            // A row the driver will reject, after a valid one. A partial write would leave the first
            // file recorded as processed, and a resumed run would skip it forever.
            const bad = { file: { ...good.file, path: 'bad.eml', size: {} as unknown as number }, message: null };

            assert.throws(() => store.writeBatch([good, bad], runId));
            assert.equal(store.queryOne<{ count: number }>('SELECT COUNT(*) AS count FROM files')?.count, 0, 'a failed batch left rows behind');
        } finally {
            store.close();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('opens with a busy timeout so a concurrent reader cannot fail a write', () => {
        const { store, dir } = tempStore();
        try {
            const value = store.queryOne<{ timeout: number }>('PRAGMA busy_timeout');
            assert.ok((value?.timeout ?? 0) >= 1000, `busy_timeout is ${JSON.stringify(value)}`);
        } finally {
            store.close();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('does not double count a resumed run', () => {
        const { store, dir } = tempStore();
        try {
            const runId = store.startRun({ root: '/corpus' });
            const row = {
                file: { path: 'a.eml', size: 10, mtime: 5, sha256: null, status: 'ok' as const, errorCode: null, errorDetail: null, durationMs: 1 },
                message: null
            };
            store.writeBatch([row], runId);

            // Same size and mtime: already done, and a resumed run skips it.
            assert.equal(store.isProcessed('a.eml', 10, 5), true);
            // Changed on disk: processed again, so the record cannot go stale.
            assert.equal(store.isProcessed('a.eml', 11, 5), false);
            assert.equal(store.isProcessed('a.eml', 10, 6), false);

            store.writeBatch([row], runId);
            assert.equal(store.queryOne<{ count: number }>('SELECT COUNT(*) AS count FROM files')?.count, 1, 'a resumed write duplicated a file');
        } finally {
            store.close();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('worker pool restart budget', () => {
    it('gives up rather than respawning a crashing worker forever', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-content-pool-'));
        const workerPath = path.join(dir, 'always-crashes.js');
        // A worker that dies on startup. Without a budget the pool replaces it forever, producing
        // no results, no error and no end.
        fs.writeFileSync(workerPath, 'process.exit(1);\n');
        const pool = new WorkerPool<number, number>({ workerPath, size: 2, taskTimeoutMs: 2000, maxRestarts: 5 });
        try {
            const errors: Error[] = [];
            for (let i = 0; i < 40; i++) {
                try {
                    await pool.submit(i);
                    assert.fail('a crashing worker returned a result');
                } catch (err) {
                    errors.push(err as Error);
                }
            }

            // The first crashes fail their own task; once the budget is spent the pool refuses
            // outright rather than replacing workers forever.
            assert.ok(
                errors.some(err => err instanceof WorkerRestartBudgetError),
                `the budget never tripped: ${[...new Set(errors.map(err => err.name))].join(', ')}`
            );
            assert.equal(errors[errors.length - 1] instanceof WorkerRestartBudgetError, true, 'the pool kept trying after giving up');
            // Every task fails fast rather than waiting out its timeout.
            assert.equal(
                errors.some(err => err.name === 'WorkerTimeoutError'),
                false,
                'a task waited for its timeout instead of failing when its worker died'
            );
        } finally {
            await pool.close();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
