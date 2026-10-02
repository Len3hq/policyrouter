// Any OpenAI-compatible provider (DeepSeek first). The provider key lives only in this object.

import OpenAI from "openai";
import { UpstreamError, type ChatChunk, type ChatCompletion, type ChatParams, type Provider } from "./types.ts";

export interface OpenAICompatibleConfig {
  name: string;
  baseURL: string;
  apiKey: string;
  timeoutMs?: number;
}

export function createOpenAICompatibleProvider(cfg: OpenAICompatibleConfig): Provider {
  const client = new OpenAI({ baseURL: cfg.baseURL, apiKey: cfg.apiKey, timeout: cfg.timeoutMs ?? 120_000, maxRetries: 1 });

  const wrap = (e: unknown): never => {
    if (e instanceof OpenAI.APIError) throw new UpstreamError(e.status, e);
    throw new UpstreamError(undefined, e);
  };

  return {
    name: cfg.name,

    async complete(params, signal) {
      try {
        return (await client.chat.completions.create({ ...params, stream: false }, { signal })) as ChatCompletion;
      } catch (e) {
        return wrap(e);
      }
    },

    async stream(params, signal) {
      try {
        const s = await client.chat.completions.create(
          { ...params, stream: true, stream_options: { include_usage: true } },
          { signal },
        );
        return s as AsyncIterable<ChatChunk>;
      } catch (e) {
        return wrap(e);
      }
    },
  };
}
