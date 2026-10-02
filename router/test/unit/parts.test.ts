import { describe, expect, it } from "vitest";
import { keccak256, stringToBytes } from "viem";
import { generateKey, hashKey, isWellFormedKey, keyFromAuthHeader } from "../../src/keys.ts";
import { createLogger, redact } from "../../src/log.ts";
import { PolicyUnavailable, UnknownKey, checkPolicy } from "../../src/policy.ts";
import { RateLimiter } from "../../src/ratelimit.ts";
import { FakeChain } from "./fakes.ts";

describe("keys", () => {
  it("generates well-formed, unique keys", () => {
    const a = generateKey();
    expect(isWellFormedKey(a)).toBe(true);
    expect(a).not.toBe(generateKey());
  });

  it("hashes with keccak256 of the UTF-8 key", () => {
    expect(hashKey("pr-live-x")).toBe(keccak256(stringToBytes("pr-live-x")));
  });

  it("rejects malformed keys", () => {
    for (const k of ["", "pr-live-", "pr-live-xyz", `sk-${"a".repeat(48)}`, `pr-live-${"A".repeat(48)}`, `pr-live-${"a".repeat(47)}`]) {
      expect(isWellFormedKey(k), k).toBe(false);
    }
  });

  it("reads bearer tokens", () => {
    expect(keyFromAuthHeader("Bearer abc")).toBe("abc");
    expect(keyFromAuthHeader("bearer   abc ")).toBe("abc");
    expect(keyFromAuthHeader("Basic abc")).toBeUndefined();
    expect(keyFromAuthHeader(undefined)).toBeUndefined();
  });
});

describe("rate limit", () => {
  it("refuses request N+1 in the window and refills over time", () => {
    let now = 0;
    const rl = new RateLimiter(3, 3, () => now);
    expect([rl.take("k"), rl.take("k"), rl.take("k")]).toEqual([true, true, true]);
    expect(rl.take("k")).toBe(false);
    expect(rl.take("other")).toBe(true);
    now += 20_000; // one third of a minute → one token
    expect(rl.take("k")).toBe(true);
    expect(rl.take("k")).toBe(false);
  });
});

describe("log redaction", () => {
  it("removes API keys, provider keys, bearer headers and configured secrets", () => {
    const key = generateKey();
    const out = redact(`key=${key} auth="Bearer ${key}" provider=sk-abcdefghijkl other=mysecret`, ["mysecret"]);
    expect(out).not.toContain(key);
    expect(out).not.toContain("sk-abcdefghijkl");
    expect(out).not.toContain("mysecret");
  });

  it("is applied to every log line", () => {
    const lines: string[] = [];
    const log = createLogger(["topsecret"], (l) => lines.push(l));
    log.info("x", { a: "topsecret", b: 5n });
    expect(lines[0]).not.toContain("topsecret");
    expect(lines[0]).toContain('"b":"5"');
  });
});

describe("policy checker", () => {
  const key = "0x" + "ab".repeat(32);
  const setup = (circuitId: bigint, state: Partial<{ killed: boolean; budgetOk: boolean }> = {}) => {
    const chain = new FakeChain();
    chain.keys.set(key as `0x${string}`, { agentId: 5n, circuitId, killed: false, budgetOk: true, ...state });
    return chain;
  };

  it("allows at the requested tier under Budget Guard", async () => {
    const d = await checkPolicy(setup(1n), key as `0x${string}`, 3, 0);
    expect(d).toMatchObject({ allow: true, routeTier: 3, agentId: 5n, circuitId: 1n, blockNumber: 100n });
    expect(d.inputBits).toBe(0b010011);
    expect(d.outputBits).toBe(0b111);
  });

  it("downgrades under Cheap Only", async () => {
    const d = await checkPolicy(setup(2n), key as `0x${string}`, 3, 0);
    expect(d).toMatchObject({ allow: true, routeTier: 1, outputBits: 0b011 });
  });

  it("denies when killed or over budget", async () => {
    expect((await checkPolicy(setup(1n, { killed: true }), key as `0x${string}`, 1, 0)).allow).toBe(false);
    const d = await checkPolicy(setup(1n, { budgetOk: false }), key as `0x${string}`, 1, 0);
    expect(d).toMatchObject({ allow: false, routeTier: 0, inputBits: 0b000001, outputBits: 0 });
  });

  it("fails closed when eval throws", async () => {
    const chain = setup(1n);
    chain.failEval = true;
    await expect(checkPolicy(chain, key as `0x${string}`, 1, 0)).rejects.toBeInstanceOf(PolicyUnavailable);
  });

  it("fails closed when a chain read throws", async () => {
    const chain = setup(1n);
    chain.failRead = true;
    await expect(checkPolicy(chain, key as `0x${string}`, 1, 0)).rejects.toBeInstanceOf(PolicyUnavailable);
    expect(chain.evalCalls).toBe(0);
  });

  it("fails closed when eval returns nothing", async () => {
    const chain = setup(1n);
    chain.evaluate = async () => new Uint8Array();
    await expect(checkPolicy(chain, key as `0x${string}`, 1, 0)).rejects.toBeInstanceOf(PolicyUnavailable);
  });

  it("rejects unknown keys before calling eval", async () => {
    const chain = new FakeChain();
    await expect(checkPolicy(chain, key as `0x${string}`, 1, 0)).rejects.toBeInstanceOf(UnknownKey);
    expect(chain.evalCalls).toBe(0);
  });
});

describe("RPC transport", () => {
  it("accepts one URL or a comma-separated fallback list, and rejects none", async () => {
    const { rpcTransport } = await import("../../src/chain.ts");
    expect(rpcTransport("https://a.example", 1000)({}).config.type).toBe("http");
    expect(rpcTransport("https://a.example, https://b.example", 1000)({}).config.type).toBe("fallback");
    expect(() => rpcTransport(" , ", 1000)).toThrow(/no RPC URL/);
  });
});
