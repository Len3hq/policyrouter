// Calls eval() on a taped-out circuit for all 64 inputs and compares each result with
// circuits/<template>.json. Writes the full run to circuits/proof/<template>.txt.
//
//   pnpm --filter @policyrouter/circuits check <circuitId> <template> [--processor 0x...]
//
// The processor address defaults to deployments/xlayer.json. RPC defaults to XLAYER_RPC_URL
// or https://rpc.xlayer.tech. Every call reads the same pinned block.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, defineChain, http, type Address, type Hex } from "viem";
import { indexToInput, type CircuitArtifact } from "@policyrouter/policy";

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
  {
    type: "function",
    name: "circuitInfo",
    stateMutability: "view",
    inputs: [{ name: "circuitId", type: "uint256" }],
    outputs: [
      { name: "nIn", type: "uint32" },
      { name: "nOut", type: "uint32" },
      { name: "nState", type: "uint32" },
      { name: "gateCount", type: "uint32" },
    ],
  },
  {
    type: "function",
    name: "netlist",
    stateMutability: "view",
    inputs: [{ name: "circuitId", type: "uint256" }],
    outputs: [{ type: "bytes" }],
  },
] as const;

export const xlayer = defineChain({
  id: 196,
  name: "X Layer",
  nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.xlayer.tech"] } },
  blockExplorers: { default: { name: "OKLink", url: "https://www.oklink.com/xlayer" } },
});

export interface CheckResult {
  rows: { input: number; expected: number; actual: number; ok: boolean }[];
  matches: number;
  structureOk: boolean;
  block: bigint;
}

export async function checkCircuit(opts: {
  rpcUrl: string;
  processor: Address;
  circuitId: bigint;
  artifact: CircuitArtifact;
  blockNumber?: bigint;
}): Promise<CheckResult> {
  const client = createPublicClient({ chain: { ...xlayer, id: await chainIdOf(opts.rpcUrl) }, transport: http(opts.rpcUrl) });
  const block = opts.blockNumber ?? (await client.getBlockNumber());
  const at = { address: opts.processor, abi: processorAbi, blockNumber: block } as const;

  const [nIn, nOut, nState, gateCount] = await client.readContract({ ...at, functionName: "circuitInfo", args: [opts.circuitId] });
  const netlist = await client.readContract({ ...at, functionName: "netlist", args: [opts.circuitId] });
  const a = opts.artifact;
  const structureOk =
    nIn === a.nIn && nOut === a.nOut && nState === 0 && gateCount === a.gateCount && netlist.toLowerCase() === a.netlist.toLowerCase();

  const rows = await Promise.all(
    a.outputs.map(async (expected, input) => {
      const out = await client.readContract({
        ...at,
        functionName: "eval",
        args: [opts.circuitId, `0x${input.toString(16).padStart(2, "0")}` as Hex],
      });
      const actual = parseInt(out.slice(2, 4) || "0", 16);
      return { input, expected, actual, ok: actual === expected };
    }),
  );
  return { rows, matches: rows.filter((r) => r.ok).length, structureOk, block };
}

async function chainIdOf(rpcUrl: string): Promise<number> {
  return createPublicClient({ transport: http(rpcUrl) }).getChainId();
}

export function formatProof(r: CheckResult, a: CircuitArtifact, processor: Address, circuitId: bigint): string {
  const fmt = (v: number, bits: number) => v.toString(2).padStart(bits, "0");
  const lines = [
    `${a.name} (${a.id}): ${a.rule}`,
    `processor ${processor}  circuit ${circuitId}  block ${r.block}`,
    `structure (nIn, nOut, nState = 0, gateCount, netlist bytes): ${r.structureOk ? "match" : "MISMATCH"}`,
    "",
    "input   kill ok size tier | expected  actual",
    ...r.rows.map((row) => {
      const i = indexToInput(row.input);
      return `0b${fmt(row.input, 6)}  ${+i.kill}    ${+i.budgetOk}  ${i.size}    ${i.tier}    | 0b${fmt(row.expected, 3)}     0b${fmt(row.actual, 3)}${row.ok ? "" : "  <-- MISMATCH"}`;
    }),
    "",
    `${r.matches}/${r.rows.length} rows match`,
  ];
  return `${lines.join("\n")}\n`;
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args.splice(i, 2)[1] : undefined;
  };
  const processorFlag = flag("--processor");
  const [idArg, template] = args;
  if (!idArg || !template) {
    console.error("usage: check <circuitId> <template> [--processor 0x...]");
    process.exit(2);
  }
  const root = new URL("../", import.meta.url);
  const artifact = JSON.parse(readFileSync(new URL(`circuits/${template}.json`, root), "utf8")) as CircuitArtifact;
  const processor = (processorFlag ??
    JSON.parse(readFileSync(new URL("deployments/xlayer.json", root), "utf8")).processor) as Address;
  const circuitId = BigInt(idArg);
  const rpcUrl = process.env.XLAYER_RPC_URL || "https://rpc.xlayer.tech";

  const result = await checkCircuit({ rpcUrl, processor, circuitId, artifact });
  const proof = formatProof(result, artifact, processor, circuitId);
  mkdirSync(new URL("circuits/proof/", root), { recursive: true });
  writeFileSync(new URL(`circuits/proof/${template}.txt`, root), proof);
  console.log(proof);
  if (result.matches !== 64 || !result.structureOk) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
