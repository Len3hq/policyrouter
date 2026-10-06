import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { receiptFromJson, type ReceiptJson } from "@policyrouter/policy";
import { parseCatalog, resolveEndpoints, type CatalogFile } from "../../src/catalog.ts";
import { generateKey, hashKey } from "../../src/keys.ts";
import { createOpenAICompatibleProvider } from "../../src/providers/openai-compatible.ts";
import { UpstreamError, type ChatChunk } from "../../src/providers/types.ts";
import { FakeProvider, makeApp } from "./fakes.ts";

// --- the adapter contract, run against two differently shaped providers ---

interface Mock {
  url: string;
  key: string;
  seen: { auth?: string; body: Record<string, unknown>; path?: string }[];
  close(): Promise<void>;
}

/** An OpenAI-compatible provider over real HTTP. `style` picks how it reports cached prompt tokens. */
async function mockProvider(style: "deepseek" | "openai", key: string): Promise<Mock> {
  const seen: Mock["seen"] = [];
  const read = (req: IncomingMessage) => new Promise<string>((r) => { let s = ""; req.on("data", (d) => (s += d)); req.on("end", () => r(s)); });
  const usage = style === "deepseek"
    ? { prompt_tokens: 30, completion_tokens: 8, total_tokens: 38, prompt_cache_hit_tokens: 10, prompt_cache_miss_tokens: 20 }
    : { prompt_tokens: 30, completion_tokens: 8, total_tokens: 38, prompt_tokens_details: { cached_tokens: 10 } };
  const server: Server = createServer(async (req, res) => {
    const body = JSON.parse(await read(req)) as Record<string, unknown>;
    seen.push({ auth: req.headers.authorization, body, path: req.url });
    if (req.headers.authorization !== `Bearer ${key}`) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `Incorrect API key provided: ${req.headers.authorization}` } }));
      return;
    }
    if (body.model === "explode") {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "internal details you shouldn't see" } }));
      return;
    }
    const base = { id: "x", created: 1, model: body.model };
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const content of ["he", "llo"]) res.write(`data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [], usage })}\n\n`);
      res.end("data: [DONE]\n\n");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ...base, object: "chat.completion", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "hello" } }], usage }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, key, seen, close: () => new Promise((r) => server.close(() => r())) };
}

describe.each(["deepseek", "openai"] as const)("OpenAI-compatible adapter against a %s-style provider", (style) => {
  let mock: Mock;
  beforeAll(async () => {
    mock = await mockProvider(style, `sk-${style}-provider-key-000000`);
  });
  afterAll(() => mock.close());

  const adapter = () => createOpenAICompatibleProvider({ name: style, baseURL: mock.url, apiKey: mock.key });
  const params = (model = "m1") => ({ model, messages: [{ role: "user" as const, content: "hi" }] });

  it("completes, with the provider's key, and returns usage", async () => {
    const r = await adapter().complete(params());
    expect(r.choices[0]!.message.content).toBe("hello");
    expect(r.usage).toMatchObject({ prompt_tokens: 30, completion_tokens: 8 });
    expect(mock.seen.at(-1)!.auth).toBe(`Bearer ${mock.key}`);
    expect(mock.seen.at(-1)!.path).toBe("/chat/completions");
  });

  it("streams, asking the provider to include usage in the last chunk", async () => {
    const chunks: ChatChunk[] = [];
    for await (const c of await adapter().stream(params())) chunks.push(c);
    expect(chunks.map((c) => c.choices[0]?.delta?.content).filter(Boolean).join("")).toBe("hello");
    expect(chunks.at(-1)!.usage).toMatchObject({ prompt_tokens: 30 });
    expect(mock.seen.at(-1)!.body.stream_options).toEqual({ include_usage: true });
  });

  it("maps provider errors to UpstreamError with the status, never the provider's message", async () => {
    const bad = createOpenAICompatibleProvider({ name: style, baseURL: mock.url, apiKey: "sk-wrong-key-0000000" });
    await expect(bad.complete(params())).rejects.toMatchObject({ status: 401 });
    await expect(bad.complete(params())).rejects.toBeInstanceOf(UpstreamError);
    const err = await adapter().complete(params("explode")).catch((e: Error) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as UpstreamError).message).not.toContain("internal details");
  });
});

// --- the router with two providers ---

const TWO: CatalogFile = {
  pricing: { markupBps: 1000, peak: { weekdaysUtc: [1, 2, 3, 4, 5], hoursUtc: [[1, 4], [6, 10]] } },
  endpoints: {
    deepseek: { baseUrl: "https://deepseek.test", apiKeyEnv: "DS_KEY", responsesPath: "/responses", messagesPath: "/anthropic/v1/messages" },
    acme: { baseUrl: "https://acme.test/v1", baseUrlEnv: "ACME_URL", apiKeyEnv: "ACME_KEY", responsesPath: "/responses", messagesPath: null },
  },
  prices: {
    "deepseek-flash": { peak: { inputCacheHit: "0.006", inputCacheMiss: "0.3", output: "1.2" }, offPeak: { inputCacheHit: "0.003", inputCacheMiss: "0.15", output: "0.6" } },
    "acme-large": { flat: { inputCacheHit: "0.5", inputCacheMiss: "2", output: "8" } },
  },
  models: [
    { id: "cheap", tier: 0, provider: "deepseek", upstreamModel: "deepseek-flash", thinking: "disabled", defaultForTier: true },
    { id: "standard", tier: 1, provider: "deepseek", upstreamModel: "deepseek-flash", thinking: "enabled", defaultForTier: true },
    { id: "premium", tier: 2, provider: "acme", upstreamModel: "acme-large", defaultForTier: true },
    { id: "frontier", tier: 3, provider: "acme", upstreamModel: "acme-large", defaultForTier: true },
  ],
  sizeBuckets: { bounds: [2000, 8000, 32000], defaultMaxTokens: 4096 },
};

describe("a catalog with two providers", () => {
  const catalog = parseCatalog(TWO);

  function setup(circuitId = 1n) {
    const deepseek = new FakeProvider("deepseek");
    const acme = new FakeProvider("acme");
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(init.body as string) });
      return new Response(JSON.stringify({ id: "r", output: [], usage: { input_tokens: 10, output_tokens: 2 } }), { headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const t = makeApp({
      catalog,
      providers: { deepseek, acme },
      upstreams: {
        deepseek: { baseURL: "https://deepseek.test", apiKey: "ds", responsesPath: "/responses", messagesPath: "/anthropic/v1/messages" },
        acme: { baseURL: "https://acme.test/v1", apiKey: "ac", responsesPath: "/responses", messagesPath: null },
      },
      fetchFn,
    });
    const key = generateKey();
    t.chain.keys.set(hashKey(key), { agentId: 1n, circuitId, killed: false, budgetOk: true });
    const post = (path: string, body: Record<string, unknown>) =>
      t.app.request(path, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
    return { t, deepseek, acme, calls, post };
  }
  const msgs = { messages: [{ role: "user", content: "hi" }], max_tokens: 50 };

  it("sends each tier to its own provider", async () => {
    const { deepseek, acme, post } = setup();
    await post("/v1/chat/completions", { model: "cheap", ...msgs });
    await post("/v1/chat/completions", { model: "frontier", ...msgs });
    expect(deepseek.calls.map((c) => c.model)).toEqual(["deepseek-flash"]);
    expect(acme.calls.map((c) => c.model)).toEqual(["acme-large"]);
    expect((acme.calls[0] as unknown as Record<string, unknown>).thinking).toBeUndefined(); // no DeepSeek switch for another provider
  });

  it("a downgrade can move a request to the other provider (Cheap Only: frontier → standard on DeepSeek)", async () => {
    const { deepseek, acme, post } = setup(2n);
    const body = (await (await post("/v1/chat/completions", { model: "frontier", ...msgs })).json()) as { model: string; policyrouter_receipt: ReceiptJson };
    expect(body.model).toBe("standard");
    expect(acme.calls).toHaveLength(0);
    expect(deepseek.calls).toHaveLength(1);
  });

  it("prices each provider's model from its own table (flat for acme)", async () => {
    const { post } = setup();
    const r = receiptFromJson(((await (await post("/v1/chat/completions", { model: "premium", ...msgs })).json()) as { policyrouter_receipt: ReceiptJson }).policyrouter_receipt);
    const acme = catalog.models.find((m) => m.id === "premium")!;
    expect(acme.prices.peak).toEqual(acme.prices.offPeak);
    expect(r.costWei).toBeGreaterThan(0n);
  });

  it("forwards the Responses API to the serving provider's path", async () => {
    const { calls, post } = setup();
    expect((await post("/v1/responses", { model: "frontier", input: "hi" })).status).toBe(200);
    expect((await post("/v1/responses", { model: "cheap", input: "hi" })).status).toBe(200);
    expect(calls.map((c) => c.url)).toEqual(["https://acme.test/v1/responses", "https://deepseek.test/responses"]);
  });

  it("refuses a format the serving provider doesn't have, clearly, without calling anyone", async () => {
    const { calls, post } = setup();
    const r = await post("/v1/messages", { model: "frontier", max_tokens: 10, messages: [] });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: { message: string } }).error.message).toMatch(/served by acme, which has no Anthropic Messages API/);
    expect(calls).toHaveLength(0);
    expect((await post("/v1/messages", { model: "cheap", max_tokens: 10, messages: [] })).status).toBe(200);
  });
});

describe("catalog endpoints", () => {
  it("resolves base URLs and keys from the environment, and only for providers in use", () => {
    const c = parseCatalog(TWO);
    const e = resolveEndpoints(c, { DS_KEY: "k1", ACME_KEY: "k2", ACME_URL: "https://eu.acme.test/v1" });
    expect(e.acme).toMatchObject({ apiKey: "k2", baseUrl: "https://eu.acme.test/v1", messagesPath: undefined, chat: true });
    expect(e.deepseek!.baseUrl).toBe("https://deepseek.test");

    const onlyDeepseek = parseCatalog({ ...TWO, models: TWO.models.map((m) => ({ ...m, provider: "deepseek", upstreamModel: "deepseek-flash" })) });
    expect(Object.keys(resolveEndpoints(onlyDeepseek, { DS_KEY: "k1" }))).toEqual(["deepseek"]); // acme's key not needed
  });

  it("refuses to start without a provider's key, naming the variable and the models", () => {
    expect(() => resolveEndpoints(parseCatalog(TWO), { DS_KEY: "k1" })).toThrow('provider "acme" needs ACME_KEY (models: premium, frontier)');
  });

  it("rejects a model whose provider isn't in the catalog", () => {
    expect(() => parseCatalog({ ...TWO, models: [{ ...TWO.models[0]!, provider: "nobody" }] })).toThrow(/no endpoint "nobody"/);
  });

  it("the shipped catalog serves everything from DeepSeek, with all three formats", async () => {
    const { loadCatalog } = await import("../../src/catalog.ts");
    const c = loadCatalog();
    expect(new Set(c.models.map((m) => m.provider))).toEqual(new Set(["deepseek"]));
    expect(c.endpoints.deepseek).toMatchObject({ chat: true, responsesPath: "/responses", messagesPath: "/anthropic/v1/messages", apiKeyEnv: "DEEPSEEK_API_KEY" });
  });
});
