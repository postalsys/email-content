import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { blockKey, compareAnnotators, type AnnotatedBlock } from '../src/annotate/agreement';
import { startAnnotationRun, writeAnnotations, finishAnnotationRun } from '../src/annotate/store';
import { parseSpec } from '../src/cli/agreement';
import { analyzeMessage } from '../src/corpus/analyze';
import { CorpusStore } from '../src/corpus/store';
import { parseMessage } from '../src/mime/parse';
import { type Label } from '../src/types';
import { fixturePath, readFixture, recordingServer, SQLITE_SUITE } from './helpers';

function block(overrides: Partial<AnnotatedBlock> & { label: Label }): AnnotatedBlock {
    return {
        path: 'a.eml',
        representation: 'html',
        blockIndex: 0,
        mimePart: '1',
        blockStart: 0,
        blockEnd: 10,
        charCount: 10,
        probabilities: null,
        lang: 'en',
        ...overrides
    };
}

describe('annotator agreement', () => {
    it('parses model@version specs', () => {
        assert.deepEqual(parseSpec('gpt-5.6-sol@annotate-v4'), { name: 'gpt-5.6-sol@annotate-v4', model: 'gpt-5.6-sol', promptVersion: 'annotate-v4' });
        assert.deepEqual(parseSpec('jev-1.13.0'), { name: 'jev-1.13.0', model: 'jev-1.13.0', promptVersion: null });
        assert.equal(parseSpec('m@').promptVersion, null);
    });

    it('counts agreement, both cost directions and the consensus gate', () => {
        const candidate = [
            block({ blockIndex: 0, label: 'NEW_CONTENT', charCount: 5 }),
            block({ blockIndex: 1, label: 'REPLY_HISTORY', charCount: 7, lang: 'et' }),
            block({ blockIndex: 2, label: 'NEW_CONTENT', charCount: 11 }),
            block({ blockIndex: 3, label: 'REPLY_HISTORY', charCount: 13 })
        ];
        const strongA = [
            block({ blockIndex: 0, label: 'NEW_CONTENT' }),
            block({ blockIndex: 1, label: 'NEW_CONTENT', lang: 'et' }),
            block({ blockIndex: 2, label: 'REPLY_HISTORY' }),
            block({ blockIndex: 3, label: 'INLINE_QUOTE' })
        ];
        const strongB = [block({ blockIndex: 0, label: 'NEW_CONTENT' }), block({ blockIndex: 1, label: 'INLINE_QUOTE', lang: 'et' })];

        const report = compareAnnotators(candidate, [
            { name: 'a', blocks: strongA },
            { name: 'b', blocks: strongB }
        ]);

        assert.equal(report.candidateBlocks, 4);
        assert.equal(report.unmatched, 0);
        const [a, b] = report.references;
        assert.equal(a!.shared, 4);
        assert.equal(a!.agreed, 1);
        assert.equal(a!.agreedChars, 5);
        assert.equal(a!.sharedChars, 36);
        assert.deepEqual(a!.expensive, { blocks: 2, chars: 20 });
        assert.deepEqual(a!.cheap, { blocks: 1, chars: 11 });
        assert.deepEqual(
            a!.perLang.find(item => item.lang === 'et'),
            { lang: 'et', shared: 1, agreed: 0 }
        );
        assert.equal(b!.shared, 2);
        // Only block 1 is labelled by both references, and both call it authored.
        assert.deepEqual(report.consensusExpensive, { blocks: 1, chars: 7, shared: 2 });
    });

    it('never pairs blocks whose offsets differ', () => {
        const report = compareAnnotators(
            [block({ label: 'NEW_CONTENT', blockStart: 0, blockEnd: 10 })],
            [{ name: 'r', blocks: [block({ label: 'NEW_CONTENT', blockStart: 0, blockEnd: 12 })] }]
        );
        assert.equal(report.unmatched, 1);
        assert.equal(report.references[0]!.shared, 0);
    });

    it('takes the latest label per block', () => {
        const report = compareAnnotators(
            [block({ label: 'REPLY_HISTORY' }), block({ label: 'NEW_CONTENT' })],
            [{ name: 'r', blocks: [block({ label: 'NEW_CONTENT' })] }]
        );
        assert.equal(report.candidateBlocks, 1);
        assert.equal(report.references[0]!.agreed, 1);
    });

    it('re-applies the cost rule to stored distributions', () => {
        const candidate = [
            block({ blockIndex: 0, label: 'NEW_CONTENT', probabilities: { REPLY_HISTORY: 0.8, NEW_CONTENT: 0.2 } }),
            block({ blockIndex: 1, label: 'SIGNATURE' })
        ];
        const reference = [block({ blockIndex: 0, label: 'REPLY_HISTORY' }), block({ blockIndex: 1, label: 'SIGNATURE' })];

        assert.equal(compareAnnotators(candidate, [{ name: 'r', blocks: reference }]).references[0]!.agreed, 1);
        const rescored = compareAnnotators(candidate, [{ name: 'r', blocks: reference }], 1);
        assert.equal(rescored.rescored, 1);
        assert.equal(rescored.references[0]!.agreed, 2);
    });

    it('keys blocks by path, part and offsets', () => {
        assert.notEqual(blockKey(block({ label: 'UNKNOWN', path: 'a' })), blockKey(block({ label: 'UNKNOWN', path: 'b' })));
        assert.notEqual(blockKey(block({ label: 'UNKNOWN', mimePart: '1' })), blockKey(block({ label: 'UNKNOWN', mimePart: '2' })));
    });
});

const CLI = path.join(__dirname, '..', 'src', 'cli', 'main.js');

function runCli(args: string[], env: Record<string, string | undefined> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise(resolve => {
        execFile(
            process.execPath,
            ['--no-warnings', CLI, ...args],
            { env: { PATH: process.env.PATH, ...env }, cwd: os.tmpdir(), encoding: 'utf8' },
            (err, stdout, stderr) => {
                resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr });
            }
        );
    });
}

/**
 * A stand-in TypeSafe endpoint. Answers every question: blocks with an even index get a confident
 * history distribution, odd ones an ambiguous one that the cost rule must keep visible.
 */
function typeSafeServer() {
    return recordingServer(request => {
        const answers: Record<string, unknown> = {};
        for (const id of Object.keys(request.body.questions as Record<string, unknown>)) {
            const even = Number(id.slice(1)) % 2 === 0;
            const probabilities = even ? { REPLY_HISTORY: 0.99, NEW_CONTENT: 0.01 } : { REPLY_HISTORY: 0.6, NEW_CONTENT: 0.35, SIGNATURE: 0.05 };
            answers[id] = { type: 'choice', choice: 'REPLY_HISTORY', probabilities, confidence: even ? 0.95 : 0.4 };
        }
        return { status: 200, body: { model: request.body.model, answers, usage: { input_tokens: 1000, output_tokens: 0 } } };
    });
}

describe('annotator commands', SQLITE_SUITE, () => {
    const FIXTURES = ['gmail-top-post.eml', 'plain-inline-reply.eml'];
    let dir: string;
    let db: string;
    let pathsFile: string;

    before(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-content-annotate-'));
        db = path.join(dir, 'corpus.sqlite');
        pathsFile = path.join(dir, 'paths.txt');
        fs.writeFileSync(pathsFile, `${FIXTURES.join('\n')}\n`);

        const store = new CorpusStore(db);
        const root = path.dirname(fixturePath(FIXTURES[0]!));
        const runId = store.startRun({ root });
        const rows = [];
        for (const name of FIXTURES) {
            const message = analyzeMessage(await parseMessage(readFixture(name)), 'salt');
            rows.push({
                file: { path: name, size: 1, mtime: 1, sha256: null, status: 'ok' as const, errorCode: null, errorDetail: null, durationMs: 1 },
                message: { ...message, isReply: true, traffic: 'human' as const }
            });
        }
        store.writeBatch(rows, runId);
        store.finishRun(runId, 'completed', { seen: 2, processed: 2, failed: 0, skipped: 0 });
        store.close();
    });

    after(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('rejects an unknown provider', async () => {
        const result = await runCli(['annotate', '--db', db, '--provider', 'nope', '--env', 'missing.env']);
        assert.equal(result.code, 2);
        assert.match(result.stderr, /unknown provider: nope/);
    });

    it('fails closed without a TypeSafe key and records nothing', async () => {
        const result = await runCli(['annotate', '--db', db, '--provider', 'typesafe', '--env', 'missing.env']);
        assert.equal(result.code, 2);
        assert.match(result.stderr, /TYPESAFE_API_KEY is not set/);
        const store = new CorpusStore(db);
        try {
            assert.equal(store.queryOne<{ count: number }>('SELECT COUNT(*) AS count FROM annotation_runs')?.count, 0);
        } finally {
            store.close();
        }
    });

    it('annotates with TypeSafe, stores distributions, and resumes per prompt version', async () => {
        const server = await typeSafeServer();
        const env = { TYPESAFE_API_KEY: 'test-key', TYPESAFE_BASE_URL: server.url };
        try {
            const first = await runCli(
                ['annotate', '--db', db, '--provider', 'typesafe', '--paths', pathsFile, '--concurrency', '1', '--env', 'missing.env'],
                env
            );
            assert.equal(first.code, 0, first.stderr);
            assert.match(first.stderr, /jev-1\.13\.0 \(typesafe, annotate-ts-v1\)/);
            assert.match(first.stderr, /per message: \d+ prompt tokens/);
            assert.ok(server.requests.length >= FIXTURES.length);
            assert.ok(server.requests.every(request => request.body.model === 'jev-1.13.0'));

            const store = new CorpusStore(db);
            try {
                const run = store.queryOne<{ model: string; prompt_version: string; messages: number; prompt_tokens: number }>(
                    'SELECT model, prompt_version, messages, prompt_tokens FROM annotation_runs'
                );
                assert.equal(run?.model, 'jev-1.13.0');
                assert.equal(run?.prompt_version, 'annotate-ts-v1');
                assert.equal(run?.messages, FIXTURES.length);
                assert.equal(run?.prompt_tokens, 1000 * server.requests.length);

                const labels = store.query<{ block_index: number; label: string; probabilities: string | null; margin: number | null }>(
                    'SELECT block_index, label, probabilities, margin FROM annotations'
                );
                assert.ok(labels.length > 0);
                for (const row of labels) {
                    assert.ok(row.probabilities, 'distribution not stored');
                    assert.ok(Math.abs((row.margin ?? -1) - (row.block_index % 2 === 0 ? 0.98 : 0.25)) < 1e-9, 'margin not stored');
                    // Even blocks were confident history; odd ones must have been kept visible.
                    assert.equal(row.label, row.block_index % 2 === 0 ? 'REPLY_HISTORY' : 'NEW_CONTENT');
                }
            } finally {
                store.close();
            }

            const requestsBefore = server.requests.length;
            const again = await runCli(['annotate', '--db', db, '--provider', 'typesafe', '--paths', pathsFile, '--env', 'missing.env'], env);
            assert.equal(again.code, 1);
            assert.match(again.stderr, /nothing to annotate/);
            assert.equal(server.requests.length, requestsBefore, 'a resumed run asked again');
        } finally {
            await server.close();
        }
    });

    it('compares the TypeSafe run against a reference annotator', async () => {
        // A reference that calls every block authored, so every confident history label from the
        // candidate lands in the expensive direction.
        const store = new CorpusStore(db);
        let candidateBlocks: number;
        try {
            const rows = store.query<{
                path: string;
                representation: 'text' | 'html';
                block_index: number;
                mime_part: string;
                block_start: number;
                block_end: number;
                char_count: number;
            }>("SELECT path, representation, block_index, mime_part, block_start, block_end, char_count FROM annotations WHERE source = 'llm'");
            candidateBlocks = rows.length;
            const runId = startAnnotationRun(store, { source: 'llm', model: 'ref-model', promptVersion: 'annotate-v4' });
            writeAnnotations(
                store,
                runId,
                rows.map(row => ({
                    path: row.path,
                    representation: row.representation,
                    blockIndex: row.block_index,
                    mimePart: row.mime_part,
                    blockStart: row.block_start,
                    blockEnd: row.block_end,
                    charCount: row.char_count,
                    source: 'llm' as const,
                    label: 'NEW_CONTENT' as const,
                    confidence: 0.9,
                    baselineLabel: null,
                    baselineConfidence: null,
                    baselineReasons: []
                }))
            );
            finishAnnotationRun(store, runId, { messages: 2, blocks: rows.length, failures: 0, promptTokens: 0, completionTokens: 0 });
            assert.equal(
                store.queryOne<{ count: number }>('SELECT COUNT(*) AS count FROM annotations WHERE probabilities IS NULL AND margin IS NULL')?.count,
                rows.length
            );
        } finally {
            store.close();
        }

        const result = await runCli(['agreement', '--db', db, '--candidate', 'jev-1.13.0@annotate-ts-v1', '--reference', 'ref-model@annotate-v4', '--json']);
        assert.equal(result.code, 0, result.stderr);
        const report = JSON.parse(result.stdout) as {
            candidateBlocks: number;
            references: { shared: number; agreed: number; expensive: { blocks: number } }[];
            consensusExpensive: { blocks: number };
            cost: { messages: number };
        };
        assert.equal(report.candidateBlocks, candidateBlocks);
        assert.equal(report.references[0]!.shared, candidateBlocks);
        const hidden = report.references[0]!.expensive.blocks;
        assert.ok(hidden > 0);
        assert.equal(report.references[0]!.agreed, candidateBlocks - hidden);
        assert.equal(report.consensusExpensive.blocks, hidden);
        assert.equal(report.cost.messages, FIXTURES.length);

        // A lenient ratio hides the ambiguous blocks too.
        const lenient = await runCli([
            'agreement',
            '--db',
            db,
            '--candidate',
            'jev-1.13.0@annotate-ts-v1',
            '--reference',
            'ref-model@annotate-v4',
            '--cost-ratio',
            '1'
        ]);
        assert.equal(lenient.code, 0, lenient.stderr);
        assert.match(lenient.stdout, /cost rule re-applied at ratio 1/);
        assert.match(lenient.stdout, new RegExp(`GATE[^\\n]*\\n  ${candidateBlocks} blocks`));
    });

    it('rejects an incomplete agreement request', async () => {
        assert.equal((await runCli(['agreement', '--db', db, '--candidate', 'x'])).code, 2);
        assert.equal((await runCli(['agreement', '--db', path.join(dir, 'none.sqlite'), '--candidate', 'x', '--reference', 'y'])).code, 2);
        const empty = await runCli(['agreement', '--db', db, '--candidate', 'nobody@v', '--reference', 'ref-model']);
        assert.equal(empty.code, 1);
        assert.match(empty.stderr, /no annotations found for nobody@v/);
    });

    it('sorts disagreements by probability margin', async () => {
        const result = await runCli(['disagreements', '--db', db, '--direction', 'all', '--sort', 'margin', '--model', 'jev-1.13.0', '--limit', '50']);
        assert.equal(result.code, 0, result.stderr);
        assert.match(result.stdout, /most ambiguous first/);
        const margins = [...result.stdout.matchAll(/margin (\d\.\d\d)/g)].map(match => Number(match[1]));
        assert.ok(margins.length > 0, 'no distribution shown');
        assert.deepEqual(
            margins,
            [...margins].sort((a, b) => a - b)
        );

        const bad = await runCli(['disagreements', '--db', db, '--sort', 'sideways']);
        assert.equal(bad.code, 2);
        assert.match(bad.stderr, /unknown sort/);
    });
});
