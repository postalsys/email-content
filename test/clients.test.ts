import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { extract } from '../src/index';
import { fixturePath } from './helpers';

/**
 * Every reply and forward captured from a real client (tools/client-capture), scored token by
 * token against the role its sentinel word encodes.
 *
 * Two guarantees, one hard and one a ratchet. No text that should be visible may come back hidden,
 * ever. And the number of fixtures scored fully correct may only go up: lower it only with a
 * reason written next to the number.
 */

const ROOT = path.join(path.dirname(fixturePath('gmail-top-post.eml')), 'clients');
const TOKEN = /\b(nvq|hvq|gvq|fvq|svq)[a-z]{6}\b/g;

/** Fully correct fixtures on the build that introduced this test; see docs/client-coverage.md. */
const MIN_FULLY_CORRECT = 575;

function* fixtures(dir: string): Generator<string> {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            yield* fixtures(full);
        } else if (entry.name.endsWith('.eml')) {
            yield full;
        }
    }
}

describe('captured client fixtures', () => {
    it('never hide text that should be visible, and do not regress', async () => {
        let total = 0;
        let fullyCorrect = 0;
        const hidden: string[] = [];
        for (const file of fixtures(ROOT)) {
            const expected = JSON.parse(fs.readFileSync(file.replace(/\.eml$/, '.expected.json'), 'utf8')).expected as Record<string, string[]>;
            const result = await extract(fs.readFileSync(file));
            const where = new Map<string, { type: string; visibility: string }>();
            for (const segment of [...result.segments, ...result.hiddenSegments]) {
                for (const match of segment.text.matchAll(TOKEN)) {
                    if (!where.has(match[0])) {
                        where.set(match[0], { type: segment.type, visibility: segment.visibility });
                    }
                }
            }
            let ok = true;
            for (const [token, labels] of Object.entries(expected)) {
                const seen = where.get(token);
                if (!seen || !labels.includes(seen.type)) {
                    ok = false;
                }
                if (seen && seen.visibility === 'hide' && !labels.includes('REPLY_HISTORY')) {
                    hidden.push(`${path.relative(ROOT, file)} ${token}`);
                }
            }
            total++;
            fullyCorrect += ok ? 1 : 0;
        }
        assert.ok(total > 500, `only ${total} fixtures found`);
        assert.deepEqual(hidden, [], 'visible text came back hidden');
        assert.ok(fullyCorrect >= MIN_FULLY_CORRECT, `${fullyCorrect} of ${total} fully correct, expected at least ${MIN_FULLY_CORRECT}`);
    });
});
