import { describe, expect, it } from "vitest";
import {
  SAMPLE_WORKLOAD,
  TEMPLATES,
  TYPICAL_USAGE,
  budgetGuard,
  cheapOnly,
  inputToIndex,
  simRequestFromReceipt,
  simulatePolicy,
  smallRequests,
  strict,
  type SimRequest,
  type Tier,
} from "../src/index.ts";

// Simple prices for hand-worked checks: tier t costs (t + 1) × 100 wei per token.
const price = (tier: Tier, r: SimRequest) => BigInt((tier + 1) * 100 * (r.promptTokens + r.completionTokens));

const req = (tier: Tier, size: 0 | 1 | 2 | 3, tokens: number, flags: Partial<{ budgetOk: boolean; kill: boolean }> = {}): SimRequest => ({
  tier,
  size,
  budgetOk: true,
  kill: false,
  ...flags,
  promptTokens: tokens,
  cachedPromptTokens: 0,
  completionTokens: 0,
});

/** 10 hand-built requests, each 10 tokens */
const TEN: SimRequest[] = [
  req(0, 0, 10), // cheap
  req(1, 0, 10), // standard
  req(2, 0, 10), // premium
  req(3, 0, 10), // frontier
  req(3, 1, 10),
  req(2, 2, 10),
  req(3, 3, 10), // huge
  req(1, 3, 10), // huge
  req(1, 0, 10, { kill: true }),
  req(0, 0, 10, { budgetOk: false }),
];
// Without any policy: tiers 0,1,2,3,3,2,3,1,1,0 → (1+2+3+4+4+3+4+2+2+1) × 1000 = 26,000 wei

describe("simulatePolicy", () => {
  it("counts always add up to the number of requests", () => {
    for (const t of TEMPLATES) {
      for (const workload of [TEN, SAMPLE_WORKLOAD]) {
        const r = simulatePolicy(t, workload, price);
        expect(r.allowed + r.downgraded + r.denied).toBe(workload.length);
        expect(r.requests).toBe(workload.length);
      }
    }
  });

  it("Budget Guard: denies only the killed and over-budget requests, no savings beyond those", () => {
    const r = simulatePolicy(budgetGuard, TEN, price);
    expect(r).toMatchObject({ allowed: 8, downgraded: 0, denied: 2, spendWithout: 26_000n });
    expect(r.spendWith).toBe(26_000n - 2_000n - 1_000n); // killed tier-1 and over-budget tier-0 cost nothing
  });

  it("Cheap Only: downgrades premium and frontier to standard", () => {
    const r = simulatePolicy(cheapOnly, TEN, price);
    // allowed unchanged: tier 0, tier 1, huge tier 1 = 3; downgraded: tiers 2,3,3,2,3 = 5; denied 2
    expect(r).toMatchObject({ allowed: 3, downgraded: 5, denied: 2 });
    // 1000 + 2000 + 2000 (huge std) + 5 × 2000 (downgraded to tier 1)
    expect(r.spendWith).toBe(15_000n);
    expect(r.savingsPct).toBe(42.3); // 11,000 / 26,000
  });

  it("Small Requests: denies the two huge requests", () => {
    const r = simulatePolicy(smallRequests, TEN, price);
    expect(r).toMatchObject({ allowed: 6, downgraded: 0, denied: 4 });
    expect(r.spendWith).toBe(26_000n - 4_000n - 2_000n - 2_000n - 1_000n); // 17,000
  });

  it("Strict: both", () => {
    const r = simulatePolicy(strict, TEN, price);
    expect(r).toMatchObject({ allowed: 2, downgraded: 4, denied: 4 });
    expect(r.spendWith).toBe(1_000n + 2_000n + 4n * 2_000n); // 11,000
  });

  it("denied requests cost nothing", () => {
    const everyoneKilled = TEN.map((r) => ({ ...r, kill: true }));
    expect(simulatePolicy(budgetGuard, everyoneKilled, price).spendWith).toBe(0n);
  });

  it("savingsPct is 0 under a policy that allows everything at the requested tier", () => {
    const open = TEN.filter((r) => !r.kill && r.budgetOk);
    const r = simulatePolicy(budgetGuard, open, price);
    expect(r.spendWith).toBe(r.spendWithout);
    expect(r.savingsPct).toBe(0);
  });

  it("an empty history gives zeros, not NaN", () => {
    expect(simulatePolicy(cheapOnly, [], price)).toEqual({
      requests: 0, allowed: 0, downgraded: 0, denied: 0, spendWithout: 0n, spendWith: 0n, savingsPct: 0,
    });
  });
});

describe("simRequestFromReceipt", () => {
  it("reads tier, size and flags from the receipt's input bits", () => {
    const bits = inputToIndex({ tier: 2, size: 1, budgetOk: true, kill: false });
    const r = simRequestFromReceipt({ inputBits: bits, promptTokens: 12, cachedPromptTokens: 3, completionTokens: 7 });
    expect(r).toMatchObject({ tier: 2, size: 1, budgetOk: true, kill: false, promptTokens: 12, cachedPromptTokens: 3, completionTokens: 7 });
  });

  it("uses typical usage for the size bucket when the receipt has no tokens (a denial)", () => {
    const bits = inputToIndex({ tier: 3, size: 2, budgetOk: true, kill: true });
    const r = simRequestFromReceipt({ inputBits: bits, promptTokens: 0, cachedPromptTokens: 0, completionTokens: 0 });
    expect(r).toMatchObject({ kill: true, ...TYPICAL_USAGE[2], cachedPromptTokens: 0 });
  });
});

describe("sample workload", () => {
  it("has 20 open requests across every tier and size", () => {
    expect(SAMPLE_WORKLOAD).toHaveLength(20);
    expect(new Set(SAMPLE_WORKLOAD.map((r) => r.tier))).toEqual(new Set([0, 1, 2, 3]));
    expect(new Set(SAMPLE_WORKLOAD.map((r) => r.size))).toEqual(new Set([0, 1, 2, 3]));
    expect(SAMPLE_WORKLOAD.every((r) => r.budgetOk && !r.kill)).toBe(true);
  });

  it("shows Strict saving more than Cheap Only, which saves more than Budget Guard", () => {
    const s = (t: typeof budgetGuard) => simulatePolicy(t, SAMPLE_WORKLOAD, price).savingsPct;
    expect(s(budgetGuard)).toBe(0);
    expect(s(cheapOnly)).toBeGreaterThan(0);
    expect(s(strict)).toBeGreaterThan(s(cheapOnly));
  });
});
