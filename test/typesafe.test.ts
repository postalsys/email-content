import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { annotatableBlocks, annotateBlocksWithTypeSafe, MAX_BLOCK_CHARS, MAX_BLOCKS } from '../src/annotate/llm';
import { applyCostRule, parseStoredProbabilities, probabilityMargin, sanitizeProbabilities, topLabel } from '../src/annotate/probabilities';
import { OpenAIClient, configFromEnv } from '../src/annotate/client';
import {
    TypeSafeClient,
    TypeSafeError,
    typeSafeConfigFromEnv,
    type SystemOneClient,
    type SystemOneRequest,
    type SystemOneResponse
} from '../src/annotate/typesafe-client';
import { blockQuestion, buildState, LABEL_CRITERIA, parseQuestionId, planRequests, questionId, REQUEST_TOKEN_BUDGET } from '../src/annotate/typesafe-prompt';
import { provider, PROVIDERS } from '../src/annotate/providers';
import { type PromptBlock } from '../src/annotate/prompt';
import { segmentTextBlocks } from '../src/segment/text-blocks';
import { LABELS, type Label } from '../src/types';
import { recordingServer } from './helpers';

const SAMPLE = 'My answer.\n\nOn Mon, 13 Jan 2025 at 09:15, Bob wrote:\n> the question\n> more question\n';

type Answer = SystemOneResponse['answers'][string];

/** A client that records every request and answers from a function. No network. */
function fakeClient(answer: (id: string, request: SystemOneRequest) => Answer | undefined): SystemOneClient & { requests: SystemOneRequest[] } {
    const client = {
        model: 'jev-test',
        requests: [] as SystemOneRequest[],
        async ask(request: SystemOneRequest): Promise<SystemOneResponse> {
            client.requests.push(request);
            const answers: SystemOneResponse['answers'] = {};
            for (const id of Object.keys(request.questions)) {
                const value = answer(id, request);
                if (value) {
                    answers[id] = value;
                }
            }
            return { answers };
        }
    };
    return client;
}

function distribution(values: Partial<Record<Label, number>>): Answer {
    return { choice: topLabel(values), probabilities: values, confidence: 0.9 };
}

function promptBlocks(count: number, chars: number): PromptBlock[] {
    return Array.from({ length: count }, (_, i) => ({ index: i * 2, text: 'x'.repeat(chars), truncated: false, quoteDepth: i % 3 }));
}

describe('typesafe questions', () => {
    it('offers exactly the label set, with a boundary for every confusable label', () => {
        assert.deepEqual(Object.keys(LABEL_CRITERIA).sort(), [...LABELS].sort());
        for (const label of LABELS) {
            assert.ok(LABEL_CRITERIA[label].not_this, `${label} states no boundary`);
        }
    });

    it('points one hop at the block by array position', () => {
        const question = blockQuestion(7);
        assert.equal(question.type, 'choice');
        assert.match(JSON.stringify(question.instructions), /`blocks\[7\]`/);
    });

    it('leaves the cost asymmetry and self reported confidence out of the question', () => {
        // The bias is applied in code to an unbiased distribution. Asking for it here as well would
        // apply it twice and make the stored distribution unusable for any other ratio.
        const serialised = JSON.stringify(blockQuestion(0)).toLowerCase();
        assert.ok(!serialised.includes('ten times'));
        assert.ok(!serialised.includes('confidence'));
        assert.ok(!serialised.includes('cost'));
    });

    it('sends the same minimal payload as the OpenAI path and no block index', () => {
        const state = buildState([{ index: 4, text: 'hello', truncated: true, quoteDepth: 2 }], true);
        assert.deepEqual(state, { is_reply: true, blocks: [{ quote_depth: 2, truncated: true, text: 'hello' }] });
    });

    it('asks a small message in one request', () => {
        const blocks = promptBlocks(3, 50);
        const requests = planRequests(blocks, false);
        assert.equal(requests.length, 1);
        assert.deepEqual(Object.keys(requests[0]!.questions), ['b0', 'b2', 'b4']);
        assert.match(JSON.stringify(requests[0]!.questions.b4!.instructions), /`blocks\[2\]`/);
    });

    it('splits a worst case message into requests under the token budget, asking every block once', () => {
        const blocks = promptBlocks(MAX_BLOCKS, MAX_BLOCK_CHARS + 3);
        const requests = planRequests(blocks, true);
        assert.ok(requests.length > 1, 'a 60 block message should not fit one request');

        const asked = requests.flatMap(request => Object.keys(request.questions));
        assert.deepEqual(
            asked,
            blocks.map(block => questionId(block.index))
        );
        for (const request of requests) {
            // Every request carries the whole message: a block cannot be judged without its neighbours.
            assert.equal((request.state as { blocks: unknown[] }).blocks.length, MAX_BLOCKS);
            assert.ok(JSON.stringify(request).length / 2 <= REQUEST_TOKEN_BUDGET, 'request exceeds the estimated budget');
        }
    });

    it('asks nothing for an empty message', () => {
        assert.deepEqual(planRequests([], true), []);
    });

    it('round trips question ids and rejects anything else', () => {
        assert.equal(parseQuestionId(questionId(42)), 42);
        for (const id of ['b', 'bx', '42', 'b4 ', '__proto__', 'constructor', 'b-1']) {
            assert.equal(parseQuestionId(id), null, id);
        }
    });
});

describe('typesafe annotator output validation', () => {
    it('stores the cost rule outcome and keeps the raw distribution', async () => {
        const { blocks } = segmentTextBlocks(SAMPLE, 'TEXT');
        // History is the top choice but not ten times likelier than authored text.
        const client = fakeClient(() => distribution({ REPLY_HISTORY: 0.8, NEW_CONTENT: 0.15, INLINE_QUOTE: 0.05 }));

        const result = await annotateBlocksWithTypeSafe(client, blocks, true);

        assert.equal(result.promptVersion, 'annotate-ts-v1');
        assert.equal(result.model, 'jev-test');
        assert.ok(result.labels.length > 0);
        for (const label of result.labels) {
            assert.equal(label.label, 'NEW_CONTENT');
            assert.deepEqual(label.probabilities, { REPLY_HISTORY: 0.8, NEW_CONTENT: 0.15, INLINE_QUOTE: 0.05 });
            assert.equal(label.confidence, 0.9);
        }
    });

    it('lets a confident history label through', async () => {
        const { blocks } = segmentTextBlocks(SAMPLE, 'TEXT');
        const client = fakeClient(() => distribution({ REPLY_HISTORY: 0.99, NEW_CONTENT: 0.005, INLINE_QUOTE: 0.005 }));
        const result = await annotateBlocksWithTypeSafe(client, blocks, true);
        assert.ok(result.labels.every(label => label.label === 'REPLY_HISTORY'));
    });

    it('defaults an unanswered block to UNKNOWN rather than dropping it', async () => {
        const { blocks } = segmentTextBlocks(SAMPLE, 'TEXT');
        const annotatable = annotatableBlocks(blocks);
        const first = questionId(annotatable[0]!.index);
        const client = fakeClient(id => (id === first ? distribution({ NEW_CONTENT: 1 }) : undefined));

        const result = await annotateBlocksWithTypeSafe(client, blocks, true);

        assert.equal(result.labels.length, annotatable.length);
        assert.equal(result.missing.length, annotatable.length - 1);
        for (const index of result.missing) {
            const label = result.labels.find(item => item.index === index);
            assert.equal(label?.label, 'UNKNOWN');
            assert.equal(label?.confidence, 0);
            assert.equal(label?.probabilities, undefined);
        }
    });

    it('treats an answer without a usable distribution as missing, so it cannot hide anything', async () => {
        const { blocks } = segmentTextBlocks(SAMPLE, 'TEXT');
        const client = fakeClient(() => ({ choice: 'REPLY_HISTORY', probabilities: { BOGUS: 1, REPLY_HISTORY: 'high' }, confidence: 1 }));
        const result = await annotateBlocksWithTypeSafe(client, blocks, true);
        assert.ok(result.labels.every(label => label.label === 'UNKNOWN'));
        assert.equal(result.missing.length, result.labels.length);
    });

    it('discards answers to questions that were never asked', async () => {
        const { blocks } = segmentTextBlocks(SAMPLE, 'TEXT');
        const client: SystemOneClient = {
            model: 'jev-test',
            async ask(request) {
                const answers: SystemOneResponse['answers'] = { b9999: distribution({ REPLY_HISTORY: 1 }), nonsense: distribution({ REPLY_HISTORY: 1 }) };
                for (const id of Object.keys(request.questions)) {
                    answers[id] = distribution({ NEW_CONTENT: 1 });
                }
                return { answers };
            }
        };

        const result = await annotateBlocksWithTypeSafe(client, blocks, true);

        assert.deepEqual(result.spurious.sort(), [-1, 9999]);
        assert.ok(result.labels.every(label => label.label === 'NEW_CONTENT'));
    });

    it('matches answers per request when a message is split', async () => {
        const text = Array.from({ length: MAX_BLOCKS + 5 }, (_, i) => `${i} ${'word '.repeat(150)}`).join('\n\n');
        const { blocks } = segmentTextBlocks(text, 'TEXT');
        const client = fakeClient(() => distribution({ SIGNATURE: 0.7, NEW_CONTENT: 0.3 }));

        const result = await annotateBlocksWithTypeSafe(client, blocks, false);

        assert.ok(client.requests.length > 1);
        assert.equal(result.blocksSent, MAX_BLOCKS);
        assert.equal(result.blocksTotal, MAX_BLOCKS + 5);
        assert.equal(result.labels.length, MAX_BLOCKS);
        assert.deepEqual(result.missing, []);
        assert.deepEqual(result.spurious, []);
    });

    it('makes no request for a message with nothing to annotate', async () => {
        const { blocks } = segmentTextBlocks('\n\n\n', 'TEXT');
        const client = fakeClient(() => distribution({ NEW_CONTENT: 1 }));
        const result = await annotateBlocksWithTypeSafe(client, blocks, false);
        assert.equal(result.labels.length, 0);
        assert.equal(client.requests.length, 0);
    });
});

describe('annotation providers', () => {
    it('registers both providers with their own prompt versions', () => {
        assert.deepEqual(Object.keys(PROVIDERS).sort(), ['openai', 'typesafe']);
        assert.equal(provider('typesafe')?.defaultModel, 'jev-1.13.0');
        assert.equal(provider('typesafe')?.promptVersion, 'annotate-ts-v1');
        assert.notEqual(provider('openai')?.promptVersion, provider('typesafe')?.promptVersion);
    });

    it('does not resolve inherited property names as providers', () => {
        assert.equal(provider('constructor'), null);
        assert.equal(provider('__proto__'), null);
        assert.equal(provider('toString'), null);
    });

    it('fails closed per provider, never falling back to the other', () => {
        const saved = { openai: process.env.OPENAI_API_KEY, typesafe: process.env.TYPESAFE_API_KEY };
        process.env.OPENAI_API_KEY = 'set';
        delete process.env.TYPESAFE_API_KEY;
        try {
            assert.throws(() => provider('typesafe')!.create('jev-1.13.0'), /TYPESAFE_API_KEY/);
            const annotator = provider('openai')!.create('gpt-test');
            assert.equal(annotator.promptVersion, 'annotate-v4');
            assert.deepEqual(annotator.usage, { promptTokens: 0, completionTokens: 0, totalTokens: 0, requests: 0 });
        } finally {
            for (const [name, value] of [
                ['OPENAI_API_KEY', saved.openai],
                ['TYPESAFE_API_KEY', saved.typesafe]
            ] as const) {
                if (value === undefined) {
                    delete process.env[name];
                } else {
                    process.env[name] = value;
                }
            }
        }
    });
});

describe('label probabilities', () => {
    it('keeps only known labels with finite values, clamped', () => {
        assert.deepEqual(sanitizeProbabilities({ NEW_CONTENT: 1.5, SIGNATURE: -1, BOGUS: 0.3, DISCLAIMER: NaN, UNKNOWN: '0.2' }), {
            NEW_CONTENT: 1,
            SIGNATURE: 0
        });
        assert.equal(sanitizeProbabilities({ BOGUS: 1 }), null);
        assert.equal(sanitizeProbabilities(null), null);
        assert.equal(sanitizeProbabilities('NEW_CONTENT'), null);
    });

    it('breaks ties toward the visible side', () => {
        assert.equal(topLabel({ REPLY_HISTORY: 0.5, NEW_CONTENT: 0.5 }), 'NEW_CONTENT');
        assert.equal(topLabel({}), 'NEW_CONTENT');
    });

    it('hides only when history outweighs authored text by the ratio', () => {
        assert.equal(applyCostRule({ REPLY_HISTORY: 0.9, NEW_CONTENT: 0.1 }), 'NEW_CONTENT');
        assert.equal(applyCostRule({ REPLY_HISTORY: 0.95, NEW_CONTENT: 0.05 }), 'REPLY_HISTORY');
        // Authored mass is summed: two small authored probabilities together can keep a block visible.
        assert.equal(applyCostRule({ REPLY_HISTORY: 0.88, NEW_CONTENT: 0.05, INLINE_QUOTE: 0.07 }), 'INLINE_QUOTE');
        assert.equal(applyCostRule({ REPLY_HISTORY: 0.6, SIGNATURE: 0.4 }), 'REPLY_HISTORY');
        assert.equal(applyCostRule({ SIGNATURE: 0.6, NEW_CONTENT: 0.4 }), 'SIGNATURE');
        assert.equal(applyCostRule({ REPLY_HISTORY: 0.9, NEW_CONTENT: 0.1 }, 5), 'REPLY_HISTORY');
    });

    it('measures ambiguity as the gap between the top two labels', () => {
        assert.equal(probabilityMargin({ NEW_CONTENT: 0.5, REPLY_HISTORY: 0.5 }), 0);
        assert.ok(Math.abs(probabilityMargin({ SIGNATURE: 0.1, NEW_CONTENT: 0.7, REPLY_HISTORY: 0.2 }) - 0.5) < 1e-9);
        assert.equal(probabilityMargin({ NEW_CONTENT: 1 }), 1);
    });

    it('reads stored JSON defensively', () => {
        assert.deepEqual(parseStoredProbabilities('{"NEW_CONTENT":0.4}'), { NEW_CONTENT: 0.4 });
        assert.equal(parseStoredProbabilities('{not json'), null);
        assert.equal(parseStoredProbabilities(null), null);
        assert.equal(parseStoredProbabilities(''), null);
    });
});

/** Replays scripted responses in order, repeating the last one. */
function scriptedServer(script: { status: number; body: unknown }[]) {
    return recordingServer((_request, count) => script[Math.min(count, script.length) - 1]!);
}

const FAST_RETRY = { timeoutMs: 5000, maxRetries: 2 };

describe('TypeSafe client', () => {
    const saved = { key: process.env.TYPESAFE_API_KEY, url: process.env.TYPESAFE_BASE_URL };
    after(() => {
        for (const [name, value] of [
            ['TYPESAFE_API_KEY', saved.key],
            ['TYPESAFE_BASE_URL', saved.url]
        ] as const) {
            if (value === undefined) {
                delete process.env[name];
            } else {
                process.env[name] = value;
            }
        }
    });

    it('fails closed without an API key', () => {
        delete process.env.TYPESAFE_API_KEY;
        assert.throws(() => typeSafeConfigFromEnv('jev-1.13.0'), /TYPESAFE_API_KEY is not set/);
    });

    it('reads key and base URL from the environment', () => {
        process.env.TYPESAFE_API_KEY = 'k';
        process.env.TYPESAFE_BASE_URL = 'http://127.0.0.1:1';
        const config = typeSafeConfigFromEnv('jev-1.13.0', { maxRetries: 1 });
        assert.equal(config.apiKey, 'k');
        assert.equal(config.baseUrl, 'http://127.0.0.1:1');
        assert.equal(config.maxRetries, 1);
        delete process.env.TYPESAFE_BASE_URL;
        assert.equal(typeSafeConfigFromEnv('jev-1.13.0').baseUrl, 'https://api.typesafe.ai/v1');
    });

    it('posts model, state and questions and records usage', async () => {
        const server = await scriptedServer([
            { status: 200, body: { model: 'jev-1.13.0', answers: { b0: { choice: 'NEW_CONTENT' } }, usage: { input_tokens: 1200, output_tokens: 3 } } }
        ]);
        try {
            const client = new TypeSafeClient({ apiKey: 'secret', baseUrl: server.url, model: 'jev-1.13.0', ...FAST_RETRY });
            const request = planRequests(promptBlocks(1, 10), true)[0]!;
            const response = await client.ask(request);

            assert.deepEqual(response.answers, { b0: { choice: 'NEW_CONTENT' } });
            assert.equal(server.requests[0]!.url, '/systemone');
            assert.equal(server.requests[0]!.authorization, 'Bearer secret');
            assert.deepEqual(Object.keys(server.requests[0]!.body).sort(), ['model', 'questions', 'state']);
            assert.equal(server.requests[0]!.body.model, 'jev-1.13.0');
            assert.deepEqual(client.usage, { promptTokens: 1200, completionTokens: 3, totalTokens: 1203, requests: 1 });
        } finally {
            await server.close();
        }
    });

    it('retries overload and rate limits', async () => {
        const server = await scriptedServer([
            { status: 529, body: { error: 'overloaded' } },
            { status: 429, body: 'not json' },
            { status: 200, body: { answers: {} } }
        ]);
        try {
            const client = new TypeSafeClient({ apiKey: 'k', baseUrl: server.url, model: 'jev-1.13.0', ...FAST_RETRY });
            assert.deepEqual(await client.ask({ state: {}, questions: {} }), { answers: {} });
            assert.equal(server.requests.length, 3);
        } finally {
            await server.close();
        }
    });

    it('does not retry a rejected request, and never surfaces the response body', async () => {
        const server = await scriptedServer([{ status: 422, body: { detail: 'state.blocks[0].text: PRIVATE MAIL TEXT' } }]);
        try {
            const client = new TypeSafeClient({ apiKey: 'k', baseUrl: server.url, model: 'jev-1.13.0', ...FAST_RETRY });
            await assert.rejects(
                () => client.ask({ state: {}, questions: {} }),
                (err: unknown) => err instanceof TypeSafeError && err.status === 422 && !err.message.includes('PRIVATE') && err.message === 'TypeSafe HTTP 422'
            );
            assert.equal(server.requests.length, 1);
        } finally {
            await server.close();
        }
    });

    it('rejects a response without answers without retrying', async () => {
        const server = await scriptedServer([{ status: 200, body: { model: 'jev-1.13.0' } }]);
        try {
            const client = new TypeSafeClient({ apiKey: 'k', baseUrl: server.url, model: 'jev-1.13.0', ...FAST_RETRY });
            await assert.rejects(() => client.ask({ state: {}, questions: {} }), /no answers/);
            assert.equal(server.requests.length, 1);
            assert.equal(client.usage.requests, 0);
        } finally {
            await server.close();
        }
    });

    it('gives up after the retry budget', async () => {
        const server = await scriptedServer([{ status: 503, body: {} }]);
        try {
            const client = new TypeSafeClient({ apiKey: 'k', baseUrl: server.url, model: 'jev-1.13.0', ...FAST_RETRY });
            await assert.rejects(() => client.ask({ state: {}, questions: {} }), /HTTP 503/);
            assert.equal(server.requests.length, FAST_RETRY.maxRetries + 1);
        } finally {
            await server.close();
        }
    });
});

describe('OpenAI client on the shared retry loop', () => {
    it('fails closed without an API key', () => {
        const saved = process.env.OPENAI_API_KEY;
        delete process.env.OPENAI_API_KEY;
        try {
            assert.throws(() => configFromEnv('gpt-5.6-sol'), /OPENAI_API_KEY is not set/);
        } finally {
            if (saved !== undefined) {
                process.env.OPENAI_API_KEY = saved;
            }
        }
    });

    it('retries a server error, then parses the structured completion', async () => {
        const server = await scriptedServer([
            { status: 500, body: {} },
            {
                status: 200,
                body: { choices: [{ message: { content: '{"labels":[]}' } }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }
            }
        ]);
        try {
            const client = new OpenAIClient({ apiKey: 'k', baseUrl: server.url, model: 'gpt-test', ...FAST_RETRY });
            const result = await client.complete<{ labels: unknown[] }>({ system: 's', user: 'u', schemaName: 'x', schema: {} });
            assert.deepEqual(result, { labels: [] });
            assert.equal(server.requests.length, 2);
            assert.equal(server.requests[1]!.url, '/chat/completions');
            assert.deepEqual(client.usage, { promptTokens: 10, completionTokens: 2, totalTokens: 12, requests: 1 });
        } finally {
            await server.close();
        }
    });

    it('surfaces the provider error message on a rejected request', async () => {
        const server = await scriptedServer([{ status: 400, body: { error: { message: 'bad schema' } } }]);
        try {
            const client = new OpenAIClient({ apiKey: 'k', baseUrl: server.url, model: 'gpt-test', ...FAST_RETRY });
            await assert.rejects(() => client.complete({ system: 's', user: 'u', schemaName: 'x', schema: {} }), /bad schema/);
            assert.equal(server.requests.length, 1);
        } finally {
            await server.close();
        }
    });

    it('does not retry a truncated completion', async () => {
        const server = await scriptedServer([{ status: 200, body: { choices: [{ finish_reason: 'length', message: { content: '{' } }] } }]);
        try {
            const client = new OpenAIClient({ apiKey: 'k', baseUrl: server.url, model: 'gpt-test', ...FAST_RETRY });
            await assert.rejects(() => client.complete({ system: 's', user: 'u', schemaName: 'x', schema: {} }), /truncated/);
            assert.equal(server.requests.length, 1);
        } finally {
            await server.close();
        }
    });
});
