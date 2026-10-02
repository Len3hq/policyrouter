// Starts the router: `pnpm --filter @policyrouter/router start` (reads ../.env if present).

import { existsSync } from "node:fs";
import { serve } from "@hono/node-server";
import { privateKeyToAccount } from "viem/accounts";
import { receiptDomain } from "@policyrouter/policy";
import { createApp } from "./app.ts";
import { loadCatalog } from "./catalog.ts";
import { createChainReader } from "./chain.ts";
import { loadConfig } from "./config.ts";
import { Store } from "./db.ts";
import { createLogger } from "./log.ts";
import { createOpenAICompatibleProvider } from "./providers/openai-compatible.ts";
import { createPriceFeed, formatE8, selectSources } from "./price.ts";
import { RateLimiter } from "./ratelimit.ts";
import { createReceiptSigner } from "./receipts.ts";
import { Settler, createEscrowWriter } from "./settler.ts";

const envFile = new URL("../../.env", import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);

const cfg = loadConfig();
const log = createLogger([cfg.deepseekApiKey, cfg.routerPrivateKey]);
const account = privateKeyToAccount(cfg.routerPrivateKey);

// Live OKB/USD price. Wait for the first quote so the router doesn't start by refusing requests.
const price = createPriceFeed({
  sources: selectSources(cfg.priceSources),
  refreshMs: cfg.priceRefreshMs,
  maxAgeMs: cfg.priceMaxAgeMs,
  log,
});
const first = await price.refresh();
if (first) log.info("OKB price", { usd: formatE8(first.okbUsdE8), source: first.source });
else log.error("no OKB price at startup; charged requests return 503 until a source answers");
price.start();

const store = new Store(cfg.databasePath);

const app = createApp({
  catalog: loadCatalog(),
  chain: createChainReader({
    rpcUrl: cfg.rpcUrl,
    processor: cfg.processor,
    registry: cfg.registry,
    escrow: cfg.escrow,
    blockCacheMs: cfg.blockCacheMs,
    timeoutMs: cfg.rpcTimeoutMs,
  }),
  providers: {
    deepseek: createOpenAICompatibleProvider({ name: "deepseek", baseURL: cfg.deepseekBaseUrl, apiKey: cfg.deepseekApiKey }),
  },
  signer: createReceiptSigner(account, receiptDomain(cfg.chainId, cfg.escrow)),
  store,
  limiter: new RateLimiter(cfg.rateLimitPerMinute),
  price,
  log,
});

// Settles receipts on chain every SETTLE_INTERVAL_MS (0 = off; run `pnpm settle` instead).
let settler: Settler | undefined;
if (cfg.settleIntervalMs > 0) {
  settler = new Settler(
    store,
    createEscrowWriter({ rpcUrl: cfg.rpcUrl, escrow: cfg.escrow, account, chainId: cfg.chainId }),
    { log },
  );
  settler.start(cfg.settleIntervalMs);
  log.info("settler running", { everyMs: cfg.settleIntervalMs });
}

const server = serve({ fetch: app.fetch, port: cfg.port }, (info) => {
  log.info("PolicyRouter listening", { port: info.port, router: account.address, chainId: cfg.chainId, escrow: cfg.escrow });
});

// Clean shutdown: stop timers, finish in-flight requests, close the database.
// A settle cycle cut off here is safe: the next start reconciles it against the chain.
// Node finishes pending DNS lookups before exiting, so if a price source's host doesn't resolve,
// exit can take up to the system resolver timeout (~30 s). Leave such sources out of PRICE_SOURCES.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    log.info("shutting down", { signal });
    settler?.stop();
    price.stop();
    server.close(() => {
      store.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}
