// Policy-checked passthrough for two more wire formats, so coding agents that don't speak chat
// completions work too:
//   POST /v1/responses   OpenAI Responses API   (Codex: wire_api = "responses")
//   POST /v1/messages    Anthropic Messages API (Claude Code: ANTHROPIC_BASE_URL)
//
// Each request goes through the same pipeline as /v1/chat/completions (auth, rate limit, model
// tier, size bucket, eval() at a pinned block, deny with a signed receipt, live OKB price), then is
// forwarded to the provider's endpoint for that format with the served model and the tier's thinking
// mode. The response is passed through unchanged; usage is read from it (the final JSON, or the SSE
// events while streaming) to meter the request and sign its receipt.

import type { Context, Hono } from "hono";
import { receiptToJson, type Receipt, type Tier } from "@policyrouter/policy";
import { costWei, estimateTokens, findModel, servedModel, sizeBucket, type CatalogModel, type MeteredUsage } from "./catalog.ts";
import { ERR } from "./errors.ts";
import { hashKey, isWellFormedKey, keyFromAuthHeader } from "./keys.ts";
import { PolicyUnavailable, UnknownKey, checkPolicy } from "./policy.ts";
import type { PriceQuote } from "./price.ts";
import { newRequestId } from "./receipts.ts";
import type { AppDeps } from "./app.ts";

export interface Upstream {
  /** Provider base URL, e.g. https://api.deepseek.com */
  baseURL: string;
  apiKey: string;
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type ErrorCode = keyof typeof ANTHROPIC_ERROR;

const ANTHROPIC_ERROR = {
  invalid_api_key: "authentication_error",
  invalid_request_error: "invalid_request_error",
  model_not_found: "not_found_error",
  rate_limit_exceeded: "rate_limit_error",
  policy_denied: "permission_error",
  policy_unavailable: "api_error",
  price_unavailable: "api_error",
  upstream_error: "api_error",
} as const;

interface Protocol {
  id: "responses" | "messages";
  upstreamUrl(base: string): string;
  key(h: Headers): string | undefined;
  upstreamHeaders(apiKey: string, h: Headers): Record<string, string>;
  maxTokens(b: Json): number | undefined;
  /** Forces the tier's thinking mode onto the upstream request. */
  applyThinking(b: Json, mode: CatalogModel["thinking"]): void;
  usage(json: Json | undefined): MeteredUsage | undefined;
  /** Updates `acc` from one streamed SSE event. */
  onEvent(event: Json, acc: { usage?: MeteredUsage }): void;
  errorBody(code: ErrorCode, message: string): Json;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export const RESPONSES: Protocol = {
  id: "responses",
  upstreamUrl: (base) => `${base.replace(/\/$/, "")}/responses`,
  key: (h) => keyFromAuthHeader(h.get("authorization") ?? undefined),
  upstreamHeaders: (apiKey) => ({ authorization: `Bearer ${apiKey}`, "content-type": "application/json" }),
  maxTokens: (b) => (typeof b.max_output_tokens === "number" ? b.max_output_tokens : undefined),
  applyThinking(b, mode) {
    // DeepSeek's Responses endpoint: reasoning.effort "none" turns thinking off; the default is on.
    if (mode === "disabled") b.reasoning = { ...(b.reasoning ?? {}), effort: "none" };
    if (mode === "enabled" && b.reasoning?.effort === "none") delete b.reasoning.effort;
  },
  usage(j) {
    const u = j?.usage;
    if (!u) return undefined;
    return { promptTokens: num(u.input_tokens), cachedPromptTokens: num(u.input_tokens_details?.cached_tokens), completionTokens: num(u.output_tokens) };
  },
  onEvent(ev, acc) {
    if (ev.type === "response.completed" || ev.type === "response.incomplete" || ev.type === "response.failed") {
      acc.usage = RESPONSES.usage(ev.response) ?? acc.usage;
    }
  },
  errorBody: (code, message) => ({ error: { message, type: code, code, param: null } }),
};

export const MESSAGES: Protocol = {
  id: "messages",
  upstreamUrl: (base) => `${base.replace(/\/$/, "")}/anthropic/v1/messages`,
  // Claude Code sends the key as x-api-key (ANTHROPIC_API_KEY) or a bearer token (ANTHROPIC_AUTH_TOKEN).
  key: (h) => h.get("x-api-key") ?? keyFromAuthHeader(h.get("authorization") ?? undefined),
  upstreamHeaders: (apiKey, h) => ({
    "x-api-key": apiKey,
    "content-type": "application/json",
    "anthropic-version": h.get("anthropic-version") ?? "2023-06-01",
    ...(h.get("anthropic-beta") ? { "anthropic-beta": h.get("anthropic-beta")! } : {}),
  }),
  maxTokens: (b) => (typeof b.max_tokens === "number" ? b.max_tokens : undefined),
  applyThinking(b, mode) {
    // DeepSeek's Anthropic endpoint: thinking.type "disabled" turns it off; on by default.
    if (mode === "disabled") b.thinking = { type: "disabled" };
    if (mode === "enabled" && b.thinking?.type === "disabled") delete b.thinking;
  },
  usage(m) {
    const u = m?.usage;
    if (!u) return undefined;
    // Anthropic's input_tokens excludes cached tokens: the prompt is all three together.
    const cached = num(u.cache_read_input_tokens);
    return { promptTokens: num(u.input_tokens) + cached + num(u.cache_creation_input_tokens), cachedPromptTokens: cached, completionTokens: num(u.output_tokens) };
  },
  onEvent(ev, acc) {
    if (ev.type === "message_start") acc.usage = MESSAGES.usage(ev.message) ?? acc.usage;
    if (ev.type === "message_delta" && ev.usage) {
      const base = acc.usage ?? { promptTokens: 0, cachedPromptTokens: 0, completionTokens: 0 };
      // output_tokens is cumulative; newer servers also repeat the input counts here
      const input = ev.usage.input_tokens !== undefined ? MESSAGES.usage({ usage: ev.usage }) : undefined;
      acc.usage = { ...(input ?? base), completionTokens: num(ev.usage.output_tokens) };
    }
  },
  errorBody: (code, message) => ({ type: "error", error: { type: ANTHROPIC_ERROR[code], message } }),
};

/** Splits an SSE byte stream into JSON events, passing every byte through untouched. */
function sseTap(onEvent: (ev: Json) => void): TransformStream<Uint8Array, Uint8Array> {
  const dec = new TextDecoder();
  let buf = "";
  const scan = (final: boolean) => {
    const lines = buf.split("\n");
    buf = final ? "" : lines.pop()!;
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        onEvent(JSON.parse(data) as Json);
      } catch {
        // not JSON: pass through only
      }
    }
  };
  return new TransformStream({
    transform(chunk, ctrl) {
      ctrl.enqueue(chunk);
      buf += dec.decode(chunk, { stream: true });
      scan(false);
    },
    flush() {
      buf += dec.decode();
      scan(true);
    },
  });
}

export function registerPassthrough(app: Hono, deps: AppDeps & { upstreams: Readonly<Record<string, Upstream>>; fetchFn?: typeof fetch }) {
  const { catalog, chain, signer, store, limiter, price, log } = deps;
  const fetchFn = deps.fetchFn ?? fetch;

  const handle = async (c: Context, proto: Protocol) => {
    const started = Date.now();
    const requestId = newRequestId();
    const fail = (status: number, code: ErrorCode, message: string, extra: Json = {}, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify({ ...proto.errorBody(code, message), ...extra }), {
        status,
        headers: { "content-type": "application/json", "x-policyrouter-request-id": requestId, ...headers },
      });

    // --- authenticate and rate limit before touching the chain or a provider ---
    const key = proto.key(c.req.raw.headers);
    if (!key) return fail(401, "invalid_api_key", ERR.missingKey().error.message);
    if (!isWellFormedKey(key)) return fail(401, "invalid_api_key", ERR.badKey().error.message);
    const keyHash = hashKey(key);
    if (!limiter.take(keyHash)) return fail(429, "rate_limit_exceeded", ERR.rateLimited().error.message);

    let body: Json;
    try {
      body = (await c.req.json()) as Json;
    } catch {
      return fail(400, "invalid_request_error", "Request body must be JSON.");
    }
    if (typeof body?.model !== "string") return fail(400, "invalid_request_error", "`model` is required.");
    const requested = findModel(catalog, body.model);
    if (!requested) {
      return fail(404, "model_not_found", `Unknown model '${body.model}'. Use one of: ${catalog.models.map((m) => m.id).join(", ")}.`);
    }
    const stream = body.stream === true;
    const promptEstimate = estimateTokens(JSON.stringify(body));
    const size = sizeBucket(catalog, promptEstimate, proto.maxTokens(body));

    // --- the policy check (fails closed) ---
    let decision;
    try {
      decision = await checkPolicy(chain, keyHash, requested.tier, size);
    } catch (e) {
      if (e instanceof UnknownKey) return fail(401, "invalid_api_key", ERR.badKey().error.message);
      log.error("policy check unavailable", { requestId, keyHash, api: proto.id, error: String((e as Error).cause ?? e) });
      return fail(503, "policy_unavailable", ERR.policyUnavailable().error.message);
    }
    const quote: PriceQuote | undefined = price.current();

    const receiptOf = (served: CatalogModel | undefined, usage: MeteredUsage): Receipt => {
      const timestamp = BigInt(Math.floor(Date.now() / 1000));
      const okbUsdE8 = quote?.okbUsdE8 ?? 0n;
      return {
        requestId,
        keyHash,
        agentId: decision.agentId,
        processor: chain.processor,
        circuitId: decision.circuitId,
        inputBits: decision.inputBits,
        outputBits: decision.outputBits,
        blockNumber: decision.blockNumber,
        modelRequested: requested.id,
        modelServed: served?.id ?? "",
        promptTokens: usage.promptTokens,
        cachedPromptTokens: usage.cachedPromptTokens,
        completionTokens: usage.completionTokens,
        okbUsdE8,
        costWei: served && okbUsdE8 > 0n ? costWei(catalog, served, usage, timestamp, okbUsdE8) : 0n,
        timestamp,
      };
    };
    const record = async (r: Receipt, allowed: boolean) => {
      const { receipt, hash } = await signer.sign(r);
      store.saveReceipt(receipt, hash, allowed);
      return receiptToJson(receipt);
    };
    const NONE: MeteredUsage = { promptTokens: 0, cachedPromptTokens: 0, completionTokens: 0 };
    const done = (status: number, extra: Json = {}) =>
      log.info("request", { requestId, api: proto.id, keyHash, agentId: decision.agentId, model: requested.id, size, allow: decision.allow, routeTier: decision.routeTier, block: decision.blockNumber, status, ms: Date.now() - started, ...extra });

    if (!decision.allow) {
      const receipt = await record(receiptOf(undefined, NONE), false);
      done(403);
      return fail(403, "policy_denied", ERR.policyDenied(receipt).error.message, { policyrouter_receipt: receipt }, {
        "x-policyrouter-receipt": Buffer.from(JSON.stringify(receipt)).toString("base64url"),
      });
    }
    if (!quote) {
      done(503);
      return fail(503, "price_unavailable", ERR.priceUnavailable().error.message);
    }

    // --- forward at the tier the circuit chose ---
    const served = servedModel(catalog, requested, decision.routeTier as Tier);
    const upstream = deps.upstreams[served.provider];
    if (!upstream) {
      log.error("no upstream configured", { requestId, provider: served.provider, api: proto.id });
      return fail(500, "upstream_error", ERR.upstream().error.message);
    }
    const upstreamBody: Json = { ...body, model: served.upstreamModel };
    proto.applyThinking(upstreamBody, served.thinking);

    const upstreamFailed = async (status?: number) => {
      const receipt = await record(receiptOf(served, NONE), true); // allowed but not served: zero-cost receipt
      log.error("upstream error", { requestId, api: proto.id, provider: served.provider, status });
      done(502, { served: served.id });
      return fail(status === 400 || status === 413 || status === 422 ? status : 502, "upstream_error", ERR.upstream(status).error.message, { policyrouter_receipt: receipt });
    };

    let res: Response;
    try {
      res = await fetchFn(proto.upstreamUrl(upstream.baseURL), {
        method: "POST",
        headers: proto.upstreamHeaders(upstream.apiKey, c.req.raw.headers),
        body: JSON.stringify(upstreamBody),
        signal: c.req.raw.signal,
      });
    } catch {
      return upstreamFailed();
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return upstreamFailed(res.status);
    }

    if (!stream) {
      const json = (await res.json()) as Json;
      const usage = proto.usage(json) ?? { ...NONE, promptTokens: promptEstimate };
      const receipt = await record(receiptOf(served, usage), true);
      done(200, { served: served.id, costWei: receipt.costWei });
      return new Response(JSON.stringify({ ...json, policyrouter_receipt: receipt }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-policyrouter-request-id": requestId,
          "x-policyrouter-receipt": Buffer.from(JSON.stringify(receipt)).toString("base64url"),
        },
      });
    }

    // Streaming: bytes pass through untouched; usage is read from the events. The receipt is stored
    // when the stream ends and served at GET /v1/receipts/<x-policyrouter-request-id>.
    const acc: { usage?: MeteredUsage } = {};
    let recorded = false;
    const finish = async () => {
      if (recorded) return;
      recorded = true;
      const receipt = await record(receiptOf(served, acc.usage ?? { ...NONE, promptTokens: promptEstimate }), true);
      done(200, { served: served.id, costWei: receipt.costWei, stream: true });
    };
    const tapped = res.body!.pipeThrough(sseTap((ev) => proto.onEvent(ev, acc)));
    const reader = tapped.getReader();
    const out = new ReadableStream<Uint8Array>({
      async pull(ctrl) {
        try {
          const { value, done: end } = await reader.read();
          if (end) {
            await finish();
            ctrl.close();
            return;
          }
          ctrl.enqueue(value);
        } catch (e) {
          await finish().catch(() => undefined);
          ctrl.error(e);
        }
      },
      async cancel() {
        await reader.cancel().catch(() => undefined);
        await finish().catch(() => undefined); // meter what was served before the client left
      },
    });
    return new Response(out, {
      status: 200,
      headers: {
        "content-type": res.headers.get("content-type") ?? "text/event-stream",
        "cache-control": "no-cache",
        "x-policyrouter-request-id": requestId,
      },
    });
  };

  app.post("/v1/responses", (c) => handle(c, RESPONSES));
  app.post("/v1/messages", (c) => handle(c, MESSAGES));

  // Claude Code asks for token counts before long requests. A local estimate costs nothing and
  // needs no policy check (nothing is served).
  app.post("/v1/messages/count_tokens", async (c) => {
    const key = MESSAGES.key(c.req.raw.headers);
    if (!key || !isWellFormedKey(key)) return c.json(MESSAGES.errorBody("invalid_api_key", "Invalid API key."), 401);
    let body: Json = {};
    try {
      body = (await c.req.json()) as Json;
    } catch {
      // empty body: count 0
    }
    return c.json({ input_tokens: estimateTokens(JSON.stringify({ system: body.system, messages: body.messages, tools: body.tools })) });
  });
}
