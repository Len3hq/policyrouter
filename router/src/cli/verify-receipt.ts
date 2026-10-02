// Checks a receipt the way anyone can, with read-only calls only:
//   1. the router's EIP-712 signature recovers to ROUTER_ADDRESS
//   2. eval(circuitId, inputBits) at the receipt's block returns outputBits
//   3. costWei equals the served model's published price at the receipt's time, converted at the
//      OKB price recorded in the receipt, plus the catalog markup
//   4. once settled: CreditEscrow.isInBatch(batchId, receiptHash, proof) is true on chain
//
//   pnpm --filter @policyrouter/router verify-receipt <requestId>       (fetches from ROUTER_URL)
//   pnpm --filter @policyrouter/router verify-receipt --file receipt.json
//
// With --file there is no proof, so check 4 is skipped. The Verify page (Phase 7) does all four in a browser.

import { existsSync, readFileSync } from "node:fs";
import { createPublicClient, getAddress, http, type Address, type Hex } from "viem";
import { receiptDomain, receiptFromJson, receiptHash, recoverReceiptSigner, type ReceiptJson } from "@policyrouter/policy";
import { costWei, findModel, isPeak, loadCatalog } from "../catalog.ts";
import { formatE8 } from "../price.ts";

const envFile = new URL("../../../.env", import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);

const evalAbi = [
  {
    type: "function",
    name: "eval",
    stateMutability: "view",
    inputs: [{ type: "uint256" }, { type: "bytes" }],
    outputs: [{ type: "bytes" }],
  },
] as const;

const escrowAbi = [
  {
    type: "function",
    name: "isInBatch",
    stateMutability: "view",
    inputs: [{ type: "uint256" }, { type: "bytes32" }, { type: "bytes32[]" }],
    outputs: [{ type: "bool" }],
  },
] as const;

interface Settlement {
  batchId: number;
  status: string;
  root: Hex;
  proof: Hex[] | null;
  txHash: Hex | null;
}

async function main() {
  const args = process.argv.slice(2);
  let json: ReceiptJson;
  let settlement: Settlement | null = null;
  if (args[0] === "--file") {
    const raw = JSON.parse(readFileSync(args[1]!, "utf8"));
    json = raw.policyrouter_receipt ?? raw.receipt ?? raw;
  } else if (args[0]) {
    const base = process.env.ROUTER_URL || `http://localhost:${process.env.PORT ?? 8787}`;
    const res = await fetch(`${base}/v1/receipts/${args[0]}`);
    if (!res.ok) throw new Error(`router returned ${res.status} for receipt ${args[0]}`);
    const body = (await res.json()) as { receipt: ReceiptJson; settlement: Settlement | null };
    json = body.receipt;
    settlement = body.settlement;
  } else {
    console.error("usage: verify-receipt <requestId> | --file receipt.json");
    process.exit(2);
  }

  const receipt = receiptFromJson(json);
  const rpcUrl = process.env.XLAYER_RPC_URL || "https://rpc.xlayer.tech";
  const client = createPublicClient({ transport: http(rpcUrl) });
  const chainId = await client.getChainId();
  const escrow = getAddress(process.env.CREDIT_ESCROW_ADDRESS!) as Address;
  const expectedRouter = getAddress(process.env.ROUTER_ADDRESS!);

  const signer = await recoverReceiptSigner(receipt, receiptDomain(chainId, escrow));
  const sigOk = signer === expectedRouter;

  const input = `0x${receipt.inputBits.toString(16).padStart(2, "0")}` as Hex;
  const out = await client.readContract({
    address: receipt.processor,
    abi: evalAbi,
    functionName: "eval",
    args: [receipt.circuitId, input],
    blockNumber: receipt.blockNumber,
  });
  const actual = parseInt(out.slice(2, 4), 16) & 7;
  const evalOk = actual === receipt.outputBits;

  const catalog = loadCatalog();
  const served = receipt.modelServed ? findModel(catalog, receipt.modelServed) : undefined;
  const expectedCost = served && receipt.okbUsdE8 > 0n ? costWei(catalog, served, receipt, receipt.timestamp, receipt.okbUsdE8) : 0n;
  const costOk = expectedCost === receipt.costWei;

  // 4. settlement: the receipt's EIP-712 hash is a leaf of the batch root stored on chain
  const leaf = receiptHash(receipt, receiptDomain(chainId, escrow));
  let settleLine = "not settled yet (no batch)";
  let settleOk = true;
  if (settlement?.proof && settlement.status === "confirmed") {
    settleOk = await client.readContract({
      address: escrow,
      abi: escrowAbi,
      functionName: "isInBatch",
      args: [BigInt(settlement.batchId), leaf, settlement.proof],
    });
    settleLine = `${settleOk ? "OK" : "MISMATCH"}  (isInBatch(${settlement.batchId}, ${leaf.slice(0, 10)}…, ${settlement.proof.length}-step proof) on ${escrow}${settlement.txHash ? `, tx ${settlement.txHash}` : ""})`;
  } else if (settlement) {
    settleLine = `batch ${settlement.batchId} is ${settlement.status}, not confirmed yet`;
  } else if (args[0] === "--file") {
    settleLine = "not checked (no proof in a file; pass the request id instead)";
  }

  console.log(`receipt ${receipt.requestId}
  model ${receipt.modelRequested} → ${receipt.modelServed || "(denied)"}, cost ${receipt.costWei} wei
  signature: ${sigOk ? "OK" : "MISMATCH"}  (signed by ${signer}, router is ${expectedRouter})
  policy:    ${evalOk ? "OK" : "MISMATCH"}  (eval(${receipt.circuitId}, ${input}) at block ${receipt.blockNumber} on ${receipt.processor} = 0x${actual.toString(16).padStart(2, "0")}, receipt says 0x${receipt.outputBits.toString(16).padStart(2, "0")})
  cost:      ${costOk ? "OK" : "MISMATCH"}  (${receipt.promptTokens} prompt / ${receipt.cachedPromptTokens} cached / ${receipt.completionTokens} completion tokens, ${isPeak(catalog, receipt.timestamp) ? "peak" : "off-peak"}, OKB at $${formatE8(receipt.okbUsdE8)} → ${expectedCost} wei)
  settled:   ${settleLine}
  re-run it: cast call ${receipt.processor} "eval(uint256,bytes)(bytes)" ${receipt.circuitId} ${input} --block ${receipt.blockNumber} --rpc-url ${rpcUrl}`);
  if (!sigOk || !evalOk || !costOk || !settleOk) process.exit(1);
}

await main();
