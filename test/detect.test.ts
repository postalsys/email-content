import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fingerprintClient } from '../src/detect/client';
import { loadPatterns } from '../src/detect/patterns';
import { classifyTraffic } from '../src/detect/traffic';
import { type HeaderEntry, type MessageHeaders } from '../src/mime/model';

function headers(overrides: Partial<MessageHeaders> = {}): MessageHeaders {
    return {
        messageId: null,
        inReplyTo: null,
        references: [],
        from: null,
        to: null,
        cc: null,
        date: null,
        dateMs: null,
        subject: null,
        contentType: null,
        userAgent: null,
        xMailer: null,
        listId: null,
        listUnsubscribe: null,
        precedence: null,
        autoSubmitted: null,
        ...overrides
    };
}

function entries(pairs: readonly [string, string][]): HeaderEntry[] {
    return pairs.map(([key, value]) => ({ key, value, decoded: value }));
}

describe('pattern sets', () => {
    it('compiles every bundled pattern', () => {
        const patterns = loadPatterns();
        assert.deepEqual(patterns.invalid, []);
        assert.ok(patterns.replyHeaders.length > 10);
        assert.ok(patterns.forwardHeaders.length > 3);
        assert.ok(patterns.htmlSelectors.length > 10);
    });

    it('matches attribution lines in several languages', () => {
        const patterns = loadPatterns();
        const cases = [
            'On Mon, Jan 13, 2025 at 9:15 AM Bob Example <bob@example.net> wrote:',
            'Le 13 janvier 2025 à 09:15, Bob <bob@example.net> a écrit :',
            'Am 13.01.2025 um 09:15 schrieb Bob:',
            'El 13 ene 2025, a las 9:15, Bob escribió:',
            'Bob Example <bob@example.net> kirjutas:',
            '-----Original Message-----'
        ];
        for (const line of cases) {
            const matched = patterns.replyHeaders.some(pattern => pattern.regex.test(line));
            assert.ok(matched, `no reply pattern matched: ${line}`);
        }
    });

    it('matches forward markers', () => {
        const patterns = loadPatterns();
        for (const line of ['Begin forwarded message:', '---------- Forwarded message ---------', '-------- Weitergeleitete Nachricht --------']) {
            assert.ok(
                patterns.forwardHeaders.some(pattern => pattern.regex.test(line)),
                `no forward pattern matched: ${line}`
            );
        }
    });

    it('does not match ordinary prose with a reply-header pattern', () => {
        const patterns = loadPatterns();
        // These read like attribution lines but are not, and a false positive here hides real text.
        const prose = ['I wrote a long report yesterday.', 'On the whole this looks fine to me.', 'The original message was lost.'];
        for (const line of prose) {
            const strong = patterns.replyHeaders.filter(pattern => pattern.strength >= 0.9).some(pattern => pattern.regex.test(line));
            assert.equal(strong, false, `high confidence pattern matched prose: ${line}`);
        }
    });
});

describe('fingerprintClient', () => {
    it('identifies Gmail from the Message-ID domain', () => {
        const result = fingerprintClient(headers({ messageId: 'caf8xyz@mail.gmail.com' }), null, null);
        assert.equal(result.client, 'gmail');
        assert.equal(result.source, 'message-id');
    });

    it('prefers the agent when it refines the provider', () => {
        const result = fingerprintClient(headers({ messageId: 'abc@AM0PR01MB1234.eurprd01.prod.outlook.com', xMailer: 'Outlook for iOS' }), null, null);
        assert.equal(result.client, 'outlook-mobile');
    });

    it('falls back to HTML structure only when nothing stronger exists', () => {
        const result = fingerprintClient(headers({ messageId: 'plain@example.com' }), '<div class="gmail_quote">x</div>', null);
        assert.equal(result.client, 'gmail');
        assert.equal(result.source, 'html');
    });

    it('returns unknown rather than guessing', () => {
        const result = fingerprintClient(headers({ messageId: 'plain@example.com' }), '<p>hello</p>', null);
        assert.equal(result.client, 'unknown');
        assert.equal(result.confidence, 0);
    });
});

describe('classifyTraffic', () => {
    it('classifies a plain person to person message as human', () => {
        const result = classifyTraffic(headers({ from: 'Alice <alice@example.com>', messageId: 'a@b' }), entries([['from', 'alice@example.com']]));
        assert.equal(result.traffic, 'human');
    });

    it('classifies ticketing systems ahead of their list headers', () => {
        const result = classifyTraffic(
            headers({ from: 'notifications@github.com', listId: 'repo <repo.github.com>', messageId: 'x@github.com' }),
            entries([
                ['x-github-recipient', 'someone'],
                ['list-id', 'repo <repo.github.com>']
            ])
        );
        assert.equal(result.traffic, 'ticketing');
    });

    it('classifies mailing lists', () => {
        const result = classifyTraffic(
            headers({ from: 'someone@example.org', listId: 'dev <dev.example.org>' }),
            entries([['list-id', 'dev <dev.example.org>']])
        );
        assert.equal(result.traffic, 'mailing-list');
    });

    it('classifies marketing mail as bulk', () => {
        const result = classifyTraffic(
            headers({ from: 'news@shop.example', listUnsubscribe: '<https://shop.example/u>' }),
            entries([['list-unsubscribe', '<x>']])
        );
        assert.equal(result.traffic, 'bulk');
    });

    it('classifies no-reply senders as notifications', () => {
        const result = classifyTraffic(headers({ from: 'no-reply@service.example', messageId: 'x@y' }), entries([]));
        assert.equal(result.traffic, 'notification');
    });

    it('does not misclassify a person whose name contains "reply"', () => {
        const result = classifyTraffic(headers({ from: 'Ripley Scott <ripley@example.com>', messageId: 'x@y' }), entries([]));
        assert.equal(result.traffic, 'human');
    });
});
