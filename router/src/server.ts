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
import { createPriceFeed, formatE8 } from "./price.ts";
import { RateLimiter } from "./ratelimit.ts";
import { createReceiptSigner } from "./receipts.ts";

const envFile = new URL("../../.env", import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);

const cfg = loadConfig();
const log = createLogger([cfg.deepseekApiKey, cfg.routerPrivateKey]);
const account = privateKeyToAccount(cfg.routerPrivateKey);

// Live OKB/USD price. Wait for the first quote so the router doesn't start by refusing requests.
const price = createPriceFeed({ refreshMs: cfg.priceRefreshMs, maxAgeMs: cfg.priceMaxAgeMs, log });
const first = await price.refresh();
if (first) log.info("OKB price", { usd: formatE8(first.okbUsdE8), source: first.source });
else log.error("no OKB price at startup; charged requests return 503 until a source answers");
price.start();

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
  store: new Store(cfg.databasePath),
  limiter: new RateLimiter(cfg.rateLimitPerMinute),
  price,
  log,
});

serve({ fetch: app.fetch, port: cfg.port }, (info) => {
  log.info("PolicyRouter listening", { port: info.port, router: account.address, chainId: cfg.chainId, escrow: cfg.escrow });
});
