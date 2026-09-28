/**
 * Shared test helpers.
 */

import fs from 'node:fs';
import http from 'node:http';
import { type AddressInfo } from 'node:net';
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

/**
 * node:sqlite arrived in Node 22.5. The corpus tooling requires it; the extraction library does not.
 * On an older runtime those tests are skipped rather than failed, so the suite still means something
 * on the oldest Node the library supports.
 */
export const HAS_SQLITE = (() => {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('node:sqlite');
        return true;
    } catch {
        return false;
    }
})();

/** `describe` option for suites that need node:sqlite. */
export const SQLITE_SUITE = { skip: HAS_SQLITE ? false : 'node:sqlite requires Node 22.5 or later' };

export interface RecordedRequest {
    url: string;
    authorization: string | undefined;
    body: Record<string, unknown>;
}

/**
 * A local HTTP server standing in for a provider API. Records every JSON request and answers it
 * with whatever `respond` returns; a string body is sent verbatim, anything else as JSON.
 */
export async function recordingServer(
    respond: (request: RecordedRequest, count: number) => { status: number; body: unknown }
): Promise<{ url: string; requests: RecordedRequest[]; close(): Promise<void> }> {
    const requests: RecordedRequest[] = [];
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', chunk => (raw += chunk));
        req.on('end', () => {
            const request = { url: req.url ?? '', authorization: req.headers.authorization, body: JSON.parse(raw || '{}') as Record<string, unknown> };
            requests.push(request);
            const reply = respond(request, requests.length);
            res.writeHead(reply.status, { 'Content-Type': 'application/json' });
            res.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body));
        });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${port}`, requests, close: () => new Promise(resolve => server.close(() => resolve())) };
}
