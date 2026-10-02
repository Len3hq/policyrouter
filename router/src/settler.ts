// The settler: batches unsettled receipts, posts their Merkle root and per-agent totals to
// CreditEscrow.settle(), and stores each receipt's proof.
//
// Crash safety:
//   1. The batch id is CreditEscrow.nextBatchId() on chain; the contract accepts each id once.
//   2. The batch, its receipts and their proofs are committed to SQLite before anything is sent.
//   3. Before building a new batch, an unfinished one is reconciled against the chain:
//        landed with our root      → confirmed, nothing resent
//        tx still pending          → wait for it
//        not landed, tx gone/failed → resent with the same id, root and entries
//        a different root landed   → conflict: our receipts are released into the next batch
// So a crash between any two steps can't lose a receipt or debit an agent twice.

import { batchTree, type Hex32 } from "@policyrouter/policy";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  type Address,
  type Hex,
  type LocalAccount,
} from "viem";
import { rpcTransport } from "./chain.ts";
import type { Batch, BatchEntry, Store, UnsettledReceipt } from "./db.ts";
import type { Logger } from "./log.ts";

// --- the chain side, behind an interface so tests can fake it ---

export interface SettleTxResult {
  status: "success" | "reverted";
  blockNumber: bigint;
  /** From the Settled event: what the escrow actually debited (≤ the entries' total) */
  debitedWei?: bigint;
}

export interface EscrowWriter {
  nextBatchId(): Promise<bigint>;
  /** Root stored for a settled batch (zero hash if none) */
  batchRoot(batchId: bigint): Promise<Hex>;
  sendSettle(batchId: bigint, root: Hex, entries: readonly BatchEntry[]): Promise<Hex>;
  waitForSettle(txHash: Hex): Promise<SettleTxResult>;
  /** What the node knows about a tx we sent earlier */
  txState(txHash: Hex): Promise<"mined" | "pending" | "unknown">;
}

const escrowAbi = [
  {
    type: "function",
    name: "settle",
    stateMutability: "nonpayable",
    inputs: [
      { name: "batchId", type: "uint256" },
      { name: "root", type: "bytes32" },
      {
        name: "entries",
        type: "tuple[]",
        components: [
          { name: "agentId", type: "uint256" },
          { name: "cost", type: "uint256" },
        ],
      },
    ],
    outputs: [],
  },
  { type: "function", name: "nextBatchId", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "batch",
    stateMutability: "view",
    inputs: [{ name: "batchId", type: "uint256" }],
    outputs: [
      { name: "root", type: "bytes32" },
      { name: "blockNumber", type: "uint64" },
    ],
  },
  {
    type: "event",
    name: "Settled",
    inputs: [
      { name: "batchId", type: "uint256", indexed: true },
      { name: "root", type: "bytes32", indexed: false },
      { name: "entries", type: "uint256", indexed: false },
      { name: "debited", type: "uint256", indexed: false },
    ],
  },
] as const;

export function createEscrowWriter(cfg: {
  rpcUrl: string;
  escrow: Address;
  account: LocalAccount;
  chainId: number;
  timeoutMs?: number;
  /** How long to wait for a settle tx to be mined before giving up for this cycle */
  confirmTimeoutMs?: number;
}): EscrowWriter {
  const chain = defineChain({
    id: cfg.chainId,
    name: "X Layer",
    nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
    rpcUrls: { default: { http: cfg.rpcUrl.split(",").map((u) => u.trim()) } },
  });
  const transport = rpcTransport(cfg.rpcUrl, cfg.timeoutMs ?? 10_000);
  const pub = createPublicClient({ chain, transport });
  const wallet = createWalletClient({ chain, transport, account: cfg.account });

  return {
    nextBatchId: () => pub.readContract({ address: cfg.escrow, abi: escrowAbi, functionName: "nextBatchId" }),
    async batchRoot(batchId) {
      const [root] = await pub.readContract({ address: cfg.escrow, abi: escrowAbi, functionName: "batch", args: [batchId] });
      return root;
    },
    sendSettle: (batchId, root, entries) =>
      wallet.writeContract({
        address: cfg.escrow,
        abi: escrowAbi,
        functionName: "settle",
        args: [batchId, root, entries.map((e) => ({ agentId: e.agentId, cost: e.cost }))],
      }),
    async waitForSettle(txHash) {
      const r = await pub.waitForTransactionReceipt({ hash: txHash, timeout: cfg.confirmTimeoutMs ?? 120_000 });
      let debitedWei: bigint | undefined;
      for (const log of r.logs) {
        if (log.address.toLowerCase() !== cfg.escrow.toLowerCase()) continue;
        try {
          const ev = decodeEventLog({ abi: escrowAbi, data: log.data, topics: log.topics });
          if (ev.eventName === "Settled") debitedWei = ev.args.debited;
        } catch {
          // Debited / Shortfall events
        }
      }
      return { status: r.status, blockNumber: r.blockNumber, debitedWei };
    },
    async txState(txHash) {
      try {
        await pub.getTransactionReceipt({ hash: txHash });
        return "mined";
      } catch {
        try {
          await pub.getTransaction({ hash: txHash });
          return "pending";
        } catch {
          return "unknown";
        }
      }
    },
  };
}

// --- batching ---

export interface BuiltBatch {
  root: Hex;
  entries: BatchEntry[];
  totalWei: bigint;
  proofs: Map<Hex, Hex[]>;
  receipts: UnsettledReceipt[];
}

/**
 * Picks receipts for one batch (oldest first, at most `maxAgents` distinct agents so the settle
 * tx stays within gas limits), builds the Merkle tree over every picked receipt (denied ones
 * too, so a denial can be proven settled), and sums cost per agent (agents with 0 cost are left out).
 */
export function buildBatch(candidates: readonly UnsettledReceipt[], maxAgents: number): BuiltBatch | undefined {
  const agents = new Set<bigint>();
  const picked: UnsettledReceipt[] = [];
  for (const r of candidates) {
    if (!agents.has(r.agentId)) {
      if (agents.size >= maxAgents) continue;
      agents.add(r.agentId);
    }
    picked.push(r);
  }
  if (picked.length === 0) return undefined;

  const tree = batchTree(picked.map((r) => r.hash as Hex32));
  const byHash = new Map(picked.map((r) => [r.hash.toLowerCase(), r]));
  const proofs = new Map<Hex, Hex[]>();
  for (const [i, [leaf]] of tree.entries()) proofs.set(byHash.get(leaf.toLowerCase())!.requestId, tree.getProof(i) as Hex[]);

  const sums = new Map<bigint, bigint>();
  for (const r of picked) sums.set(r.agentId, (sums.get(r.agentId) ?? 0n) + r.costWei);
  const entries = [...sums]
    .filter(([, cost]) => cost > 0n)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([agentId, cost]) => ({ agentId, cost }));
  const totalWei = entries.reduce((s, e) => s + e.cost, 0n);
  return { root: tree.root as Hex, entries, totalWei, proofs, receipts: picked };
}

// --- the settler ---

export type SettleResult =
  | { kind: "empty" }
  | { kind: "settled"; batchId: number; txHash: Hex; receipts: number; totalWei: bigint; debitedWei?: bigint }
  | { kind: "recovered"; batchId: number; how: "already-on-chain" | "resent" | "waited" }
  | { kind: "conflict"; batchId: number; released: number }
  | { kind: "failed"; batchId?: number; error: string };

export interface SettlerOptions {
  /** Receipts considered per batch */
  maxReceipts?: number;
  /** Distinct agents (settle entries) per batch */
  maxAgents?: number;
  log?: Logger;
  /** Test hooks to simulate a crash at a given point */
  hooks?: { afterCommit?: () => void; afterSend?: () => void };
}

const ZERO_ROOT = `0x${"00".repeat(32)}`;

export class Settler {
  private running = false;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly store: Store,
    private readonly escrow: EscrowWriter,
    private readonly opts: SettlerOptions = {},
  ) {}

  /** One cycle: finish an open batch if there is one, otherwise settle the next batch of receipts. */
  async settleOnce(): Promise<SettleResult> {
    if (this.running) return { kind: "failed", error: "a settle cycle is already running" };
    this.running = true;
    try {
      const open = this.store.openBatch();
      if (open) return await this.recover(open);
      return await this.settleNew();
    } catch (e) {
      this.opts.log?.error("settle cycle failed", { error: String(e) });
      return { kind: "failed", error: String(e) };
    } finally {
      this.running = false;
    }
  }

  /** Runs cycles until there is nothing left to settle or a cycle fails. */
  async settleAll(maxCycles = 100): Promise<SettleResult[]> {
    const results: SettleResult[] = [];
    for (let i = 0; i < maxCycles; i++) {
      const r = await this.settleOnce();
      results.push(r);
      if (r.kind === "empty" || r.kind === "failed") break;
    }
    return results;
  }

  start(intervalMs: number): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.settleOnce(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async settleNew(): Promise<SettleResult> {
    const built = buildBatch(this.store.unsettled(this.opts.maxReceipts ?? 2000), this.opts.maxAgents ?? 100);
    if (!built) return { kind: "empty" };

    const batchId = Number(await this.escrow.nextBatchId());
    this.store.createBatch({ batchId, root: built.root, entries: built.entries, totalWei: built.totalWei, proofs: built.proofs });
    this.opts.hooks?.afterCommit?.();
    this.opts.log?.info("batch created", { batchId, root: built.root, receipts: built.receipts.length, agents: built.entries.length, totalWei: built.totalWei });
    return this.submit(this.store.getBatch(batchId)!, "new");
  }

  private async submit(b: Batch, why: "new" | "resend"): Promise<SettleResult> {
    const txHash = await this.escrow.sendSettle(BigInt(b.batchId), b.root, b.entries);
    this.store.markSent(b.batchId, txHash);
    this.opts.hooks?.afterSend?.();
    return this.await(b, txHash, why === "new" ? undefined : "resent");
  }

  private async await(b: Batch, txHash: Hex, recoveredHow?: "resent" | "waited"): Promise<SettleResult> {
    const r = await this.escrow.waitForSettle(txHash);
    if (r.status === "success") {
      this.store.markConfirmed(b.batchId, { txHash, blockNumber: r.blockNumber, debitedWei: r.debitedWei ?? null });
      this.opts.log?.info("batch settled", { batchId: b.batchId, txHash, block: r.blockNumber, debitedWei: r.debitedWei, totalWei: b.totalWei });
      if (recoveredHow) return { kind: "recovered", batchId: b.batchId, how: recoveredHow };
      return { kind: "settled", batchId: b.batchId, txHash, receipts: b.receiptCount, totalWei: b.totalWei, debitedWei: r.debitedWei };
    }
    // Reverted. The usual cause is that the batch id was already used, e.g. by an earlier send of
    // this same batch that landed. Reconcile against the chain without sending again.
    this.opts.log?.warn("settle tx reverted; reconciling", { batchId: b.batchId, txHash });
    return this.reconcile(this.store.getBatch(b.batchId)!, false);
  }

  private async recover(b: Batch): Promise<SettleResult> {
    this.opts.log?.info("recovering open batch", { batchId: b.batchId, status: b.status, txHash: b.txHash });
    return this.reconcile(b, true);
  }

  private async reconcile(b: Batch, mayResend: boolean): Promise<SettleResult> {
    const next = await this.escrow.nextBatchId();
    const id = BigInt(b.batchId);

    if (next > id) {
      const root = await this.escrow.batchRoot(id);
      if (root.toLowerCase() === b.root.toLowerCase()) {
        let info: { blockNumber?: bigint; debitedWei?: bigint } = {};
        if (b.txHash && (await this.escrow.txState(b.txHash)) === "mined") {
          const r = await this.escrow.waitForSettle(b.txHash);
          if (r.status === "success") info = { blockNumber: r.blockNumber, debitedWei: r.debitedWei };
        }
        this.store.markConfirmed(b.batchId, { txHash: b.txHash, blockNumber: info.blockNumber ?? null, debitedWei: info.debitedWei ?? null });
        this.opts.log?.info("open batch was already settled on chain", { batchId: b.batchId });
        return { kind: "recovered", batchId: b.batchId, how: "already-on-chain" };
      }
      const released = this.store.markConflictAndRelease(b.batchId);
      this.opts.log?.error("batch id holds a different root on chain; receipts released", {
        batchId: b.batchId,
        ours: b.root,
        onChain: root === ZERO_ROOT ? null : root,
        released,
      });
      return { kind: "conflict", batchId: b.batchId, released };
    }

    if (next < id) {
      const released = this.store.markConflictAndRelease(b.batchId);
      this.opts.log?.error("batch id is ahead of the chain; receipts released", { batchId: b.batchId, nextOnChain: next, released });
      return { kind: "conflict", batchId: b.batchId, released };
    }

    // next === id: not on chain yet.
    if (b.txHash) {
      const state = await this.escrow.txState(b.txHash);
      if (state === "pending") return this.await(b, b.txHash, "waited");
    }
    if (!mayResend) return { kind: "failed", batchId: b.batchId, error: "settle reverted and the batch is not on chain" };
    return this.submit(b, "resend");
  }
}
