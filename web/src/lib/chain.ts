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
    type: "function",
    name: "rotateKey",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "newKeyHash", type: "bytes32" },
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

export const transistorsWriteAbi = [
  { type: "function", name: "mint", stateMutability: "payable", inputs: [{ name: "id", type: "uint256" }, { name: "amount", type: "uint256" }], outputs: [] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "uint256" }] },
] as const;

export const processorAbi = [
  {
    type: "function",
    name: "tapeout",
    stateMutability: "payable",
    inputs: [
      { name: "nl", type: "bytes" },
      { name: "nIn", type: "uint32" },
      { name: "nOut", type: "uint32" },
    ],
    outputs: [{ type: "uint256" }],
  },
  { type: "function", name: "TAPEOUT_FEE", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "nextId", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "netlist", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "bytes" }] },
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "tokenId", type: "uint256", indexed: true },
    ],
  },
] as const;

export const factoryAbi = [{ type: "function", name: "protocolFee", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }] as const;

/** What a tape-out costs right now: transistors at the mint price, TapeOut's protocol fee per mint, and its tape-out fee. */
export async function readTapeoutCosts() {
  const { TAPEOUT } = await import("@policyrouter/policy");
  const [mintPrice, protocolFee, tapeoutFee] = await Promise.all([
    publicClient.readContract({ address: CONFIG.transistors, abi: transistorsAbi, functionName: "mintPrice" }),
    publicClient.readContract({ address: TAPEOUT.factory, abi: factoryAbi, functionName: "protocolFee" }),
    publicClient.readContract({ address: CONFIG.processor, abi: processorAbi, functionName: "TAPEOUT_FEE" }),
  ]);
  return { mintPrice, protocolFee, tapeoutFee };
}

/**
 * The id of a circuit already on the processor with exactly this netlist, if any (ids run 1…nextId).
 * Reusing one costs nothing: circuits are public and anyone can point an agent at any of them.
 */
export async function findCircuit(netlist: Hex): Promise<bigint | undefined> {
  const last = await publicClient.readContract({ address: CONFIG.processor, abi: processorAbi, functionName: "nextId" });
  const ids = Array.from({ length: Math.min(Number(last), 500) }, (_, i) => BigInt(i + 1));
  const lists = await Promise.all(
    ids.map((id) => publicClient.readContract({ address: CONFIG.processor, abi: processorAbi, functionName: "netlist", args: [id] }).catch(() => undefined)),
  );
  const i = lists.findIndex((n) => n?.toLowerCase() === netlist.toLowerCase());
  return i < 0 ? undefined : ids[i];
}

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
