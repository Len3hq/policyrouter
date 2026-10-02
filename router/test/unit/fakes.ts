// Test doubles for the router's dependencies.

import { budgetGuard, cheapOnly, decodeOutput, indexToInput, outputToIndex, receiptDomain } from "@policyrouter/policy";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createApp } from "../../src/app.ts";
import { loadCatalog } from "../../src/catalog.ts";
import type { ChainReader, PolicyState } from "../../src/chain.ts";
import { Store } from "../../src/db.ts";
import { createLogger } from "../../src/log.ts";
import type { ChatChunk, ChatCompletion, ChatParams, Provider } from "../../src/providers/types.ts";
import { UpstreamError } from "../../src/providers/types.ts";
import { staticPriceFeed, type PriceFeed } from "../../src/price.ts";
import { RateLimiter } from "../../src/ratelimit.ts";
import { createReceiptSigner } from "../../src/receipts.ts";

// anvil's well-known test key; never holds real funds
export const ROUTER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
export const ESCROW = "0x00000000000000000000000000000000000e5c20" as const;
export const PROCESSOR = "0x11FF9976c86E4C868a803Bc9B5E1ba7749226f99" as const;
export const PROVIDER_SECRET = "sk-provider-secret-do-not-leak-123456";

const TEMPLATE_BY_CIRCUIT = { 1: budgetGuard, 2: cheapOnly } as const;

export class FakeChain implements ChainReader {
  readonly processor = PROCESSOR;
  block = 100n;
  keys = new Map<Hex, Omit<PolicyState, "blockNumber">>();
  failRead = false;
  failEval = false;
  evalCalls = 0;

  policyState = async (keyHash: Hex): Promise<PolicyState> => {
    if (this.failRead) throw new Error("rpc down");
    const s = this.keys.get(keyHash) ?? { agentId: 0n, circuitId: 0n, killed: true, budgetOk: false };
    return { ...s, blockNumber: this.block };
  };

  evaluate = async (circuitId: bigint, input: Uint8Array): Promise<Uint8Array> => {
    this.evalCalls++;
    if (this.failEval) throw new Error("eval reverted");
    const t = TEMPLATE_BY_CIRCUIT[Number(circuitId) as 1 | 2];
    if (!t) throw new Error("no circuit");
    return Uint8Array.of(outputToIndex(t.evaluate(indexToInput(input[0]!))));
  };
}

export class FakeProvider implements Provider {
  readonly name = "deepseek";
  calls: ChatParams[] = [];
  fail?: UpstreamError;
  usage = { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, prompt_cache_hit_tokens: 40, prompt_cache_miss_tokens: 60 };

  complete = async (params: ChatParams): Promise<ChatCompletion> => {
    this.calls.push(params);
    if (this.fail) throw this.fail;
    return {
      id: "cmpl-1",
      object: "chat.completion",
      created: 1,
      model: params.model,
      choices: [{ index: 0, finish_reason: "stop", logprobs: null, message: { role: "assistant", content: "hello", refusal: null } }],
      usage: this.usage,
    };
  };

  stream = async (params: ChatParams): Promise<AsyncIterable<ChatChunk>> => {
    this.calls.push(params);
    if (this.fail) throw this.fail;
    const usage = this.usage;
    const chunk = (content: string | null, extra: Partial<ChatChunk> = {}): ChatChunk => ({
      id: "chunk-1",
      object: "chat.completion.chunk",
      created: 1,
      model: params.model,
      choices: content === null ? [] : [{ index: 0, delta: { content }, finish_reason: null, logprobs: null }],
      ...extra,
    });
    return (async function* () {
      yield chunk("Hel");
      yield chunk("lo");
      yield chunk(null, { usage });
    })();
  };
}

export function makeApp(opts: { rateLimit?: number; price?: PriceFeed } = {}) {
  const chain = new FakeChain();
  const provider = new FakeProvider();
  const store = new Store(":memory:");
  const lines: string[] = [];
  const account = privateKeyToAccount(ROUTER_KEY);
  const domain = receiptDomain(196, ESCROW);
  const app = createApp({
    catalog: loadCatalog(),
    chain,
    providers: { deepseek: provider },
    signer: createReceiptSigner(account, domain),
    store,
    limiter: new RateLimiter(opts.rateLimit ?? 1000),
    price: opts.price ?? staticPriceFeed("122.09"),
    log: createLogger([PROVIDER_SECRET, ROUTER_KEY], (l) => lines.push(l)),
  });
  return { app, chain, provider, store, lines, account, domain };
}

export const decode = decodeOutput;
