import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzeMessage } from '../src/corpus/analyze';
import { selectSample } from '../src/corpus/scanner';
import { CorpusStore } from '../src/corpus/store';
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
