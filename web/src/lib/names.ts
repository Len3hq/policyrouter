// Project names chosen by the owner. They are a label for this browser only: the registry stores no
// names, so they never reach the chain or the router.

import { CONFIG } from "./config.ts";

export const MAX_NAME_LENGTH = 40;

const prefix = () => `policyrouter:name:${CONFIG.registry.toLowerCase()}:`;

export const agentNames = {
  get(agentId: bigint): string | undefined {
    try {
      return localStorage.getItem(prefix() + agentId) ?? undefined;
    } catch {
      return undefined;
    }
  },
  /** An empty name clears it, so the project shows as "Project #N" again. */
  set(agentId: bigint, name: string) {
    const n = name.trim().slice(0, MAX_NAME_LENGTH);
    try {
      if (n) localStorage.setItem(prefix() + agentId, n);
      else localStorage.removeItem(prefix() + agentId);
    } catch {
      // storage unavailable: the project keeps its number
    }
  },
};

/** "Discord bot (#3)" for a named project, "Project #3" otherwise. */
export function agentLabel(agentId: bigint): string {
  const name = agentNames.get(agentId);
  return name ? `${name} (#${agentId})` : `Project #${agentId}`;
}
