// The OpenAI-compatible gateway.
//
// For every chat completion: authenticate the key → rate limit → look up the model's tier →
// bucket the request size → read chain state and call eval() at one pinned block → deny (403 with a
// signed receipt) or forward at the tier the circuit chose → meter tokens → sign and store the
// receipt → return it with the response. Any failure of the policy check refuses the request.

import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import {
  POLICYROUTER,
  SAMPLE_WORKLOAD,
  TEMPLATES,
  parseRuleId,
  ruleTemplate,
  receiptToJson,
  simRequestFromReceipt,
  simulatePolicy,
  type Receipt,
  type SimRequest,
  type Tier,
} from "@policyrouter/policy";
import type { Hex } from "viem";
import {
  costWei,
  defaultForTier,
  estimateTokens,
  findModel,
  servedModel,
  sizeBucket,
  type Catalog,
  type CatalogModel,
  type MeteredUsage,
} from "./catalog.ts";
import type { ChainReader } from "./chain.ts";
import type { Store } from "./db.ts";
import { ERR, type ErrorBody } from "./errors.ts";
import { hashKey, isWellFormedKey, keyFromAuthHeader } from "./keys.ts";
import type { Logger } from "./log.ts";
import { PolicyUnavailable, UnknownKey, checkPolicy, type Decision } from "./policy.ts";
import type { ChatChunk, ChatParams, Provider } from "./providers/types.ts";
import { UpstreamError } from "./providers/types.ts";
import type { PriceFeed, PriceQuote } from "./price.ts";
import { registerPassthrough, type Upstream } from "./passthrough.ts";
import type { RateLimiter } from "./ratelimit.ts";
import { newRequestId, type ReceiptSigner } from "./receipts.ts";

export interface AppDeps {
  catalog: Catalog;
  chain: ChainReader;
  providers: Readonly<Record<string, Provider>>;
  signer: ReceiptSigner;
  store: Store;
  limiter: RateLimiter;
  /** Live OKB/USD price; requests that would be charged are refused while it is unavailable */
  price: PriceFeed;
  log: Logger;
  /** Browser origins allowed to call the API (the web app). Default "*": keys are bearer tokens, no cookies. */
  corsOrigins?: string[];
  /** Provider endpoints for the Responses and Anthropic Messages passthrough (by catalog provider name) */
  upstreams?: Readonly<Record<string, Upstream>>;
  fetchFn?: typeof fetch;
}

export const RECEIPT_HEADER = "x-policyrouter-receipt";
export const REQUEST_ID_HEADER = "x-policyrouter-request-id";

/** Receipt as a header value: base64url of its JSON. */
export const encodeReceiptHeader = (json: object) => Buffer.from(JSON.stringify(json)).toString("base64url");

type Status = 400 | 401 | 403 | 404 | 429 | 500 | 502 | 503;

export function createApp(deps: AppDeps): Hono {
  const { catalog, chain, providers, signer, store, limiter, price, log } = deps;
  const app = new Hono();
  app.use(
    "*",
    cors({
      origin: deps.corsOrigins && deps.corsOrigins.length > 0 ? deps.corsOrigins : "*",
      allowHeaders: ["authorization", "content-type", "x-api-key", "anthropic-version", "anthropic-beta"],
      exposeHeaders: [RECEIPT_HEADER, REQUEST_ID_HEADER],
    }),
  );

  const fail = (c: Context, status: Status, body: ErrorBody, headers: Record<string, string> = {}) => {
    for (const [k, v] of Object.entries(headers)) c.header(k, v);
    return c.json(body, status);
  };

  app.get("/health", (c) => c.json({ ok: true, router: signer.address, domain: signer.domain }));

  app.get("/v1/models", (c) =>
    c.json({
      object: "list",
      data: catalog.models.map((m) => ({ id: m.id, object: "model", created: 0, owned_by: "policyrouter", tier: m.tier })),
    }),
  );

  app.get("/v1/receipts/:id", (c) => {
    const id = c.req.param("id");
    if (!/^0x[0-9a-fA-F]{64}$/.test(id)) return fail(c, 404, ERR.notFound());
    const stored = store.getReceipt(id.toLowerCase());
    if (!stored) return fail(c, 404, ERR.notFound());
    const batch = stored.batchId === null ? undefined : store.getBatch(stored.batchId);
    return c.json({
      receipt: receiptToJson(stored.receipt),
      receiptHash: stored.hash,
      allowed: stored.allowed,
      batchId: stored.batchId,
      // Check on chain with CreditEscrow.isInBatch(batchId, receiptHash, proof)
      settlement: batch
        ? {
            batchId: batch.batchId,
            status: batch.status,
            root: batch.root,
            proof: stored.proof,
            txHash: batch.txHash,
            blockNumber: batch.blockNumber?.toString() ?? null,
          }
        : null,
    });
  });

  // What each template policy would have done to this key's recent requests (or a sample workload
  // if it has none). Only the caller's own history is used: the key selects it. Without a key, the
  // sample workload is used (for choosing a policy before an agent exists).
  app.get("/v1/simulate", (c) => {
    const header = c.req.header("authorization");
    const key = keyFromAuthHeader(header);
    if (header && !key) return fail(c, 401, ERR.badKey());
    if (key && !isWellFormedKey(key)) return fail(c, 401, ERR.badKey());
    const keyHash = key ? hashKey(key) : undefined;
    if (!limiter.take(keyHash ?? `anon:${c.req.header("x-forwarded-for") ?? "local"}`)) return fail(c, 429, ERR.rateLimited());

    // a template id, or a custom rule: custom:t<maxTier>-<downgrade|deny>-s<maxSize>
    const only = c.req.query("template");
    let templates = only ? TEMPLATES.filter((t) => t.id === only) : TEMPLATES;
    if (only?.startsWith("custom:")) {
      try {
        templates = [ruleTemplate(parseRuleId(only))];
      } catch {
        return fail(c, 400, ERR.badRequest(`'${only}' isn't a custom rule. Use custom:t<0-3>-<downgrade|deny>-s<0-3>.`));
      }
    }
    if (templates.length === 0) {
      return fail(c, 400, ERR.badRequest(`Unknown template '${only}'. Known: ${TEMPLATES.map((t) => t.id).join(", ")}, or custom:t<0-3>-<downgrade|deny>-s<0-3>.`));
    }
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 100) || 100, 1), 500);

    const history = keyHash ? store.recentForKey(keyHash, limit).map(simRequestFromReceipt) : [];
    const source = history.length > 0 ? "history" : "sample";
    const requests: readonly SimRequest[] = history.length > 0 ? history : SAMPLE_WORKLOAD;

    const now = price.current();
    const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
    const priceAt = (tier: Tier, r: SimRequest) => {
      const okb = r.okbUsdE8 ?? now?.okbUsdE8;
      if (!okb) throw new Error("no OKB price");
      return costWei(catalog, defaultForTier(catalog, tier), r, r.timestamp ?? nowSeconds, okb);
    };
    if (!now && requests.some((r) => !r.okbUsdE8)) return fail(c, 503, ERR.priceUnavailable());

    const circuits = POLICYROUTER.circuits as Readonly<Record<string, bigint>>;
    return c.json({
      source,
      requests: requests.length,
      results: templates.map((t) => {
        const r = simulatePolicy(t, requests, priceAt);
        return {
          template: t.id,
          name: t.name,
          rule: t.rule,
          circuitId: circuits[t.id]?.toString() ?? null,
          ...r,
          spendWithout: r.spendWithout.toString(),
          spendWith: r.spendWith.toString(),
        };
      }),
    });
  });

  // An agent's own usage, for its dashboard: decision counts, spend, and recent requests.
  app.get("/v1/usage", (c) => {
    const key = keyFromAuthHeader(c.req.header("authorization"));
    if (!key) return fail(c, 401, ERR.missingKey());
    if (!isWellFormedKey(key)) return fail(c, 401, ERR.badKey());
    const keyHash = hashKey(key);
    if (!limiter.take(keyHash)) return fail(c, 429, ERR.rateLimited());
    const u = store.usageForKey(keyHash);
    const recent = store.recentForKey(keyHash, 20).map((r) => ({
      requestId: r.requestId,
      modelRequested: r.modelRequested,
      modelServed: r.modelServed,
      allowed: (r.outputBits & 1) === 1,
      downgraded: (r.outputBits & 1) === 1 && r.outputBits >> 1 < (r.inputBits & 3),
      costWei: r.costWei.toString(),
      timestamp: r.timestamp.toString(),
    }));
    return c.json({ ...u, spentWei: u.spentWei.toString(), unsettledWei: u.unsettledWei.toString(), recent });
  });

  app.post("/v1/chat/completions", async (c) => {
    const started = Date.now();
    const requestId = newRequestId();

    // --- authenticate and rate limit before touching the chain or a provider ---
    const key = keyFromAuthHeader(c.req.header("authorization"));
    if (!key) return fail(c, 401, ERR.missingKey());
    if (!isWellFormedKey(key)) return fail(c, 401, ERR.badKey());
    const keyHash = hashKey(key);
    if (!limiter.take(keyHash)) return fail(c, 429, ERR.rateLimited());

    // --- validate the request ---
    let body: ChatParams & { stream?: boolean };
    try {
      body = await c.req.json();
    } catch {
      return fail(c, 400, ERR.badRequest("Request body must be JSON."));
    }
    if (typeof body?.model !== "string") return fail(c, 400, ERR.badRequest("`model` is required."));
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return fail(c, 400, ERR.badRequest("`messages` must be a non-empty array."));
    }
    const requested = findModel(catalog, body.model);
    if (!requested) return fail(c, 404, ERR.unknownModel(body.model));

    const promptEstimate = estimateTokens(JSON.stringify(body.messages) + (body.tools ? JSON.stringify(body.tools) : ""));
    const maxTokens = body.max_completion_tokens ?? body.max_tokens ?? undefined;
    const size = sizeBucket(catalog, promptEstimate, maxTokens);

    // --- the policy check (fails closed) ---
    let decision: Decision;
    try {
      decision = await checkPolicy(chain, keyHash, requested.tier, size);
    } catch (e) {
      if (e instanceof UnknownKey) return fail(c, 401, ERR.badKey());
      log.error("policy check unavailable", { requestId, keyHash, error: String((e as Error).cause ?? e) });
      return fail(c, 503, ERR.policyUnavailable());
    }

    const NO_USAGE: MeteredUsage = { promptTokens: 0, cachedPromptTokens: 0, completionTokens: 0 };
    // One OKB price per request, taken before forwarding, so a stream is priced at the rate it started with.
    let quote: PriceQuote | undefined;
    const receiptBase = (served: CatalogModel | undefined, usage: MeteredUsage): Receipt => {
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

    const done = (status: number, extra: Record<string, unknown> = {}) =>
      log.info("request", {
        requestId,
        keyHash,
        agentId: decision.agentId,
        model: requested.id,
        tier: requested.tier,
        size,
        allow: decision.allow,
        routeTier: decision.routeTier,
        block: decision.blockNumber,
        status,
        ms: Date.now() - started,
        ...extra,
      });

    quote = price.current();
    if (!decision.allow) {
      const receipt = await record(receiptBase(undefined, NO_USAGE), false);
      done(403);
      return fail(c, 403, ERR.policyDenied(receipt), {
        [RECEIPT_HEADER]: encodeReceiptHeader(receipt),
        [REQUEST_ID_HEADER]: requestId,
      });
    }

    // --- no fresh OKB price: refuse rather than guess what to charge (fail closed) ---
    if (!quote) {
      log.error("no fresh OKB price; refusing request", { requestId, keyHash });
      done(503);
      return fail(c, 503, ERR.priceUnavailable());
    }

    // --- forward at the tier the circuit chose ---
    const served = servedModel(catalog, requested, decision.routeTier as Tier);
    const provider = providers[served.provider];
    if (!provider) {
      if (deps.upstreams?.[served.provider]) {
        // the provider exists but has no chat completions endpoint
        return fail(c, 400, ERR.badRequest(`Model '${served.id}' is served by ${served.provider}, which has no chat completions API. Use /v1/responses or /v1/messages.`));
      }
      log.error("no provider configured", { requestId, provider: served.provider });
      return fail(c, 500, ERR.upstream());
    }
    const { stream: wantsStream, stream_options: _so, ...rest } = body as ChatParams & { stream?: boolean; stream_options?: unknown };
    // The tier decides thinking mode, not the agent: a client can't buy thinking at a non-thinking tier.
    const upstreamParams = { ...rest, model: served.upstreamModel } as ChatParams & Record<string, unknown>;
    if (served.thinking) {
      upstreamParams.thinking = { type: served.thinking };
      if (served.thinking === "disabled") delete upstreamParams.reasoning_effort;
    }

    if (!wantsStream) {
      let completion;
      try {
        completion = await provider.complete(upstreamParams, c.req.raw.signal);
      } catch (e) {
        return upstreamFailure(c, e, served);
      }
      const usage = completion.usage
        ? meteredUsage(completion.usage)
        : { ...NO_USAGE, promptTokens: promptEstimate, completionTokens: estimateTokens(completion.choices.map((x) => x.message?.content ?? "").join("")) };
      const receipt = await record(receiptBase(served, usage), true);
      done(200, { served: served.id, costWei: receipt.costWei });
      c.header(RECEIPT_HEADER, encodeReceiptHeader(receipt));
      c.header(REQUEST_ID_HEADER, requestId);
      return c.json({ ...completion, model: served.id, policyrouter_receipt: receipt });
    }

    // --- streaming ---
    const abort = new AbortController();
    c.req.raw.signal.addEventListener("abort", () => abort.abort());
    let upstream: AsyncIterable<ChatChunk>;
    try {
      upstream = await provider.stream(upstreamParams, abort.signal);
    } catch (e) {
      return upstreamFailure(c, e, served);
    }

    const enc = new TextEncoder();
    const sse = (data: unknown) => enc.encode(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
    let usage: MeteredUsage | undefined;
    let text = "";
    let last: Pick<ChatChunk, "id" | "created"> = { id: requestId, created: Math.floor(Date.now() / 1000) };
    let finished = false;

    const finish = async () => {
      if (finished) return undefined;
      finished = true;
      const u = usage ?? { ...NO_USAGE, promptTokens: promptEstimate, completionTokens: estimateTokens(text) };
      const receipt = await record(receiptBase(served, u), true);
      done(200, { served: served.id, costWei: receipt.costWei, stream: true });
      return receipt;
    };

    const out = new ReadableStream<Uint8Array>({
      async start(ctrl) {
        try {
          for await (const chunk of upstream) {
            last = { id: chunk.id, created: chunk.created };
            if (chunk.usage) usage = meteredUsage(chunk.usage);
            for (const ch of chunk.choices ?? []) text += ch.delta?.content ?? "";
            ctrl.enqueue(sse({ ...chunk, model: served.id }));
          }
          const receipt = await finish();
          ctrl.enqueue(
            sse({ id: last.id, object: "chat.completion.chunk", created: last.created, model: served.id, choices: [], policyrouter_receipt: receipt }),
          );
          ctrl.enqueue(sse("[DONE]"));
          ctrl.close();
        } catch (e) {
          await finish().catch(() => undefined); // meter what was served before the failure
          log.error("stream failed", { requestId, error: e instanceof UpstreamError ? e.message : String(e) });
          try {
            ctrl.enqueue(sse(ERR.upstream()));
            ctrl.close();
          } catch {
            // client already gone
          }
        }
      },
      cancel() {
        abort.abort();
      },
    });

    return new Response(out, {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
        [REQUEST_ID_HEADER]: requestId,
      },
    });

    async function upstreamFailure(ctx: Context, e: unknown, m: CatalogModel) {
      const status = e instanceof UpstreamError ? e.status : undefined;
      // Allowed by policy but not served: keep a zero-cost receipt for the audit trail.
      const receipt = await record(receiptBase(m, NO_USAGE), true);
      log.error("upstream error", { requestId, provider: m.provider, status });
      done(502, { served: m.id });
      return fail(ctx, 502, { ...ERR.upstream(status), policyrouter_receipt: receipt }, { [REQUEST_ID_HEADER]: requestId });
    }
  });

  if (deps.upstreams) registerPassthrough(app, { ...deps, upstreams: deps.upstreams });

  app.notFound((c) => c.json(ERR.notFound(), 404));
  app.onError((e, c) => {
    log.error("unhandled", { error: String(e) });
    return c.json(ERR.upstream(), 500);
  });

  return app;
}

/**
 * Provider usage → metered usage. DeepSeek reports `prompt_cache_hit_tokens`; OpenAI-style providers
 * report `prompt_tokens_details.cached_tokens`. With neither, every prompt token is billed as a miss.
 */
export function meteredUsage(u: {
  prompt_tokens: number;
  completion_tokens: number;
  prompt_cache_hit_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
}): MeteredUsage {
  const cached = u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0;
  return { promptTokens: u.prompt_tokens, cachedPromptTokens: Math.min(cached, u.prompt_tokens), completionTokens: u.completion_tokens };
}

export type { Hex };
