// Receipt verification with read-only calls only: no wallet, no trust in the router.
//
//   1. signature   the receipt's EIP-712 signature recovers to CreditEscrow.router(), the address
//                  fixed on chain as the only one allowed to settle
//   2. inputs      the flags the router fed the circuit match chain state at the receipt's block:
//                  agent, circuit, kill switch (PolicyRegistry) and budget_ok (CreditEscrow).
//                  Tier and size come from the request itself, which only the agent and router saw.
//   3. policy      eval(circuitId, inputBits) on PolicyRouter's processor returns outputBits
//   4. settlement  the receipt's EIP-712 hash is in its batch: CreditEscrow.isInBatch(batchId, hash, proof)
//                  ("pending" until the receipt's batch is settled)
//
// Every check carries the exact calls it made, as `cast` commands and raw eth_call payloads, so
// anyone can re-run it without this code.

import { encodeFunctionData, type Abi, type Address, type Hex } from "viem";
import { receiptDomain, receiptFromJson, receiptHash, recoverReceiptSigner, type ReceiptJson, type SignedReceipt } from "./receipt.ts";

export type CheckId = "signature" | "inputs" | "policy" | "settlement";
export type CheckStatus = "pass" | "fail" | "pending" | "unavailable";

export interface CheckCall {
  description: string;
  to: Address;
  data: Hex;
  /** undefined = latest block */
  blockNumber?: bigint;
  /** The same call as a Foundry `cast call` command */
  cast: string;
}

export interface Check {
  id: CheckId;
  label: string;
  status: CheckStatus;
  reason: string;
  calls: CheckCall[];
}

export interface Settlement {
  batchId: number;
  /** Router-side status: only "confirmed" batches are checked on chain */
  status?: string;
  proof: Hex[] | null;
  txHash?: Hex | null;
}

export interface VerifyResult {
  /** verified: every check passed. pending: nothing failed, but something isn't settled or checkable yet. */
  verdict: "verified" | "pending" | "failed";
  failed: CheckId[];
  checks: Check[];
  receiptHash: Hex;
}

/** The read access the verifier needs (a viem PublicClient fits). */
export interface ChainReads {
  readContract(args: { address: Address; abi: Abi; functionName: string; args?: readonly unknown[]; blockNumber?: bigint }): Promise<unknown>;
}

export interface VerifyContext {
  client: ChainReads;
  chainId: number;
  /** PolicyRouter's processor; a receipt naming any other processor fails */
  processor: Address;
  registry: Address;
  escrow: Address;
  /** Only used to write the `cast` commands */
  rpcUrl: string;
}

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
  { type: "function", name: "router", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "budgetOkForKey", stateMutability: "view", inputs: [{ name: "keyHash", type: "bytes32" }], outputs: [{ type: "bool" }] },
  {
    type: "function",
    name: "isInBatch",
    stateMutability: "view",
    inputs: [
      { name: "batchId", type: "uint256" },
      { name: "receiptHash", type: "bytes32" },
      { name: "proof", type: "bytes32[]" },
    ],
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

const byteHex = (v: number) => `0x${v.toString(16).padStart(2, "0")}` as Hex;
const bin = (v: number, w: number) => `0b${v.toString(2).padStart(w, "0")}`;

function call(ctx: VerifyContext, description: string, to: Address, abi: Abi, functionName: string, args: readonly unknown[], sig: string, castArgs: string, blockNumber?: bigint): CheckCall {
  const data = encodeFunctionData({ abi, functionName, args } as never);
  const block = blockNumber === undefined ? "" : ` --block ${blockNumber}`;
  return { description, to, data, blockNumber, cast: `cast call ${to} "${sig}"${castArgs ? ` ${castArgs}` : ""}${block} --rpc-url ${ctx.rpcUrl}` };
}

/** The raw JSON-RPC request for a call, for re-running it with curl. */
export function rawEthCall(c: CheckCall): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "eth_call",
    params: [{ to: c.to, data: c.data }, c.blockNumber === undefined ? "latest" : `0x${c.blockNumber.toString(16)}`],
  });
}

const msg = (e: unknown) => ((e as { shortMessage?: string }).shortMessage ?? (e as Error).message ?? String(e)).split("\n")[0]!;
const looksLikeMissingState = (e: unknown) => /missing trie node|header not found|state.*(not available|pruned)|historical state|block.*not found/i.test(msg(e));

export async function verifyReceiptOnChain(ctx: VerifyContext, r: SignedReceipt, settlement?: Settlement | null): Promise<VerifyResult> {
  const domain = receiptDomain(ctx.chainId, ctx.escrow);
  const leaf = receiptHash(r, domain);
  const read = (address: Address, abi: Abi, functionName: string, args: readonly unknown[] = [], blockNumber?: bigint) =>
    ctx.client.readContract({ address, abi, functionName, args, blockNumber });
  const checks: Check[] = [];

  // 1. signature
  {
    const routerCall = call(ctx, "The router address fixed in CreditEscrow", ctx.escrow, escrowAbi as Abi, "router", [], "router()(address)", "");
    let status: CheckStatus;
    let reason: string;
    try {
      const router = (await read(ctx.escrow, escrowAbi as Abi, "router")) as Address;
      let signer: Address | undefined;
      try {
        signer = await recoverReceiptSigner(r, domain);
      } catch {
        signer = undefined;
      }
      if (signer && signer.toLowerCase() === router.toLowerCase()) {
        status = "pass";
        reason = `Signed by ${router}, the router fixed in CreditEscrow.`;
      } else {
        status = "fail";
        reason = signer
          ? `Signed by ${signer}, but CreditEscrow's router is ${router}. The receipt was altered or signed by someone else.`
          : "The signature is malformed.";
      }
    } catch (e) {
      status = "unavailable";
      reason = `Could not read the router address: ${msg(e)}`;
    }
    checks.push({ id: "signature", label: "Signature", status, reason, calls: [routerCall] });
  }

  // 2. inputs: the flags the circuit was given match chain state at the receipt's block
  {
    const policyCall = call(ctx, "Agent, circuit and kill switch at the receipt's block", ctx.registry, registryAbi as Abi, "policyOf", [r.keyHash], "policyOf(bytes32)(uint256,address,uint256,uint128,bool)", r.keyHash, r.blockNumber);
    const budgetCall = call(ctx, "budget_ok at the receipt's block", ctx.escrow, escrowAbi as Abi, "budgetOkForKey", [r.keyHash], "budgetOkForKey(bytes32)(bool)", r.keyHash, r.blockNumber);
    let status: CheckStatus;
    let reason: string;
    try {
      const [agentId, , circuitId, , killed] = (await read(ctx.registry, registryAbi as Abi, "policyOf", [r.keyHash], r.blockNumber)) as [bigint, Address, bigint, bigint, boolean];
      const budgetOk = (await read(ctx.escrow, escrowAbi as Abi, "budgetOkForKey", [r.keyHash], r.blockNumber)) as boolean;
      const kill = ((r.inputBits >> 5) & 1) === 1;
      const budget = ((r.inputBits >> 4) & 1) === 1;
      const problems: string[] = [];
      if (agentId !== r.agentId) problems.push(`the key belonged to agent ${agentId}, not ${r.agentId}`);
      if (circuitId !== r.circuitId) problems.push(`the agent's circuit was ${circuitId}, not ${r.circuitId}`);
      if (killed !== kill) problems.push(`kill switch was ${killed ? "on" : "off"}, receipt says ${kill ? "on" : "off"}`);
      if (budgetOk !== budget) problems.push(`budget_ok was ${budgetOk}, receipt says ${budget}`);
      status = problems.length === 0 ? "pass" : "fail";
      reason =
        problems.length === 0
          ? `At block ${r.blockNumber}: agent ${agentId}, circuit ${circuitId}, kill switch ${killed ? "on" : "off"}, budget_ok ${budgetOk}, as the receipt says.`
          : `At block ${r.blockNumber}, ${problems.join("; ")}.`;
    } catch (e) {
      status = "unavailable";
      reason = looksLikeMissingState(e)
        ? `This RPC has no state for block ${r.blockNumber}; use an archive RPC to check the flags.`
        : `Could not read chain state at block ${r.blockNumber}: ${msg(e)}`;
    }
    checks.push({ id: "inputs", label: "Chain inputs", status, reason, calls: [policyCall, budgetCall] });
  }

  // 3. policy: the circuit's answer to these inputs is the receipt's output
  {
    const input = byteHex(r.inputBits);
    const evalCall = (block?: bigint) =>
      call(ctx, `eval(${r.circuitId}, ${input}) on PolicyRouter's processor`, r.processor, processorAbi as Abi, "eval", [r.circuitId, input], "eval(uint256,bytes)(bytes)", `${r.circuitId} ${input}`, block);
    let status: CheckStatus;
    let reason: string;
    let calls = [evalCall(r.blockNumber)];
    if (r.processor.toLowerCase() !== ctx.processor.toLowerCase()) {
      status = "fail";
      reason = `The receipt names processor ${r.processor}, not PolicyRouter's ${ctx.processor}.`;
    } else {
      try {
        let out: Hex;
        let note = "";
        try {
          out = (await read(r.processor, processorAbi as Abi, "eval", [r.circuitId, input], r.blockNumber)) as Hex;
        } catch (e) {
          if (!looksLikeMissingState(e)) throw e;
          // Circuits can never change, so the latest block gives the same answer.
          out = (await read(r.processor, processorAbi as Abi, "eval", [r.circuitId, input])) as Hex;
          calls = [evalCall()];
          note = " (checked at the latest block: this RPC has no state for the receipt's block, and circuits can never change)";
        }
        const actual = parseInt(out.slice(2, 4) || "0", 16) & 7;
        const allow = (actual & 1) === 1;
        const said = `${allow ? `allow at tier ${actual >> 1}` : "deny"}`;
        status = actual === r.outputBits ? "pass" : "fail";
        reason =
          status === "pass"
            ? `Circuit ${r.circuitId} answers ${bin(actual, 3)} (${said}) to ${bin(r.inputBits, 6)}, exactly as the receipt says${note}.`
            : `Circuit ${r.circuitId} answers ${bin(actual, 3)} (${said}) to ${bin(r.inputBits, 6)}, but the receipt says ${bin(r.outputBits, 3)}${note}.`;
      } catch (e) {
        status = "fail";
        reason = `eval() failed: ${msg(e)}`;
      }
    }
    checks.push({ id: "policy", label: "Policy decision", status, reason, calls });
  }

  // 4. settlement
  {
    let status: CheckStatus;
    let reason: string;
    let calls: CheckCall[] = [];
    if (!settlement) {
      status = "pending";
      reason = "Not in a settled batch yet. The router settles every few minutes; check again later.";
    } else if (settlement.status && settlement.status !== "confirmed") {
      status = "pending";
      reason = `Batch ${settlement.batchId} is ${settlement.status}, not confirmed on chain yet.`;
    } else if (!settlement.proof) {
      status = "pending";
      reason = `In batch ${settlement.batchId}, but no Merkle proof was provided.`;
    } else {
      const proofArg = `[${settlement.proof.join(",")}]`;
      calls = [
        call(ctx, `Is this receipt's hash in batch ${settlement.batchId}?`, ctx.escrow, escrowAbi as Abi, "isInBatch", [BigInt(settlement.batchId), leaf, settlement.proof], "isInBatch(uint256,bytes32,bytes32[])(bool)", `${settlement.batchId} ${leaf} "${proofArg}"`),
      ];
      try {
        const ok = (await read(ctx.escrow, escrowAbi as Abi, "isInBatch", [BigInt(settlement.batchId), leaf, settlement.proof])) as boolean;
        status = ok ? "pass" : "fail";
        reason = ok
          ? `Receipt hash ${leaf.slice(0, 12)}… is in batch ${settlement.batchId}, whose Merkle root is stored in CreditEscrow.`
          : `CreditEscrow says receipt hash ${leaf.slice(0, 12)}… is not in batch ${settlement.batchId} with this proof.`;
      } catch (e) {
        status = "unavailable";
        reason = `Could not call isInBatch: ${msg(e)}`;
      }
    }
    checks.push({ id: "settlement", label: "Settlement", status, reason, calls });
  }

  const failed = checks.filter((c) => c.status === "fail").map((c) => c.id);
  const verdict = failed.length > 0 ? "failed" : checks.every((c) => c.status === "pass") ? "verified" : "pending";
  return { verdict, failed, checks, receiptHash: leaf };
}

/**
 * Accepts what people paste: a `GET /v1/receipts/:id` response ({ receipt, settlement }), a
 * completion response with `policyrouter_receipt`, an error body with it, or a bare receipt.
 */
export function parseReceiptInput(text: string): { receipt: SignedReceipt; settlement: Settlement | null } {
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error("That isn't JSON. Paste a receipt, a router response, or open /verify?id=<requestId>.");
  }
  const json = (v.receipt ?? v.policyrouter_receipt ?? v) as ReceiptJson;
  if (typeof json !== "object" || !json || !("routerSig" in json) || !("inputBits" in json)) {
    throw new Error("No receipt found in that JSON.");
  }
  const s = v.settlement as { batchId: number; status?: string; proof: Hex[] | null; txHash?: Hex | null } | null | undefined;
  return { receipt: receiptFromJson(json), settlement: s ? { batchId: s.batchId, status: s.status, proof: s.proof, txHash: s.txHash } : null };
}
