/**
 * Retrying JSON POST shared by the annotator clients.
 *
 * Both providers need the same thing: one authenticated POST, exponential backoff on rate limits
 * and overload, and no retry once the provider has said the request itself is wrong. Keeping that
 * loop in one place means a fix to it cannot land in one client and not the other.
 */

export interface RetryPolicy {
    /** Per request timeout in milliseconds. */
    timeoutMs: number;
    maxRetries: number;
}

/** What every provider client needs: where, who, which model, and how hard to retry. */
export interface ApiConfig extends RetryPolicy {
    apiKey: string;
    baseUrl: string;
    model: string;
}

/**
 * Load a provider's configuration from the environment, after process.loadEnvFile().
 *
 * Throws when the key is missing. That is the fail closed guarantee in docs/threat-model.md: a
 * provider without a configured key never gets as far as reading a message.
 */
export function apiConfigFromEnv(env: { keyVar: string; urlVar: string; defaultUrl: string }, model: string, overrides: Partial<ApiConfig> = {}): ApiConfig {
    const apiKey = process.env[env.keyVar];
    if (!apiKey) {
        throw new Error(`${env.keyVar} is not set. Copy .env.example to .env and fill it in.`);
    }
    return {
        apiKey,
        baseUrl: process.env[env.urlVar] || env.defaultUrl,
        model,
        timeoutMs: 120000,
        maxRetries: 5,
        ...overrides
    };
}

/** Token accounting, in one shape for every provider. */
export interface Usage {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    requests: number;
}

/** An HTTP or protocol failure from an annotation provider. */
export class ApiError extends Error {
    readonly status: number;
    readonly retryable: boolean;

    constructor(message: string, status: number, retryable: boolean) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.retryable = retryable;
    }
}

export interface PostJsonOptions<T> {
    url: string;
    apiKey: string;
    payload: unknown;
    policy: RetryPolicy;
    /** Build the error for a non 2xx response. Decides what, if anything, of the body is surfaced. */
    httpError(status: number, body: unknown): ApiError;
    /**
     * Turn a 2xx body into the result. Runs inside the retry loop: throwing an ApiError with
     * `retryable: false` stops immediately, any other error is retried like a network failure.
     */
    parse(body: unknown): T;
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export async function postJson<T>(options: PostJsonOptions<T>): Promise<T> {
    let lastError: Error | null = null;
    // Payloads run to hundreds of kilobytes, and nothing about them changes between attempts.
    const body = JSON.stringify(options.payload);

    for (let attempt = 0; attempt <= options.policy.maxRetries; attempt++) {
        if (attempt > 0) {
            // Full jitter, capped, so a burst of workers does not retry in lockstep.
            const backoff = Math.min(30000, 500 * 2 ** (attempt - 1));
            await sleep(Math.random() * backoff);
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), options.policy.timeoutMs);

        try {
            const response = await fetch(options.url, {
                method: 'POST',
                signal: controller.signal,
                headers: {
                    Authorization: `Bearer ${options.apiKey}`,
                    'Content-Type': 'application/json'
                },
                body
            });

            if (!response.ok) {
                let detail: unknown = null;
                try {
                    detail = await response.json();
                } catch {
                    // Body was not JSON. The status alone is enough.
                }
                const error = options.httpError(response.status, detail);
                if (!error.retryable) {
                    throw error;
                }
                lastError = error;
                continue;
            }

            return options.parse(await response.json());
        } catch (err) {
            if (err instanceof ApiError && !err.retryable) {
                throw err;
            }
            lastError = err instanceof Error ? err : new Error(String(err));
        } finally {
            clearTimeout(timer);
        }
    }

    throw lastError ?? new Error('request failed');
}
