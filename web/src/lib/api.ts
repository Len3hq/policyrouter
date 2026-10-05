// API keys (generated in the browser) and calls to the router.

import { keccak256, stringToBytes, type Hex } from "viem";
import { CONFIG } from "./config.ts";

/** `pr-live-` + 48 hex characters, the same format the router accepts. */
export function generateKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return `pr-live-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** keccak256 of the key's UTF-8 bytes: what PolicyRegistry stores and the router looks up. */
export const hashKey = (key: string): Hex => keccak256(stringToBytes(key));

export const isWellFormedKey = (key: string) => /^pr-live-[0-9a-f]{48}$/.test(key);

// The key is kept in this browser tab's session only, so the dashboard can show usage after the
// owner creates an agent. It is never sent anywhere except as the bearer token to the router.
const SESSION_PREFIX = "policyrouter:key:";
export const sessionKey = {
  get(agentId: bigint): string | undefined {
    try {
      return sessionStorage.getItem(SESSION_PREFIX + agentId) ?? undefined;
    } catch {
      return undefined;
    }
  },
  set(agentId: bigint, key: string) {
    try {
      sessionStorage.setItem(SESSION_PREFIX + agentId, key);
    } catch {
      // storage unavailable: the owner can paste the key again
    }
  },
};

export interface SimResult {
  template: string;
  name: string;
  rule: string;
  circuitId: string | null;
  requests: number;
  allowed: number;
  downgraded: number;
  denied: number;
  spendWithout: string;
  spendWith: string;
  savingsPct: number;
}

export interface SimResponse {
  source: "history" | "sample";
  requests: number;
  results: SimResult[];
}

export interface Usage {
  requests: number;
  allowed: number;
  downgraded: number;
  denied: number;
  spentWei: string;
  unsettledWei: string;
  recent: { requestId: Hex; modelRequested: string; modelServed: string; allowed: boolean; downgraded: boolean; costWei: string; timestamp: string }[];
}

async function get<T>(path: string, key?: string): Promise<T> {
  const res = await fetch(`${CONFIG.routerUrl}${path}`, { headers: key ? { authorization: `Bearer ${key}` } : {} });
  const body = (await res.json()) as T & { error?: { message: string } };
  if (!res.ok) throw new Error(body.error?.message ?? `router returned ${res.status}`);
  return body;
}

export const api = {
  simulate: (key?: string) => get<SimResponse>("/v1/simulate", key),
  usage: (key: string) => get<Usage>("/v1/usage", key),
};
