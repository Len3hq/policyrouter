// Live OKB/USD price, used to convert provider USD prices into OKB for each request.
//
// Sources are tried in order and the first valid answer wins: OKX's OKB-USD index (OKB is OKX's
// token), then CoinGecko, then CoinPaprika. The price is refreshed in the background. If it is
// older than `maxAgeMs`, `current()` returns undefined and the router refuses allowed requests
// rather than guess (fail closed). A refresh that moves the price by more than `maxJump` from the
// last good price is ignored as a bad tick, unless the last good price has already expired.

import type { Logger } from "./log.ts";

/** OKB price in USD with 8 decimals: $122.09 → 12_209_000_000n */
export type PriceE8 = bigint;

export interface PriceQuote {
  okbUsdE8: PriceE8;
  /** ms since epoch when fetched */
  at: number;
  source: string;
}

export interface PriceFeed {
  /** The latest price if it is fresh enough to charge with, else undefined. */
  current(): PriceQuote | undefined;
  /** Fetch now; resolves to the accepted quote or undefined. */
  refresh(): Promise<PriceQuote | undefined>;
  start(): void;
  stop(): void;
}

export interface PriceSource {
  name: string;
  /** Returns the OKB price in USD as a decimal string or number. */
  fetch(fetchFn: typeof fetch, signal: AbortSignal): Promise<string | number>;
}

export const DEFAULT_SOURCES: readonly PriceSource[] = [
  {
    name: "okx",
    async fetch(f, signal) {
      const r = await f("https://www.okx.com/api/v5/market/index-tickers?instId=OKB-USD", { signal });
      if (!r.ok) throw new Error(`okx ${r.status}`);
      const j = (await r.json()) as { data?: { idxPx?: string }[] };
      const px = j.data?.[0]?.idxPx;
      if (!px) throw new Error("okx: no idxPx");
      return px;
    },
  },
  {
    name: "coingecko",
    async fetch(f, signal) {
      const r = await f("https://api.coingecko.com/api/v3/simple/price?ids=okb&vs_currencies=usd", { signal });
      if (!r.ok) throw new Error(`coingecko ${r.status}`);
      const j = (await r.json()) as { okb?: { usd?: number } };
      if (j.okb?.usd === undefined) throw new Error("coingecko: no okb.usd");
      return j.okb.usd;
    },
  },
  {
    name: "coinpaprika",
    async fetch(f, signal) {
      const r = await f("https://api.coinpaprika.com/v1/tickers/okb-okb?quotes=USD", { signal });
      if (!r.ok) throw new Error(`coinpaprika ${r.status}`);
      const j = (await r.json()) as { quotes?: { USD?: { price?: number } } };
      if (j.quotes?.USD?.price === undefined) throw new Error("coinpaprika: no price");
      return j.quotes.USD.price;
    },
  },
];

/** "122.09" or 122.09 → 12_209_000_000n. Rejects anything that isn't a positive finite number. */
export function toE8(v: string | number): PriceE8 {
  const s = typeof v === "number" ? (Number.isFinite(v) ? v.toFixed(8) : "") : v.trim();
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new Error(`not a price: ${v}`);
  const frac = (m[2] ?? "").padEnd(8, "0").slice(0, 8);
  const e8 = BigInt(m[1]!) * 100_000_000n + BigInt(frac || "0");
  if (e8 <= 0n) throw new Error(`not a positive price: ${v}`);
  return e8;
}

export function formatE8(p: PriceE8): string {
  const s = p.toString().padStart(9, "0");
  return `${s.slice(0, -8)}.${s.slice(-8)}`.replace(/0+$/, "").replace(/\.$/, "");
}

export interface PriceFeedOptions {
  sources?: readonly PriceSource[];
  refreshMs?: number;
  maxAgeMs?: number;
  /** Largest accepted move from the last good price, as a fraction (0.5 = 50%) */
  maxJump?: number;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  now?: () => number;
  log?: Logger;
}

export function createPriceFeed(opts: PriceFeedOptions = {}): PriceFeed {
  const sources = opts.sources ?? DEFAULT_SOURCES;
  const refreshMs = opts.refreshMs ?? 60_000;
  const maxAgeMs = opts.maxAgeMs ?? 10 * 60_000;
  const maxJump = opts.maxJump ?? 0.5;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const fetchFn = opts.fetchFn ?? fetch;
  const now = opts.now ?? Date.now;
  let last: PriceQuote | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  const fresh = (q: PriceQuote | undefined) => (q && now() - q.at <= maxAgeMs ? q : undefined);

  async function refresh(): Promise<PriceQuote | undefined> {
    for (const s of sources) {
      let price: PriceE8;
      try {
        price = toE8(await s.fetch(fetchFn, AbortSignal.timeout(timeoutMs)));
      } catch (e) {
        opts.log?.warn("price source failed", { source: s.name, error: String(e) });
        continue;
      }
      const prev = fresh(last);
      if (prev) {
        const move = Math.abs(Number(price - prev.okbUsdE8)) / Number(prev.okbUsdE8);
        if (move > maxJump) {
          opts.log?.warn("price jump ignored", { source: s.name, price: formatE8(price), previous: formatE8(prev.okbUsdE8) });
          continue;
        }
      }
      last = { okbUsdE8: price, at: now(), source: s.name };
      return last;
    }
    opts.log?.error("no OKB price source answered", { lastGood: last ? formatE8(last.okbUsdE8) : null });
    return undefined;
  }

  return {
    current: () => fresh(last),
    refresh,
    start() {
      if (timer) return;
      void refresh();
      timer = setInterval(() => void refresh(), refreshMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}

/** A fixed price, for tests and local rehearsals. */
export function staticPriceFeed(okbUsd: string | number): PriceFeed {
  const q = { okbUsdE8: toE8(okbUsd), at: Date.now(), source: "static" };
  return {
    current: () => ({ ...q, at: Date.now() }),
    refresh: async () => q,
    start() {},
    stop() {},
  };
}
