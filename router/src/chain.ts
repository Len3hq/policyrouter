// Reads policy state from X Layer at one pinned block and calls eval() at that same block, so a
// receipt records exactly the state the router acted on.

import { createPublicClient, http, type Address, type Hex, type PublicClient } from "viem";

const registryAbi = [
  {
    type: "function",
    name: "policyOf",
    stateMutability: "view",
    inputs: [{ name: "keyHash", type: "bytes32" }],
    outputs: [
      { name: "agentId", type: "uint256" },
      { name: "owner", type: "address" },
      { name: "circuitId", type: "uint256" },
      { name: "dailyCap", type: "uint128" },
      { name: "killed", type: "bool" },
    ],
  },
] as const;

const escrowAbi = [
  {
    type: "function",
    name: "budgetOkForKey",
    stateMutability: "view",
    inputs: [{ name: "keyHash", type: "bytes32" }],
    outputs: [{ type: "bool" }],
  },
] as const;

const processorAbi = [
  {
    type: "function",
    name: "eval",
    stateMutability: "view",
    inputs: [
      { name: "circuitId", type: "uint256" },
      { name: "input", type: "bytes" },
    ],
    outputs: [{ type: "bytes" }],
  },
] as const;

export interface PolicyState {
  blockNumber: bigint;
  /** 0 when the key is not registered */
  agentId: bigint;
  circuitId: bigint;
  killed: boolean;
  budgetOk: boolean;
}

export interface ChainReader {
  readonly processor: Address;
  policyState(keyHash: Hex): Promise<PolicyState>;
  evaluate(circuitId: bigint, input: Uint8Array, blockNumber: bigint): Promise<Uint8Array>;
}

export interface ChainConfig {
  rpcUrl: string;
  processor: Address;
  registry: Address;
  escrow: Address;
  /** How long a block number is reused before asking the RPC again. 0 = every request. */
  blockCacheMs: number;
  /** Per-call timeout; a slow RPC fails closed rather than holding the request. */
  timeoutMs: number;
}

export function createChainReader(cfg: ChainConfig, client?: PublicClient): ChainReader {
  const c = client ?? createPublicClient({ transport: http(cfg.rpcUrl, { timeout: cfg.timeoutMs, retryCount: 0 }) });
  let cachedBlock: { n: bigint; at: number } | undefined;
  const stateCache = new Map<string, PolicyState>();

  async function pinnedBlock(): Promise<bigint> {
    const now = Date.now();
    if (cachedBlock && now - cachedBlock.at < cfg.blockCacheMs) return cachedBlock.n;
    const n = await c.getBlockNumber({ cacheTime: 0 });
    if (!cachedBlock || n !== cachedBlock.n) stateCache.clear(); // state is cached per block only
    cachedBlock = { n, at: now };
    return n;
  }

  return {
    processor: cfg.processor,

    async policyState(keyHash) {
      const blockNumber = await pinnedBlock();
      const cacheKey = `${blockNumber}:${keyHash}`;
      const hit = stateCache.get(cacheKey);
      if (hit) return hit;

      const [policy, budgetOk] = await Promise.all([
        c.readContract({ address: cfg.registry, abi: registryAbi, functionName: "policyOf", args: [keyHash], blockNumber }),
        c.readContract({ address: cfg.escrow, abi: escrowAbi, functionName: "budgetOkForKey", args: [keyHash], blockNumber }),
      ]);
      const [agentId, , circuitId, , killed] = policy;
      const state: PolicyState = { blockNumber, agentId, circuitId, killed, budgetOk };
      stateCache.set(cacheKey, state);
      return state;
    },

    async evaluate(circuitId, input, blockNumber) {
      const out = await c.readContract({
        address: cfg.processor,
        abi: processorAbi,
        functionName: "eval",
        args: [circuitId, `0x${Buffer.from(input).toString("hex")}`],
        blockNumber,
      });
      return Uint8Array.from(Buffer.from(out.slice(2), "hex"));
    },
  };
}
