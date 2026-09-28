/**
 * Minimal TypeSafe System One client.
 *
 * No SDK dependency, for the same reason as the OpenAI client: the package ships three runtime
 * dependencies and none of them opens a socket. `@typesafe-ai/sdk` could only be a dev dependency,
 * and `dist/cli` is part of the published tarball, so an installed `email-content annotate` would
 * fail to load it. The surface used here is one POST.
 *
 * This is the second place in the codebase that sends message content off the machine, under the
 * same terms as the first: only reachable from `email-content annotate`, opt in, fails closed
 * without a key. See docs/threat-model.md, "Configured exception: LLM annotation".
 */

import { ApiError, apiConfigFromEnv, postJson, type ApiConfig, type Usage } from './http';

/**
 * Pinned rather than `jev-latest`: labels are stored with the model that produced them, and an
 * alias that silently moves would put two models' output under one name.
 */
export const TYPESAFE_DEFAULT_MODEL = 'jev-1.13.0';

export type TypeSafeConfig = ApiConfig;

export interface ChoiceQuestion {
    type: 'choice';
    instructions: string | Record<string, unknown>;
    criteria: Record<string, string | Record<string, unknown> | null>;
}

export interface SystemOneRequest {
    state: unknown;
    questions: Record<string, ChoiceQuestion>;
}

/** One answer as returned. Fields are unvalidated until the annotator checks them. */
export interface ChoiceAnswer {
    choice?: unknown;
    probabilities?: unknown;
    confidence?: unknown;
}

export interface SystemOneResponse {
    answers: Record<string, ChoiceAnswer>;
}

/** The narrow surface the annotator depends on, so its validation can be tested without a network. */
export interface SystemOneClient {
    readonly model: string;
    ask(request: SystemOneRequest): Promise<SystemOneResponse>;
}

export class TypeSafeError extends ApiError {
    constructor(message: string, status: number, retryable: boolean) {
        super(message, status, retryable);
        this.name = 'TypeSafeError';
    }
}

/** Load configuration from the environment, after process.loadEnvFile(). */
export function typeSafeConfigFromEnv(model: string, overrides: Partial<TypeSafeConfig> = {}): TypeSafeConfig {
    return apiConfigFromEnv({ keyVar: 'TYPESAFE_API_KEY', urlVar: 'TYPESAFE_BASE_URL', defaultUrl: 'https://api.typesafe.ai/v1' }, model, overrides);
}

export class TypeSafeClient implements SystemOneClient {
    private readonly config: TypeSafeConfig;
    /** Input tokens are reported as prompt tokens, output tokens as completion tokens. */
    readonly usage: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, requests: 0 };

    constructor(config: TypeSafeConfig) {
        this.config = config;
    }

    get model(): string {
        return this.config.model;
    }

    /**
     * Ask a set of questions about one state.
     *
     * Retries on rate limits (429), overload (529) and other server errors. Anything else, a 422
     * validation failure in particular, is a bug in the request and is not retried. Error messages
     * carry the status only, never the response body: a validation error may echo the state back,
     * and the state is private mail.
     */
    async ask(request: SystemOneRequest): Promise<SystemOneResponse> {
        return postJson<SystemOneResponse>({
            url: `${this.config.baseUrl}/systemone`,
            apiKey: this.config.apiKey,
            policy: this.config,
            payload: { model: this.config.model, state: request.state, questions: request.questions },
            httpError: status => new TypeSafeError(`TypeSafe HTTP ${status}`, status, status === 429 || status >= 500),
            parse: raw => {
                const body = raw as { answers?: unknown; usage?: { input_tokens?: unknown; output_tokens?: unknown } } | null;
                if (!body || typeof body.answers !== 'object' || body.answers === null) {
                    throw new TypeSafeError('TypeSafe response has no answers', 0, false);
                }

                const input = typeof body.usage?.input_tokens === 'number' ? body.usage.input_tokens : 0;
                const output = typeof body.usage?.output_tokens === 'number' ? body.usage.output_tokens : 0;
                this.usage.requests++;
                this.usage.promptTokens += input;
                this.usage.completionTokens += output;
                this.usage.totalTokens += input + output;

                return { answers: body.answers as Record<string, ChoiceAnswer> };
            }
        });
    }
}
