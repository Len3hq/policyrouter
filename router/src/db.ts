// SQLite storage (Node's built-in node:sqlite; no native modules to build).
//
//   keys      API keys created by this router (hash only; the key itself is never stored)
//   receipts  one row per handled request, allowed or denied: usage, cost and the signed receipt
//   batches   settlement batches: Merkle root, per-agent entries, tx hash and status (settler.ts)
//
// A batch moves pending → sent → confirmed. Its receipts are assigned to it (with their Merkle
// proofs) in the same transaction that creates it, before anything is sent on chain, so a crash at
// any point leaves a record the settler can reconcile against the chain.

import { DatabaseSync } from "node:sqlite";
import { receiptFromJson, receiptToJson, type ReceiptJson, type SignedReceipt } from "@policyrouter/policy";
import type { Hex } from "viem";

export interface StoredReceipt {
  receipt: SignedReceipt;
  hash: Hex;
  allowed: boolean;
  batchId: number | null;
  proof: Hex[] | null;
}

export type BatchStatus = "pending" | "sent" | "confirmed" | "conflict";

export interface BatchEntry {
  agentId: bigint;
  cost: bigint;
}

export interface Batch {
  batchId: number;
  root: Hex;
  entries: BatchEntry[];
  receiptCount: number;
  totalWei: bigint;
  status: BatchStatus;
  txHash: Hex | null;
  debitedWei: bigint | null;
  blockNumber: bigint | null;
  createdAt: number;
  confirmedAt: number | null;
}

/** An unsettled receipt, as the settler needs it. */
export interface UnsettledReceipt {
  requestId: Hex;
  agentId: bigint;
  costWei: bigint;
  hash: Hex;
}

interface BatchRow {
  batch_id: number;
  root: Hex;
  entries_json: string | null;
  receipt_count: number | null;
  total_wei: string | null;
  status: BatchStatus;
  tx_hash: Hex | null;
  debited_wei: string | null;
  block_number: string | null;
  created_at: number;
  confirmed_at: number | null;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS keys (
        key_hash   TEXT PRIMARY KEY,
        label      TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS receipts (
        request_id        TEXT PRIMARY KEY,
        key_hash          TEXT NOT NULL,
        agent_id          TEXT NOT NULL,
        circuit_id        TEXT NOT NULL,
        block_number      TEXT NOT NULL,
        input_bits        INTEGER NOT NULL,
        output_bits       INTEGER NOT NULL,
        allowed           INTEGER NOT NULL,
        model_requested   TEXT NOT NULL,
        model_served      TEXT NOT NULL,
        prompt_tokens     INTEGER NOT NULL,
        completion_tokens INTEGER NOT NULL,
        cost_wei          TEXT NOT NULL,
        receipt_hash      TEXT NOT NULL UNIQUE,
        receipt_json      TEXT NOT NULL,
        batch_id          INTEGER,
        created_at        INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS receipts_unsettled ON receipts (batch_id) WHERE batch_id IS NULL;
      CREATE INDEX IF NOT EXISTS receipts_by_key ON receipts (key_hash, created_at);
      CREATE TABLE IF NOT EXISTS batches (
        batch_id     INTEGER PRIMARY KEY,
        root         TEXT NOT NULL,
        tx_hash      TEXT,
        status       TEXT NOT NULL,
        created_at   INTEGER NOT NULL,
        confirmed_at INTEGER
      );
    `);
    // Columns added after the first release: add them to older databases.
    this.ensureColumn("receipts", "merkle_proof", "TEXT");
    this.ensureColumn("batches", "entries_json", "TEXT");
    this.ensureColumn("batches", "receipt_count", "INTEGER");
    this.ensureColumn("batches", "total_wei", "TEXT");
    this.ensureColumn("batches", "debited_wei", "TEXT");
    this.ensureColumn("batches", "block_number", "TEXT");
  }

  private ensureColumn(table: string, column: string, type: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }

  /** Runs `fn` in one SQLite transaction: all of it commits, or none of it does. */
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  // --- settlement ---

  /** Oldest receipts not yet in a batch. */
  unsettled(limit: number): UnsettledReceipt[] {
    const rows = this.db
      .prepare("SELECT request_id, agent_id, cost_wei, receipt_hash FROM receipts WHERE batch_id IS NULL ORDER BY created_at, rowid LIMIT ?")
      .all(limit) as { request_id: Hex; agent_id: string; cost_wei: string; receipt_hash: Hex }[];
    return rows.map((r) => ({ requestId: r.request_id, agentId: BigInt(r.agent_id), costWei: BigInt(r.cost_wei), hash: r.receipt_hash }));
  }

  /**
   * Creates a batch and assigns its receipts and their proofs, atomically. Throws (and changes
   * nothing) if the batch id already exists or a receipt was already assigned.
   */
  createBatch(b: { batchId: number; root: Hex; entries: BatchEntry[]; totalWei: bigint; proofs: Map<Hex, Hex[]> }): void {
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO batches (batch_id, root, entries_json, receipt_count, total_wei, status, created_at)
           VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
        )
        .run(
          b.batchId,
          b.root,
          JSON.stringify(b.entries.map((e) => [e.agentId.toString(), e.cost.toString()])),
          b.proofs.size,
          b.totalWei.toString(),
          Date.now(),
        );
      const assign = this.db.prepare("UPDATE receipts SET batch_id = ?, merkle_proof = ? WHERE request_id = ? AND batch_id IS NULL");
      for (const [requestId, proof] of b.proofs) {
        const res = assign.run(b.batchId, JSON.stringify(proof), requestId);
        if (res.changes !== 1) throw new Error(`receipt ${requestId} is already in a batch`);
      }
    });
  }

  /** The batch that was created but not yet confirmed, if any (there is at most one). */
  openBatch(): Batch | undefined {
    const row = this.db
      .prepare("SELECT * FROM batches WHERE status IN ('pending', 'sent') ORDER BY batch_id LIMIT 1")
      .get() as BatchRow | undefined;
    return row && toBatch(row);
  }

  getBatch(batchId: number): Batch | undefined {
    const row = this.db.prepare("SELECT * FROM batches WHERE batch_id = ?").get(batchId) as BatchRow | undefined;
    return row && toBatch(row);
  }

  markSent(batchId: number, txHash: Hex): void {
    this.db.prepare("UPDATE batches SET status = 'sent', tx_hash = ? WHERE batch_id = ?").run(txHash, batchId);
  }

  markConfirmed(batchId: number, info: { txHash?: Hex | null; blockNumber?: bigint | null; debitedWei?: bigint | null }): void {
    this.db
      .prepare(
        `UPDATE batches SET status = 'confirmed', confirmed_at = ?,
           tx_hash = COALESCE(?, tx_hash), block_number = COALESCE(?, block_number), debited_wei = COALESCE(?, debited_wei)
         WHERE batch_id = ?`,
      )
      .run(Date.now(), info.txHash ?? null, info.blockNumber?.toString() ?? null, info.debitedWei?.toString() ?? null, batchId);
  }

  /**
   * The chain holds a different batch under this id. Marks ours as a conflict and releases its
   * receipts, so they go into the next batch instead of being lost.
   */
  markConflictAndRelease(batchId: number): number {
    return this.transaction(() => {
      this.db.prepare("UPDATE batches SET status = 'conflict' WHERE batch_id = ?").run(batchId);
      return Number(this.db.prepare("UPDATE receipts SET batch_id = NULL, merkle_proof = NULL WHERE batch_id = ?").run(batchId).changes);
    });
  }

  addKey(keyHash: Hex, label: string | undefined): void {
    this.db.prepare("INSERT INTO keys (key_hash, label, created_at) VALUES (?, ?, ?)").run(keyHash, label ?? null, Date.now());
  }

  saveReceipt(r: SignedReceipt, hash: Hex, allowed: boolean): void {
    this.db
      .prepare(
        `INSERT INTO receipts (request_id, key_hash, agent_id, circuit_id, block_number, input_bits, output_bits, allowed,
           model_requested, model_served, prompt_tokens, completion_tokens, cost_wei, receipt_hash, receipt_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.requestId,
        r.keyHash,
        r.agentId.toString(),
        r.circuitId.toString(),
        r.blockNumber.toString(),
        r.inputBits,
        r.outputBits,
        allowed ? 1 : 0,
        r.modelRequested,
        r.modelServed,
        r.promptTokens,
        r.completionTokens,
        r.costWei.toString(),
        hash,
        JSON.stringify(receiptToJson(r)),
        Date.now(),
      );
  }

  getReceipt(requestId: string): StoredReceipt | undefined {
    const row = this.db
      .prepare("SELECT receipt_json, receipt_hash, allowed, batch_id, merkle_proof FROM receipts WHERE request_id = ?")
      .get(requestId) as
      | { receipt_json: string; receipt_hash: Hex; allowed: number; batch_id: number | null; merkle_proof: string | null }
      | undefined;
    if (!row) return undefined;
    return {
      receipt: receiptFromJson(JSON.parse(row.receipt_json) as ReceiptJson),
      hash: row.receipt_hash,
      allowed: row.allowed === 1,
      batchId: row.batch_id,
      proof: row.merkle_proof ? (JSON.parse(row.merkle_proof) as Hex[]) : null,
    };
  }

  /** Recent receipts for one key, newest first (used by policy simulation in Phase 5). */
  recentForKey(keyHash: Hex, limit: number): SignedReceipt[] {
    const rows = this.db
      .prepare("SELECT receipt_json FROM receipts WHERE key_hash = ? ORDER BY created_at DESC, rowid DESC LIMIT ?")
      .all(keyHash, limit) as { receipt_json: string }[];
    return rows.map((r) => receiptFromJson(JSON.parse(r.receipt_json) as ReceiptJson));
  }

  close(): void {
    this.db.close();
  }
}

function toBatch(r: BatchRow): Batch {
  return {
    batchId: r.batch_id,
    root: r.root,
    entries: (JSON.parse(r.entries_json ?? "[]") as [string, string][]).map(([a, c]) => ({ agentId: BigInt(a), cost: BigInt(c) })),
    receiptCount: r.receipt_count ?? 0,
    totalWei: BigInt(r.total_wei ?? "0"),
    status: r.status,
    txHash: r.tx_hash,
    debitedWei: r.debited_wei === null ? null : BigInt(r.debited_wei),
    blockNumber: r.block_number === null ? null : BigInt(r.block_number),
    createdAt: r.created_at,
    confirmedAt: r.confirmed_at,
  };
}
