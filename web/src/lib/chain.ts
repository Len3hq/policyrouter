// Read access to X Layer, and the contract ABIs the app uses.

import { createPublicClient, defineChain, formatEther, http, type Address, type Hex } from "viem";
import { CONFIG } from "./config.ts";

export const xlayer = defineChain({
  id: CONFIG.chainId,
  name: "X Layer",
  nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
  rpcUrls: { default: { http: [CONFIG.rpcUrl] } },
  blockExplorers: { default: { name: "OKLink", url: CONFIG.explorer } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});

export const publicClient = createPublicClient({ chain: xlayer, transport: http(CONFIG.rpcUrl), batch: { multicall: true } });

export const registryAbi = [
  { type: "function", name: "agentCount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "agent",
    stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "owner", type: "address" },
          { name: "circuitId", type: "uint64" },
          { name: "killed", type: "bool" },
          { name: "dailyCap", type: "uint128" },
          { name: "keyHash", type: "bytes32" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "registerAgent",
    stateMutability: "nonpayable",
    inputs: [
      { name: "keyHash", type: "bytes32" },
      { name: "circuitId", type: "uint256" },
      { name: "dailyCap", type: "uint128" },
    ],
    outputs: [{ name: "agentId", type: "uint256" }],
  },
  {
    type: "function",
    name: "setCircuit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "circuitId", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "setDailyCap",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "dailyCap", type: "uint128" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "setKill",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "killed", type: "bool" },
    ],
    outputs: [],
  },
  {
    type: "event",
    name: "AgentRegistered",
    inputs: [
      { name: "agentId", type: "uint256", indexed: true },
      { name: "owner", type: "address", indexed: true },
      { name: "keyHash", type: "bytes32", indexed: true },
      { name: "circuitId", type: "uint256", indexed: false },
      { name: "dailyCap", type: "uint128", indexed: false },
    ],
  },
] as const;

export const escrowAbi = [
  { type: "function", name: "deposit", stateMutability: "payable", inputs: [{ name: "agentId", type: "uint256" }], outputs: [] },
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "spentToday", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "budgetOk", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

export const transistorsAbi = [
  { type: "function", name: "supplyCap", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "mintPrice", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "minted", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

export interface AgentState {
  agentId: bigint;
  owner: Address;
  circuitId: bigint;
  killed: boolean;
  dailyCap: bigint;
  keyHash: Hex;
  balance: bigint;
  spentToday: bigint;
  budgetOk: boolean;
}

/** Agents owned by `owner`. Reads every agent in one multicall (the registry has no owner index). */
export async function listAgents(owner: Address): Promise<AgentState[]> {
  const count = await publicClient.readContract({ address: CONFIG.registry, abi: registryAbi, functionName: "agentCount" });
  const ids = Array.from({ length: Math.min(Number(count), 2000) }, (_, i) => BigInt(i + 1));
  const agents = await Promise.all(
    ids.map((id) => publicClient.readContract({ address: CONFIG.registry, abi: registryAbi, functionName: "agent", args: [id] })),
  );
  const mine = ids.filter((_, i) => agents[i]!.owner.toLowerCase() === owner.toLowerCase());
  return Promise.all(mine.map((id) => readAgent(id)));
}

export async function readAgent(agentId: bigint): Promise<AgentState> {
  const [a, balance, spentToday, budgetOk] = await Promise.all([
    publicClient.readContract({ address: CONFIG.registry, abi: registryAbi, functionName: "agent", args: [agentId] }),
    publicClient.readContract({ address: CONFIG.escrow, abi: escrowAbi, functionName: "balanceOf", args: [agentId] }),
    publicClient.readContract({ address: CONFIG.escrow, abi: escrowAbi, functionName: "spentToday", args: [agentId] }),
    publicClient.readContract({ address: CONFIG.escrow, abi: escrowAbi, functionName: "budgetOk", args: [agentId] }),
  ]);
  return { agentId, ...a, circuitId: BigInt(a.circuitId), balance, spentToday, budgetOk };
}

export async function readTransistorFacts() {
  const [supplyCap, mintPrice, minted] = await Promise.all([
    publicClient.readContract({ address: CONFIG.transistors, abi: transistorsAbi, functionName: "supplyCap" }),
    publicClient.readContract({ address: CONFIG.transistors, abi: transistorsAbi, functionName: "mintPrice" }),
    publicClient.readContract({ address: CONFIG.transistors, abi: transistorsAbi, functionName: "minted" }),
  ]);
  return { supplyCap, mintPrice, minted };
}

/** "0.0003" style OKB amount, trimmed to `digits` significant decimals. */
export function okb(wei: bigint, digits = 6): string {
  const s = formatEther(wei);
  const [i, f = ""] = s.split(".");
  const trimmed = f.slice(0, digits).replace(/0+$/, "");
  if (!trimmed && wei > 0n && i === "0") return `<0.${"0".repeat(digits - 1)}1`;
  return trimmed ? `${i}.${trimmed}` : i!;
}

export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
