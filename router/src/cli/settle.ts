// Settles every unsettled receipt now (finishing any open batch first), then exits.
//   pnpm --filter @policyrouter/router settle
// The router also does this on its own every SETTLE_INTERVAL_MS.

import { existsSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import { loadConfig } from "../config.ts";
import { Store } from "../db.ts";
import { createLogger } from "../log.ts";
import { Settler, createEscrowWriter } from "../settler.ts";

const envFile = new URL("../../../.env", import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);

const cfg = loadConfig();
// the settler never calls a provider; only the router key needs keeping out of the logs
const log = createLogger([cfg.routerPrivateKey]);
const account = privateKeyToAccount(cfg.routerPrivateKey);
const store = new Store(cfg.databasePath);
const settler = new Settler(store, createEscrowWriter({ rpcUrl: cfg.rpcUrl, escrow: cfg.escrow, account, chainId: cfg.chainId }), { log });

const results = await settler.settleAll();
for (const r of results) console.log(JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
store.close();
if (results.some((r) => r.kind === "failed" || r.kind === "conflict")) process.exit(1);
