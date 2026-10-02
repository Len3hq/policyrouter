// SQLite storage (Node's built-in node:sqlite; no native modules to build).
//
//   keys      API keys created by this router (hash only; the key itself is never stored)
//   receipts  one row per handled request, allowed or denied: usage, cost and the signed receipt
//   batches   settlement batches (written by the settler in Phase 4)

import { DatabaseSync } from "node:sqlite";
import { receiptFromJson, receiptToJson, type ReceiptJson, type SignedReceipt } from "@policyrouter/policy";
import type { Hex } from "viem";

export interface StoredReceipt {
  receipt: SignedReceipt;
  hash: Hex;
  allowed: boolean;
  batchId: number | null;
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
      .prepare("SELECT receipt_json, receipt_hash, allowed, batch_id FROM receipts WHERE request_id = ?")
      .get(requestId) as { receipt_json: string; receipt_hash: Hex; allowed: number; batch_id: number | null } | undefined;
    if (!row) return undefined;
    return {
      receipt: receiptFromJson(JSON.parse(row.receipt_json) as ReceiptJson),
      hash: row.receipt_hash,
      allowed: row.allowed === 1,
      batchId: row.batch_id,
    };
  }

  /** Recent receipts for one key, newest first (used by policy simulation in Phase 5). */
  recentForKey(keyHash: Hex, limit: number): SignedReceipt[] {
    const rows = this.db
      .prepare("SELECT receipt_json FROM receipts WHERE key_hash = ? ORDER BY created_at DESC LIMIT ?")
      .all(keyHash, limit) as { receipt_json: string }[];
    return rows.map((r) => receiptFromJson(JSON.parse(r.receipt_json) as ReceiptJson));
  }

  close(): void {
    this.db.close();
  }
}
