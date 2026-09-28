/**
 * Annotation providers behind one interface.
 *
 * Each provider owns its client, default model, prompt version and response validation. Commands
 * only pick one by name, so adding a provider never means editing a command's control flow.
 */

import { configFromEnv, OpenAIClient } from './client';
import { type Usage } from './http';
import { annotateBlocks, annotateBlocksWithTypeSafe, type AnnotationResult } from './llm';
import { PROMPT_VERSION } from './prompt';
import { TYPESAFE_DEFAULT_MODEL, TypeSafeClient, typeSafeConfigFromEnv } from './typesafe-client';
import { TYPESAFE_PROMPT_VERSION } from './typesafe-prompt';
import { type Block } from '../segment/types';

export interface Annotator {
    readonly model: string;
    readonly promptVersion: string;
    readonly usage: Usage;
    annotate(blocks: readonly Block[], isReply: boolean): Promise<AnnotationResult>;
}

interface ProviderSpec {
    defaultModel: string;
    promptVersion: string;
    /** Throws, before anything is sent, when the provider's key is not configured. */
    create(model: string): Annotator;
}

export const PROVIDERS: Readonly<Record<string, ProviderSpec>> = {
    openai: {
        defaultModel: 'gpt-5.6-sol',
        promptVersion: PROMPT_VERSION,
        create(model) {
            const client = new OpenAIClient(configFromEnv(model));
            return { model, promptVersion: PROMPT_VERSION, usage: client.usage, annotate: (blocks, isReply) => annotateBlocks(client, blocks, isReply) };
        }
    },
    typesafe: {
        defaultModel: TYPESAFE_DEFAULT_MODEL,
        promptVersion: TYPESAFE_PROMPT_VERSION,
        create(model) {
            const client = new TypeSafeClient(typeSafeConfigFromEnv(model));
            return {
                model,
                promptVersion: TYPESAFE_PROMPT_VERSION,
                usage: client.usage,
                annotate: (blocks, isReply) => annotateBlocksWithTypeSafe(client, blocks, isReply)
            };
        }
    }
};

/** The provider registered under `name`, or null. Own properties only, so `constructor` is not one. */
export function provider(name: string): ProviderSpec | null {
    return Object.hasOwn(PROVIDERS, name) ? (PROVIDERS[name] as ProviderSpec) : null;
}
