/**
 * Minimal argument parsing.
 *
 * No dependency: the CLI surface is small, fully documented in the README, and a hand rolled parser
 * keeps the runtime dependency tree at three packages, all of which are needed for correctness
 * rather than convenience.
 */

export interface ParsedArgs {
    positional: string[];
    flags: Map<string, string | boolean>;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
    const positional: string[] = [];
    const flags = new Map<string, string | boolean>();

    for (let i = 0; i < argv.length; i++) {
        const token = argv[i] as string;
        if (!token.startsWith('--')) {
            positional.push(token);
            continue;
        }
        const body = token.slice(2);
        const eq = body.indexOf('=');
        if (eq !== -1) {
            flags.set(body.slice(0, eq), body.slice(eq + 1));
            continue;
        }
        // `--no-thing` is the negation of `--thing`, so that documented defaults can be turned off.
        if (body.startsWith('no-')) {
            flags.set(body.slice(3), false);
            continue;
        }
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
            flags.set(body, next);
            i++;
        } else {
            flags.set(body, true);
        }
    }

    return { positional, flags };
}

export function flagString(args: ParsedArgs, name: string, fallback: string): string {
    const value = args.flags.get(name);
    return typeof value === 'string' ? value : fallback;
}

export function flagOptionalString(args: ParsedArgs, name: string): string | undefined {
    const value = args.flags.get(name);
    return typeof value === 'string' ? value : undefined;
}

export function flagNumber(args: ParsedArgs, name: string, fallback: number): number {
    const value = args.flags.get(name);
    if (typeof value !== 'string') {
        return fallback;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

export function flagBool(args: ParsedArgs, name: string, fallback: boolean): boolean {
    const value = args.flags.get(name);
    if (value === undefined) {
        return fallback;
    }
    if (typeof value === 'boolean') {
        return value;
    }
    return value !== 'false' && value !== '0' && value !== 'no';
}
