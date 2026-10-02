// The settler against the real CreditEscrow on an anvil fork of X Layer mainnet:
// real requests through the router, real settle transactions, proofs checked by the contract.

import { execSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseEther, type Hex } from "viem";
import { POLICYROUTER, type ReceiptJson } from "@policyrouter/policy";
import { generateKey, hashKey } from "../../src/keys.ts";
import { Settler, createEscrowWriter } from "../../src/settler.ts";
import { setupWorld, startAnvil, startMockProvider, startRouter, type MockProvider, type World } from "./harness.ts";

const hasAnvil = (() => {
  try {
    execSync("anvil --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const crash = () => {
  throw new Error("simulated crash");
};

describe.skipIf(!hasAnvil)("settler on a mainnet fork", { timeout: 90_000 }, () => {
  let anvil: { url: string; stop: () => void };
  let w: World;
  let provider: MockProvider;
  let router: ReturnType<typeof startRouter>;

  beforeAll(async () => {
    anvil = await startAnvil();
    w = await setupWorld(anvil.url);
    provider = await startMockProvider();
    router = startRouter(w, provider);
  }, 180_000);

  afterAll(async () => {
    await provider?.close();
    anvil?.stop();
  });

  const writer = () => createEscrowWriter({ rpcUrl: w.url, escrow: w.escrow, account: w.routerAccount, chainId: 196, confirmTimeoutMs: 20_000 });
  const read = <T>(functionName: string, args: unknown[] = []) =>
    w.pub.readContract({ address: w.escrow, abi: w.escrowAbi, functionName, args }) as Promise<T>;
  const routerNonce = () => w.pub.getTransactionCount({ address: w.routerAccount.address });

  async function newAgent(circuitId = POLICYROUTER.circuits["budget-guard"]) {
    const key = generateKey();
    const agentId = (await w.send(w.owner, w.registry, w.registryAbi, "registerAgent", [hashKey(key), circuitId, parseEther("1")])) as bigint;
    await w.send(w.owner, w.escrow, w.escrowAbi, "deposit", [agentId], parseEther("0.01"));
    return { key, agentId };
  }

  const chat = async (key: string, model = "cheap") => {
    const r = await router.app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, max_tokens: 32, messages: [{ role: "user", content: "hi" }] }),
    });
    return ((await r.json()) as { policyrouter_receipt: ReceiptJson }).policyrouter_receipt;
  };

  const proofOf = async (requestId: string) =>
    (await (await router.app.request(`/v1/receipts/${requestId}`)).json()) as {
      receiptHash: Hex;
      settlement: { batchId: number; status: string; root: Hex; proof: Hex[]; txHash: Hex };
    };

  it("settles: balances drop by each agent's summed cost, the root is on chain, every proof verifies in the contract", async () => {
    const a = await newAgent();
    const b = await newAgent();
    const receipts = [await chat(a.key), await chat(a.key, "frontier"), await chat(b.key, "premium")];
    // a denial too: kill b, then request
    await w.send(w.owner, w.registry, w.registryAbi, "setKill", [b.agentId, true]);
    receipts.push(await chat(b.key));
    expect(receipts.at(-1)!.costWei).toBe("0");

    const balA = await read<bigint>("balanceOf", [a.agentId]);
    const balB = await read<bigint>("balanceOf", [b.agentId]);
    const costA = receipts.filter((r) => r.agentId === a.agentId.toString()).reduce((s, r) => s + BigInt(r.costWei), 0n);
    const costB = receipts.filter((r) => r.agentId === b.agentId.toString()).reduce((s, r) => s + BigInt(r.costWei), 0n);

    const result = await new Settler(router.store, writer()).settleOnce();
    expect(result).toMatchObject({ kind: "settled", receipts: 4, totalWei: costA + costB, debitedWei: costA + costB });
    if (result.kind !== "settled") throw new Error("not settled");

    expect(await read<bigint>("balanceOf", [a.agentId])).toBe(balA - costA);
    expect(await read<bigint>("balanceOf", [b.agentId])).toBe(balB - costB);
    expect(await read<bigint>("spentToday", [a.agentId])).toBe(costA);

    const [root] = await read<[Hex, bigint]>("batch", [BigInt(result.batchId)]);
    expect(root).toBe(router.store.getBatch(result.batchId)!.root);

    for (const r of receipts) {
      const p = await proofOf(r.requestId);
      expect(p.settlement.status).toBe("confirmed");
      expect(await read<boolean>("isInBatch", [BigInt(p.settlement.batchId), p.receiptHash, p.settlement.proof])).toBe(true);
    }
    // a proof for the wrong receipt does not verify
    const p0 = await proofOf(receipts[0]!.requestId);
    const p1 = await proofOf(receipts[1]!.requestId);
    expect(await read<boolean>("isInBatch", [BigInt(p0.settlement.batchId), p1.receiptHash, p0.settlement.proof])).toBe(false);
  });

  it("an empty interval sends no transaction", async () => {
    const before = await routerNonce();
    expect(await new Settler(router.store, writer()).settleOnce()).toEqual({ kind: "empty" });
    expect(await routerNonce()).toBe(before);
  });

  it("crash after sending, before confirming: the restart confirms from chain, nothing double debited or lost", async () => {
    const a = await newAgent();
    const r = await chat(a.key);
    const bal = await read<bigint>("balanceOf", [a.agentId]);
    const nextBefore = await read<bigint>("nextBatchId");

    expect((await new Settler(router.store, writer(), { hooks: { afterSend: crash } }).settleOnce()).kind).toBe("failed");
    const recovered = await new Settler(router.store, writer()).settleOnce();
    expect(recovered).toMatchObject({ kind: "recovered", how: "already-on-chain" });

    expect(await read<bigint>("balanceOf", [a.agentId])).toBe(bal - BigInt(r.costWei));
    expect(await read<bigint>("nextBatchId")).toBe(nextBefore + 1n);
    const p = await proofOf(r.requestId);
    expect(await read<boolean>("isInBatch", [BigInt(p.settlement.batchId), p.receiptHash, p.settlement.proof])).toBe(true);
  });

  it("crash after committing, before sending: the restart sends it once", async () => {
    const a = await newAgent();
    const r = await chat(a.key);
    const bal = await read<bigint>("balanceOf", [a.agentId]);
    const nonce = await routerNonce();

    expect((await new Settler(router.store, writer(), { hooks: { afterCommit: crash } }).settleOnce()).kind).toBe("failed");
    expect(await routerNonce()).toBe(nonce); // nothing sent
    expect(await new Settler(router.store, writer()).settleOnce()).toMatchObject({ kind: "recovered", how: "resent" });
    expect(await read<bigint>("balanceOf", [a.agentId])).toBe(bal - BigInt(r.costWei));
    expect(await routerNonce()).toBe(nonce + 1);
  });

  it("crash with the tx still in the mempool: the restart waits for it instead of sending a second one", async () => {
    const a = await newAgent();
    const r = await chat(a.key);
    const bal = await read<bigint>("balanceOf", [a.agentId]);

    await w.test.setAutomine(false);
    try {
      expect((await new Settler(router.store, writer(), { hooks: { afterSend: crash } }).settleOnce()).kind).toBe("failed");
      const pending = new Settler(router.store, writer()).settleOnce();
      await new Promise((res) => setTimeout(res, 1500));
      await w.test.mine({ blocks: 1 });
      expect(await pending).toMatchObject({ kind: "recovered", how: "waited" });
    } finally {
      await w.test.setAutomine(true);
    }
    expect(await read<bigint>("balanceOf", [a.agentId])).toBe(bal - BigInt(r.costWei));
  });
});
