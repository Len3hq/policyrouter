import { describe, expect, it } from "vitest";
import { receiptFromJson, recoverReceiptSigner, type ReceiptJson } from "@policyrouter/policy";
import { generateKey, hashKey } from "../../src/keys.ts";
import { RECEIPT_HEADER, meteredUsage } from "../../src/app.ts";
import { costWei, findModel, loadCatalog } from "../../src/catalog.ts";
import { staticPriceFeed } from "../../src/price.ts";
import { UpstreamError } from "../../src/providers/types.ts";
import { PROVIDER_SECRET, makeApp } from "./fakes.ts";

const KEY = generateKey();

function setup(circuitId = 1n, state: Partial<{ killed: boolean; budgetOk: boolean }> = {}, opts: Parameters<typeof makeApp>[0] = {}) {
  const t = makeApp(opts);
  t.chain.keys.set(hashKey(KEY), { agentId: 9n, circuitId, killed: false, budgetOk: true, ...state });
  return t;
}

const chat = (t: ReturnType<typeof makeApp>, body: Record<string, unknown>, key: string | null = KEY) =>
  t.app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body),
  });

const msg = { messages: [{ role: "user", content: "hi" }] };

describe("auth", () => {
  it("401 for a missing, malformed or unknown key, without calling the chain or provider", async () => {
    const t = setup();
    expect((await chat(t, { model: "standard", ...msg }, null)).status).toBe(401);
    expect((await chat(t, { model: "standard", ...msg }, "pr-live-short")).status).toBe(401);
    expect(t.chain.evalCalls).toBe(0);

    const unknown = await chat(t, { model: "standard", ...msg }, generateKey());
    expect(unknown.status).toBe(401);
    expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe("invalid_api_key");
    expect(t.provider.calls).toHaveLength(0);
  });

  it("never logs the API key", async () => {
    const t = setup();
    await chat(t, { model: "standard", ...msg });
    await chat(t, { model: "standard", ...msg }, generateKey());
    expect(t.lines.join("\n")).not.toContain(KEY);
  });
});

describe("request validation", () => {
  it("404 model_not_found for unknown models", async () => {
    const t = setup();
    const r = await chat(t, { model: "gpt-9", ...msg });
    expect(r.status).toBe(404);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("model_not_found");
  });

  it("400 for bad bodies", async () => {
    const t = setup();
    expect((await chat(t, { messages: msg.messages })).status).toBe(400);
    expect((await chat(t, { model: "standard", messages: [] })).status).toBe(400);
    const r = await t.app.request("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}` },
      body: "not json",
    });
    expect(r.status).toBe(400);
  });

  it("429 when the key is over its rate limit", async () => {
    const t = setup(1n, {}, { rateLimit: 2 });
    expect((await chat(t, { model: "standard", ...msg })).status).toBe(200);
    expect((await chat(t, { model: "standard", ...msg })).status).toBe(200);
    expect((await chat(t, { model: "standard", ...msg })).status).toBe(429);
  });
});

describe("policy decisions", () => {
  it("allows: forwards the requested model, returns a signed receipt in body and header, stores it", async () => {
    const t = setup();
    const r = await chat(t, { model: "frontier", max_tokens: 100, ...msg });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { model: string; policyrouter_receipt: ReceiptJson };
    expect(body.model).toBe("frontier");
    expect(t.provider.calls[0]!.model).toBe("deepseek-v4-pro");

    const receipt = receiptFromJson(body.policyrouter_receipt);
    expect(receipt).toMatchObject({ modelRequested: "frontier", modelServed: "frontier", agentId: 9n, circuitId: 1n, blockNumber: 100n });
    expect(receipt.inputBits).toBe(0b010011); // budget ok, size 0 (small), tier 3
    expect(receipt.promptTokens).toBe(100);
    expect(receipt.costWei).toBeGreaterThan(0n);
    expect(await recoverReceiptSigner(receipt, t.domain)).toBe(t.account.address);

    const header = JSON.parse(Buffer.from(r.headers.get(RECEIPT_HEADER)!, "base64url").toString());
    expect(header).toEqual(body.policyrouter_receipt);
    expect(t.store.getReceipt(receipt.requestId)?.allowed).toBe(true);
  });

  it("downgrades: Cheap Only serves the standard model and charges standard prices", async () => {
    const t = setup(2n);
    const r = await chat(t, { model: "frontier", ...msg });
    const body = (await r.json()) as { model: string; policyrouter_receipt: ReceiptJson };
    expect(body.model).toBe("standard");
    expect(t.provider.calls[0]!.model).toBe("deepseek-flash");
    expect(body.policyrouter_receipt.modelRequested).toBe("frontier");
    expect(body.policyrouter_receipt.modelServed).toBe("standard");
    // charged at the served (standard) model's price for the time of the request
    const rc = receiptFromJson(body.policyrouter_receipt);
    const catalog = loadCatalog();
    expect(rc.costWei).toBe(costWei(catalog, findModel(catalog, "standard")!, rc, rc.timestamp, rc.okbUsdE8));
    expect(rc.costWei).toBeLessThan(costWei(catalog, findModel(catalog, "frontier")!, rc, rc.timestamp, rc.okbUsdE8));
  });

  it("records cached prompt tokens and bills them at the cache-hit rate", async () => {
    const t = setup();
    const r = receiptFromJson(((await (await chat(t, { model: "cheap", ...msg })).json()) as { policyrouter_receipt: ReceiptJson }).policyrouter_receipt);
    expect(r).toMatchObject({ promptTokens: 100, cachedPromptTokens: 40, completionTokens: 50 });
    const catalog = loadCatalog();
    const cheap = findModel(catalog, "cheap")!;
    expect(r.costWei).toBe(costWei(catalog, cheap, r, r.timestamp, r.okbUsdE8));
    expect(r.costWei).toBeLessThan(costWei(catalog, cheap, { ...r, cachedPromptTokens: 0 }, r.timestamp, r.okbUsdE8));
  });

  it("records the live OKB price in the receipt and charges at it", async () => {
    const at = (usd: string) => {
      const t = makeApp({ price: staticPriceFeed(usd) });
      t.chain.keys.set(hashKey(KEY), { agentId: 9n, circuitId: 1n, killed: false, budgetOk: true });
      return t;
    };
    const cost = async (usd: string) =>
      receiptFromJson(((await (await chat(at(usd), { model: "cheap", ...msg })).json()) as { policyrouter_receipt: ReceiptJson }).policyrouter_receipt);
    const r100 = await cost("100");
    const r200 = await cost("200");
    expect(r100.okbUsdE8).toBe(10_000_000_000n);
    expect(r200.okbUsdE8).toBe(20_000_000_000n);
    // OKB at twice the price → about half as much OKB for the same USD cost
    expect(r100.costWei / r200.costWei).toBe(2n);
  });

  it("fails closed: 503 price_unavailable with no fresh OKB price, provider not called", async () => {
    const t = setup(1n, {}, { price: { current: () => undefined, refresh: async () => undefined, start() {}, stop() {} } });
    const r = await chat(t, { model: "standard", ...msg });
    expect(r.status).toBe(503);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("price_unavailable");
    expect(t.provider.calls).toHaveLength(0);
  });

  it("still denies with a receipt when there is no price (denials cost nothing)", async () => {
    const t = setup(1n, { killed: true }, { price: { current: () => undefined, refresh: async () => undefined, start() {}, stop() {} } });
    const r = await chat(t, { model: "standard", ...msg });
    expect(r.status).toBe(403);
    expect(((await r.json()) as { policyrouter_receipt: ReceiptJson }).policyrouter_receipt).toMatchObject({ costWei: "0", okbUsdE8: "0" });
  });

  it("forces the tier's thinking mode, whatever the agent asks for", async () => {
    const t = setup();
    await chat(t, { model: "cheap", thinking: { type: "enabled" }, reasoning_effort: "max", ...msg });
    await chat(t, { model: "standard", thinking: { type: "disabled" }, ...msg });
    const [cheap, standard] = t.provider.calls as unknown as Record<string, unknown>[];
    expect(cheap!.model).toBe("deepseek-flash");
    expect(cheap!.thinking).toEqual({ type: "disabled" });
    expect(cheap!.reasoning_effort).toBeUndefined();
    expect(standard!.model).toBe("deepseek-flash");
    expect(standard!.thinking).toEqual({ type: "enabled" });
  });

  it("reads cache hits from DeepSeek or OpenAI usage shapes", () => {
    expect(meteredUsage({ prompt_tokens: 10, completion_tokens: 2, prompt_cache_hit_tokens: 4 }).cachedPromptTokens).toBe(4);
    expect(meteredUsage({ prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 3 } }).cachedPromptTokens).toBe(3);
    expect(meteredUsage({ prompt_tokens: 10, completion_tokens: 2 }).cachedPromptTokens).toBe(0);
    expect(meteredUsage({ prompt_tokens: 10, completion_tokens: 2, prompt_cache_hit_tokens: 99 }).cachedPromptTokens).toBe(10);
  });

  it("denies: 403 policy_denied with a receipt, no provider call, zero cost", async () => {
    const t = setup(1n, { killed: true });
    const r = await chat(t, { model: "standard", ...msg });
    expect(r.status).toBe(403);
    const body = (await r.json()) as { error: { code: string }; policyrouter_receipt: ReceiptJson };
    expect(body.error.code).toBe("policy_denied");
    expect(body.policyrouter_receipt).toMatchObject({ outputBits: "0b000", modelServed: "", costWei: "0" });
    expect(r.headers.get(RECEIPT_HEADER)).toBeTruthy();
    expect(t.provider.calls).toHaveLength(0);
    expect(t.store.getReceipt(body.policyrouter_receipt.requestId)?.allowed).toBe(false);
  });

  it("fails closed: 503 when the chain cannot be read, no provider call", async () => {
    const t = setup();
    t.chain.failRead = true;
    const r = await chat(t, { model: "standard", ...msg });
    expect(r.status).toBe(503);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("policy_unavailable");
    expect(t.provider.calls).toHaveLength(0);
  });

  it("buckets size from the prompt plus max tokens, defaulting to 4,096 output tokens", async () => {
    const t = setup();
    const bits = async (extra: Record<string, unknown>) =>
      receiptFromJson(((await (await chat(t, { model: "cheap", ...msg, ...extra })).json()) as { policyrouter_receipt: ReceiptJson }).policyrouter_receipt).inputBits;
    expect((await bits({ max_tokens: 100 })) >> 2 & 3).toBe(0);
    expect((await bits({})) >> 2 & 3).toBe(1);
    expect((await bits({ max_completion_tokens: 10_000 })) >> 2 & 3).toBe(2);
    expect((await bits({ max_tokens: 50_000 })) >> 2 & 3).toBe(3);
  });

  it("fails closed: 503 when eval fails", async () => {
    const t = setup();
    t.chain.failEval = true;
    expect((await chat(t, { model: "standard", ...msg })).status).toBe(503);
    expect(t.provider.calls).toHaveLength(0);
  });
});

describe("upstream errors", () => {
  it("502 without the provider's message or key", async () => {
    const t = setup();
    t.provider.fail = new UpstreamError(401, new Error(`Authentication Fails, your api key: ${PROVIDER_SECRET} is invalid`));
    const r = await chat(t, { model: "standard", ...msg });
    expect(r.status).toBe(502);
    const text = await r.text();
    expect(text).not.toContain(PROVIDER_SECRET);
    expect(text).toContain("upstream_error");
    expect(t.lines.join("\n")).not.toContain(PROVIDER_SECRET);
  });
});

describe("streaming", () => {
  it("passes chunks through in order, then a receipt chunk, then [DONE]", async () => {
    const t = setup(2n);
    const r = await chat(t, { model: "premium", stream: true, ...msg });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/event-stream");
    const events = (await r.text())
      .split("\n\n")
      .filter(Boolean)
      .map((e) => e.replace(/^data: /, ""));
    expect(events.at(-1)).toBe("[DONE]");
    const chunks = events.slice(0, -1).map((e) => JSON.parse(e));
    expect(chunks.map((c) => c.choices[0]?.delta?.content).filter(Boolean).join("")).toBe("Hello");
    expect(chunks.every((c) => c.model === "standard")).toBe(true);

    const receipt = chunks.at(-1).policyrouter_receipt as ReceiptJson;
    expect(receipt).toMatchObject({ modelRequested: "premium", modelServed: "standard", promptTokens: 100, completionTokens: 50 });
    expect(await recoverReceiptSigner(receiptFromJson(receipt), t.domain)).toBe(t.account.address);
    expect(t.store.getReceipt(receipt.requestId)).toBeDefined();
    expect(t.provider.calls[0]!.model).toBe("deepseek-flash");
  });

  it("a denied streaming request is a plain 403 JSON error", async () => {
    const t = setup(1n, { budgetOk: false });
    const r = await chat(t, { model: "standard", stream: true, ...msg });
    expect(r.status).toBe(403);
    expect(r.headers.get("content-type")).toContain("application/json");
  });
});

describe("other endpoints", () => {
  it("GET /v1/models lists the catalog with tiers", async () => {
    const t = setup();
    const body = (await (await t.app.request("/v1/models")).json()) as { data: { id: string; tier: number }[] };
    expect(body.data.map((m) => [m.id, m.tier])).toEqual([
      ["cheap", 0],
      ["standard", 1],
      ["premium", 2],
      ["frontier", 3],
    ]);
  });

  it("GET /v1/receipts/:id returns a stored receipt and 404s otherwise", async () => {
    const t = setup();
    const body = (await (await chat(t, { model: "cheap", ...msg })).json()) as { policyrouter_receipt: ReceiptJson };
    const id = body.policyrouter_receipt.requestId;
    const got = (await (await t.app.request(`/v1/receipts/${id}`)).json()) as { receipt: ReceiptJson; allowed: boolean; batchId: null };
    expect(got.receipt).toEqual(body.policyrouter_receipt);
    expect(got.allowed).toBe(true);
    expect(got.batchId).toBeNull();
    expect((await t.app.request(`/v1/receipts/0x${"00".repeat(32)}`)).status).toBe(404);
    expect((await t.app.request("/v1/receipts/nope")).status).toBe(404);
  });
});

describe("GET /v1/usage/history", () => {
  interface History {
    agentId: string;
    bucketMs: number;
    totals: { requests: number; allowed: number; downgraded: number; denied: number; spentWei: string; promptTokens: number };
    series: { start: number; allowed: number; downgraded: number; denied: number; spentWei: string }[];
    byModel: { model: string; requests: number; spentWei: string }[];
    receipts: { requestId: string; decision: string; modelServed: string; costWei: string; settled: boolean }[];
  }
  const history = (t: ReturnType<typeof makeApp>, key: string, range?: string) =>
    t.app.request(`/v1/usage/history${range ? `?range=${range}` : ""}`, { headers: { authorization: `Bearer ${key}` } });

  it("buckets an agent's decisions and spend, by served model, newest receipts first", async () => {
    const t = setup(2n); // Cheap Only: frontier is downgraded to standard
    await chat(t, { model: "cheap", ...msg });
    await chat(t, { model: "frontier", ...msg });
    t.chain.keys.set(hashKey(KEY), { agentId: 9n, circuitId: 2n, killed: true, budgetOk: true });
    await chat(t, { model: "cheap", ...msg });
    t.chain.keys.set(hashKey(KEY), { agentId: 9n, circuitId: 2n, killed: false, budgetOk: true });

    const res = await history(t, KEY, "24h");
    expect(res.status).toBe(200);
    const h = (await res.json()) as History;
    expect(h.agentId).toBe("9");
    expect(h.bucketMs).toBe(3_600_000);
    expect(h.totals).toMatchObject({ requests: 3, allowed: 1, downgraded: 1, denied: 1, promptTokens: 200 });
    expect(h.series.length).toBeGreaterThanOrEqual(24);
    const last = h.series.at(-1)!;
    expect([last.allowed, last.downgraded, last.denied]).toEqual([1, 1, 1]);
    expect(h.series.reduce((s, b) => s + BigInt(b.spentWei), 0n)).toBe(BigInt(h.totals.spentWei));
    expect(h.byModel.map((m) => m.model).sort()).toEqual(["cheap", "standard"]);
    expect(h.receipts.map((r) => r.decision)).toEqual(["denied", "downgraded", "allowed"]);
    expect(h.receipts[0]!.costWei).toBe("0");
    expect(h.receipts.every((r) => !r.settled)).toBe(true);
  });

  it("follows the agent across a key rotation, and refuses the rotated-out key", async () => {
    const t = setup();
    await chat(t, { model: "cheap", ...msg });
    const next = generateKey();
    t.chain.keys.delete(hashKey(KEY));
    t.chain.keys.set(hashKey(next), { agentId: 9n, circuitId: 1n, killed: false, budgetOk: true });
    await chat(t, { model: "cheap", ...msg }, next);

    const h = (await (await history(t, next)).json()) as History;
    expect(h.totals.requests).toBe(2);
    expect((await history(t, KEY)).status).toBe(401);
  });

  it("pendingWei counts usage until its batch is confirmed on chain", async () => {
    const t = setup();
    await chat(t, { model: "cheap", ...msg });
    await chat(t, { model: "standard", ...msg });
    const pending = async () => BigInt(((await (await history(t, KEY)).json()) as { pendingWei: string }).pendingWei);
    const [first, second] = t.store.unsettled(10);
    expect(await pending()).toBe(first!.costWei + second!.costWei);

    // in a batch that hasn't confirmed yet: still pending
    t.store.createBatch({ batchId: 0, root: `0x${"11".repeat(32)}`, entries: [{ agentId: 9n, cost: first!.costWei }], totalWei: first!.costWei, proofs: new Map([[first!.requestId, []]]) });
    t.store.markSent(0, `0x${"22".repeat(32)}`);
    expect(await pending()).toBe(first!.costWei + second!.costWei);

    // confirmed: debited on chain, so no longer pending
    t.store.markConfirmed(0, {});
    expect(await pending()).toBe(second!.costWei);
  });

  it("400 for an unknown range, 401 without a key, 503 when the chain can't be read", async () => {
    const t = setup();
    expect((await history(t, KEY, "1y")).status).toBe(400);
    expect((await t.app.request("/v1/usage/history")).status).toBe(401);
    t.chain.failRead = true;
    expect((await history(t, KEY)).status).toBe(503);
  });
});
