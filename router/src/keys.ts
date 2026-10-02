// API keys: `pr-live-` followed by 48 hex characters (24 random bytes).
// Only keccak256(key) is ever stored, on chain (PolicyRegistry) or in the router database.

import { randomBytes } from "node:crypto";
import { keccak256, stringToBytes, type Hex } from "viem";

export const KEY_PREFIX = "pr-live-";
const KEY_RE = /^pr-live-[0-9a-f]{48}$/;

export function generateKey(): string {
  return KEY_PREFIX + randomBytes(24).toString("hex");
}

export function isWellFormedKey(key: string): boolean {
  return KEY_RE.test(key);
}

export function hashKey(key: string): Hex {
  return keccak256(stringToBytes(key));
}

/** Extracts the key from an `Authorization: Bearer pr-live-…` header, or undefined. */
export function keyFromAuthHeader(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return m?.[1];
}
