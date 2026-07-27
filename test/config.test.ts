/**
 * Public configuration validation.
 *
 * Two kinds of bad input, deliberately handled differently:
 *
 *   - a malformed **message** degrades and never throws. The sender chose it and the caller cannot
 *     fix it, so the pipeline shows what it can and says what went wrong.
 *   - an invalid **option** throws before any processing. It is the programmer's own mistake, it
 *     will repeat on every message, and returning a plausible looking degraded result for it hides
 *     an operational fault behind what reads like ordinary output.
 *
 * The line between rejecting and tolerating is drawn at meaninglessness, not at size. `NaN`,
 * infinities, negatives and fractions are always errors. A large but finite value is the caller's
 * decision, and failing on it is more likely to take down a service than to protect it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../src/analyze';
import { extract } from '../src/index';
import { DEFAULT_CONFIDENCE, validateConfidenceConfig } from '../src/classify/confidence';
import { DEFAULT_PARSE_OPTIONS, validateParseOptions } from '../src/mime/model';
import { parseMessage } from '../src/mime/parse';
import { ConfigurationError } from '../src/types';
import { flagNonNegativeInt, flagPositiveInt, parseArgs, CliOptionError } from '../src/cli/args';

const NONSENSE = [NaN, Infinity, -Infinity, -1, -0.5];

function message(body: string): Buffer {
    return Buffer.from(['From: a@example.com', 'Subject: Config', 'Content-Type: text/plain; charset=utf-8', '', body, ''].join('\r\n'), 'utf8');
}

describe('confidence configuration', () => {
    it('rejects every meaningless threshold', () => {
        for (const option of ['hideThreshold', 'collapseThreshold', 'minAnchorStrength'] as const) {
            for (const value of [...NONSENSE, 1.5, 2]) {
                assert.throws(() => validateConfidenceConfig({ [option]: value }), ConfigurationError, `${option}=${value} was accepted`);
            }
        }
    });

    it('rejects inverted thresholds', () => {
        assert.throws(
            () => validateConfidenceConfig({ collapseThreshold: 0.9, hideThreshold: 0.5 }),
            (err: unknown) => {
                assert.ok(err instanceof ConfigurationError);
                assert.equal(err.code, 'inverted_thresholds');
                return true;
            }
        );
    });

    it('does not require minAnchorStrength to sit under hideThreshold', () => {
        // Different dimensions: anchor strength measures the evidence, the thresholds measure the
        // classification. Ordering them would be meaningless.
        const config = validateConfidenceConfig({ minAnchorStrength: 1, hideThreshold: 0.5, collapseThreshold: 0.5 });
        assert.equal(config.minAnchorStrength, 1);
    });

    it('accepts a partial and fills in the rest', () => {
        const config = validateConfidenceConfig({ collapseThreshold: 0.6 });
        assert.equal(config.collapseThreshold, 0.6);
        assert.equal(config.hideThreshold, DEFAULT_CONFIDENCE.hideThreshold);
        assert.equal(config.minAnchorStrength, DEFAULT_CONFIDENCE.minAnchorStrength);
    });

    it('leaves the defaults alone', () => {
        assert.deepEqual(validateConfidenceConfig(), DEFAULT_CONFIDENCE);
        assert.deepEqual(validateConfidenceConfig({}), DEFAULT_CONFIDENCE);
    });

    it('accepts the boundary values', () => {
        const config = validateConfidenceConfig({ collapseThreshold: 0, hideThreshold: 1, minAnchorStrength: 0 });
        assert.deepEqual(config, { collapseThreshold: 0, hideThreshold: 1, minAnchorStrength: 0 });
    });

    it('throws from both entry points before any processing', async () => {
        await assert.rejects(() => analyze({ text: 'hello' }, { confidence: { hideThreshold: NaN } }), ConfigurationError);
        await assert.rejects(() => extract(message('hello'), { confidence: { hideThreshold: NaN } }), ConfigurationError);
    });
});

describe('parse option validation', () => {
    it('rejects every meaningless size', () => {
        for (const option of ['maxTextPartBytes', 'maxParts', 'maxHeadSize', 'maxMessageBytes', 'maxTotalDecodedTextBytes'] as const) {
            for (const value of [...NONSENSE, 0, 1.5]) {
                assert.throws(() => validateParseOptions({ [option]: value }), ConfigurationError, `${option}=${value} was accepted`);
            }
        }
    });

    it('rejects a non boolean ignoreEmbedded', () => {
        assert.throws(() => validateParseOptions({ ignoreEmbedded: 'yes' as unknown as boolean }), ConfigurationError);
    });

    it('accepts a large but finite value rather than second guessing the host', () => {
        const options = validateParseOptions({ maxTextPartBytes: 512 * 1024 * 1024 });
        assert.equal(options.maxTextPartBytes, 512 * 1024 * 1024);
    });

    it('leaves the defaults alone', () => {
        assert.deepEqual(validateParseOptions(), DEFAULT_PARSE_OPTIONS);
        assert.deepEqual(validateParseOptions({}), DEFAULT_PARSE_OPTIONS);
    });

    it('throws before parsing rather than after', async () => {
        await assert.rejects(() => parseMessage(message('hello'), { maxParts: -1 }), ConfigurationError);
        await assert.rejects(() => extract(message('hello'), { parse: { maxParts: 0 } }), ConfigurationError);
    });
});

describe('aggregate input limits', () => {
    it('stops at the raw message limit and says which one fired', async () => {
        const result = await extract(message('x'.repeat(5000)), { parse: { maxMessageBytes: 100 } });

        const limit = result.warnings.find(warning => warning.code === 'input_limit_exceeded');
        assert.ok(limit, 'the limit fired silently');
        assert.match(limit.detail ?? '', /maxMessageBytes/);
        assert.equal(result.segments.length, 0);
        // Never an exception: an oversized message is input, and input degrades.
        assert.equal(result.originalAvailable, true);
    });

    it('caps total decoded text across every part, not just each one', async () => {
        // Three parts, each individually under the per part cap, together over the aggregate.
        const part = 'y'.repeat(4000);
        const raw = Buffer.from(
            [
                'From: a@example.com',
                'Subject: Many legal sized parts',
                'MIME-Version: 1.0',
                'Content-Type: multipart/mixed; boundary="B"',
                '',
                ...['1', '2', '3'].flatMap(() => ['--B', 'Content-Type: text/plain; charset=utf-8', '', part, '']),
                '--B--',
                ''
            ].join('\r\n'),
            'utf8'
        );

        const parsed = await parseMessage(raw, { maxTotalDecodedTextBytes: 5000 });
        const retained = parsed.parts.reduce((sum, item) => sum + (item.decoded?.text.length ?? 0), 0);

        assert.ok(retained <= 5000, `retained ${retained} characters past the aggregate limit`);
        assert.ok(parsed.warnings.some(warning => warning.code === 'input_limit_exceeded'));
    });

    it('caps content first input and keeps what fits', async () => {
        const result = await analyze(
            {
                sections: [{ text: 'SENTINEL_FIRST short body.' }, { text: 'SENTINEL_SECOND '.repeat(500) }]
            },
            { maxContentChars: 30 }
        );

        assert.ok(result.warnings.some(warning => warning.code === 'input_limit_exceeded'));
        // Everything the budget allowed through is still returned in full.
        const text = [...result.segments, ...result.hiddenSegments].map(segment => segment.text).join('\n');
        assert.ok(text.includes('SENTINEL_FIRST'));
    });

    it('rejects a meaningless content limit', async () => {
        for (const value of [...NONSENSE, 0, 1.5]) {
            await assert.rejects(() => analyze({ text: 'hello' }, { maxContentChars: value }), ConfigurationError, `maxContentChars=${value}`);
        }
    });

    it('never puts message content or a value into the error', () => {
        try {
            validateConfidenceConfig({ hideThreshold: NaN });
            assert.fail('expected a throw');
        } catch (err) {
            assert.ok(err instanceof ConfigurationError);
            assert.equal(err.message.includes('NaN'), false, 'the offending value leaked into the message');
            assert.equal(err.option, 'confidence.hideThreshold');
            assert.equal(err.code, 'invalid_option');
        }
    });
});

describe('configuration property', () => {
    it('either validates into a bounded configuration or fails before classification', () => {
        // Deterministic pseudo-random sweep. Every outcome must be one of exactly two things: a
        // fully bounded config, or a ConfigurationError. Never a half applied one.
        let seed = 987654321;
        const next = () => {
            seed = (seed * 1103515245 + 12345) & 0x7fffffff;
            return seed / 0x7fffffff;
        };
        const values = [NaN, Infinity, -Infinity, -1, -0.5, 0, 0.25, 0.5, 0.75, 1, 1.5, 42];

        for (let i = 0; i < 5000; i++) {
            const candidate = {
                hideThreshold: values[Math.floor(next() * values.length)] as number,
                collapseThreshold: values[Math.floor(next() * values.length)] as number,
                minAnchorStrength: values[Math.floor(next() * values.length)] as number
            };
            let config;
            try {
                config = validateConfidenceConfig(candidate);
            } catch (err) {
                assert.ok(err instanceof ConfigurationError, `threw something other than ConfigurationError: ${String(err)}`);
                continue;
            }
            for (const [key, value] of Object.entries(config)) {
                assert.ok(Number.isFinite(value) && value >= 0 && value <= 1, `${key} escaped the unit interval as ${value}`);
            }
            assert.ok(config.collapseThreshold <= config.hideThreshold, 'an inverted pair validated');
        }
    });
});

describe('command line option validation', () => {
    it('refuses values that would reach the worker pool or SQL', () => {
        for (const raw of ['-1', '0', '1.5', 'NaN', 'abc']) {
            const args = parseArgs(['--concurrency', raw]);
            assert.throws(() => flagPositiveInt(args, 'concurrency', 4), CliOptionError, `--concurrency ${raw} was accepted`);
        }
        for (const raw of ['-5', '-1', '2.5']) {
            const args = parseArgs(['--sample', raw]);
            assert.throws(() => flagNonNegativeInt(args, 'sample', 0), CliOptionError, `--sample ${raw} was accepted`);
        }
    });

    it('names the option it rejected', () => {
        try {
            flagPositiveInt(parseArgs(['--timeout', '-1']), 'timeout', 30000);
            assert.fail('expected a throw');
        } catch (err) {
            assert.ok(err instanceof CliOptionError);
            assert.equal(err.option, 'timeout');
            assert.match(err.message, /--timeout expects a positive integer/);
        }
    });

    it('accepts valid values and defaults', () => {
        assert.equal(flagPositiveInt(parseArgs(['--sample', '2000']), 'sample', 25), 2000);
        assert.equal(flagPositiveInt(parseArgs([]), 'sample', 25), 25);
        assert.equal(flagNonNegativeInt(parseArgs(['--limit', '0']), 'limit', 5), 0);
    });
});
