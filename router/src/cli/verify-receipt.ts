// Checks a receipt the way anyone can, with read-only calls only (the same checks as the Verify page,
// from @policyrouter/policy's verifyReceiptOnChain), plus a cost check against this router's catalog:
//   signature   recovers to CreditEscrow.router()
//   inputs      agent, circuit, kill switch and budget_ok match chain state at the receipt's block
//   policy      eval(circuitId, inputBits) at that block returns outputBits
//   settlement  CreditEscrow.isInBatch(batchId, receiptHash, proof), or pending
//   cost        costWei = the served model's published price at the receipt's time, at the receipt's OKB rate
//
//   pnpm --filter @policyrouter/router verify-receipt <requestId>       (fetches from ROUTER_URL)
//   pnpm --filter @policyrouter/router verify-receipt --file receipt.json

import { existsSync, readFileSync } from "node:fs";
import { createPublicClient, getAddress, http } from "viem";
import { parseReceiptInput, verifyReceiptOnChain } from "@policyrouter/policy";
import { costWei, findModel, isPeak, loadCatalog } from "../catalog.ts";
import { formatE8 } from "../price.ts";

const envFile = new URL("../../../.env", import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);

async function main() {
  const args = process.argv.slice(2);
  let text: string;
  if (args[0] === "--file") {
    text = readFileSync(args[1]!, "utf8");
  } else if (args[0]) {
    const base = process.env.ROUTER_URL || `http://localhost:${process.env.PORT ?? 8787}`;
    const res = await fetch(`${base}/v1/receipts/${args[0]}`);
    if (!res.ok) throw new Error(`router returned ${res.status} for receipt ${args[0]}`);
    text = await res.text();
  } else {
    console.error("usage: verify-receipt <requestId> | --file receipt.json");
    process.exit(2);
  }

  const { receipt, settlement } = parseReceiptInput(text);
  const rpcUrl = (process.env.XLAYER_RPC_URL || "https://rpc.xlayer.tech").split(",")[0]!.trim();
  const client = createPublicClient({ transport: http(rpcUrl) });
  const result = await verifyReceiptOnChain(
    {
      client: client as never,
      chainId: await client.getChainId(),
      processor: getAddress(process.env.PROCESSOR_ADDRESS!),
      registry: getAddress(process.env.POLICY_REGISTRY_ADDRESS!),
      escrow: getAddress(process.env.CREDIT_ESCROW_ADDRESS!),
      rpcUrl,
    },
    receipt,
    settlement,
  );

  const catalog = loadCatalog();
  const served = receipt.modelServed ? findModel(catalog, receipt.modelServed) : undefined;
  const expectedCost = served && receipt.okbUsdE8 > 0n ? costWei(catalog, served, receipt, receipt.timestamp, receipt.okbUsdE8) : 0n;
  const costOk = expectedCost === receipt.costWei;

  const word = { pass: "OK", fail: "MISMATCH", pending: "pending", unavailable: "unavailable" } as const;
  console.log(`receipt ${receipt.requestId}
  model ${receipt.modelRequested} → ${receipt.modelServed || "(denied)"}, cost ${receipt.costWei} wei`);
  for (const c of result.checks) console.log(`  ${`${c.id}:`.padEnd(11)} ${word[c.status]}  (${c.reason})`);
  console.log(
    `  ${"cost:".padEnd(11)} ${costOk ? "OK" : "MISMATCH"}  (${receipt.promptTokens} prompt / ${receipt.cachedPromptTokens} cached / ${receipt.completionTokens} completion tokens, ${isPeak(catalog, receipt.timestamp) ? "peak" : "off-peak"}, OKB at $${formatE8(receipt.okbUsdE8)} → ${expectedCost} wei)`,
  );
  const evalCall = result.checks.find((c) => c.id === "policy")?.calls[0];
  if (evalCall) console.log(`  re-run it: ${evalCall.cast}`);
  if (result.verdict === "failed" || !costOk) process.exit(1);
}

await main();
