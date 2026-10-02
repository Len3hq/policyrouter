import type OpenAI from "openai";

export type ChatParams = OpenAI.Chat.Completions.ChatCompletionCreateParams;
export type ChatCompletion = OpenAI.Chat.Completions.ChatCompletion;
export type ChatChunk = OpenAI.Chat.Completions.ChatCompletionChunk;

export interface Usage {
  promptTokens: number;
  completionTokens: number;
}

export interface Provider {
  readonly name: string;
  /** Non-streaming completion. `params.model` is already the upstream model name. */
  complete(params: ChatParams, signal?: AbortSignal): Promise<ChatCompletion>;
  /** Streaming completion. The provider is asked to include usage in the last chunk. */
  stream(params: ChatParams, signal?: AbortSignal): Promise<AsyncIterable<ChatChunk>>;
}

/** An upstream failure, safe to show to clients: it never carries the provider's own message. */
export class UpstreamError extends Error {
  constructor(
    readonly status: number | undefined,
    cause: unknown,
  ) {
    super(`upstream provider error${status ? ` (status ${status})` : ""}`, { cause });
  }
}
