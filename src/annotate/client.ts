/**
 * Minimal OpenAI chat completions client.
 *
 * No SDK dependency: this project ships three runtime dependencies and none of them opens a socket.
 * Adding a vendor SDK for one optional command would change that materially, and the surface used
 * here is a single POST with a JSON schema response format.
 *
 * This is one of the two places in the codebase that send message content off the machine, the
 * other being `typesafe-client.ts`. Both are only reachable from `email-content annotate`, never
 * from `extract()` or the corpus scanner. See
 * docs/threat-model.md, "Configured exception: LLM annotation".
 */

import { ApiError, apiConfigFromEnv, postJson, type ApiConfig, type Usage } from './http';

export type { Usage } from './http';

export type OpenAIConfig = ApiConfig;

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

export class OpenAIError extends ApiError {
    constructor(message: string, status: number, retryable: boolean) {
        super(message, status, retryable);
        this.name = 'OpenAIError';
    }
}

/** Load configuration from the environment, after process.loadEnvFile(). */
export function configFromEnv(model: string, overrides: Partial<OpenAIConfig> = {}): OpenAIConfig {
    return apiConfigFromEnv({ keyVar: 'OPENAI_API_KEY', urlVar: 'OPENAI_BASE_URL', defaultUrl: 'https://api.openai.com/v1' }, model, overrides);
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
        return postJson<T>({
            url: `${this.config.baseUrl}/chat/completions`,
            apiKey: this.config.apiKey,
            policy: this.config,
            payload: {
                model: this.config.model,
                messages: [
                    { role: 'system', content: request.system },
                    { role: 'user', content: request.user }
                ],
                response_format: {
                    type: 'json_schema',
                    json_schema: { name: request.schemaName, strict: true, schema: request.schema }
                }
            },
            httpError: (status, body) => {
                const message = (body as { error?: { message?: string } } | null)?.error?.message;
                return new OpenAIError(message ? message.slice(0, 300) : `HTTP ${status}`, status, status === 429 || status >= 500);
            },
            parse: raw => {
                const body = raw as {
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
            }
        });
    }
}
