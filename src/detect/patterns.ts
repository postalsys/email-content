/**
 * Pattern set loader.
 *
 * Patterns live in JSON so they can be extended or overridden without touching code, which matters
 * because the multilingual and client specific surface keeps growing. A broken pattern is skipped
 * with a warning rather than crashing the process: a bad regex in a config file must never take
 * down a corpus run.
 *
 * Set EMAIL_CONTENT_PATTERNS to a directory to override the bundled sets. Files are matched by
 * name, so an override directory may contain only the files it wants to replace.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface LinePattern {
    id: string;
    lang?: string;
    role?: string;
    client?: string;
    strength: number;
    regex: RegExp;
}

export interface SelectorPattern {
    id: string;
    client: string;
    role: 'quote' | 'attribution' | 'separator' | 'signature' | 'disclaimer' | 'new' | 'hint';
    strength: number;
    selector: string;
    prevalence: number;
}

export interface PatternSets {
    replyHeaders: LinePattern[];
    forwardHeaders: LinePattern[];
    quotedHeaderFields: LinePattern[];
    signatureDelimiters: LinePattern[];
    signaturePhrases: LinePattern[];
    disclaimerPhrases: LinePattern[];
    htmlSelectors: SelectorPattern[];
    /** Ids of patterns that failed to compile, for diagnostics. */
    invalid: string[];
}

interface RawPattern {
    id?: unknown;
    lang?: unknown;
    role?: unknown;
    client?: unknown;
    strength?: unknown;
    flags?: unknown;
    pattern?: unknown;
}

const BUNDLED_DIR = path.join(__dirname, 'patterns');

function readJson(dir: string, file: string): Record<string, unknown> | null {
    try {
        const raw = fs.readFileSync(path.join(dir, file), 'utf8');
        const parsed: unknown = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch {
        return null;
    }
}

function loadFile(file: string, overrideDir: string | null): Record<string, unknown> {
    if (overrideDir) {
        const override = readJson(overrideDir, file);
        if (override) {
            return override;
        }
    }
    return readJson(BUNDLED_DIR, file) || {};
}

function compileLinePatterns(input: unknown, invalid: string[]): LinePattern[] {
    if (!Array.isArray(input)) {
        return [];
    }
    const out: LinePattern[] = [];
    for (const item of input as RawPattern[]) {
        const id = typeof item.id === 'string' ? item.id : null;
        const source = typeof item.pattern === 'string' ? item.pattern : null;
        if (!id || !source) {
            invalid.push(String(item.id ?? 'unnamed'));
            continue;
        }
        try {
            out.push({
                id,
                lang: typeof item.lang === 'string' ? item.lang : undefined,
                role: typeof item.role === 'string' ? item.role : undefined,
                client: typeof item.client === 'string' ? item.client : undefined,
                strength: typeof item.strength === 'number' ? item.strength : 0.5,
                regex: new RegExp(source, typeof item.flags === 'string' ? item.flags : '')
            });
        } catch {
            invalid.push(id);
        }
    }
    return out;
}

function compileSelectors(input: unknown, invalid: string[]): SelectorPattern[] {
    if (!Array.isArray(input)) {
        return [];
    }
    const out: SelectorPattern[] = [];
    for (const item of input as Record<string, unknown>[]) {
        const id = typeof item.id === 'string' ? item.id : null;
        const selector = typeof item.selector === 'string' ? item.selector : null;
        if (!id || !selector) {
            invalid.push(String(item.id ?? 'unnamed'));
            continue;
        }
        out.push({
            id,
            client: typeof item.client === 'string' ? item.client : '*',
            role: (typeof item.role === 'string' ? item.role : 'hint') as SelectorPattern['role'],
            strength: typeof item.strength === 'number' ? item.strength : 0.5,
            selector,
            prevalence: typeof item.prevalence === 'number' ? item.prevalence : 0
        });
    }
    return out;
}

let cached: PatternSets | null = null;

/** Load and compile all pattern sets. Cached after the first call. */
export function loadPatterns(overrideDir?: string | null): PatternSets {
    if (cached && overrideDir === undefined) {
        return cached;
    }
    const dir = overrideDir === undefined ? process.env.EMAIL_CONTENT_PATTERNS || null : overrideDir;
    const invalid: string[] = [];

    const reply = loadFile('reply-headers.json', dir);
    const forward = loadFile('forward-headers.json', dir);
    const quoted = loadFile('quoted-headers.json', dir);
    const signatures = loadFile('signatures.json', dir);
    const disclaimers = loadFile('disclaimers.json', dir);
    const html = loadFile('html-clients.json', dir);

    const sets: PatternSets = {
        replyHeaders: compileLinePatterns(reply.patterns, invalid),
        forwardHeaders: compileLinePatterns(forward.patterns, invalid),
        quotedHeaderFields: compileLinePatterns(quoted.fields, invalid),
        signatureDelimiters: compileLinePatterns(signatures.delimiters, invalid),
        signaturePhrases: compileLinePatterns(signatures.phrases, invalid),
        disclaimerPhrases: compileLinePatterns(disclaimers.phrases, invalid),
        htmlSelectors: compileSelectors(html.selectors, invalid),
        invalid
    };

    if (overrideDir === undefined) {
        cached = sets;
    }
    return sets;
}

/** Reset the cache. Used by tests that swap pattern directories. */
export function resetPatternCache(): void {
    cached = null;
}
