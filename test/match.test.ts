import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildHistoryDocument, matchBlocks, matchedIndices } from '../src/match/history';
import { normaliseForMatch, tokenise, MIN_MATCH_TOKENS } from '../src/match/normalize';
import { buildShingleIndex, containment, CONTAINMENT_THRESHOLD } from '../src/match/shingle';
import { segmentTextBlocks } from '../src/segment/text-blocks';
import { extract } from '../src/index';

const PARENT = [
    'From: Bob <bob@example.net>',
    'To: Alice <alice@example.com>',
    'Subject: Deploy window',
    'Message-ID: <parent@example.net>',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Should we deploy the billing change this afternoon, or wait until the release window on Monday?',
    'The finance team asked for it before the end of the quarter.',
    ''
].join('\n');

describe('normalisation for matching', () => {
    it('folds the transformations a quoted message goes through', () => {
        const original = 'Should we deploy the billing change this afternoon?';
        const quoted = '>  Should we deploy the billing\n>  change this   afternoon?';
        assert.equal(normaliseForMatch(quoted), normaliseForMatch(original));
    });

    it('folds smart punctuation and exotic spaces', () => {
        assert.equal(normaliseForMatch('It’s a “test” — really'), normaliseForMatch('It\'s a "test" - really'));
        assert.equal(normaliseForMatch('a b c'), 'a b c');
    });

    it('does not fold genuinely different text together', () => {
        assert.notEqual(normaliseForMatch('deploy on Monday'), normaliseForMatch('deploy on Tuesday'));
    });

    it('tokenises to words', () => {
        assert.deepEqual(tokenise(normaliseForMatch('Hello, world! 42')), ['hello', 'world', '42']);
    });
});

describe('shingle containment', () => {
    const parent = buildShingleIndex(normaliseForMatch('The quick brown fox jumps over the lazy dog while the cat watches from the windowsill nearby'));

    it('scores a verbatim excerpt as fully contained', () => {
        const block = buildShingleIndex(normaliseForMatch('the quick brown fox jumps over the lazy dog'));
        assert.equal(containment(block, parent).containment, 1);
    });

    it('tolerates a small edit', () => {
        const block = buildShingleIndex(normaliseForMatch('The quick brown fox jumps over the lazy dog while the cat watches from the window nearby'));
        assert.ok(containment(block, parent).containment >= CONTAINMENT_THRESHOLD);
    });

    it('scores unrelated text near zero', () => {
        const block = buildShingleIndex(normaliseForMatch('Kubernetes evicted four pods because the node ran out of memory this morning'));
        assert.ok(containment(block, parent).containment < 0.2);
    });
});

describe('history matching', () => {
    it('matches a quoted block back to the parent message', async () => {
        const history = [await buildHistoryDocument(PARENT, 'parent', true)];
        const reply = [
            'Monday works better for us.',
            '',
            'On Wed, Bob wrote:',
            '> Should we deploy the billing change this afternoon, or wait until the release',
            '> window on Monday?',
            '> The finance team asked for it before the end of the quarter.'
        ].join('\n');

        const { blocks } = segmentTextBlocks(reply, 'TEXT');
        const matches = matchBlocks(blocks, history);

        assert.ok(matches.length > 0, 'expected the quoted block to match the parent');
        assert.ok(matches.every(match => match.isParent));
        assert.ok(matches.every(match => match.containment >= CONTAINMENT_THRESHOLD));

        // The sender's own new line must never match.
        const matchedText = matchedIndices(matches);
        const newBlock = blocks.find(block => block.content.startsWith('Monday works better'));
        assert.ok(newBlock);
        assert.ok(!matchedText.has(newBlock.index), 'new content must not match history');
    });

    it('never matches blocks too short to be meaningful', async () => {
        // "Thanks" appears in half of all threads. Matching on it would hide new content.
        const history = [await buildHistoryDocument(`${PARENT}\nThanks\nBest regards`, 'parent', true)];
        const { blocks } = segmentTextBlocks('Thanks\n\nBest regards', 'TEXT');
        const matches = matchBlocks(blocks, history);
        assert.equal(matches.length, 0);
        assert.ok(MIN_MATCH_TOKENS > 5);
    });

    it('returns nothing when there is no history', () => {
        const { blocks } = segmentTextBlocks('some text that is long enough to be matchable in principle', 'TEXT');
        assert.deepEqual(matchBlocks(blocks, []), []);
    });

    it('raises confidence enough to hide a region that was only collapsed', async () => {
        const reply = [
            'From: Alice <alice@example.com>',
            'To: Bob <bob@example.net>',
            'Subject: Re: Deploy window',
            'Message-ID: <reply@example.com>',
            'In-Reply-To: <parent@example.net>',
            'Content-Type: text/plain; charset=utf-8',
            '',
            'Monday works better for us.',
            '',
            'On Wed, Bob wrote:',
            '> Should we deploy the billing change this afternoon, or wait until the release',
            '> window on Monday?',
            '> The finance team asked for it before the end of the quarter.',
            ''
        ].join('\n');

        const without = await extract(reply);
        const withHistory = await extract(reply, { history: [PARENT] });

        assert.equal(without.historyUsed, false);
        assert.equal(withHistory.historyUsed, true);

        const historySegment = [...withHistory.segments, ...withHistory.hiddenSegments].find(segment => segment.type === 'REPLY_HISTORY');
        assert.ok(historySegment);
        assert.ok(historySegment.reasons.includes('matched_parent_message'));
        assert.ok(historySegment.confidence > 0.9);

        // The sender's own text stays visible either way. That is the property that must not move.
        assert.match(without.segments.map(segment => segment.text).join(' '), /Monday works better/);
        assert.match(withHistory.segments.map(segment => segment.text).join(' '), /Monday works better/);
    });

    it('does not hide new content even when the parent is available', async () => {
        const reply = [
            'From: Alice <alice@example.com>',
            'Message-ID: <reply2@example.com>',
            'In-Reply-To: <parent@example.net>',
            'Content-Type: text/plain; charset=utf-8',
            '',
            'I have thought about the release window and I think we should hold the billing change',
            'until Monday morning so the finance team can review it first.',
            ''
        ].join('\n');

        const result = await extract(reply, { history: [PARENT] });
        assert.equal(result.hiddenSegments.length, 0);
        assert.match(result.segments.map(segment => segment.text).join(' '), /hold the billing change/);
    });
});
