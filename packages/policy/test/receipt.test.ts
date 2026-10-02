import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import {
  receiptDomain,
  receiptFromJson,
  receiptHash,
  receiptToJson,
  recoverReceiptSigner,
  typedReceipt,
  type Receipt,
  type SignedReceipt,
} from "../src/index.ts";

// anvil's well-known test key; never holds real funds
const router = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const domain = receiptDomain(196, "0xCc2dd59C8042e42253D1C14d5c34F976226b7F7A");

const base: Receipt = {
  requestId: `0x${"11".repeat(32)}`,
  keyHash: `0x${"22".repeat(32)}`,
  agentId: 7n,
  processor: "0x11FF9976c86E4C868a803Bc9B5E1ba7749226f99",
  circuitId: 1n,
  inputBits: 0b010011,
  outputBits: 0b011,
  blockNumber: 72128138n,
  modelRequested: "frontier",
  modelServed: "standard",
  promptTokens: 120,
  cachedPromptTokens: 64,
  completionTokens: 340,
  okbUsdE8: 12_209_000_000n,
  costWei: 123456789n,
  timestamp: 1790000000n,
};

async function sign(r: Receipt): Promise<SignedReceipt> {
  return { ...r, routerSig: await router.signTypedData(typedReceipt(r, domain)) };
}

describe("receipts", () => {
  it("recover to the router address", async () => {
    expect(await recoverReceiptSigner(await sign(base), domain)).toBe(router.address);
  });

  it("break when any field changes", async () => {
    const signed = await sign(base);
    const tampered: Partial<Record<keyof Receipt, unknown>> = {
      requestId: `0x${"12".repeat(32)}`,
      keyHash: `0x${"23".repeat(32)}`,
      agentId: 8n,
      processor: "0x0000000000000000000000000000000000000001",
      circuitId: 2n,
      inputBits: 0b110011,
      outputBits: 0b000,
      blockNumber: 1n,
      modelRequested: "cheap",
      modelServed: "frontier",
      promptTokens: 1,
      cachedPromptTokens: 1,
      completionTokens: 1,
      okbUsdE8: 1n,
      costWei: 1n,
      timestamp: 1n,
    };
    for (const [field, value] of Object.entries(tampered)) {
      const changed = { ...signed, [field]: value } as SignedReceipt;
      expect(await recoverReceiptSigner(changed, domain), field).not.toBe(router.address);
    }
  });

  it("are bound to the chain and escrow in the domain", async () => {
    const signed = await sign(base);
    expect(await recoverReceiptSigner(signed, receiptDomain(1, domain.verifyingContract as Hex))).not.toBe(router.address);
    expect(receiptHash(base, domain)).not.toBe(receiptHash(base, receiptDomain(1, domain.verifyingContract as Hex)));
  });

  it("round-trip through JSON in the spec's format", async () => {
    const signed = await sign(base);
    const json = receiptToJson(signed);
    expect(json.inputBits).toBe("0b010011");
    expect(json.outputBits).toBe("0b011");
    expect(json.costWei).toBe("123456789");
    expect(receiptFromJson(JSON.parse(JSON.stringify(json)))).toEqual(signed);
  });

  it("rejects malformed bit strings", () => {
    expect(() => receiptFromJson({ ...receiptToJson({ ...base, routerSig: "0x" }), inputBits: "19" })).toThrow(/bad bit string/);
  });
});
