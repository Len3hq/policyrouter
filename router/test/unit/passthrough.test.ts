import { describe, expect, it } from "vitest";
import { receiptFromJson, type ReceiptJson } from "@policyrouter/policy";
import { costWei, findModel, loadCatalog } from "../../src/catalog.ts";
import { generateKey, hashKey } from "../../src/keys.ts";
import { PROVIDER_SECRET, makeApp } from "./fakes.ts";

type Call = { url: string; headers: Record<string, string>; body: Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any

/** A fake provider: records what it was sent and answers with `respond(url, body)`. */
function upstream(respond: (url: string, body: Record<string, any>) => Response) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const calls: Call[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    calls.push({ url, headers: init.headers as Record<string, string>, body });
    return respond(url, body);
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
const sse = (events: unknown[]) =>
  new Response(events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });

const RESPONSES_REPLY = {
  id: "resp_1",
  object: "response",
  model: "deepseek-flash",
  output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
  usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 40 }, output_tokens: 20, total_tokens: 120 },
};
const MESSAGES_REPLY = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "deepseek-flash",
  content: [{ type: "text", text: "ok" }],
  usage: { input_tokens: 60, cache_read_input_tokens: 40, cache_creation_input_tokens: 0, output_tokens: 20 },
};

function setup(respond: (url: string, body: Record<string, any>) => Response, circuitId = 1n, state: Partial<{ killed: boolean }> = {}) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const up = upstream(respond);
  const t = makeApp({ fetchFn: up.fetchFn });
  const key = generateKey();
  t.chain.keys.set(hashKey(key), { agentId: 4n, circuitId, killed: false, budgetOk: true, ...state });
  return { ...t, key, calls: up.calls };
}

const post = (t: ReturnType<typeof setup>, path: string, body: unknown, headers: Record<string, string>) =>
  t.app.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("POST /v1/responses (Codex)", () => {
  it("forwards to the provider's /responses with the served model, thinking off for cheap, and meters cached tokens", async () => {
    const t = setup(() => json(RESPONSES_REPLY));
    const r = await post(t, "/v1/responses", { model: "cheap", input: "hi", reasoning: { effort: "high", summary: "auto" } }, { authorization: `Bearer ${t.key}` });
    expect(r.status).toBe(200);
    expect(t.calls[0]!.url).toBe("https://upstream.test/responses");
    expect(t.calls[0]!.headers.authorization).toBe(`Bearer ${PROVIDER_SECRET}`);
    expect(t.calls[0]!.body.model).toBe("deepseek-flash");
    expect(t.calls[0]!.body.reasoning).toEqual({ effort: "none", summary: "auto" });

    const body = (await r.json()) as typeof RESPONSES_REPLY & { policyrouter_receipt: ReceiptJson };
    expect(body.output).toEqual(RESPONSES_REPLY.output); // passed through
    const rc = receiptFromJson(body.policyrouter_receipt);
    expect(rc).toMatchObject({ modelServed: "cheap", promptTokens: 100, cachedPromptTokens: 40, completionTokens: 20 });
    const catalog = loadCatalog();
    expect(rc.costWei).toBe(costWei(catalog, findModel(catalog, "cheap")!, rc, rc.timestamp, rc.okbUsdE8));
    expect(r.headers.get("x-policyrouter-receipt")).toBeTruthy();
    expect(t.store.getReceipt(rc.requestId)?.allowed).toBe(true);
  });

  it("thinking tiers can't be switched off by the agent; Cheap Only downgrades frontier to standard", async () => {
    const t = setup(() => json(RESPONSES_REPLY), 2n);
    await post(t, "/v1/responses", { model: "frontier", input: "hi", reasoning: { effort: "none" } }, { authorization: `Bearer ${t.key}` });
    expect(t.calls[0]!.body.model).toBe("deepseek-flash"); // standard = flash with thinking
    expect(t.calls[0]!.body.reasoning).toEqual({});
  });

  it("streams the provider's bytes through untouched and meters usage from response.completed", async () => {
    const events = [
      { type: "response.created", response: { id: "resp_1" } },
      { type: "response.output_text.delta", delta: "o" },
      { type: "response.output_text.delta", delta: "k" },
      { type: "response.completed", response: { ...RESPONSES_REPLY } },
    ];
    const t = setup(() => sse(events));
    const r = await post(t, "/v1/responses", { model: "premium", input: "hi", stream: true }, { authorization: `Bearer ${t.key}` });
    expect(r.headers.get("content-type")).toContain("text/event-stream");
    const text = await r.text();
    expect(text).toBe((await sse(events).text())); // byte for byte
    const id = r.headers.get("x-policyrouter-request-id")!;
    const stored = t.store.getReceipt(id)!;
    expect(stored.receipt).toMatchObject({ modelServed: "premium", promptTokens: 100, cachedPromptTokens: 40, completionTokens: 20 });
    expect(stored.receipt.costWei).toBeGreaterThan(0n);
  });

  it("denies in OpenAI's error shape with a receipt, without calling the provider", async () => {
    const t = setup(() => json(RESPONSES_REPLY), 1n, { killed: true });
    const r = await post(t, "/v1/responses", { model: "cheap", input: "hi" }, { authorization: `Bearer ${t.key}` });
    expect(r.status).toBe(403);
    const body = (await r.json()) as { error: { code: string }; policyrouter_receipt: ReceiptJson };
    expect(body.error.code).toBe("policy_denied");
    expect(body.policyrouter_receipt.outputBits).toBe("0b000");
    expect(t.calls).toHaveLength(0);
  });
});

describe("POST /v1/messages (Claude Code)", () => {
  it("accepts the key as x-api-key, forwards to /anthropic/v1/messages with thinking off for cheap, and meters cache reads", async () => {
    const t = setup(() => json(MESSAGES_REPLY));
    const r = await post(
      t,
      "/v1/messages",
      { model: "cheap", max_tokens: 100, messages: [{ role: "user", content: "hi" }], thinking: { type: "enabled", budget_tokens: 50 } },
      { "x-api-key": t.key, "anthropic-version": "2023-06-01", "anthropic-beta": "claude-code-20250219" },
    );
    expect(r.status).toBe(200);
    const call = t.calls[0]!;
    expect(call.url).toBe("https://upstream.test/anthropic/v1/messages");
    expect(call.headers["x-api-key"]).toBe(PROVIDER_SECRET);
    expect(call.headers["anthropic-version"]).toBe("2023-06-01");
    expect(call.headers["anthropic-beta"]).toBe("claude-code-20250219");
    expect(call.body.model).toBe("deepseek-flash");
    expect(call.body.thinking).toEqual({ type: "disabled" });
    const rc = receiptFromJson(((await r.json()) as { policyrouter_receipt: ReceiptJson }).policyrouter_receipt);
    expect(rc).toMatchObject({ promptTokens: 100, cachedPromptTokens: 40, completionTokens: 20 }); // 60 input + 40 cache read
  });

  it("also accepts a bearer token (ANTHROPIC_AUTH_TOKEN), and lets thinking tiers think", async () => {
    const t = setup(() => json(MESSAGES_REPLY));
    await post(t, "/v1/messages", { model: "frontier", max_tokens: 100, messages: [], thinking: { type: "disabled" } }, { authorization: `Bearer ${t.key}` });
    expect(t.calls[0]!.body.model).toBe("deepseek-v4-pro");
    expect(t.calls[0]!.body.thinking).toBeUndefined();
  });

  it("streams through untouched and meters from message_start and message_delta", async () => {
    const events = [
      { type: "message_start", message: { ...MESSAGES_REPLY, content: [], usage: { input_tokens: 60, cache_read_input_tokens: 40, output_tokens: 1 } } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 25 } },
      { type: "message_stop" },
    ];
    const t = setup(() => sse(events));
    const r = await post(t, "/v1/messages", { model: "cheap", max_tokens: 100, messages: [], stream: true }, { "x-api-key": t.key });
    expect(await r.text()).toBe(await sse(events).text());
    const stored = t.store.getReceipt(r.headers.get("x-policyrouter-request-id")!)!;
    expect(stored.receipt).toMatchObject({ promptTokens: 100, cachedPromptTokens: 40, completionTokens: 25 });
  });

  it("speaks Anthropic's error shape: missing key, unknown model, denial", async () => {
    const t = setup(() => json(MESSAGES_REPLY), 1n, { killed: true });
    const noKey = await post(t, "/v1/messages", { model: "cheap", messages: [] }, {});
    expect(noKey.status).toBe(401);
    expect(await noKey.json()).toMatchObject({ type: "error", error: { type: "authentication_error" } });

    const badModel = await post(t, "/v1/messages", { model: "claude-sonnet-4-5", messages: [] }, { "x-api-key": t.key });
    expect(badModel.status).toBe(404);
    expect(((await badModel.json()) as { error: { type: string; message: string } }).error).toMatchObject({ type: "not_found_error" });

    const denied = await post(t, "/v1/messages", { model: "cheap", max_tokens: 10, messages: [] }, { "x-api-key": t.key });
    expect(denied.status).toBe(403);
    const body = (await denied.json()) as { type: string; error: { type: string }; policyrouter_receipt: ReceiptJson };
    expect(body).toMatchObject({ type: "error", error: { type: "permission_error" } });
    expect(body.policyrouter_receipt.costWei).toBe("0");
    expect(t.calls).toHaveLength(0);
  });

  it("an upstream failure is a generic error that never echoes the provider's message or key", async () => {
    const t = setup(() => json({ error: { message: `bad key ${PROVIDER_SECRET}` } }, 401));
    const r = await post(t, "/v1/messages", { model: "cheap", max_tokens: 10, messages: [] }, { "x-api-key": t.key });
    expect(r.status).toBe(502);
    expect(await r.text()).not.toContain(PROVIDER_SECRET);
    expect(t.lines.join("\n")).not.toContain(PROVIDER_SECRET);
    expect(t.lines.join("\n")).not.toContain(t.key);
  });

  it("count_tokens answers with a local estimate and needs a key", async () => {
    const t = setup(() => json({}));
    const ok = await post(t, "/v1/messages/count_tokens", { model: "cheap", messages: [{ role: "user", content: "x".repeat(400) }] }, { "x-api-key": t.key });
    expect(((await ok.json()) as { input_tokens: number }).input_tokens).toBeGreaterThan(100);
    expect((await post(t, "/v1/messages/count_tokens", {}, {})).status).toBe(401);
    expect(t.calls).toHaveLength(0);
  });
});
