import { describe, expect, it } from "vitest";
import { createPriceFeed, formatE8, toE8, type PriceSource } from "../../src/price.ts";

const src = (name: string, answers: (string | number | Error)[]): PriceSource & { calls: number } => {
  const s = {
    name,
    calls: 0,
    async fetch() {
      const a = answers[Math.min(s.calls++, answers.length - 1)]!;
      if (a instanceof Error) throw a;
      return a;
    },
  };
  return s;
};

describe("price parsing", () => {
  it("parses decimal strings and numbers to 8 decimals", () => {
    expect(toE8("122.09")).toBe(12_209_000_000n);
    expect(toE8(122.16)).toBe(12_216_000_000n);
    expect(toE8("122.032272305289")).toBe(12_203_227_230n); // truncated past 8 decimals
    expect(toE8("5")).toBe(500_000_000n);
    expect(formatE8(12_209_000_000n)).toBe("122.09");
  });

  it("rejects zero, negatives, NaN and junk", () => {
    for (const v of ["0", "0.00000000", "-1", "abc", "", "1e3", Number.NaN, Number.POSITIVE_INFINITY, -5]) {
      expect(() => toE8(v as string | number), String(v)).toThrow();
    }
  });
});

describe("price feed", () => {
  it("uses the first source that answers, in order", async () => {
    const okx = src("okx", [new Error("blocked")]);
    const cg = src("coingecko", ["122.16"]);
    const cp = src("coinpaprika", ["122.03"]);
    const feed = createPriceFeed({ sources: [okx, cg, cp] });
    const q = await feed.refresh();
    expect(q).toMatchObject({ okbUsdE8: 12_216_000_000n, source: "coingecko" });
    expect(cp.calls).toBe(0);
    expect(feed.current()?.source).toBe("coingecko");
  });

  it("skips sources that return junk", async () => {
    const feed = createPriceFeed({ sources: [src("a", ["0"]), src("b", ["nope"]), src("c", [121.5])] });
    expect((await feed.refresh())?.source).toBe("c");
  });

  it("has no price until a refresh succeeds, and none if every source fails", async () => {
    const feed = createPriceFeed({ sources: [src("a", [new Error("x")]), src("b", [new Error("y")])] });
    expect(feed.current()).toBeUndefined();
    expect(await feed.refresh()).toBeUndefined();
    expect(feed.current()).toBeUndefined();
  });

  it("expires a price after maxAgeMs, so the router stops charging with it", async () => {
    let now = 1_000_000;
    const a = src("a", ["122", new Error("down")]);
    const feed = createPriceFeed({ sources: [a], maxAgeMs: 60_000, now: () => now });
    await feed.refresh();
    now += 59_000;
    await feed.refresh(); // source down: keep the last good price while it is fresh
    expect(feed.current()?.okbUsdE8).toBe(12_200_000_000n);
    now += 2_000;
    expect(feed.current()).toBeUndefined();
  });

  it("ignores a jump of more than 50% from a fresh price, but accepts it once the old one expires", async () => {
    let now = 0;
    const a = src("a", ["100", "300", "300"]);
    const feed = createPriceFeed({ sources: [a], maxAgeMs: 60_000, now: () => now });
    await feed.refresh();
    expect(await feed.refresh()).toBeUndefined(); // 100 → 300 rejected
    expect(feed.current()?.okbUsdE8).toBe(10_000_000_000n);
    now += 61_000;
    expect((await feed.refresh())?.okbUsdE8).toBe(30_000_000_000n);
  });

  it("accepts normal moves", async () => {
    const feed = createPriceFeed({ sources: [src("a", ["100", "120", "90"])] });
    await feed.refresh();
    expect((await feed.refresh())?.okbUsdE8).toBe(12_000_000_000n);
    expect((await feed.refresh())?.okbUsdE8).toBe(9_000_000_000n);
  });
});

describe("price source back-off", () => {
  it("skips a failing source for a while, trying healthy ones first", async () => {
    let now = 0;
    const okx = src("okx", [new Error("blocked")]);
    const cg = src("coingecko", ["122"]);
    const feed = createPriceFeed({ sources: [okx, cg], backoffMs: 60_000, now: () => now });
    await feed.refresh();
    expect(okx.calls).toBe(1);
    now += 30_000;
    await feed.refresh();
    expect(okx.calls).toBe(1); // resting
    expect(cg.calls).toBe(2);
    now += 31_000;
    await feed.refresh();
    expect(okx.calls).toBe(2); // tried again after its back-off
  });

  it("backs off longer after repeated failures, up to the cap", async () => {
    let now = 0;
    const okx = src("okx", [new Error("blocked")]);
    const cg = src("coingecko", ["122"]);
    const feed = createPriceFeed({ sources: [okx, cg], backoffMs: 60_000, maxBackoffMs: 150_000, now: () => now });
    await feed.refresh(); // failure 1 → rest 60 s
    now += 61_000;
    await feed.refresh(); // failure 2 → rest 120 s
    now += 100_000;
    await feed.refresh();
    expect(okx.calls).toBe(2);
    now += 21_000;
    await feed.refresh(); // failure 3 → rest min(180, 150) s
    expect(okx.calls).toBe(3);
    now += 149_000;
    await feed.refresh();
    expect(okx.calls).toBe(3);
  });

  it("still tries a resting source as a last resort when every healthy one fails", async () => {
    let now = 0;
    const okx = src("okx", [new Error("blocked"), "121"]);
    const cg = src("coingecko", ["122", new Error("down")]);
    const feed = createPriceFeed({ sources: [okx, cg], now: () => now });
    await feed.refresh(); // okx fails → resting; coingecko answers
    now += 1_000;
    const q = await feed.refresh(); // coingecko fails → okx tried anyway
    expect(q?.source).toBe("okx");
  });

  it("selects sources by name and order, and rejects unknown names", async () => {
    const { selectSources } = await import("../../src/price.ts");
    expect(selectSources(undefined).map((s) => s.name)).toEqual(["okx", "coingecko", "coinpaprika"]);
    expect(selectSources("coinpaprika, coingecko").map((s) => s.name)).toEqual(["coinpaprika", "coingecko"]);
    expect(() => selectSources("okx,binance")).toThrow(/unknown price source "binance"/);
  });
});
