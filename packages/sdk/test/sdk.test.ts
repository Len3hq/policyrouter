import { describe, expect, it } from "vitest";
import type { Abi, Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  batchTree,
  proofFor,
  receiptDomain,
  receiptHash,
  typedReceipt,
  verifyReceipt as verifyProof,
  type ChainReads,
  type Hex32,
  type SignedReceipt,
} from "@policyrouter/policy";
import { PolicyDeniedError, PolicyRouter, PolicyRouterError, verifyReceipt } from "../src/index.ts";
import { generateKey, hashKey } from "../../../router/src/keys.ts";
import { ESCROW, PROCESSOR, makeApp } from "../../../router/test/unit/fakes.ts";

const BASE = "https://router.test";

/** The real router app (fake chain and provider behind it), reached through the SDK's fetch. */
function setup(circuitId = 1n, state: Partial<{ killed: boolean; budgetOk: boolean }> = {}) {
  const t = makeApp();
  const key = generateKey();
  t.chain.keys.set(hashKey(key), { agentId: 7n, circuitId, killed: false, budgetOk: true, ...state });
  const urls: string[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    urls.push(req.url);
    return t.app.fetch(req);
  }) as typeof fetch;
  const pr = new PolicyRouter({ apiKey: key, baseURL: BASE, fetch: fetchFn });
  return { t, key, pr, urls };
}
const hi = { messages: [{ role: "user" as const, content: "hi" }], max_tokens: 50 };

describe("PolicyRouter client", () => {
  it("calls the router's /v1 endpoints, whatever form the base URL takes", async () => {
    const { pr, urls } = setup();
    await pr.chat({ model: "cheap", ...hi });
    expect(urls).toEqual([`${BASE}/v1/chat/completions`]);
    for (const b of [`${BASE}/`, `${BASE}/v1`, `${BASE}/v1/`]) expect(new PolicyRouter({ apiKey: `pr-live-${"a".repeat(48)}`, baseURL: b }).baseURL).toBe(BASE);
  });

  it("refuses a key that isn't a PolicyRouter key", () => {
    expect(() => new PolicyRouter({ apiKey: "sk-123" })).toThrow(/pr-live-/);
  });

  it("returns the answer, the model served, and the signed receipt", async () => {
    const { pr, t } = setup();
    const r = await pr.chat({ model: "frontier", ...hi });
    expect(r.text).toBe("hello");
    expect(r.model).toBe("frontier");
    expect(r.receipt).toMatchObject({ agentId: 7n, modelRequested: "frontier", modelServed: "frontier" });
    expect(t.store.getReceipt(r.receipt.requestId)).toBeDefined();
  });

  it("shows a downgrade: Cheap Only serves frontier as standard", async () => {
    const { pr } = setup(2n);
    const r = await pr.chat({ model: "frontier", ...hi });
    expect(r.model).toBe("standard");
    expect(r.receipt.modelRequested).toBe("frontier");
  });

  it("a denial is a typed PolicyDeniedError carrying the denial's signed receipt", async () => {
    const { pr, t } = setup(1n, { killed: true });
    const err = await pr.chat({ model: "cheap", ...hi }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PolicyDeniedError);
    expect(err).toBeInstanceOf(PolicyRouterError);
    const denied = err as PolicyDeniedError;
    expect(denied).toMatchObject({ status: 403, code: "policy_denied" });
    expect(denied.receipt).toMatchObject({ outputBits: 0, modelServed: "", costWei: 0n });
    expect(t.store.getReceipt(denied.receipt.requestId)?.allowed).toBe(false);
    expect(t.provider.calls).toHaveLength(0);
  });

  it("other router errors are PolicyRouterErrors with the router's code", async () => {
    const { pr } = setup();
    const err = (await pr.chat({ model: "gpt-9", ...hi }).catch((e: unknown) => e)) as PolicyRouterError;
    expect(err).toBeInstanceOf(PolicyRouterError);
    expect(err).not.toBeInstanceOf(PolicyDeniedError);
    expect(err).toMatchObject({ status: 404, code: "model_not_found" });
  });

  it("streams the chunks and returns the receipt when the stream ends", async () => {
    const { pr } = setup();
    const gen = pr.chatStream({ model: "premium", ...hi });
    let text = "";
    let step = await gen.next();
    while (!step.done) {
      text += step.value.choices[0]?.delta?.content ?? "";
      step = await gen.next();
    }
    expect(text).toBe("Hello");
    expect(step.value).toMatchObject({ modelServed: "premium", completionTokens: 50 });
  });

  it("a streamed denial throws before any chunk", async () => {
    const { pr } = setup(1n, { budgetOk: false });
    await expect(pr.chatStream({ model: "cheap", ...hi }).next()).rejects.toBeInstanceOf(PolicyDeniedError);
  });

  it("reads usage and simulation, including a custom rule", async () => {
    const { pr } = setup();
    await pr.chat({ model: "frontier", ...hi });
    expect(await pr.usage()).toMatchObject({ requests: 1, allowed: 1 });
    const sim = (await pr.simulate("custom:t1-downgrade-s3")) as { results: { downgraded: number }[] };
    expect(sim.results[0]!.downgraded).toBe(1);
  });
});

// --- verifyReceipt: the Phase 7 vectors, on receipts the real router signed ---

/** Answers the verifier's reads like the chain would, from the router test's fake chain. */
function chainFor(t: ReturnType<typeof setup>["t"], roots: Map<bigint, Hex>): ChainReads {
  return {
    async readContract({ functionName, args = [] }: { address: Address; abi: Abi; functionName: string; args?: readonly unknown[] }) {
      switch (functionName) {
        case "router":
          return t.account.address;
        case "policyOf": {
          const s = t.chain.keys.get(args[0] as Hex)!;
          return [s.agentId, t.account.address, s.circuitId, 10n ** 18n, s.killed];
        }
        case "budgetOkForKey":
          return t.chain.keys.get(args[0] as Hex)!.budgetOk;
        case "eval": {
          const out = await t.chain.evaluate(args[0] as bigint, Uint8Array.of(parseInt((args[1] as Hex).slice(2), 16)));
          return `0x${out[0]!.toString(16).padStart(2, "0")}`;
        }
        case "isInBatch": {
          const root = roots.get(args[0] as bigint);
          return !!root && verifyProof(root as Hex32, args[1] as Hex32, args[2] as Hex32[]);
        }
        default:
          throw new Error(functionName);
      }
    },
  };
}

describe("verifyReceipt", () => {
  async function receipts() {
    const s = setup();
    const allowed = (await s.pr.chat({ model: "standard", ...hi })).receipt;
    s.t.chain.keys.get(hashKey(s.key))!.killed = true;
    const denied = ((await s.pr.chat({ model: "cheap", ...hi }).catch((e: PolicyDeniedError) => e)) as PolicyDeniedError).receipt;
    const domain = receiptDomain(196, ESCROW);
    const tree = batchTree([receiptHash(allowed, domain), receiptHash(denied, domain)] as Hex32[]);
    const roots = new Map<bigint, Hex>([[0n, tree.root as Hex]]);
    const settle = (r: SignedReceipt) => ({ batchId: 0, status: "confirmed", proof: proofFor(tree, receiptHash(r, domain) as Hex32) as Hex[] });
    // the fake chain has one state, so set the kill switch to what it was when the receipt was made
    const verify = (r: SignedReceipt, settlement: ReturnType<typeof settle> | null, killedAtBlock: boolean) => {
      s.t.chain.keys.get(hashKey(s.key))!.killed = killedAtBlock;
      return verifyReceipt(r, { client: chainFor(s.t, roots), settlement, escrow: ESCROW, processor: PROCESSOR, chainId: 196 });
    };
    return { s, allowed, denied, settle, verify, domain };
  }
  const status = (r: { checks: { id: string; status: string }[] }) => Object.fromEntries(r.checks.map((c) => [c.id, c.status]));

  it("a valid allow receipt passes all four checks", async () => {
    const { allowed, settle, verify } = await receipts();
    expect((await verify(allowed, settle(allowed), false)).verdict).toBe("verified");
  });

  it("a valid deny receipt passes", async () => {
    const { denied, settle, verify } = await receipts();
    expect((await verify(denied, settle(denied), true)).verdict).toBe("verified");
  });

  it("changed outputBits fails the policy check", async () => {
    const { allowed, settle, verify } = await receipts();
    const r = await verify({ ...allowed, outputBits: 0b111 }, settle(allowed), false);
    expect(r.failed).toContain("policy");
  });

  it("changed costWei fails the signature check, and the policy still holds", async () => {
    const { allowed, verify } = await receipts();
    const r = await verify({ ...allowed, costWei: 1n }, null, false);
    expect(status(r)).toMatchObject({ signature: "fail", policy: "pass" });
  });

  it("a receipt re-signed by another key fails the signature check", async () => {
    const { allowed, settle, verify, domain } = await receipts();
    const impostor = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
    const routerSig = await impostor.signTypedData(typedReceipt(allowed, domain));
    const r = await verify({ ...allowed, routerSig }, settle(allowed), false);
    expect(r.failed).toEqual(["signature"]);
  });

  it("a wrong proof fails the settlement check", async () => {
    const { allowed, settle, verify } = await receipts();
    const r = await verify(allowed, { ...settle(allowed), proof: [`0x${"00".repeat(32)}`] }, false);
    expect(r.failed).toEqual(["settlement"]);
  });

  it("an unsettled receipt is pending, not failed", async () => {
    const { allowed, verify } = await receipts();
    const r = await verify(allowed, null, false);
    expect(r.verdict).toBe("pending");
    expect(r.failed).toEqual([]);
  });

  it("accepts the receipt's JSON or a /v1/receipts response too", async () => {
    const { s, allowed } = await receipts();
    s.t.chain.keys.get(hashKey(s.key))!.killed = false;
    const fetched = await s.pr.receipt(allowed.requestId);
    expect(fetched.receipt).toEqual(allowed);
    expect(fetched.settlement).toBeNull();
    const roots = new Map<bigint, Hex>();
    const opts = { client: chainFor(s.t, roots), escrow: ESCROW, processor: PROCESSOR, chainId: 196 };
    const viaResponse = await verifyReceipt({ receipt: JSON.parse(JSON.stringify((await (await s.t.app.request(`/v1/receipts/${allowed.requestId}`)).json()) as object)).receipt, settlement: null }, opts);
    expect(viaResponse.verdict).toBe("pending"); // valid, not settled yet
  });
});
