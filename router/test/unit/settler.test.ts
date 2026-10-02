import { describe, expect, it } from "vitest";
import { keccak256, toHex, type Hex } from "viem";
import { verifyReceipt, type Hex32, type SignedReceipt } from "@policyrouter/policy";
import { Store, type BatchEntry } from "../../src/db.ts";
import { Settler, buildBatch, type EscrowWriter, type SettleTxResult } from "../../src/settler.ts";
import { generateKey, hashKey } from "../../src/keys.ts";
import { makeApp } from "./fakes.ts";

const ZERO = `0x${"00".repeat(32)}` as Hex;

/** Behaves like CreditEscrow: batch ids in order, each once; can hold, drop or fail transactions. */
class FakeEscrow implements EscrowWriter {
  next = 0n;
  roots = new Map<bigint, Hex>();
  /** Every debit that actually happened on "chain" */
  debits: { batchId: bigint; entries: readonly BatchEntry[] }[] = [];
  sends = 0;
  holdNext = false; // next tx stays pending until waited on
  dropNext = false; // next tx vanishes (never mined)
  private txs = new Map<Hex, { id: bigint; root: Hex; entries: readonly BatchEntry[]; state: "pending" | "mined" | "dropped"; status?: "success" | "reverted" }>();

  nextBatchId = async () => this.next;
  batchRoot = async (id: bigint) => this.roots.get(id) ?? ZERO;

  sendSettle = async (id: bigint, root: Hex, entries: readonly BatchEntry[]) => {
    const hash = keccak256(toHex(`tx-${++this.sends}`));
    const tx = { id, root, entries, state: "pending" as "pending" | "mined" | "dropped", status: undefined as "success" | "reverted" | undefined };
    this.txs.set(hash, tx);
    if (this.dropNext) {
      this.dropNext = false;
      tx.state = "dropped";
    } else if (this.holdNext) {
      this.holdNext = false;
    } else {
      this.mine(tx);
    }
    return hash;
  };

  waitForSettle = async (hash: Hex): Promise<SettleTxResult> => {
    const tx = this.txs.get(hash)!;
    if (tx.state === "dropped") throw new Error("timed out waiting for tx");
    if (tx.state === "pending") this.mine(tx);
    const debitedWei = tx.status === "success" ? tx.entries.reduce((s, e) => s + e.cost, 0n) : undefined;
    return { status: tx.status!, blockNumber: 100n, debitedWei };
  };

  txState = async (hash: Hex) => {
    const tx = this.txs.get(hash);
    if (!tx || tx.state === "dropped") return "unknown" as const;
    return tx.state;
  };

  /** Someone else settles this id first (e.g. a second router process) */
  settleExternally(root: Hex) {
    this.roots.set(this.next, root);
    this.next++;
  }

  private mine(tx: { id: bigint; root: Hex; entries: readonly BatchEntry[]; state: string; status?: string }) {
    tx.state = "mined";
    if (tx.id !== this.next) {
      tx.status = "reverted"; // WrongBatchId
      return;
    }
    this.roots.set(tx.id, tx.root);
    this.debits.push({ batchId: tx.id, entries: tx.entries });
    this.next++;
    tx.status = "success";
  }

  debitedFor(agentId: bigint) {
    return this.debits.flatMap((d) => d.entries).filter((e) => e.agentId === agentId).reduce((s, e) => s + e.cost, 0n);
  }
}

let seq = 0;
function addReceipt(store: Store, agentId: bigint, costWei: bigint): Hex {
  const n = ++seq;
  const requestId = keccak256(toHex(`req-${n}`));
  const r: SignedReceipt = {
    requestId,
    keyHash: keccak256(toHex(`key-${agentId}`)),
    agentId,
    processor: "0x11FF9976c86E4C868a803Bc9B5E1ba7749226f99",
    circuitId: 1n,
    inputBits: 0b010000,
    outputBits: costWei > 0n ? 1 : 0,
    blockNumber: 1n,
    modelRequested: "cheap",
    modelServed: costWei > 0n ? "cheap" : "",
    promptTokens: 1,
    cachedPromptTokens: 0,
    completionTokens: 1,
    okbUsdE8: 12_200_000_000n,
    costWei,
    timestamp: 1n,
    routerSig: "0x",
  };
  store.saveReceipt(r, keccak256(toHex(`leaf-${n}`)), costWei > 0n);
  return requestId;
}

const crash = () => {
  throw new Error("simulated crash");
};

describe("buildBatch", () => {
  const receipts = (n: number, agents = 3) =>
    Array.from({ length: n }, (_, i) => ({
      requestId: keccak256(toHex(`r${i}`)),
      agentId: BigInt((i % agents) + 1),
      costWei: BigInt(i + 1),
      hash: keccak256(toHex(`h${i}`)),
    }));

  it("builds a tree from 1, 2 and 1,000 receipts where every proof verifies", () => {
    for (const n of [1, 2, 1000]) {
      const rs = receipts(n);
      const b = buildBatch(rs, 100)!;
      expect(b.proofs.size).toBe(n);
      for (const r of rs) expect(verifyReceipt(b.root as Hex32, r.hash as Hex32, b.proofs.get(r.requestId)! as Hex32[])).toBe(true);
    }
  });

  it("sums cost per agent, matching the receipts, sorted by agent, leaving out zero-cost agents", () => {
    const rs = [...receipts(10, 3), { requestId: keccak256(toHex("deny")), agentId: 9n, costWei: 0n, hash: keccak256(toHex("deny-h")) }];
    const b = buildBatch(rs, 100)!;
    for (const e of b.entries) {
      expect(e.cost).toBe(rs.filter((r) => r.agentId === e.agentId).reduce((s, r) => s + r.costWei, 0n));
    }
    expect(b.entries.map((e) => e.agentId)).toEqual([1n, 2n, 3n]);
    expect(b.totalWei).toBe(rs.reduce((s, r) => s + r.costWei, 0n));
    expect(b.proofs.has(rs.at(-1)!.requestId)).toBe(true); // the denial is in the tree
  });

  it("caps distinct agents per batch and leaves the rest for the next one", () => {
    const b = buildBatch(receipts(9, 3), 2)!;
    expect(b.entries.map((e) => e.agentId)).toEqual([1n, 2n]);
    expect(b.receipts).toHaveLength(6);
  });

  it("returns nothing for no receipts", () => {
    expect(buildBatch([], 100)).toBeUndefined();
  });
});

describe("settler", () => {
  const setup = () => {
    const store = new Store(":memory:");
    const escrow = new FakeEscrow();
    return { store, escrow };
  };

  it("settles: one tx with per-agent sums, receipts get the batch and their proofs, batch confirmed", async () => {
    const { store, escrow } = setup();
    const a = addReceipt(store, 1n, 100n);
    addReceipt(store, 1n, 50n);
    addReceipt(store, 2n, 7n);
    const denied = addReceipt(store, 2n, 0n);

    const r = await new Settler(store, escrow).settleOnce();
    expect(r).toMatchObject({ kind: "settled", batchId: 0, receipts: 4, totalWei: 157n, debitedWei: 157n });
    expect(escrow.debits).toEqual([{ batchId: 0n, entries: [{ agentId: 1n, cost: 150n }, { agentId: 2n, cost: 7n }] }]);

    const batch = store.getBatch(0)!;
    expect(batch).toMatchObject({ status: "confirmed", blockNumber: 100n, debitedWei: 157n });
    expect(escrow.roots.get(0n)).toBe(batch.root);
    for (const id of [a, denied]) {
      const s = store.getReceipt(id)!;
      expect(s.batchId).toBe(0);
      expect(verifyReceipt(batch.root as Hex32, s.hash as Hex32, s.proof! as Hex32[])).toBe(true);
    }
  });

  it("an empty interval sends no transaction", async () => {
    const { store, escrow } = setup();
    expect(await new Settler(store, escrow).settleOnce()).toEqual({ kind: "empty" });
    expect(escrow.sends).toBe(0);
  });

  it("only settles new receipts on the next cycle", async () => {
    const { store, escrow } = setup();
    addReceipt(store, 1n, 10n);
    const s = new Settler(store, escrow);
    await s.settleOnce();
    expect(await s.settleOnce()).toEqual({ kind: "empty" });
    addReceipt(store, 1n, 5n);
    expect(await s.settleOnce()).toMatchObject({ kind: "settled", batchId: 1, totalWei: 5n });
    expect(escrow.debitedFor(1n)).toBe(15n);
  });

  it("settleAll keeps going until everything is settled", async () => {
    const { store, escrow } = setup();
    for (let i = 1n; i <= 5n; i++) addReceipt(store, i, i);
    const results = await new Settler(store, escrow, { maxAgents: 2 }).settleAll();
    expect(results.map((r) => r.kind)).toEqual(["settled", "settled", "settled", "empty"]);
    expect(escrow.debits).toHaveLength(3);
  });

  it("crash after committing, before sending: the restarted settler sends it once", async () => {
    const { store, escrow } = setup();
    addReceipt(store, 1n, 10n);
    expect((await new Settler(store, escrow, { hooks: { afterCommit: crash } }).settleOnce()).kind).toBe("failed");
    expect(escrow.sends).toBe(0);
    expect(store.openBatch()?.status).toBe("pending");

    expect(await new Settler(store, escrow).settleOnce()).toMatchObject({ kind: "recovered", how: "resent" });
    expect(escrow.debitedFor(1n)).toBe(10n);
    expect(store.getBatch(0)?.status).toBe("confirmed");
    expect(await new Settler(store, escrow).settleOnce()).toEqual({ kind: "empty" });
  });

  it("crash after sending, tx mined: the restarted settler confirms without sending again", async () => {
    const { store, escrow } = setup();
    addReceipt(store, 1n, 10n);
    expect((await new Settler(store, escrow, { hooks: { afterSend: crash } }).settleOnce()).kind).toBe("failed");
    expect(store.openBatch()?.status).toBe("sent");

    expect(await new Settler(store, escrow).settleOnce()).toMatchObject({ kind: "recovered", how: "already-on-chain" });
    expect(escrow.sends).toBe(1);
    expect(escrow.debitedFor(1n)).toBe(10n);
    expect(store.getBatch(0)).toMatchObject({ status: "confirmed", debitedWei: 10n });
  });

  it("crash after sending, tx still pending: the restarted settler waits for it instead of resending", async () => {
    const { store, escrow } = setup();
    addReceipt(store, 1n, 10n);
    escrow.holdNext = true;
    await new Settler(store, escrow, { hooks: { afterSend: crash } }).settleOnce();
    expect(await new Settler(store, escrow).settleOnce()).toMatchObject({ kind: "recovered", how: "waited" });
    expect(escrow.sends).toBe(1);
    expect(escrow.debitedFor(1n)).toBe(10n);
  });

  it("tx dropped from the mempool: resent with the same batch id, debited once", async () => {
    const { store, escrow } = setup();
    addReceipt(store, 1n, 10n);
    escrow.dropNext = true;
    expect((await new Settler(store, escrow).settleOnce()).kind).toBe("failed"); // wait timed out
    expect(await new Settler(store, escrow).settleOnce()).toMatchObject({ kind: "recovered", how: "resent", batchId: 0 });
    expect(escrow.sends).toBe(2);
    expect(escrow.debitedFor(1n)).toBe(10n);
  });

  it("a second send of a batch that already landed reverts on chain and is reconciled, not double debited", async () => {
    const { store, escrow } = setup();
    addReceipt(store, 1n, 10n);
    await new Settler(store, escrow, { hooks: { afterSend: crash } }).settleOnce();
    // force a blind resend of the stored batch, as a naive retry would
    const b = store.getBatch(0)!;
    const hash = await escrow.sendSettle(0n, b.root, b.entries);
    expect((await escrow.waitForSettle(hash)).status).toBe("reverted");
    expect(escrow.debitedFor(1n)).toBe(10n);
    expect(await new Settler(store, escrow).settleOnce()).toMatchObject({ kind: "recovered", how: "already-on-chain" });
  });

  it("conflict: the batch id holds a different root on chain, so receipts are released into the next batch", async () => {
    const { store, escrow } = setup();
    addReceipt(store, 1n, 10n);
    await new Settler(store, escrow, { hooks: { afterCommit: crash } }).settleOnce();
    escrow.settleExternally(keccak256(toHex("someone else")));

    expect(await new Settler(store, escrow).settleOnce()).toMatchObject({ kind: "conflict", batchId: 0, released: 1 });
    expect(store.getBatch(0)?.status).toBe("conflict");
    expect(await new Settler(store, escrow).settleOnce()).toMatchObject({ kind: "settled", batchId: 1, totalWei: 10n });
    expect(escrow.debitedFor(1n)).toBe(10n);
  });

  it("runs one cycle at a time", async () => {
    const { store, escrow } = setup();
    addReceipt(store, 1n, 10n);
    const s = new Settler(store, escrow);
    const [a, b] = await Promise.all([s.settleOnce(), s.settleOnce()]);
    expect([a.kind, b.kind].sort()).toEqual(["failed", "settled"]);
    expect(escrow.sends).toBe(1);
  });
});

describe("GET /v1/receipts/:id after settlement", () => {
  it("returns the batch, root, tx and a proof that verifies", async () => {
    const t = makeApp();
    const key = generateKey();
    t.chain.keys.set(hashKey(key), { agentId: 3n, circuitId: 1n, killed: false, budgetOk: true });
    const res = await t.app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: "cheap", messages: [{ role: "user", content: "hi" }] }),
    });
    const id = ((await res.json()) as { policyrouter_receipt: { requestId: string } }).policyrouter_receipt.requestId;

    const before = (await (await t.app.request(`/v1/receipts/${id}`)).json()) as { settlement: unknown };
    expect(before.settlement).toBeNull();

    await new Settler(t.store, new FakeEscrow()).settleOnce();
    const after = (await (await t.app.request(`/v1/receipts/${id}`)).json()) as {
      receiptHash: Hex32;
      settlement: { batchId: number; status: string; root: Hex32; proof: Hex32[]; txHash: string; blockNumber: string };
    };
    expect(after.settlement).toMatchObject({ batchId: 0, status: "confirmed", blockNumber: "100" });
    expect(after.settlement.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(verifyReceipt(after.settlement.root, after.receiptHash, after.settlement.proof)).toBe(true);
  });
});
