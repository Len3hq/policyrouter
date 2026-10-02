import { describe, expect, it } from "vitest";
import { parseUnits } from "viem";
import {
  costUsdScaled,
  costWei,
  defaultForTier,
  estimateTokens,
  findModel,
  isPeak,
  loadCatalog,
  parseCatalog,
  servedModel,
  sizeBucket,
  usdScaledToOkbWei,
  type CatalogFile,
} from "../../src/catalog.ts";

const catalog = loadCatalog();
const utc = (y: number, mo: number, d: number, h: number, mi = 0) => Date.UTC(y, mo - 1, d, h, mi) / 1000;

const OKB_100 = 10_000_000_000n; // $100.00000000

/** A small catalog with round numbers for hand-worked checks (no markup; tests use OKB = $100). */
const simple: CatalogFile = {
  pricing: { markupBps: 0, peak: { weekdaysUtc: [1, 2, 3, 4, 5], hoursUtc: [[1, 4], [6, 10]] } },
  providers: {
    up: {
      peak: { inputCacheHit: "0.01", inputCacheMiss: "0.3", output: "1.2" },
      offPeak: { inputCacheHit: "0.005", inputCacheMiss: "0.15", output: "0.6" },
    },
  },
  models: [0, 1, 2, 3].map((tier) => ({ id: `m${tier}`, tier, provider: "p", upstreamModel: "up", defaultForTier: true })),
  sizeBuckets: { bounds: [1, 2, 3], defaultMaxTokens: 1 },
};

describe("catalog", () => {
  it("serves DeepSeek's current models, with thinking off then on, across tiers 0-3", () => {
    const rows = catalog.models.map((m) => [m.id, m.tier, m.upstreamModel, m.thinking]);
    expect(rows).toEqual([
      ["cheap", 0, "deepseek-flash", "disabled"],
      ["standard", 1, "deepseek-flash", "enabled"],
      ["premium", 2, "deepseek-v4-pro", "disabled"],
      ["frontier", 3, "deepseek-v4-pro", "enabled"],
    ]);
    for (const t of [0, 1, 2, 3] as const) expect(defaultForTier(catalog, t).tier).toBe(t);
  });

  it("prices every model, with off-peak at half of peak and pro above flash", () => {
    for (const m of catalog.models) {
      for (const k of ["inputCacheHit", "inputCacheMiss", "output"] as const) {
        expect(m.prices.peak[k]).toBeGreaterThan(0n);
        // DeepSeek: off-peak is half of peak (allow 1 wei of rounding)
        expect(m.prices.peak[k] - 2n * m.prices.offPeak[k]).toBeGreaterThanOrEqual(-2n);
        expect(m.prices.peak[k] - 2n * m.prices.offPeak[k]).toBeLessThanOrEqual(2n);
      }
    }
    const flash = findModel(catalog, "cheap")!.prices.peak;
    const pro = findModel(catalog, "premium")!.prices.peak;
    expect(pro.output).toBeGreaterThan(flash.output);
    expect(flash.inputCacheHit).toBeLessThan(flash.inputCacheMiss);
  });

  it("finds known models and returns undefined for unknown ones", () => {
    expect(findModel(catalog, "frontier")?.tier).toBe(3);
    expect(findModel(catalog, "deepseek-flash")).toBeUndefined(); // public names only
  });

  it("rejects broken catalogs", () => {
    expect(() => parseCatalog(simple)).not.toThrow();
    const m0 = simple.models[0]!;
    expect(() => parseCatalog({ ...simple, models: [...simple.models, { ...m0, tier: 4, id: "x" }] })).toThrow(/tier/);
    expect(() => parseCatalog({ ...simple, models: simple.models.slice(1) })).toThrow(/tier 0/);
    expect(() => parseCatalog({ ...simple, models: [...simple.models, m0] })).toThrow(/duplicate/);
    expect(() => parseCatalog({ ...simple, models: [{ ...m0, upstreamModel: "nope" }] })).toThrow(/no prices/);
    expect(() => parseCatalog({ ...simple, models: [{ ...m0, thinking: "maybe" }] })).toThrow(/thinking/);
    expect(() => parseCatalog({ ...simple, sizeBuckets: { bounds: [3, 2, 1], defaultMaxTokens: 1 } })).toThrow(/increasing/);
    expect(() => parseCatalog({ ...simple, pricing: { ...simple.pricing, markupBps: -1 } })).toThrow(/markup/);
  });
});

describe("USD → OKB at the live price", () => {
  it("converts at the OKB price and adds the markup, rounding up", () => {
    const usd = (s: string) => parseUnits(s, 18);
    expect(usdScaledToOkbWei(usd("0.3"), OKB_100, 0)).toBe(3_000_000_000_000_000n); // $0.3 / $100 = 0.003 OKB
    expect(usdScaledToOkbWei(usd("0.3"), OKB_100, 1000)).toBe(3_300_000_000_000_000n); // +10%
    expect(usdScaledToOkbWei(usd("1"), 300_000_000n, 0)).toBe(333_333_333_333_333_334n); // OKB = $3 → 1/3 OKB, rounded up
    expect(() => usdScaledToOkbWei(usd("1"), 0n, 0)).toThrow(/positive/);
  });

  it("keeps DeepSeek's USD prices as published", () => {
    const flash = findModel(catalog, "cheap")!.prices;
    expect(flash.peak.inputCacheMiss).toBe(parseUnits("0.3", 18));
    expect(flash.offPeak.output).toBe(parseUnits("0.6", 18));
    expect(catalog.markupBps).toBe(1000);
  });

  it("charges half as much OKB when OKB is worth twice as much", () => {
    const m = findModel(catalog, "frontier")!;
    const u = { promptTokens: 10_000, cachedPromptTokens: 0, completionTokens: 10_000 };
    const t = utc(2026, 10, 5, 7);
    expect(costWei(catalog, m, u, t, OKB_100)).toBe(2n * costWei(catalog, m, u, t, 2n * OKB_100));
  });
});

describe("peak hours (UTC, Monday-Friday, 01-04 and 06-10)", () => {
  it("knows peak from off-peak", () => {
    expect(isPeak(catalog, utc(2026, 10, 5, 1))).toBe(true); // Monday 01:00
    expect(isPeak(catalog, utc(2026, 10, 5, 3, 59))).toBe(true);
    expect(isPeak(catalog, utc(2026, 10, 5, 4))).toBe(false); // 04:00 ends the first window
    expect(isPeak(catalog, utc(2026, 10, 5, 5))).toBe(false);
    expect(isPeak(catalog, utc(2026, 10, 5, 6))).toBe(true);
    expect(isPeak(catalog, utc(2026, 10, 5, 9, 59))).toBe(true);
    expect(isPeak(catalog, utc(2026, 10, 5, 10))).toBe(false);
    expect(isPeak(catalog, utc(2026, 10, 5, 0, 59))).toBe(false);
    expect(isPeak(catalog, utc(2026, 10, 9, 7))).toBe(true); // Friday
    expect(isPeak(catalog, utc(2026, 10, 3, 7))).toBe(false); // Saturday
    expect(isPeak(catalog, utc(2026, 10, 4, 7))).toBe(false); // Sunday
  });
});

describe("served model", () => {
  it("serves the requested model when the circuit keeps its tier, else the tier default", () => {
    const frontier = findModel(catalog, "frontier")!;
    expect(servedModel(catalog, frontier, 3).id).toBe("frontier");
    expect(servedModel(catalog, frontier, 1).id).toBe("standard");
  });
});

describe("metering", () => {
  const c = parseCatalog(simple);
  const m = c.models[0]!;
  const usage = { promptTokens: 2000, cachedPromptTokens: 1000, completionTokens: 500 };

  it("matches a hand-worked peak cost, splitting cached and uncached prompt tokens", () => {
    // OKB/1M: hit 0.0001, miss 0.003, out 0.012
    // 1000·0.0001 + 1000·0.003 + 500·0.012 = 0.1 + 3 + 6 = 9.1 OKB per 1M → 9.1e-6 OKB
    expect(costUsdScaled(c, m, usage, utc(2026, 10, 5, 7))).toBe(parseUnits("0.00091", 18)); // $0.00091
    expect(costWei(c, m, usage, utc(2026, 10, 5, 7), OKB_100)).toBe(9_100_000_000_000n);
  });

  it("charges half off-peak", () => {
    expect(costWei(c, m, usage, utc(2026, 10, 3, 7), OKB_100)).toBe(4_550_000_000_000n);
  });

  it("bills every prompt token as a miss when nothing was cached, and caps cached at prompt", () => {
    const t = utc(2026, 10, 5, 7);
    expect(costWei(c, m, { ...usage, cachedPromptTokens: 0 }, t, OKB_100)).toBe(12_000_000_000_000n);
    expect(costWei(c, m, { ...usage, cachedPromptTokens: 99_999 }, t, OKB_100)).toBe(costWei(c, m, { ...usage, cachedPromptTokens: 2000 }, t, OKB_100));
  });

  it("rounds up to the next wei", () => {
    const tiny = { ...m, prices: { ...m.prices, peak: { inputCacheHit: 0n, inputCacheMiss: 3n, output: 0n } } };
    expect(costWei(c, tiny, { promptTokens: 1, cachedPromptTokens: 0, completionTokens: 0 }, utc(2026, 10, 5, 7), OKB_100)).toBe(1n);
  });

  it("charges a downgraded request at the served tier", () => {
    const frontier = findModel(catalog, "frontier")!;
    const served = servedModel(catalog, frontier, 1);
    const t = utc(2026, 10, 5, 7);
    expect(costWei(catalog, served, usage, t, OKB_100)).toBeLessThan(costWei(catalog, frontier, usage, t, OKB_100));
  });
});

describe("size buckets", () => {
  const [a, b, c] = catalog.sizeBounds;

  it("puts each boundary in the right bucket", () => {
    expect(sizeBucket(catalog, 0, a - 1)).toBe(0);
    expect(sizeBucket(catalog, 0, a)).toBe(1);
    expect(sizeBucket(catalog, 0, b - 1)).toBe(1);
    expect(sizeBucket(catalog, 0, b)).toBe(2);
    expect(sizeBucket(catalog, 0, c - 1)).toBe(2);
    expect(sizeBucket(catalog, 0, c)).toBe(3);
  });

  it("adds prompt tokens and max tokens, defaulting max tokens", () => {
    expect(sizeBucket(catalog, a, 0)).toBe(1);
    expect(sizeBucket(catalog, 0, undefined)).toBe(sizeBucket(catalog, 0, catalog.defaultMaxTokens));
  });

  it("estimates about 4 characters per token", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });
});
