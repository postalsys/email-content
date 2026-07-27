/**
 * The benchmark's safety oracles.
 *
 * These exist because the benchmark used to decide whether the input had content by looking at the
 * output: `visibleChars + hiddenChars > 0`. When extraction dropped everything that flag went
 * false, the catastrophic counter never incremented, and the gate reported zero losses while a
 * reproducible total loss case existed. The tests below pin the property that makes the gate
 * meaningful: the input inventory is computed without consulting extraction at all.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkMessage } from '../src/cli/benchmark';
import { coverageOf, eligibleBodyParts, inventoryVisibleInput, requiredCoverageGroups } from '../src/eval/oracle';
import { parseMessage } from '../src/mime/parse';
import { extract } from '../src/index';
import { readFixture } from './helpers';
import { mimePartOf, type Segment } from '../src/types';

async function inventory(fixture: string) {
    return inventoryVisibleInput(await parseMessage(readFixture(fixture)));
}

async function groupsFor(raw: Buffer) {
    return requiredCoverageGroups(await parseMessage(raw));
}

/** Compare the required groups against what extraction actually emitted. */
async function coverageFor(raw: Buffer) {
    const groups = await groupsFor(raw);
    const result = await extract(raw);
    const parts = (segments: readonly Segment[]) =>
        new Set(segments.map(segment => mimePartOf(segment.source)).filter((part): part is string => part !== null));
    return coverageOf(groups, parts(result.segments), parts(result.hiddenSegments));
}

function message(lines: readonly string[]): Buffer {
    return Buffer.from(lines.join('\r\n'), 'utf8');
}

describe('input inventory oracle', () => {
    it('sees visible text in a body extraction cannot parse', async () => {
        // The whole point. The markup is unparseable, so nothing downstream can be trusted to say
        // whether there was anything to show. The oracle answers from the input.
        const found = await inventory('pathological-html-visible-text.eml');
        assert.ok(found.hasVisibleText);
        assert.ok(found.visibleChars > 0);
    });

    it('does not count an image only body as visible text', async () => {
        const found = await inventory('image-only-html.eml');
        assert.equal(found.hasVisibleText, false);
        assert.equal(found.eligibleParts, 1, 'the part is eligible, it simply holds no visible text');
    });

    it('does not count script or style bodies as visible text', async () => {
        const found = await inventory('script-style-only-html.eml');
        assert.equal(found.hasVisibleText, false);
    });

    it('does not count bare quote markers as visible text', async () => {
        // A plain body of `>` on three lines contains nothing a reader would have seen. Counting the
        // markers made the gate report a total content loss on a message that had nothing to lose,
        // which is the one thing a gate must never do: cry wolf on the check everyone relies on.
        const raw = message(['From: a@example.com', 'Subject: Empty quote markers', 'Content-Type: text/plain; charset=utf-8', '', '>', '>', '>', '']);
        const found = inventoryVisibleInput(await parseMessage(raw));

        assert.equal(found.visibleChars, 0);
        assert.equal(found.hasVisibleText, false);
        assert.equal(found.eligibleParts, 1, 'the part is eligible, it simply holds nothing visible');

        const check = await checkMessage(raw);
        assert.equal(check.emptyFromNonEmpty, false);
        assert.equal(check.everythingHidden, false);
    });

    it('still counts quoted text that has content', async () => {
        const raw = message([
            'From: a@example.com',
            'Subject: Quoted text with content',
            'Content-Type: text/plain; charset=utf-8',
            '',
            '> Can we meet on Monday?',
            ''
        ]);
        const found = inventoryVisibleInput(await parseMessage(raw));
        assert.ok(found.visibleChars > 0);
        assert.equal(found.hasVisibleText, true);
    });

    it('does not count a message with no text parts as a loss', async () => {
        const found = await inventory('no-text-parts.eml');
        assert.equal(found.hasVisibleText, false);
        assert.equal(found.eligibleParts, 0);
    });

    it('counts both members of an alternative, and demands neither', async () => {
        // Over-inclusive on purpose: the question is only whether the message had anything visible.
        // Requiring both part ids in the output would report ordinary HTML primary mail as lossy.
        const found = await inventory('mixed-alternative-plus-footer.eml');
        assert.ok(found.eligibleParts >= 3);
        assert.ok(found.hasVisibleText);
    });

    it('excludes attachments and embedded message parts', async () => {
        const message = await parseMessage(readFixture('forwarded-with-comment.eml'));
        const eligible = eligibleBodyParts(message);
        assert.ok(eligible.every(part => part.disposition !== 'attachment'));
        assert.ok(eligible.every(part => !part.rfc822));
    });
});

describe('MIME coverage oracle', () => {
    it('treats an alternative as one group, satisfied by either member', async () => {
        // Per-part coverage would report most valid HTML mail as lossy: an alternative carries both
        // renderings and the output deliberately contains only one of them.
        const raw = readFixture('gmail-top-post.eml');
        const groups = await groupsFor(raw);
        const alternative = groups.filter(group => group.alternative);
        assert.equal(alternative.length, 1);
        assert.ok((alternative[0] as { members: string[] }).members.length >= 2);

        const coverage = await coverageFor(raw);
        assert.deepEqual(coverage.missing, []);
        assert.ok(coverage.alternativesNotEmitted.length >= 1, 'the unused alternative member should be reported as intentional');
    });

    it('makes each independent mixed section its own required group', async () => {
        const raw = readFixture('mixed-alternative-plus-footer.eml');
        const groups = await groupsFor(raw);

        // multipart/mixed(alternative(P,H), P): one alternative group and one independent section.
        assert.equal(groups.length, 2);
        assert.equal(groups.filter(group => group.alternative).length, 1);

        const coverage = await coverageFor(raw);
        assert.deepEqual(coverage.missing, [], 'an independent section is not represented in the output');
        assert.equal(coverage.covered, 2);
    });

    it('detects an omitted independent section', async () => {
        // What the gate is for. Simulates the pre-fix behaviour by scoring the required groups
        // against an output that carries only the first section.
        const groups = await groupsFor(readFixture('mixed-short-body-long-footer.eml'));
        assert.equal(groups.length, 2);

        const coverage = coverageOf(groups, new Set(['1']), new Set());
        assert.equal(coverage.missing.length, 1);
        assert.equal(coverage.missing[0], '2');
    });

    it('does not make a related resource a required group', async () => {
        const raw = message([
            'From: Alice <alice@example.com>',
            'Subject: Related root and a resource',
            'MIME-Version: 1.0',
            'Content-Type: multipart/related; boundary="B"',
            '',
            '--B',
            'Content-Type: text/html; charset=utf-8',
            '',
            '<div dir="ltr">AUTHORED_SENTINEL the body of the message.</div>',
            '',
            '--B',
            'Content-Type: text/plain; charset=utf-8',
            'Content-ID: <notes@example.com>',
            '',
            'RESOURCE_SENTINEL side notes that are not the root.',
            '',
            '--B--',
            ''
        ]);
        const groups = await groupsFor(raw);

        assert.equal(groups.length, 1, 'the related root is the only required group');
        assert.equal((groups[0] as { id: string }).id, '1');
        assert.deepEqual((await coverageFor(raw)).missing, []);
    });

    it('honours the related start parameter when resolving the root', async () => {
        const groups = await groupsFor(readFixture('nested-alternative-related-root.eml'));

        // The root is the second child, named by start, and it is itself an alternative.
        assert.equal(groups.length, 1);
        assert.equal((groups[0] as { alternative: boolean }).alternative, true);
        assert.deepEqual((await coverageFor(readFixture('nested-alternative-related-root.eml'))).missing, []);
    });

    it('folds a misencoded alternative in a mixed container into one group', async () => {
        // `mixed(P, H)` carrying the same content is a client that meant `alternative`. The
        // extractor merges those into one section, so demanding both part ids would report a loss
        // where none happened. The oracle decides this by content, independently of the selection
        // code, so the two can still disagree and be caught.
        const body = 'AUTHORED_SENTINEL the release is scheduled for Monday morning and the runbook is linked below.';
        const raw = message([
            'From: a@example.com',
            'Subject: Mixed used as alternative',
            'MIME-Version: 1.0',
            'Content-Type: multipart/mixed; boundary="B"',
            '',
            '--B',
            'Content-Type: text/plain; charset=utf-8',
            '',
            body,
            '',
            '--B',
            'Content-Type: text/html; charset=utf-8',
            '',
            `<div dir="ltr">${body}</div>`,
            '',
            '--B--',
            ''
        ]);
        const groups = await groupsFor(raw);

        assert.equal(groups.length, 1, 'the same content in two representations is one group');
        assert.equal((groups[0] as { alternative: boolean }).alternative, true);
        assert.deepEqual((await coverageFor(raw)).missing, []);
    });

    it('keeps genuinely distinct mixed siblings as separate groups', async () => {
        const raw = message([
            'From: a@example.com',
            'Subject: Distinct siblings',
            'MIME-Version: 1.0',
            'Content-Type: multipart/mixed; boundary="B"',
            '',
            '--B',
            'Content-Type: text/plain; charset=utf-8',
            '',
            'SENTINEL_INTRO please find the quarterly summary reproduced underneath this note.',
            '',
            '--B',
            'Content-Type: text/html; charset=utf-8',
            '',
            '<div dir="ltr">SENTINEL_BODY revenue grew across every region we operate in this quarter.</div>',
            '',
            '--B--',
            ''
        ]);
        const groups = await groupsFor(raw);

        assert.equal(groups.length, 2, 'distinct siblings were folded together');
        assert.deepEqual((await coverageFor(raw)).missing, [], 'a distinct sibling is missing from the output');
    });

    it('does not require coverage for parts with no visible text', async () => {
        for (const fixture of ['image-only-html.eml', 'script-style-only-html.eml', 'no-text-parts.eml']) {
            assert.deepEqual(await groupsFor(readFixture(fixture)), [], fixture);
        }
    });

    it('does not require coverage for attachments or embedded messages', async () => {
        const groups = await groupsFor(readFixture('forwarded-with-comment.eml'));
        const coverage = await coverageFor(readFixture('forwarded-with-comment.eml'));
        assert.ok(groups.length >= 1);
        assert.deepEqual(coverage.missing, []);
    });
});

describe('structural gate', () => {
    it('does not report an empty extraction for pathological HTML with text', async () => {
        const check = await checkMessage(readFixture('pathological-html-visible-text.eml'));
        assert.ok(check.inputVisibleChars > 0);
        assert.equal(check.emptyFromNonEmpty, false);
        assert.equal(check.degradedWithEmptyOutput, false);
        assert.ok(check.visibleChars > 0);
    });

    it('does not fire on a body that legitimately holds no text', async () => {
        for (const fixture of ['image-only-html.eml', 'script-style-only-html.eml', 'no-text-parts.eml']) {
            const check = await checkMessage(readFixture(fixture));
            assert.equal(check.emptyFromNonEmpty, false, fixture);
            assert.equal(check.everythingHidden, false, fixture);
        }
    });

    it('counts a hidden-without-anchor message once, not once per segment', async () => {
        // The old counter incremented per hidden segment while the reported rate divided by the
        // message count, so its percentage was not a percentage of anything.
        const check = await checkMessage(readFixture('gmail-top-post.eml'));
        assert.equal(typeof check.hiddenWithoutAnchor, 'boolean');
    });

    it('reports every fixture as structurally sound', async () => {
        // The committed fixture gate, in the form the CI job runs. Any catastrophic flag here means
        // a message that had content going in lost it coming out.
        const fixtures = [
            'gmail-top-post.eml',
            'outlook-web-reply.eml',
            'outlook-unmarked-history.eml',
            'plain-bottom-post.eml',
            'plain-inline-reply.eml',
            'forwarded-with-comment.eml',
            'format-flowed.eml',
            'charset-latin1.eml',
            'text-mentions-headers.eml',
            'pathological-html-visible-text.eml',
            'mixed-short-body-long-footer.eml',
            'mixed-alternative-plus-footer.eml',
            'mixed-primary-signature-plus-footer.eml',
            'nested-alternative-related-root.eml',
            'filename-text-without-disposition.eml'
        ];
        for (const fixture of fixtures) {
            const check = await checkMessage(readFixture(fixture));
            assert.equal(check.emptyFromNonEmpty, false, `${fixture}: non empty input produced no output`);
            assert.equal(check.everythingHidden, false, `${fixture}: everything hidden`);
            assert.equal(check.forwardedHidden, false, `${fixture}: forwarded content hidden`);
            assert.equal(check.hiddenWithoutAnchor, false, `${fixture}: hidden without a structural anchor`);
            assert.equal(check.degradedWithEmptyOutput, false, `${fixture}: degraded HTML produced no output`);
        }
    });
});
