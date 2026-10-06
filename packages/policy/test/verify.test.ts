import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { decodeFunctionData, type Abi, type Address, type Hex } from "viem";
import {
  batchTree,
  budgetGuard,
  cheapOnly,
  indexToInput,
  inputToIndex,
  outputToIndex,
  parseReceiptInput,
  proofFor,
  rawEthCall,
  receiptDomain,
  receiptHash,
  receiptToJson,
  typedReceipt,
  verifyReceiptOnChain,
  type ChainReads,
  type Hex32,
  type Receipt,
  type SignedReceipt,
  type VerifyContext,
} from "../src/index.ts";

// anvil's well-known test keys; never hold real funds
const router = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const impostor = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");

const PROCESSOR = "0x11FF9976c86E4C868a803Bc9B5E1ba7749226f99" as Address;
const REGISTRY = "0x7F05d6c389F973EA3Fb10A3Eb27e338f8eB42D0a" as Address;
const ESCROW = "0xCc2dd59C8042e42253D1C14d5c34F976226b7F7A" as Address;
const KEY = `0x${"ab".repeat(32)}` as Hex;
const domain = receiptDomain(196, ESCROW);

/** Chain state at "the receipt's block", as the fake chain will report it. */
interface ChainState {
  agentId: bigint;
  circuitId: bigint;
  killed: boolean;
  budgetOk: boolean;
}

/** Answers the verifier's reads from the real template rules and a real Merkle tree. */
class FakeChain implements ChainReads {
  state: ChainState = { agentId: 1n, circuitId: 1n, killed: false, budgetOk: true };
  roots = new Map<bigint, Hex>();
  noHistory = false;

  async readContract({ functionName, args = [], blockNumber, address }: { address: Address; abi: Abi; functionName: string; args?: readonly unknown[]; blockNumber?: bigint }) {
    if (this.noHistory && blockNumber !== undefined) throw new Error("missing trie node abc (path ) state not available");
    switch (functionName) {
      case "router":
        return router.address;
      case "policyOf":
        return [this.state.agentId, router.address, this.state.circuitId, 10n ** 15n, this.state.killed];
      case "budgetOkForKey":
        return this.state.budgetOk;
      case "eval": {
        if (address.toLowerCase() !== PROCESSOR.toLowerCase()) throw new Error("not a processor");
        const [circuitId, input] = args as [bigint, Hex];
        const t = circuitId === 1n ? budgetGuard : circuitId === 2n ? cheapOnly : undefined;
        if (!t) throw new Error("no circuit");
        return `0x${outputToIndex(t.evaluate(indexToInput(parseInt(input.slice(2), 16)))).toString(16).padStart(2, "0")}`;
      }
      case "isInBatch": {
        const [batchId, leaf, proof] = args as [bigint, Hex, Hex[]];
        const root = this.roots.get(batchId);
        if (!root) return false;
        const { verifyReceipt } = await import("../src/merkle.ts");
        return verifyReceipt(root as Hex32, leaf as Hex32, proof as Hex32[]);
      }
      default:
        throw new Error(`unexpected ${functionName}`);
    }
  }
}

const ctx = (client: ChainReads): VerifyContext => ({ client, chainId: 196, processor: PROCESSOR, registry: REGISTRY, escrow: ESCROW, rpcUrl: "https://rpc.xlayer.tech" });

function receipt(over: Partial<Receipt> = {}): Receipt {
  return {
    requestId: `0x${"11".repeat(32)}`,
    keyHash: KEY,
    agentId: 1n,
    processor: PROCESSOR,
    circuitId: 1n,
    inputBits: inputToIndex({ tier: 1, size: 0, budgetOk: true, kill: false }),
    outputBits: outputToIndex({ allow: true, routeTier: 1 }),
    blockNumber: 72160362n,
    modelRequested: "standard",
    modelServed: "standard",
    promptTokens: 14,
    cachedPromptTokens: 0,
    completionTokens: 24,
    okbUsdE8: 12_265_000_000n,
    costWei: 295_964_125_561n,
    timestamp: 1790930000n,
    ...over,
  };
}

const sign = async (r: Receipt, by = router): Promise<SignedReceipt> => ({ ...r, routerSig: await by.signTypedData(typedReceipt(r, domain)) });

/** Settles `receipts` as batch `id` on the fake chain and returns each one's settlement. */
function settle(chain: FakeChain, id: number, receipts: SignedReceipt[]) {
  const hashes = receipts.map((r) => receiptHash(r, domain) as Hex32);
  const tree = batchTree(hashes);
  chain.roots.set(BigInt(id), tree.root as Hex);
  return hashes.map((h) => ({ batchId: id, status: "confirmed", proof: proofFor(tree, h) as Hex[] }));
}

const byId = (checks: { id: string; status: string }[]) => Object.fromEntries(checks.map((c) => [c.id, c.status]));

describe("verifyReceiptOnChain", () => {
  it("a valid, settled allow receipt passes all four checks", async () => {
    const chain = new FakeChain();
    const r = await sign(receipt());
    const [s] = settle(chain, 0, [r, await sign(receipt({ requestId: `0x${"22".repeat(32)}` }))]);
    const res = await verifyReceiptOnChain(ctx(chain), r, s);
    expect(res.verdict).toBe("verified");
    expect(byId(res.checks)).toEqual({ signature: "pass", inputs: "pass", policy: "pass", settlement: "pass" });
    expect(res.failed).toEqual([]);
  });

  it("a valid deny receipt passes: the policy check proves the deny was right", async () => {
    const chain = new FakeChain();
    chain.state.killed = true;
    const r = await sign(receipt({ inputBits: inputToIndex({ tier: 1, size: 0, budgetOk: true, kill: true }), outputBits: 0, modelServed: "", costWei: 0n }));
    const [s] = settle(chain, 0, [r]);
    const res = await verifyReceiptOnChain(ctx(chain), r, s);
    expect(res.verdict).toBe("verified");
    expect(res.checks.find((c) => c.id === "policy")!.reason).toContain("(deny)");
  });

  it("changed outputBits → the policy check fails (and the signature no longer matches)", async () => {
    const chain = new FakeChain();
    const r = await sign(receipt());
    const tampered = { ...r, outputBits: outputToIndex({ allow: true, routeTier: 3 }) };
    const res = await verifyReceiptOnChain(ctx(chain), tampered, null);
    expect(res.verdict).toBe("failed");
    expect(res.failed).toContain("policy");
    expect(res.failed).toContain("signature");
    expect(res.checks.find((c) => c.id === "policy")!.reason).toMatch(/but the receipt says 0b111/);
  });

  it("changed costWei → the signature check fails; the policy still holds", async () => {
    const chain = new FakeChain();
    const r = await sign(receipt());
    const res = await verifyReceiptOnChain(ctx(chain), { ...r, costWei: 1n }, null);
    expect(byId(res.checks)).toMatchObject({ signature: "fail", policy: "pass", inputs: "pass" });
    expect(res.checks[0]!.reason).toMatch(/Signed by 0x\w+, but CreditEscrow's router is/);
  });

  it("a receipt re-signed with another key → the signature check fails", async () => {
    const chain = new FakeChain();
    const r = await sign(receipt(), impostor);
    const res = await verifyReceiptOnChain(ctx(chain), r, null);
    expect(res.failed).toEqual(["signature"]);
    expect(res.checks[0]!.reason).toContain(impostor.address);
  });

  it("a valid receipt with a wrong proof → the settlement check fails", async () => {
    const chain = new FakeChain();
    const r = await sign(receipt());
    const other = await sign(receipt({ requestId: `0x${"33".repeat(32)}` }));
    const [, sOther] = settle(chain, 0, [r, other]);
    const res = await verifyReceiptOnChain(ctx(chain), r, { ...sOther!, proof: [`0x${"00".repeat(32)}`] });
    expect(res.failed).toEqual(["settlement"]);
  });

  it("an unsettled receipt is pending, not failed", async () => {
    const chain = new FakeChain();
    const r = await sign(receipt());
    for (const s of [null, { batchId: 3, status: "sent", proof: [] as Hex[] }]) {
      const res = await verifyReceiptOnChain(ctx(chain), r, s);
      expect(res.verdict).toBe("pending");
      expect(byId(res.checks).settlement).toBe("pending");
      expect(res.failed).toEqual([]);
    }
  });

  it("a router that lies about budget_ok or the kill switch fails the inputs check, even with a valid signature", async () => {
    const chain = new FakeChain();
    chain.state.budgetOk = false; // the chain says the agent was over budget
    const r = await sign(receipt()); // the router claimed budget_ok = 1 and served it
    const res = await verifyReceiptOnChain(ctx(chain), r, null);
    expect(res.failed).toEqual(["inputs"]);
    expect(res.checks.find((c) => c.id === "inputs")!.reason).toContain("budget_ok was false, receipt says true");
  });

  it("a receipt claiming another circuit or agent fails the inputs check", async () => {
    const chain = new FakeChain();
    chain.state.circuitId = 2n; // the agent was on Cheap Only
    const res = await verifyReceiptOnChain(ctx(chain), await sign(receipt()), null);
    expect(res.checks.find((c) => c.id === "inputs")!.reason).toContain("the agent's circuit was 2, not 1");
  });

  it("a receipt naming some other processor fails the policy check", async () => {
    const chain = new FakeChain();
    const r = await sign(receipt({ processor: "0x000000000000000000000000000000000000dEaD" }));
    const res = await verifyReceiptOnChain(ctx(chain), r, null);
    expect(res.failed).toContain("policy");
  });

  it("without historical state: eval falls back to the latest block (circuits never change); inputs are 'unavailable', not failed", async () => {
    const chain = new FakeChain();
    chain.noHistory = true;
    const res = await verifyReceiptOnChain(ctx(chain), await sign(receipt()), null);
    expect(byId(res.checks)).toMatchObject({ policy: "pass", inputs: "unavailable" });
    expect(res.checks.find((c) => c.id === "policy")!.reason).toContain("latest block");
    expect(res.verdict).toBe("pending");
  });

  it("every call is re-runnable: cast commands and raw eth_call payloads at the receipt's block", async () => {
    const chain = new FakeChain();
    const r = await sign(receipt());
    const res = await verifyReceiptOnChain(ctx(chain), r, null);
    const evalCall = res.checks.find((c) => c.id === "policy")!.calls[0]!;
    expect(evalCall.cast).toBe(`cast call ${PROCESSOR} "eval(uint256,bytes)(bytes)" 1 0x11 --block 72160362 --rpc-url https://rpc.xlayer.tech`);
    const raw = JSON.parse(rawEthCall(evalCall));
    expect(raw).toMatchObject({ method: "eth_call", params: [{ to: PROCESSOR }, `0x${(72160362).toString(16)}`] });
    const decoded = decodeFunctionData({
      abi: [{ type: "function", name: "eval", inputs: [{ type: "uint256" }, { type: "bytes" }], outputs: [{ type: "bytes" }], stateMutability: "view" }],
      data: evalCall.data,
    });
    expect(decoded.args).toEqual([1n, "0x11"]);
  });
});

describe("parseReceiptInput", () => {
  it("accepts a /v1/receipts response, a completion with policyrouter_receipt, and a bare receipt", async () => {
    const r = await sign(receipt());
    const json = receiptToJson(r);
    const settlement = { batchId: 0, status: "confirmed", root: "0x", proof: [`0x${"aa".repeat(32)}`], txHash: null };
    expect(parseReceiptInput(JSON.stringify({ receipt: json, settlement }))).toMatchObject({ receipt: r, settlement: { batchId: 0, status: "confirmed" } });
    expect(parseReceiptInput(JSON.stringify({ choices: [], policyrouter_receipt: json })).receipt).toEqual(r);
    expect(parseReceiptInput(JSON.stringify(json))).toEqual({ receipt: r, settlement: null });
  });

  it("explains what's wrong with other input", () => {
    expect(() => parseReceiptInput("not json")).toThrow(/isn't JSON/);
    expect(() => parseReceiptInput(JSON.stringify({ hello: 1 }))).toThrow(/No receipt/);
  });
});
