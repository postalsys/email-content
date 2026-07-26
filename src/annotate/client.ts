/**
 * Minimal OpenAI chat completions client.
 *
 * No SDK dependency: this project ships three runtime dependencies and none of them opens a socket.
 * Adding a vendor SDK for one optional command would change that materially, and the surface used
 * here is a single POST with a JSON schema response format.
 *
 * This is the one place in the codebase that sends message content off the machine. It is only
 * reachable from `email-content annotate`, never from `extract()` or the corpus scanner. See
 * docs/threat-model.md, "Configured exception: LLM annotation".
 */

export interface OpenAIConfig {
    apiKey: string;
    baseUrl: string;
    model: string;
    /** Per request timeout in milliseconds. */
    timeoutMs: number;
    maxRetries: number;
}

export interface Usage {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    requests: number;
}

export interface CompletionRequest {
    system: string;
    user: string;
    schemaName: string;
    schema: Record<string, unknown>;
}

/**
 * The narrow surface the annotator depends on.
 *
 * Depending on this rather than on the concrete client is what lets the annotator's validation
 * logic be tested without a network call, which matters because that validation is the guard
 * against a model returning indices that do not exist.
 */
export interface CompletionClient {
    readonly model: string;
    complete<T>(request: CompletionRequest): Promise<T>;
}

export class OpenAIError extends Error {
    readonly status: number;
    readonly retryable: boolean;

    constructor(message: string, status: number, retryable: boolean) {
        super(message);
        this.name = 'OpenAIError';
        this.status = status;
        this.retryable = retryable;
    }
}

/** Load configuration from the environment, after process.loadEnvFile(). */
export function configFromEnv(model: string, overrides: Partial<OpenAIConfig> = {}): OpenAIConfig {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        throw new Error('OPENAI_API_KEY is not set. Copy .env.example to .env and fill it in.');
    }
    return {
        apiKey,
        baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
        model,
        timeoutMs: 120000,
        maxRetries: 5,
        ...overrides
    };
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export class OpenAIClient implements CompletionClient {
    private readonly config: OpenAIConfig;
    readonly usage: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, requests: 0 };

    constructor(config: OpenAIConfig) {
        this.config = config;
    }

    get model(): string {
        return this.config.model;
    }

    /**
     * Request a structured completion and return the parsed object.
     *
     * Retries on rate limits and transient server errors with exponential backoff plus jitter. A
     * schema violation is not retried: strict mode means the model already failed to satisfy the
     * contract, and a retry would usually fail the same way.
     */
    async complete<T>(request: CompletionRequest): Promise<T> {
        let lastError: Error | null = null;

        for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
            if (attempt > 0) {
                // Full jitter, capped, so a burst of workers does not retry in lockstep.
                const backoff = Math.min(30000, 500 * 2 ** (attempt - 1));
                await sleep(Math.random() * backoff);
            }

            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);

            try {
                const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
                    method: 'POST',
                    signal: controller.signal,
                    headers: {
                        Authorization: `Bearer ${this.config.apiKey}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        model: this.config.model,
                        messages: [
                            { role: 'system', content: request.system },
                            { role: 'user', content: request.user }
                        ],
                        response_format: {
                            type: 'json_schema',
                            json_schema: { name: request.schemaName, strict: true, schema: request.schema }
                        }
                    })
                });

                if (!response.ok) {
                    const retryable = response.status === 429 || response.status >= 500;
                    let detail = `HTTP ${response.status}`;
                    try {
                        const body = (await response.json()) as { error?: { message?: string } };
                        if (body.error?.message) {
                            detail = body.error.message.slice(0, 300);
                        }
                    } catch {
                        // Body was not JSON. The status alone is enough.
                    }
                    const error = new OpenAIError(detail, response.status, retryable);
                    if (!retryable) {
                        throw error;
                    }
                    lastError = error;
                    continue;
                }

                const body = (await response.json()) as {
                    choices?: { message?: { content?: string }; finish_reason?: string }[];
                    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
                };

                this.usage.requests++;
                this.usage.promptTokens += body.usage?.prompt_tokens ?? 0;
                this.usage.completionTokens += body.usage?.completion_tokens ?? 0;
                this.usage.totalTokens += body.usage?.total_tokens ?? 0;

                const choice = body.choices?.[0];
                if (choice?.finish_reason === 'length') {
                    throw new OpenAIError('response truncated by token limit', 0, false);
                }
                const content = choice?.message?.content;
                if (!content) {
                    throw new OpenAIError('empty completion', 0, false);
                }
                return JSON.parse(content) as T;
            } catch (err) {
                if (err instanceof OpenAIError && !err.retryable) {
                    throw err;
                }
                lastError = err instanceof Error ? err : new Error(String(err));
            } finally {
                clearTimeout(timer);
            }
        }

        throw lastError ?? new Error('request failed');
    }
}
