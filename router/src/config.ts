// Router configuration from environment variables (see .env.example).

import { getAddress, type Address, type Hex } from "viem";

export interface Config {
  port: number;
  rpcUrl: string;
  chainId: number;
  processor: Address;
  registry: Address;
  escrow: Address;
  routerPrivateKey: Hex;
  deepseekBaseUrl: string;
  deepseekApiKey: string;
  databasePath: string;
  rateLimitPerMinute: number;
  blockCacheMs: number;
  rpcTimeoutMs: number;
  priceRefreshMs: number;
  priceMaxAgeMs: number;
}

const ZERO = "0x0000000000000000000000000000000000000000";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const need = (name: string): string => {
    const v = env[name];
    if (!v) throw new Error(`missing env ${name}`);
    return v;
  };
  const addr = (name: string): Address => {
    const a = getAddress(need(name));
    if (a === ZERO) throw new Error(`env ${name} is the zero address; deploy Phase 2 first`);
    return a;
  };
  const key = need("ROUTER_PRIVATE_KEY");
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("ROUTER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex key");
  return {
    port: Number(env.PORT ?? 8787),
    rpcUrl: env.XLAYER_RPC_URL || "https://rpc.xlayer.tech",
    chainId: Number(env.CHAIN_ID ?? 196),
    processor: addr("PROCESSOR_ADDRESS"),
    registry: addr("POLICY_REGISTRY_ADDRESS"),
    escrow: addr("CREDIT_ESCROW_ADDRESS"),
    routerPrivateKey: key as Hex,
    deepseekBaseUrl: env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
    deepseekApiKey: need("DEEPSEEK_API_KEY"),
    databasePath: env.DATABASE_PATH || "policyrouter.sqlite",
    rateLimitPerMinute: Number(env.RATE_LIMIT_PER_MINUTE ?? 60),
    blockCacheMs: Number(env.BLOCK_CACHE_MS ?? 1000),
    rpcTimeoutMs: Number(env.RPC_TIMEOUT_MS ?? 5000),
    priceRefreshMs: Number(env.PRICE_REFRESH_MS ?? 60_000),
    priceMaxAgeMs: Number(env.PRICE_MAX_AGE_MS ?? 600_000),
  };
}
