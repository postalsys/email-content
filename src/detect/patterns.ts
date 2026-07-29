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

/**
 * A classifier asset is missing or corrupt.
 *
 * An installation defect, not malformed email, and therefore deliberately outside the per message
 * fail-soft path. Without the pattern files every detector returns nothing: no reply header is
 * recognised, no quoted history is found, and every message comes back looking like new content.
 * That reads as success, which makes it the worst possible failure mode for a package whose whole
 * job is to know which parts of a message are history.
 */
export class PatternAssetError extends Error {
    readonly code = 'pattern_assets_unusable';
    readonly file: string | null;

    constructor(message: string, file: string | null = null) {
        super(message);
        this.name = 'PatternAssetError';
        this.file = file;
    }
}

type ReadResult = { ok: true; value: Record<string, unknown> } | { ok: false; reason: 'missing' | 'invalid' };

function readJson(dir: string, file: string): ReadResult {
    let raw: string;
    try {
        raw = fs.readFileSync(path.join(dir, file), 'utf8');
    } catch {
        return { ok: false, reason: 'missing' };
    }
    // Present but unreadable is a different fault from absent, and must not be silently treated as
    // an empty pattern set. A truncated file in a published tarball produced exactly that.
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') {
            return { ok: false, reason: 'invalid' };
        }
        return { ok: true, value: parsed as Record<string, unknown> };
    } catch {
        return { ok: false, reason: 'invalid' };
    }
}

function loadFile(file: string, overrideDir: string | null): Record<string, unknown> {
    if (overrideDir) {
        const override = readJson(overrideDir, file);
        if (override.ok) {
            return override.value;
        }
        if (override.reason === 'invalid') {
            throw new PatternAssetError(`Pattern file ${file} in ${overrideDir} is not valid JSON.`, file);
        }
        // Absent from an override directory is normal: an override may replace only some files.
    }
    const bundled = readJson(BUNDLED_DIR, file);
    if (bundled.ok) {
        return bundled.value;
    }
    if (bundled.reason === 'invalid') {
        throw new PatternAssetError(`Bundled pattern file ${file} is corrupt. Reinstall the package.`, file);
    }
    return {};
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
        // A strength outside [0, 1] would outrank every structural anchor, and the g and y flags
        // make the shared regex object stateful, so test() alternates results across lines. Both
        // are treated the same as a regex that does not compile.
        const strength = typeof item.strength === 'number' ? item.strength : 0.5;
        const flags = typeof item.flags === 'string' ? item.flags : '';
        if (strength < 0 || strength > 1 || !Number.isFinite(strength) || /[gy]/.test(flags)) {
            invalid.push(id);
            continue;
        }
        try {
            out.push({
                id,
                lang: typeof item.lang === 'string' ? item.lang : undefined,
                role: typeof item.role === 'string' ? item.role : undefined,
                client: typeof item.client === 'string' ? item.client : undefined,
                strength,
                regex: new RegExp(source, flags)
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

/** Total compiled patterns across every set. */
export function countPatterns(sets: PatternSets): number {
    return (
        sets.replyHeaders.length +
        sets.forwardHeaders.length +
        sets.quotedHeaderFields.length +
        sets.signatureDelimiters.length +
        sets.signaturePhrases.length +
        sets.disclaimerPhrases.length +
        sets.htmlSelectors.length
    );
}

/**
 * Fail loudly when no pattern survived loading.
 *
 * The bundled patterns are read from disk at runtime through path.join(__dirname, 'patterns').
 * @yao-pkg/pkg detects that form and bundles the directory automatically, which is why consumers
 * need no pkg asset configuration, but it is a static analysis heuristic rather than a guarantee.
 * If it ever fails, or the files are missing from a published tarball, every detector quietly
 * returns nothing: no reply header is recognised and reply history stops being detected.
 *
 * The failure direction is at least the safe one, since nothing can be hidden without an anchor.
 * But a build that silently extracts nothing useful should not pass unnoticed.
 */
export function assertPatternsLoaded(sets: PatternSets, source: string): void {
    if (countPatterns(sets) === 0) {
        throw new PatternAssetError(
            `No detector patterns could be loaded from ${source}. ` +
                'The pattern JSON files are missing from the installation or the bundle. ' +
                'Without them no reply history can be detected.'
        );
    }
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

    assertPatternsLoaded(sets, dir ?? BUNDLED_DIR);

    if (overrideDir === undefined) {
        cached = sets;
    }
    return sets;
}

/** Reset the cache. Used by tests that swap pattern directories. */
export function resetPatternCache(): void {
    cached = null;
}
