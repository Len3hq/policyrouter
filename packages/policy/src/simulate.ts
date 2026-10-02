// Policy simulation: "what would this policy have done to my last N requests?"
//
// Each request is replayed through the template's rule with the inputs it actually had (tier,
// size bucket, budget_ok, kill). The result counts what would be allowed unchanged, downgraded or
// denied, and compares spend without any policy (everything served at the requested tier) with
// spend under the policy (denied requests cost nothing; downgraded ones are priced at the tier the
// rule picks). Prices come from the caller, so this module stays independent of any catalog.
//
// Approximations, stated so the numbers aren't over-read:
//   - token counts are kept the same when a request is priced at a different tier;
//   - a request that was denied when it happened has no token counts, so it is priced with the
//     typical usage for its size bucket (TYPICAL_USAGE);
//   - budget_ok is taken as it was; a cheaper policy could have kept budget_ok true for longer.

import { indexToInput, type PolicyInput, type Size, type Tier } from "./bits.ts";
import type { Template } from "./templates.ts";
import sampleWorkload from "./sample-workload.json" with { type: "json" };

export interface SimRequest extends PolicyInput {
  promptTokens: number;
  cachedPromptTokens: number;
  completionTokens: number;
  /** When the request happened (unix seconds), for time-of-day pricing */
  timestamp?: bigint;
  /** OKB price used for the request (8 decimals), if known */
  okbUsdE8?: bigint;
}

/** Cost in wei of serving `r` at `tier`. */
export type PriceFn = (tier: Tier, r: SimRequest) => bigint;

export interface SimResult {
  requests: number;
  /** Allowed at the requested tier */
  allowed: number;
  /** Allowed at a lower tier than requested */
  downgraded: number;
  denied: number;
  /** wei: every request served at its requested tier */
  spendWithout: bigint;
  /** wei: under the policy */
  spendWith: bigint;
  /** (spendWithout - spendWith) / spendWithout, in percent, 2 decimals; 0 when there was no spend */
  savingsPct: number;
}

/** Typical usage per size bucket, for requests with no recorded tokens. */
export const TYPICAL_USAGE: Record<Size, { promptTokens: number; completionTokens: number }> = {
  0: { promptTokens: 500, completionTokens: 300 },
  1: { promptTokens: 2_000, completionTokens: 1_500 },
  2: { promptTokens: 8_000, completionTokens: 4_000 },
  3: { promptTokens: 30_000, completionTokens: 8_000 },
};

export function simulatePolicy(t: Template, requests: readonly SimRequest[], price: PriceFn): SimResult {
  const out: SimResult = { requests: requests.length, allowed: 0, downgraded: 0, denied: 0, spendWithout: 0n, spendWith: 0n, savingsPct: 0 };
  for (const r of requests) {
    out.spendWithout += price(r.tier, r);
    const d = t.evaluate(r);
    if (!d.allow) {
      out.denied++;
      continue;
    }
    if (d.routeTier < r.tier) out.downgraded++;
    else out.allowed++;
    out.spendWith += price(d.routeTier, r);
  }
  if (out.spendWithout > 0n) {
    out.savingsPct = Number(((out.spendWithout - out.spendWith) * 10_000n) / out.spendWithout) / 100;
  }
  return out;
}

/**
 * A request as recorded in a receipt → a simulation input. `inputBits` carries tier, size and
 * the flags exactly as the circuit saw them. Requests without token counts (denied ones) get the
 * typical usage for their size bucket.
 */
export function simRequestFromReceipt(r: {
  inputBits: number;
  promptTokens: number;
  cachedPromptTokens: number;
  completionTokens: number;
  timestamp?: bigint;
  okbUsdE8?: bigint;
}): SimRequest {
  const input = indexToInput(r.inputBits & 0x3f);
  const noUsage = r.promptTokens === 0 && r.completionTokens === 0;
  const usage = noUsage
    ? { ...TYPICAL_USAGE[input.size], cachedPromptTokens: 0 }
    : { promptTokens: r.promptTokens, cachedPromptTokens: r.cachedPromptTokens, completionTokens: r.completionTokens };
  return { ...input, ...usage, timestamp: r.timestamp, okbUsdE8: r.okbUsdE8 && r.okbUsdE8 > 0n ? r.okbUsdE8 : undefined };
}

/** A fixed, mixed workload for agents with no history yet. */
export const SAMPLE_WORKLOAD: readonly SimRequest[] = (
  sampleWorkload.requests as { tier: number; size: number; promptTokens: number; completionTokens: number }[]
).map((r) => ({
  tier: r.tier as Tier,
  size: r.size as Size,
  budgetOk: true,
  kill: false,
  promptTokens: r.promptTokens,
  cachedPromptTokens: 0,
  completionTokens: r.completionTokens,
}));
