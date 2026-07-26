/**
 * Shared test helpers.
 */

import fs from 'node:fs';
import path from 'node:path';

const FIXTURE_DIR = path.join(__dirname, '..', '..', 'test', 'fixtures');

/** Resolve a fixture path, working from both the source tree and the compiled test output. */
export function fixturePath(name: string): string {
    const candidates = [path.join(FIXTURE_DIR, name), path.join(__dirname, 'fixtures', name), path.join(process.cwd(), 'test', 'fixtures', name)];
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }
    throw new Error(`fixture not found: ${name}`);
}

export function readFixture(name: string): Buffer {
    return fs.readFileSync(fixturePath(name));
}

export function listFixtures(): string[] {
    const dir = path.dirname(fixturePath('gmail-top-post.eml'));
    return fs
        .readdirSync(dir)
        .filter(name => name.endsWith('.eml'))
        .sort();
}
