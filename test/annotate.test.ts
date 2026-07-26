import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { annotatableBlocks, annotateBlocks, MAX_BLOCK_CHARS } from '../src/annotate/llm';
import { type CompletionClient, type CompletionRequest } from '../src/annotate/client';
import { renderUserPrompt, RESPONSE_SCHEMA, SYSTEM_PROMPT } from '../src/annotate/prompt';
import { segmentTextBlocks } from '../src/segment/text-blocks';
import { type Label } from '../src/types';

/** A client that records what it was asked and replies with a scripted answer. No network. */
function fakeClient(reply: { index: number; label: Label; confidence: number }[]): CompletionClient & { last: CompletionRequest | null } {
    const client = {
        model: 'test-model',
        last: null as CompletionRequest | null,
        async complete<T>(request: CompletionRequest): Promise<T> {
            client.last = request;
            return { labels: reply } as T;
        }
    };
    return client;
}

const SAMPLE = 'My answer.\n\nOn Mon, 13 Jan 2025 at 09:15, Bob wrote:\n> the question\n> more question\n';

describe('annotator input', () => {
    it('sends only non blank blocks', () => {
        const { blocks } = segmentTextBlocks('one\n\n\n\ntwo', 'TEXT');
        const annotatable = annotatableBlocks(blocks);
        assert.ok(annotatable.length < blocks.length || blocks.every(block => block.content.trim()));
        assert.ok(annotatable.every(block => block.content.trim().length > 0));
    });

    it('includes quote depth for every block', async () => {
        const { blocks } = segmentTextBlocks(SAMPLE, 'TEXT');
        const client = fakeClient(annotatableBlocks(blocks).map(block => ({ index: block.index, label: 'NEW_CONTENT' as Label, confidence: 1 })));
        await annotateBlocks(client, blocks, true);

        assert.ok(client.last);
        // Depth is what stops the annotator reading a quoted greeting as freshly written text.
        assert.match(client.last.user, /quoted depth 1/);
        assert.match(client.last.user, /not quoted/);
    });

    it('never asks the model to produce text', async () => {
        const { blocks } = segmentTextBlocks(SAMPLE, 'TEXT');
        const client = fakeClient([]);
        await annotateBlocks(client, blocks, true);

        assert.ok(client.last);
        assert.equal(client.last.system, SYSTEM_PROMPT);
        assert.deepEqual(client.last.schema, RESPONSE_SCHEMA);

        // The schema must not allow a text field to come back, or the "select, never generate"
        // rule would depend on the model's goodwill rather than on the contract.
        const serialised = JSON.stringify(RESPONSE_SCHEMA);
        assert.ok(!serialised.includes('"text"'));
        assert.ok(!serialised.includes('content'));
        assert.match(serialised, /"index"/);
        assert.match(serialised, /"label"/);
    });

    it('truncates long blocks and says so', () => {
        const long = 'x'.repeat(MAX_BLOCK_CHARS + 500);
        const rendered = renderUserPrompt([{ index: 0, text: `${long.slice(0, MAX_BLOCK_CHARS)}...`, truncated: true, quoteDepth: 0 }], true);
        assert.match(rendered, /truncated/);
    });
});

describe('annotator output validation', () => {
    it('defaults omitted blocks to UNKNOWN rather than dropping them', async () => {
        const { blocks } = segmentTextBlocks(SAMPLE, 'TEXT');
        const annotatable = annotatableBlocks(blocks);
        // Reply about the first block only.
        const client = fakeClient([{ index: annotatable[0]!.index, label: 'NEW_CONTENT', confidence: 0.9 }]);

        const result = await annotateBlocks(client, blocks, true);

        assert.equal(result.labels.length, annotatable.length, 'every sent block must come back labelled');
        assert.equal(result.missing.length, annotatable.length - 1);
        for (const index of result.missing) {
            const label = result.labels.find(item => item.index === index);
            assert.equal(label?.label, 'UNKNOWN');
            assert.equal(label?.confidence, 0);
        }
    });

    it('discards indices the model invented', async () => {
        const { blocks } = segmentTextBlocks(SAMPLE, 'TEXT');
        const annotatable = annotatableBlocks(blocks);
        const client = fakeClient([
            { index: annotatable[0]!.index, label: 'NEW_CONTENT', confidence: 0.9 },
            { index: 9999, label: 'REPLY_HISTORY', confidence: 1 }
        ]);

        const result = await annotateBlocks(client, blocks, true);

        assert.deepEqual(result.spurious, [9999]);
        assert.ok(!result.labels.some(item => item.index === 9999));
    });

    it('ignores a repeated index rather than overwriting', async () => {
        const { blocks } = segmentTextBlocks(SAMPLE, 'TEXT');
        const annotatable = annotatableBlocks(blocks);
        const index = annotatable[0]!.index;
        const client = fakeClient([
            { index, label: 'NEW_CONTENT', confidence: 0.9 },
            { index, label: 'REPLY_HISTORY', confidence: 1 }
        ]);

        const result = await annotateBlocks(client, blocks, true);

        const labels = result.labels.filter(item => item.index === index);
        assert.equal(labels.length, 1);
        assert.equal(labels[0]?.label, 'NEW_CONTENT');
        assert.deepEqual(result.spurious, [index]);
    });

    it('clamps confidence into range', async () => {
        const { blocks } = segmentTextBlocks(SAMPLE, 'TEXT');
        const index = annotatableBlocks(blocks)[0]!.index;
        const client = fakeClient([{ index, label: 'NEW_CONTENT', confidence: 42 }]);

        const result = await annotateBlocks(client, blocks, true);
        assert.equal(result.labels.find(item => item.index === index)?.confidence, 1);
    });

    it('handles a message with nothing to annotate', async () => {
        const { blocks } = segmentTextBlocks('\n\n\n', 'TEXT');
        const client = fakeClient([]);
        const result = await annotateBlocks(client, blocks, false);
        assert.equal(result.labels.length, 0);
        assert.equal(client.last, null, 'no request should be made for an empty message');
    });
});
