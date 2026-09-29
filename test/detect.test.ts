import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fingerprintClient } from '../src/detect/client';
import { detectAttributionLine } from '../src/detect/reply-header';
import { assertPatternsLoaded, countPatterns, loadPatterns, patternSource, resetPatternCache } from '../src/detect/patterns';
import * as publicApi from '../src/index';
import { classifyTraffic } from '../src/detect/traffic';
import { type HeaderEntry, type MessageHeaders } from '../src/mime/model';

/**
 * Run fn with EMAIL_CONTENT_PATTERNS set to value (unset for undefined) and a fresh pattern cache,
 * then restore both, so a failing assertion cannot leak an override into later tests.
 */
function withPatternsEnv(value: string | undefined, fn: () => void): void {
    const saved = process.env.EMAIL_CONTENT_PATTERNS;
    const set = (next: string | undefined) => {
        if (next === undefined) {
            delete process.env.EMAIL_CONTENT_PATTERNS;
        } else {
            process.env.EMAIL_CONTENT_PATTERNS = next;
        }
    };
    set(value);
    resetPatternCache();
    try {
        fn();
    } finally {
        set(saved);
        resetPatternCache();
    }
}

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

describe('pattern loading is fail loud', () => {
    it('throws when nothing loaded, so a packaging failure cannot pass silently', () => {
        const empty = {
            replyHeaders: [],
            forwardHeaders: [],
            quotedHeaderFields: [],
            inlineAnnouncements: [],
            signatureDelimiters: [],
            signaturePhrases: [],
            disclaimerPhrases: [],
            htmlSelectors: [],
            invalid: []
        };
        assert.equal(countPatterns(empty), 0);
        assert.throws(() => assertPatternsLoaded(empty, '/somewhere'), /No detector patterns could be loaded/);
    });

    it('accepts the bundled set', () => {
        const patterns = loadPatterns();
        assert.ok(countPatterns(patterns) > 50);
        assert.doesNotThrow(() => assertPatternsLoaded(patterns, 'bundled'));
    });

    it('falls back to the bundled files when an override directory lacks them', () => {
        // The override is per file by design, so a directory containing only some replacements
        // still gets the rest from the bundle.
        const patterns = loadPatterns('/nonexistent/pattern/directory');
        assert.ok(patterns.replyHeaders.length > 0);
        resetPatternCache();
    });

    it('reports the bundled source when no override is set', () => {
        withPatternsEnv(undefined, () => {
            assert.deepEqual(patternSource(), { override: null, overriddenFiles: [] });
            assert.equal(publicApi.patternSource, patternSource);
        });
    });

    it('reports the override directory and which files it actually replaced', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-content-patterns-'));
        try {
            fs.writeFileSync(
                path.join(dir, 'signatures.json'),
                JSON.stringify({ delimiters: [{ id: 'test-delimiter', pattern: '^--override--$', strength: 0.9 }], phrases: [] })
            );
            withPatternsEnv(dir, () => {
                const patterns = loadPatterns();
                assert.deepEqual(
                    patterns.signatureDelimiters.map(p => p.id),
                    ['test-delimiter']
                );
                // Files the directory does not hold still come from the bundle.
                assert.ok(patterns.replyHeaders.length > 0);
                assert.deepEqual(patternSource(), { override: dir, overriddenFiles: ['signatures.json'] });
            });
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('attribution lines captured from real clients', () => {
    // Each line is what a real client wrote above quoted history, from test/fixtures/clients.
    // Every one was left unrecognised before, so the quoted reply stayed visible.
    const captured = [
        'El 2026-09-29 13:55, Marta Kask va escriure:',
        'O 2026-09-29 11:46, Marta Kask escribiu:',
        'Më 2026-09-29 12:36, Marta Kask shkroi:',
        'На 2026-09-29 12:28, Marta Kask написа:',
        'На $дата,$праќач напиша:',
        'Dana 2026-09-29 12:31, Marta Kask je napisao(la):',
        'Marta Kask напісаў 2026-09-29 12:28:',
        'Στις 2026-09-29 11:47, Marta Kask έγραψε:',
        '2026-09-29 11:43 egunean, Marta Kask-(e)k idatzi du:',
        'Marta Kask kirjoitti 2026-09-29 12:15:',
        'Marta Kask schreef op 2026-09-29 11:46:',
        '"Marta Kask" <marta.kask@example.com> skrev 29. september 2026 kl. 10:10:',
        '2026-09-29 11:47 időpontban Marta Kask ezt írta:',
        'Pada 2026-09-29 11:47, Marta Kask menulis:',
        '2026-09-29 12:33 に Marta Kask さんは書きました:',
        '2026-09-29 11:46-ში, Marta Kask დაწერა:',
        'កាលពី\u200bថ្ងៃ 2026-09-29 12:33, Marta Kask បាន\u200bសរសេរ៖',
        'Marta Kask @ 2026-09-29 12:35 rakstīja:',
        '2026-09-29 11:50, je Marta Kask napisal',
        'Vào ngày 2026-09-29 12:27, Marta Kask viết:',
        'كتب Marta Kask في 2026-09-29 11:43:',
        ':כתב Marta Kask, 2026-09-29 12:30 בתאריך',
        'Op 2026-09-29 13:56, skreau Marta Kask:',
        '29 września 2026 10:11, "Marta Kask" <marta.kask@example.com> napisał/-a/:',
        '2026年9月29日 10:18, "Marta Kask" <marta.kask@example.com> 写到:',
        '۷ مهر ۱۴۰۵ ساعت ۱۰:۰۳, "Marta Kask" <marta.kask@example.com> نوشت:',
        'Am Tue, 29 Sep 2026 08:09:34 +0000Marta Kask marta.kask@example.com sagte'
    ];

    it('recognises every captured format as an anchor', () => {
        for (const line of captured) {
            const evidence = detectAttributionLine(line);
            assert.ok(evidence && evidence.strength >= 0.85, `not an anchor: ${line}`);
        }
    });

    it('ignores the mailto URL SnappyMail writes into its plain text attribution', () => {
        const line =
            'Am 29. September 2026 um 10:00 schrieb "Marta Kask" <marta.kask@example.com ' +
            'mailto:marta.kask@example.com?to=%22Marta%20Kask%22%20%3Cmarta.kask%40example.com%3E >:';
        assert.ok(line.trim().length > 60);
        assert.equal(detectAttributionLine(line)?.id, 'reply:am_x_schrieb_de');
    });

    it('does not anchor on prose that uses the same verbs', () => {
        // No clock time, or no trailing colon: the shape of a sentence, not an attribution.
        const prose = [
            'Marta kirjoitti kokouksessa 12 kohtaa:',
            'Jan schreef op 3 mei een brief aan de gemeente.',
            'Hij schreef het volgende:',
            'Ona napisała 3 punkty:',
            'Il a écrit le rapport en 2024:',
            'He said it would be fine at bob@example.com',
            '我写到这里:'
        ];
        for (const line of prose) {
            const evidence = detectAttributionLine(line);
            assert.ok(!evidence || evidence.strength < 0.85, `prose anchored as attribution: ${line} (${evidence?.id})`);
        }
    });

    it('rejects oversized lines before doing any work on them', () => {
        assert.equal(detectAttributionLine(`${'mailto:x'.repeat(400)} wrote:`), null);
    });
});
