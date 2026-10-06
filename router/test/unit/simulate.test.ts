import { describe, expect, it } from "vitest";
import { TEMPLATES, receiptFromJson, type ReceiptJson } from "@policyrouter/policy";
import { generateKey, hashKey } from "../../src/keys.ts";
import { TEMPLATE_BY_CIRCUIT, makeApp } from "./fakes.ts";

interface SimBody {
  source: "history" | "sample";
  requests: number;
  results: {
    template: string;
    circuitId: string | null;
    requests: number;
    allowed: number;
    downgraded: number;
    denied: number;
    spendWithout: string;
    spendWith: string;
    savingsPct: number;
  }[];
}

function setup() {
  const t = makeApp();
  const agent = (circuitId: bigint, state: Partial<{ killed: boolean; budgetOk: boolean }> = {}) => {
    const key = generateKey();
    t.chain.keys.set(hashKey(key), { agentId: BigInt(t.chain.keys.size + 1), circuitId, killed: false, budgetOk: true, ...state });
    return key;
  };
  const chat = async (key: string, model: string, max_tokens = 50) =>
    (await (
      await t.app.request("/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, max_tokens, messages: [{ role: "user", content: "hi" }] }),
      })
    ).json()) as { policyrouter_receipt: ReceiptJson };
  const simulate = async (key: string | null, query = "") =>
    t.app.request(`/v1/simulate${query}`, { headers: key ? { authorization: `Bearer ${key}` } : {} });
  return { t, agent, chat, simulate };
}

describe("GET /v1/simulate", () => {
  it("uses the sample workload for a key with no history, for every template", async () => {
    const { agent, simulate } = setup();
    const body = (await (await simulate(agent(1n))).json()) as SimBody;
    expect(body.source).toBe("sample");
    expect(body.requests).toBe(20);
    expect(body.results.map((r) => r.template)).toEqual(TEMPLATES.map((t) => t.id));
    expect(body.results[0]).toMatchObject({ template: "budget-guard", circuitId: "1", savingsPct: 0 });
    const strict = body.results.find((r) => r.template === "strict")!;
    expect(BigInt(strict.spendWith)).toBeLessThan(BigInt(strict.spendWithout));
  });

  it("uses the key's own history once it has some, and one template when asked", async () => {
    const { agent, chat, simulate } = setup();
    const key = agent(1n);
    await chat(key, "frontier");
    await chat(key, "cheap");
    const body = (await (await simulate(key, "?template=cheap-only")).json()) as SimBody;
    expect(body).toMatchObject({ source: "history", requests: 2 });
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({ template: "cheap-only", allowed: 1, downgraded: 1, denied: 0 });
    expect(body.results[0]!.savingsPct).toBeGreaterThan(0);
  });

  it("a key can only simulate its own history", async () => {
    const { agent, chat, simulate } = setup();
    const a = agent(1n);
    const b = agent(1n);
    for (let i = 0; i < 3; i++) await chat(a, "frontier");
    expect(((await (await simulate(a)).json()) as SimBody)).toMatchObject({ source: "history", requests: 3 });
    expect(((await (await simulate(b)).json()) as SimBody)).toMatchObject({ source: "sample", requests: 20 });
  });

  it("without a key, simulates the sample workload (for choosing a policy before an agent exists)", async () => {
    const { simulate } = setup();
    const body = (await (await simulate(null)).json()) as SimBody;
    expect(body).toMatchObject({ source: "sample", requests: 20 });
  });

  it("rejects malformed keys and unknown templates, and caps the history window", async () => {
    const { agent, chat, simulate } = setup();
    expect((await simulate("pr-live-nope")).status).toBe(401);
    const key = agent(1n);
    expect((await simulate(key, "?template=yolo")).status).toBe(400);
    for (let i = 0; i < 5; i++) await chat(key, "cheap");
    expect(((await (await simulate(key, "?limit=3")).json()) as SimBody).requests).toBe(3);
  });

  it("matches the router's real decisions for each template's own traffic", async () => {
    const { agent, chat, simulate } = setup();
    const models = ["cheap", "standard", "premium", "frontier"];
    for (const [circuit, template] of Object.entries(TEMPLATE_BY_CIRCUIT)) {
      // mixed traffic: every tier, small and huge, plus a killed and an over-budget agent
      const keys = [agent(BigInt(circuit)), agent(BigInt(circuit), { killed: true }), agent(BigInt(circuit), { budgetOk: false })];
      const actual = { allowed: 0, downgraded: 0, denied: 0 };
      for (const key of keys) {
        for (const model of models) {
          for (const maxTokens of [50, 60_000]) {
            const receipt = receiptFromJson((await chat(key, model, maxTokens)).policyrouter_receipt);
            const tier = receipt.inputBits & 3;
            const allow = (receipt.outputBits & 1) === 1;
            const routeTier = receipt.outputBits >> 1;
            if (!allow) actual.denied++;
            else if (routeTier < tier) actual.downgraded++;
            else actual.allowed++;
          }
        }
      }
      const simulated = { allowed: 0, downgraded: 0, denied: 0 };
      for (const key of keys) {
        const r = ((await (await simulate(key, `?template=${template.id}`)).json()) as SimBody).results[0]!;
        simulated.allowed += r.allowed;
        simulated.downgraded += r.downgraded;
        simulated.denied += r.denied;
      }
      expect(simulated, template.id).toEqual(actual);
    }
  });
});

describe("GET /v1/simulate with a custom rule", () => {
  it("simulates a custom rule on the key's own history, matching what that rule decides", async () => {
    const { agent, chat, simulate } = setup();
    const key = agent(1n);
    await chat(key, "frontier"); // tier 3
    await chat(key, "premium"); // tier 2
    await chat(key, "cheap", 60_000); // huge
    // max tier premium, deny above it; nothing larger than large
    const body = (await (await simulate(key, "?template=custom:t2-deny-s2")).json()) as SimBody;
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({ template: "custom:t2-deny-s2", circuitId: null, allowed: 1, downgraded: 0, denied: 2 });
    const down = (await (await simulate(key, "?template=custom:t1-downgrade-s3")).json()) as SimBody;
    expect(down.results[0]).toMatchObject({ allowed: 1, downgraded: 2, denied: 0 });
  });

  it("rejects a malformed custom rule", async () => {
    const { simulate } = setup();
    const r = await simulate(null, "?template=custom:t9-maybe-s1");
    expect(r.status).toBe(400);
  });
});

describe("GET /v1/usage", () => {
  it("counts the key's own decisions and spend, and lists recent requests", async () => {
    const { t, agent, chat } = setup();
    const key = agent(2n); // Cheap Only
    await chat(key, "cheap");
    await chat(key, "frontier"); // downgraded
    const other = agent(1n, { killed: true });
    await chat(other, "cheap"); // denied, someone else's
    const r = await t.app.request("/v1/usage", { headers: { authorization: `Bearer ${key}` } });
    const u = (await r.json()) as { requests: number; allowed: number; downgraded: number; denied: number; spentWei: string; unsettledWei: string; recent: { downgraded: boolean }[] };
    expect(u).toMatchObject({ requests: 2, allowed: 1, downgraded: 1, denied: 0 });
    expect(BigInt(u.spentWei)).toBeGreaterThan(0n);
    expect(u.unsettledWei).toBe(u.spentWei);
    expect(u.recent.filter((x) => x.downgraded)).toHaveLength(1);
  });

  it("needs a key", async () => {
    const { t } = setup();
    expect((await t.app.request("/v1/usage")).status).toBe(401);
  });

  it("allows browser calls (CORS) and exposes the receipt headers", async () => {
    const { t } = setup();
    const r = await t.app.request("/v1/simulate", { method: "OPTIONS", headers: { origin: "http://localhost:5173", "access-control-request-method": "GET" } });
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
  });
});
