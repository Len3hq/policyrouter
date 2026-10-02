// Signed receipts: one per request the router handles, allowed or denied.
//
// A receipt records exactly what the router saw and decided: the key, the circuit, the input and
// output bits, the block it read chain state at, the models, the tokens and the cost. The router
// signs it as EIP-712 typed data. Its EIP-712 hash is also its Merkle leaf when the batch is
// settled (CreditEscrow.isInBatch), so one hash ties the signature to the on-chain settlement.

import { hashTypedData, recoverTypedDataAddress, type Address, type Hex, type TypedDataDomain } from "viem";

export const RECEIPT_TYPES = {
  Receipt: [
    { name: "requestId", type: "bytes32" },
    { name: "keyHash", type: "bytes32" },
    { name: "agentId", type: "uint256" },
    { name: "processor", type: "address" },
    { name: "circuitId", type: "uint256" },
    { name: "inputBits", type: "uint8" },
    { name: "outputBits", type: "uint8" },
    { name: "blockNumber", type: "uint64" },
    { name: "modelRequested", type: "string" },
    { name: "modelServed", type: "string" },
    { name: "promptTokens", type: "uint32" },
    { name: "cachedPromptTokens", type: "uint32" },
    { name: "completionTokens", type: "uint32" },
    { name: "okbUsdE8", type: "uint64" },
    { name: "costWei", type: "uint256" },
    { name: "timestamp", type: "uint64" },
  ],
} as const;

/** The values that are signed. */
export interface Receipt {
  requestId: Hex;
  keyHash: Hex;
  agentId: bigint;
  processor: Address;
  circuitId: bigint;
  /** eval() input byte: tier + 4·size + 16·budget_ok + 32·kill */
  inputBits: number;
  /** eval() output byte: allow + 2·route_tier */
  outputBits: number;
  /** Block at which chain state was read and eval() was called */
  blockNumber: bigint;
  modelRequested: string;
  /** Empty when the request was denied */
  modelServed: string;
  promptTokens: number;
  /** Prompt tokens served from the provider's context cache (billed at the cache-hit rate) */
  cachedPromptTokens: number;
  completionTokens: number;
  /** OKB/USD price used to convert the provider's USD price, with 8 decimals ($122.09 = 12209000000) */
  okbUsdE8: bigint;
  /** Served model's USD price at `timestamp` (peak or off-peak) × token counts, converted at okbUsdE8, plus markup */
  costWei: bigint;
  /** Unix seconds */
  timestamp: bigint;
}

export interface SignedReceipt extends Receipt {
  routerSig: Hex;
}

/** JSON form returned to clients: bigints as decimal strings, bits as binary strings. */
export interface ReceiptJson {
  requestId: Hex;
  keyHash: Hex;
  agentId: string;
  processor: Address;
  circuitId: string;
  inputBits: string;
  outputBits: string;
  blockNumber: string;
  modelRequested: string;
  modelServed: string;
  promptTokens: number;
  cachedPromptTokens: number;
  completionTokens: number;
  okbUsdE8: string;
  costWei: string;
  timestamp: string;
  routerSig: Hex;
}

export function receiptDomain(chainId: number, escrow: Address): TypedDataDomain {
  return { name: "PolicyRouter", version: "1", chainId, verifyingContract: escrow };
}

/** EIP-712 hash of the receipt: what the router signs and what goes into the settlement Merkle tree. */
export function receiptHash(r: Receipt, domain: TypedDataDomain): Hex {
  return hashTypedData({ domain, types: RECEIPT_TYPES, primaryType: "Receipt", message: message(r) });
}

export async function recoverReceiptSigner(r: SignedReceipt, domain: TypedDataDomain): Promise<Address> {
  return recoverTypedDataAddress({
    domain,
    types: RECEIPT_TYPES,
    primaryType: "Receipt",
    message: message(r),
    signature: r.routerSig,
  });
}

export function typedReceipt(r: Receipt, domain: TypedDataDomain) {
  return { domain, types: RECEIPT_TYPES, primaryType: "Receipt" as const, message: message(r) };
}

const bin = (v: number, width: number) => `0b${v.toString(2).padStart(width, "0")}`;

export function receiptToJson(r: SignedReceipt): ReceiptJson {
  return {
    requestId: r.requestId,
    keyHash: r.keyHash,
    agentId: r.agentId.toString(),
    processor: r.processor,
    circuitId: r.circuitId.toString(),
    inputBits: bin(r.inputBits, 6),
    outputBits: bin(r.outputBits, 3),
    blockNumber: r.blockNumber.toString(),
    modelRequested: r.modelRequested,
    modelServed: r.modelServed,
    promptTokens: r.promptTokens,
    cachedPromptTokens: r.cachedPromptTokens,
    completionTokens: r.completionTokens,
    okbUsdE8: r.okbUsdE8.toString(),
    costWei: r.costWei.toString(),
    timestamp: r.timestamp.toString(),
    routerSig: r.routerSig,
  };
}

export function receiptFromJson(j: ReceiptJson): SignedReceipt {
  const bits = (s: string) => {
    if (!/^0b[01]+$/.test(s)) throw new Error(`bad bit string ${s}`);
    return parseInt(s.slice(2), 2);
  };
  return {
    requestId: j.requestId,
    keyHash: j.keyHash,
    agentId: BigInt(j.agentId),
    processor: j.processor,
    circuitId: BigInt(j.circuitId),
    inputBits: bits(j.inputBits),
    outputBits: bits(j.outputBits),
    blockNumber: BigInt(j.blockNumber),
    modelRequested: j.modelRequested,
    modelServed: j.modelServed,
    promptTokens: j.promptTokens,
    cachedPromptTokens: j.cachedPromptTokens,
    completionTokens: j.completionTokens,
    okbUsdE8: BigInt(j.okbUsdE8),
    costWei: BigInt(j.costWei),
    timestamp: BigInt(j.timestamp),
    routerSig: j.routerSig,
  };
}

function message(r: Receipt) {
  return {
    requestId: r.requestId,
    keyHash: r.keyHash,
    agentId: r.agentId,
    processor: r.processor,
    circuitId: r.circuitId,
    inputBits: r.inputBits,
    outputBits: r.outputBits,
    blockNumber: r.blockNumber,
    modelRequested: r.modelRequested,
    modelServed: r.modelServed,
    promptTokens: r.promptTokens,
    cachedPromptTokens: r.cachedPromptTokens,
    completionTokens: r.completionTokens,
    okbUsdE8: r.okbUsdE8,
    costWei: r.costWei,
    timestamp: r.timestamp,
  };
}
