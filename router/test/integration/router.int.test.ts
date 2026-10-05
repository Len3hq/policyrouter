// End to end against an anvil fork of X Layer mainnet: real contracts, the live processor and
// circuits, a real router, a mock provider. Run with `pnpm --filter @policyrouter/router test:integration`.

import { execSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseEther, type Hex } from "viem";
import {
  POLICYROUTER,
  budgetGuard,
  cheapOnly,
  simRequestFromReceipt,
  simulatePolicy,
  receiptFromJson,
  receiptHash,
  recoverReceiptSigner,
  type ReceiptJson,
} from "@policyrouter/policy";
import { generateKey, hashKey } from "../../src/keys.ts";
import {
  PROVIDER_KEY,
  processorEvalAbi,
  setupWorld,
  startAnvil,
  startMockProvider,
  startRouter,
  type MockProvider,
  type World,
} from "./harness.ts";

const hasAnvil = (() => {
  try {
    execSync("anvil --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const BUDGET_GUARD = POLICYROUTER.circuits["budget-guard"];
const CAP = parseEther("0.001");

describe.skipIf(!hasAnvil)("router on a mainnet fork", { timeout: 60_000 }, () => {
  let anvil: { url: string; stop: () => void };
  let w: World;
  let provider: MockProvider;
  let router: ReturnType<typeof startRouter>;

  beforeAll(async () => {
    anvil = await startAnvil();
    w = await setupWorld(anvil.url);
    provider = await startMockProvider();
    router = startRouter(w, provider);
  }, 180_000);

  afterAll(async () => {
    await provider?.close();
    anvil?.stop();
  });

  /** Registers and funds a new agent; returns its API key and agent id. */
  async function newAgent(circuitId: bigint, deposit = parseEther("0.01")) {
    const key = generateKey();
    const agentId = (await w.send(w.owner, w.registry, w.registryAbi, "registerAgent", [hashKey(key), circuitId, CAP])) as bigint;
    if (deposit > 0n) await w.send(w.owner, w.escrow, w.escrowAbi, "deposit", [agentId], deposit);
    return { key, agentId };
  }

  const chat = (key: string, body: Record<string, unknown>) =>
    router.app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ messages: [{ role: "user", content: "hello" }], max_tokens: 64, ...body }),
    });

  it("allowed request: forwarded at the requested tier, receipt returned, usage stored", async () => {
    const { key, agentId } = await newAgent(BUDGET_GUARD);
    const before = provider.requests.length;
    const r = await chat(key, { model: "frontier" });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { model: string; choices: { message: { content: string } }[]; policyrouter_receipt: ReceiptJson };
    expect(body.choices[0]!.message.content).toBe("Policy");
    expect(body.model).toBe("frontier");

    const sent = provider.requests[before]!;
    expect(sent.body.model).toBe("deepseek-v4-pro");
    expect(sent.body.thinking).toEqual({ type: "enabled" });
    expect(sent.auth).toBe(`Bearer ${PROVIDER_KEY}`);

    const receipt = receiptFromJson(body.policyrouter_receipt);
    expect(receipt).toMatchObject({ agentId, circuitId: BUDGET_GUARD, processor: POLICYROUTER.processor, promptTokens: 42, cachedPromptTokens: 10, completionTokens: 7 });
    expect(router.store.getReceipt(receipt.requestId)?.allowed).toBe(true);
  });

  it("downgrade: under Cheap Only a frontier request is served by the standard model", async () => {
    const { key } = await newAgent(w.cheapOnlyId);
    const before = provider.requests.length;
    const body = (await (await chat(key, { model: "frontier" })).json()) as { model: string; policyrouter_receipt: ReceiptJson };
    expect(body.model).toBe("standard");
    expect(provider.requests[before]!.body.model).toBe("deepseek-flash");
    expect(body.policyrouter_receipt.modelRequested).toBe("frontier");
    expect(body.policyrouter_receipt.modelServed).toBe("standard");
    expect(body.policyrouter_receipt.outputBits).toBe("0b011");
  });

  it("kill switch: the next request is 403 and the provider is not called", async () => {
    const { key, agentId } = await newAgent(BUDGET_GUARD);
    expect((await chat(key, { model: "cheap" })).status).toBe(200);
    await w.send(w.owner, w.registry, w.registryAbi, "setKill", [agentId, true]);
    const before = provider.requests.length;
    const r = await chat(key, { model: "cheap" });
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("policy_denied");
    expect(provider.requests.length).toBe(before);
  });

  it("cap reached: once settled spend hits the daily cap, the next request is 403", async () => {
    const { key, agentId } = await newAgent(BUDGET_GUARD);
    expect((await chat(key, { model: "cheap" })).status).toBe(200);
    const batchId = (await w.pub.readContract({ address: w.escrow, abi: w.escrowAbi, functionName: "nextBatchId" })) as bigint;
    await w.send(w.routerAccount, w.escrow, w.escrowAbi, "settle", [batchId, `0x${"00".repeat(32)}`, [{ agentId, cost: CAP }]]);
    const before = provider.requests.length;
    const r = await chat(key, { model: "cheap" });
    expect(r.status).toBe(403);
    const receipt = ((await r.json()) as { policyrouter_receipt: ReceiptJson }).policyrouter_receipt;
    expect(receipt.inputBits).toBe("0b000000"); // budget_ok = 0, tier 0, small
    expect(provider.requests.length).toBe(before);
  });

  it("unfunded agent: denied, because budget_ok needs a balance", async () => {
    const { key } = await newAgent(BUDGET_GUARD, 0n);
    expect((await chat(key, { model: "cheap" })).status).toBe(403);
  });

  it("unknown key: 401 after the on-chain lookup", async () => {
    expect((await chat(generateKey(), { model: "cheap" })).status).toBe(401);
  });

  it("RPC down: 503 and the provider is not called", async () => {
    const { key } = await newAgent(BUDGET_GUARD);
    const dead = startRouter(w, provider, { rpcUrl: "http://127.0.0.1:1" });
    const before = provider.requests.length;
    const r = await dead.app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: "cheap", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(r.status).toBe(503);
    expect(provider.requests.length).toBe(before);
  });

  it("streaming: chunks in order, usage metered, receipt as the last event", async () => {
    const { key } = await newAgent(BUDGET_GUARD);
    const r = await chat(key, { model: "premium", stream: true });
    expect(r.status).toBe(200);
    const events = (await r.text()).split("\n\n").filter(Boolean).map((e) => e.replace(/^data: /, ""));
    expect(events.at(-1)).toBe("[DONE]");
    const chunks = events.slice(0, -1).map((e) => JSON.parse(e));
    expect(chunks.map((c) => c.choices[0]?.delta?.content).filter(Boolean).join("")).toBe("Policy");
    const receipt = chunks.at(-1).policyrouter_receipt as ReceiptJson;
    expect(receipt).toMatchObject({ modelServed: "premium", promptTokens: 42, completionTokens: 7 });
    expect(BigInt(receipt.costWei)).toBeGreaterThan(0n);
  });

  it("receipt replay: eval() at the receipt's block with its input gives its output; the signature is the router's", async () => {
    const { key } = await newAgent(w.cheapOnlyId);
    const json = ((await (await chat(key, { model: "frontier" })).json()) as { policyrouter_receipt: ReceiptJson }).policyrouter_receipt;
    const receipt = receiptFromJson(json);

    const out = (await w.pub.readContract({
      address: receipt.processor,
      abi: processorEvalAbi,
      functionName: "eval",
      args: [receipt.circuitId, `0x${receipt.inputBits.toString(16).padStart(2, "0")}` as Hex],
      blockNumber: receipt.blockNumber,
    })) as Hex;
    expect(parseInt(out.slice(2, 4), 16)).toBe(receipt.outputBits);
    expect(await recoverReceiptSigner(receipt, router.domain)).toBe(w.routerAccount.address);
    expect(router.store.getReceipt(receipt.requestId)?.hash).toBe(receiptHash(receipt, router.domain));
  });

  it("Codex's Responses API and Claude Code's Messages API go through the same live policy check", async () => {
    const { key, agentId } = await newAgent(w.cheapOnlyId);
    const call = (path: string, body: unknown, headers: Record<string, string>) =>
      router.app.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

    const before = provider.requests.length;
    const resp = await call("/v1/responses", { model: "frontier", input: "hi", max_output_tokens: 64 }, { authorization: `Bearer ${key}` });
    expect(resp.status).toBe(200);
    const r1 = receiptFromJson(((await resp.json()) as { policyrouter_receipt: ReceiptJson }).policyrouter_receipt);
    expect(r1).toMatchObject({ agentId, modelRequested: "frontier", modelServed: "standard", promptTokens: 30, cachedPromptTokens: 5 });
    expect(provider.requests[before]).toMatchObject({ path: "/responses", body: { model: "deepseek-flash" } });

    const msg = await call("/v1/messages", { model: "cheap", max_tokens: 64, messages: [{ role: "user", content: "hi" }] }, { "x-api-key": key, "anthropic-version": "2023-06-01" });
    expect(msg.status).toBe(200);
    const r2 = receiptFromJson(((await msg.json()) as { policyrouter_receipt: ReceiptJson }).policyrouter_receipt);
    expect(r2).toMatchObject({ modelServed: "cheap", promptTokens: 26, cachedPromptTokens: 6, completionTokens: 4 });
    expect(provider.requests[before + 1]).toMatchObject({ path: "/anthropic/v1/messages", body: { model: "deepseek-flash", thinking: { type: "disabled" } } });

    // both receipts replay on chain
    for (const r of [r1, r2]) {
      const out = (await w.pub.readContract({
        address: r.processor,
        abi: processorEvalAbi,
        functionName: "eval",
        args: [r.circuitId, `0x${r.inputBits.toString(16).padStart(2, "0")}` as Hex],
        blockNumber: r.blockNumber,
      })) as Hex;
      expect(parseInt(out.slice(2, 4), 16)).toBe(r.outputBits);
    }

    // and the kill switch stops them too, in each format's own error shape
    await w.send(w.owner, w.registry, w.registryAbi, "setKill", [agentId, true]);
    const n = provider.requests.length;
    const deniedMsg = await call("/v1/messages", { model: "cheap", max_tokens: 64, messages: [] }, { "x-api-key": key });
    expect(deniedMsg.status).toBe(403);
    expect(await deniedMsg.json()).toMatchObject({ type: "error", error: { type: "permission_error" } });
    expect((await call("/v1/responses", { model: "cheap", input: "hi" }, { authorization: `Bearer ${key}` })).status).toBe(403);
    expect(provider.requests.length).toBe(n);
  });

  it("simulation replays this suite's real traffic and reaches the same decisions as the live circuits", async () => {
    const rows = router.store.db
      .prepare("SELECT key_hash, circuit_id FROM receipts GROUP BY key_hash, circuit_id")
      .all() as { key_hash: `0x${string}`; circuit_id: string }[];
    const templateFor = (id: bigint) => (id === BUDGET_GUARD ? budgetGuard : id === w.cheapOnlyId ? cheapOnly : undefined);
    let compared = 0;
    for (const { key_hash, circuit_id } of rows) {
      const template = templateFor(BigInt(circuit_id))!;
      const receipts = router.store.recentForKey(key_hash, 1000).filter((r) => r.circuitId === BigInt(circuit_id));
      const actual = { allowed: 0, downgraded: 0, denied: 0 };
      for (const r of receipts) {
        if ((r.outputBits & 1) === 0) actual.denied++;
        else if (r.outputBits >> 1 < (r.inputBits & 3)) actual.downgraded++;
        else actual.allowed++;
      }
      const sim = simulatePolicy(template, receipts.map(simRequestFromReceipt), () => 1n);
      expect({ allowed: sim.allowed, downgraded: sim.downgraded, denied: sim.denied }).toEqual(actual);
      compared += receipts.length;
    }
    const total = (router.store.db.prepare("SELECT COUNT(*) AS n FROM receipts").get() as { n: number }).n;
    expect(total).toBeGreaterThan(0);
    expect(compared).toBe(total); // every receipt this suite produced was replayed
  });

  it("never logs API keys or the provider key", async () => {
    const { key } = await newAgent(BUDGET_GUARD);
    await chat(key, { model: "cheap" });
    const logs = router.lines.join("\n");
    expect(logs).not.toContain(key);
    expect(logs).not.toContain(PROVIDER_KEY);
  });
});
