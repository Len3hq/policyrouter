// The model catalog: public model names, their policy tier, where they are served, and prices.
//
// Provider prices are kept in USD exactly as the provider publishes them (peak and off-peak, cache
// hit and miss, output). Each request is converted to wei of OKB at the live OKB/USD price
// (see price.ts): USD ÷ okbUsd × (1 + markup).

import { readFileSync } from "node:fs";
import { parseUnits } from "viem";
import type { Size, Tier } from "@policyrouter/policy";

/** USD per million tokens, scaled by 1e18 */
export interface PriceTriple {
  inputCacheHit: bigint;
  inputCacheMiss: bigint;
  output: bigint;
}

export interface CatalogModel {
  id: string;
  tier: Tier;
  provider: string;
  upstreamModel: string;
  /** Forced on every upstream request, so an agent can't change its tier's thinking mode. */
  thinking?: "enabled" | "disabled";
  prices: { peak: PriceTriple; offPeak: PriceTriple };
  defaultForTier: boolean;
}

export interface PeakSchedule {
  /** 0 = Sunday … 6 = Saturday, UTC */
  weekdays: readonly number[];
  /** [startHour, endHour) pairs, UTC */
  hours: readonly (readonly [number, number])[];
}

export interface Catalog {
  models: readonly CatalogModel[];
  /** Markup over provider cost, in basis points */
  markupBps: number;
  peak: PeakSchedule;
  /** Token bounds between size buckets 0|1, 1|2 and 2|3 */
  sizeBounds: readonly [number, number, number];
  defaultMaxTokens: number;
}

type UsdTriple = { inputCacheHit: string; inputCacheMiss: string; output: string };

export interface CatalogFile {
  pricing: {
    markupBps: number;
    peak: { weekdaysUtc: number[]; hoursUtc: number[][] };
  };
  providers: Record<string, { peak: UsdTriple; offPeak: UsdTriple }>;
  models: {
    id: string;
    tier: number;
    provider: string;
    upstreamModel: string;
    thinking?: string;
    defaultForTier?: boolean;
  }[];
  sizeBuckets: { bounds: number[]; defaultMaxTokens: number };
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/** USD amount (scaled by 1e18) → wei of OKB at `okbUsdE8` (price with 8 decimals), plus markup, rounded up. */
export function usdScaledToOkbWei(usdScaled: bigint, okbUsdE8: bigint, markupBps: number): bigint {
  if (okbUsdE8 <= 0n) throw new Error("OKB price must be positive");
  return ceilDiv(usdScaled * 100_000_000n * BigInt(10_000 + markupBps), okbUsdE8 * 10_000n);
}

export function parseCatalog(raw: CatalogFile): Catalog {
  const { markupBps } = raw.pricing;
  if (!Number.isInteger(markupBps) || markupBps < 0) throw new Error("markupBps must be a non-negative integer");
  const triple = (t: UsdTriple): PriceTriple => ({
    inputCacheHit: parseUnits(t.inputCacheHit, 18),
    inputCacheMiss: parseUnits(t.inputCacheMiss, 18),
    output: parseUnits(t.output, 18),
  });

  const models = raw.models.map((m) => {
    if (!Number.isInteger(m.tier) || m.tier < 0 || m.tier > 3) throw new Error(`model ${m.id}: tier must be 0-3`);
    const p = raw.providers[m.upstreamModel];
    if (!p) throw new Error(`model ${m.id}: no prices for upstream model ${m.upstreamModel}`);
    if (m.thinking !== undefined && m.thinking !== "enabled" && m.thinking !== "disabled") {
      throw new Error(`model ${m.id}: thinking must be "enabled" or "disabled"`);
    }
    return {
      id: m.id,
      tier: m.tier as Tier,
      provider: m.provider,
      upstreamModel: m.upstreamModel,
      thinking: m.thinking as CatalogModel["thinking"],
      prices: { peak: triple(p.peak), offPeak: triple(p.offPeak) },
      defaultForTier: m.defaultForTier ?? false,
    };
  });
  const ids = new Set(models.map((m) => m.id));
  if (ids.size !== models.length) throw new Error("duplicate model ids in catalog");
  for (const tier of [0, 1, 2, 3] as const) {
    const defaults = models.filter((m) => m.tier === tier && m.defaultForTier);
    if (defaults.length !== 1) throw new Error(`tier ${tier} needs exactly one defaultForTier model`);
  }
  const b = raw.sizeBuckets.bounds;
  if (b.length !== 3 || !(b[0]! < b[1]! && b[1]! < b[2]!)) throw new Error("sizeBuckets.bounds must be 3 increasing numbers");
  const hours = raw.pricing.peak.hoursUtc.map(([s, e]) => {
    if (!(s! >= 0 && e! <= 24 && s! < e!)) throw new Error("peak.hoursUtc must be [start, end) pairs within 0-24");
    return [s!, e!] as const;
  });
  return {
    models,
    markupBps,
    peak: { weekdays: raw.pricing.peak.weekdaysUtc, hours },
    sizeBounds: [b[0]!, b[1]!, b[2]!],
    defaultMaxTokens: raw.sizeBuckets.defaultMaxTokens,
  };
}

export function loadCatalog(path = new URL("../catalog.json", import.meta.url)): Catalog {
  return parseCatalog(JSON.parse(readFileSync(path, "utf8")) as CatalogFile);
}

export function findModel(c: Catalog, id: string): CatalogModel | undefined {
  return c.models.find((m) => m.id === id);
}

export function defaultForTier(c: Catalog, tier: Tier): CatalogModel {
  return c.models.find((m) => m.tier === tier && m.defaultForTier)!;
}

/** The model actually served: the requested one if the circuit kept its tier, else the tier default. */
export function servedModel(c: Catalog, requested: CatalogModel, routeTier: Tier): CatalogModel {
  return routeTier === requested.tier ? requested : defaultForTier(c, routeTier);
}

export function isPeak(c: Catalog, unixSeconds: bigint | number): boolean {
  const d = new Date(Number(unixSeconds) * 1000);
  if (!c.peak.weekdays.includes(d.getUTCDay())) return false;
  const h = d.getUTCHours();
  return c.peak.hours.some(([s, e]) => h >= s && h < e);
}

export interface MeteredUsage {
  promptTokens: number;
  /** Prompt tokens served from the provider's context cache (billed at the cache-hit rate) */
  cachedPromptTokens: number;
  completionTokens: number;
}

/** Provider cost in USD, scaled by 1e18, at the served model's price for the time of the request. */
export function costUsdScaled(c: Catalog, m: CatalogModel, u: MeteredUsage, unixSeconds: bigint | number): bigint {
  const p = isPeak(c, unixSeconds) ? m.prices.peak : m.prices.offPeak;
  const cached = BigInt(Math.min(u.cachedPromptTokens, u.promptTokens));
  const missed = BigInt(u.promptTokens) - cached;
  const perMillion = cached * p.inputCacheHit + missed * p.inputCacheMiss + BigInt(u.completionTokens) * p.output;
  return ceilDiv(perMillion, 1_000_000n);
}

/**
 * Cost in wei of OKB: provider USD cost at the served model's price for the time of the request,
 * converted at `okbUsdE8` with the markup, rounded up. Everything needed to recompute it is in the
 * receipt: model served, timestamp, prompt / cached / completion tokens, and the OKB price used.
 */
export function costWei(c: Catalog, m: CatalogModel, u: MeteredUsage, unixSeconds: bigint | number, okbUsdE8: bigint): bigint {
  return usdScaledToOkbWei(costUsdScaled(c, m, u, unixSeconds), okbUsdE8, c.markupBps);
}

/**
 * Rough token estimate for size bucketing: about 4 characters per token. Buckets are coarse
 * (thousands of tokens apart), so an estimate is enough; the receipt records the bucket used.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function sizeBucket(c: Catalog, promptTokens: number, maxTokens: number | undefined): Size {
  const size = promptTokens + (maxTokens ?? c.defaultMaxTokens);
  const [a, b, d] = c.sizeBounds;
  if (size < a) return 0;
  if (size < b) return 1;
  if (size < d) return 2;
  return 3;
}
