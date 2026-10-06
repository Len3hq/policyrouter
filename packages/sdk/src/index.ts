// @policyrouter/sdk: a thin client for PolicyRouter.
//
//   const pr = new PolicyRouter({ apiKey: "pr-live-…", baseURL: "https://your-router" });
//   const { text, receipt } = await pr.chat({ model: "standard", messages: [{ role: "user", content: "Hi" }] });
//   const check = await pr.verify(receipt.requestId);   // signature, chain inputs, policy, settlement
//
// It wraps the official OpenAI client, so every chat-completions option works. What it adds: the
// signed receipt with every answer, a typed PolicyDeniedError (with the denial's receipt) when the
// policy circuit says no, and on-chain receipt verification with the Verify page's own checks.

import OpenAI from "openai";
import { createPublicClient, http, type Address } from "viem";
import {
  POLICYROUTER,
  XLAYER_CHAIN_ID,
  parseReceiptInput,
  receiptFromJson,
  verifyReceiptOnChain,
  type ChainReads,
  type ReceiptJson,
  type Settlement,
  type SignedReceipt,
  type VerifyResult,
} from "@policyrouter/policy";

export type { SignedReceipt, ReceiptJson, Settlement, VerifyResult } from "@policyrouter/policy";

type ChatParams = Omit<OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming, "stream">;
type StreamParams = Omit<OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming, "stream">;

export interface PolicyRouterOptions {
  /** The agent's `pr-live-…` key */
  apiKey: string;
  /** The router's root URL (without /v1). Default: POLICYROUTER_URL, or http://localhost:8787 */
  baseURL?: string;
  /** For verification: an X Layer RPC. Default: POLICYROUTER_RPC_URL, or https://rpc.xlayer.tech */
  rpcUrl?: string;
  /** Custom fetch (tests, proxies, edge runtimes) */
  fetch?: typeof fetch;
}

/** Any error the router returned, with its code (policy_denied, rate_limit_exceeded, …). */
export class PolicyRouterError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly code: string | undefined,
    /** The signed receipt, when the router issued one (denials and upstream failures) */
    readonly receipt?: SignedReceipt,
  ) {
    super(message);
    this.name = "PolicyRouterError";
  }
}

/** The agent's policy circuit refused the request. The provider never saw it. */
export class PolicyDeniedError extends PolicyRouterError {
  declare readonly receipt: SignedReceipt;
  constructor(message: string, receipt: SignedReceipt) {
    super(message, 403, "policy_denied", receipt);
    this.name = "PolicyDeniedError";
  }
}

export interface ChatResult {
  /** The first choice's text */
  text: string;
  /** The model actually served: lower than requested if the policy downgraded it */
  model: string;
  completion: OpenAI.Chat.Completions.ChatCompletion;
  receipt: SignedReceipt;
}

const env = (k: string) => (typeof process !== "undefined" ? process.env?.[k] : undefined);

function receiptFromHeader(value: string | null | undefined): SignedReceipt | undefined {
  if (!value) return undefined;
  try {
    const json = typeof Buffer !== "undefined" ? Buffer.from(value, "base64url").toString("utf8") : atob(value.replace(/-/g, "+").replace(/_/g, "/"));
    return receiptFromJson(JSON.parse(json) as ReceiptJson);
  } catch {
    return undefined;
  }
}

function toPolicyRouterError(e: unknown): unknown {
  if (!(e instanceof OpenAI.APIError)) return e;
  const code = (e.error as { code?: string } | undefined)?.code ?? e.code ?? undefined;
  const receipt = receiptFromHeader((e.headers as Headers | undefined)?.get?.("x-policyrouter-receipt"));
  const message = (e.error as { message?: string } | undefined)?.message ?? e.message;
  if (code === "policy_denied" && receipt) return new PolicyDeniedError(message, receipt);
  return new PolicyRouterError(message, e.status, code ?? undefined, receipt);
}

export class PolicyRouter {
  /** The underlying OpenAI client, pointed at the router */
  readonly openai: OpenAI;
  readonly baseURL: string;
  private readonly apiKey: string;
  private readonly rpcUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(opts: PolicyRouterOptions) {
    if (!/^pr-live-[0-9a-f]{48}$/.test(opts.apiKey)) throw new Error("apiKey must be a PolicyRouter key: pr-live- followed by 48 hex characters.");
    this.apiKey = opts.apiKey;
    this.baseURL = (opts.baseURL ?? env("POLICYROUTER_URL") ?? "http://localhost:8787").replace(/\/+$/, "").replace(/\/v1$/, "");
    this.rpcUrl = opts.rpcUrl ?? env("POLICYROUTER_RPC_URL") ?? "https://rpc.xlayer.tech";
    this.fetchFn = opts.fetch ?? fetch;
    this.openai = new OpenAI({ apiKey: opts.apiKey, baseURL: `${this.baseURL}/v1`, fetch: this.fetchFn, maxRetries: 0 });
  }

  /** One chat completion. Throws PolicyDeniedError when the policy refuses it. */
  async chat(params: ChatParams): Promise<ChatResult> {
    let completion: OpenAI.Chat.Completions.ChatCompletion & { policyrouter_receipt?: ReceiptJson };
    try {
      completion = await this.openai.chat.completions.create({ ...params, stream: false });
    } catch (e) {
      throw toPolicyRouterError(e);
    }
    if (!completion.policyrouter_receipt) throw new PolicyRouterError("The response had no PolicyRouter receipt. Is baseURL a PolicyRouter?", 200, undefined);
    return {
      text: completion.choices[0]?.message?.content ?? "",
      model: completion.model,
      completion,
      receipt: receiptFromJson(completion.policyrouter_receipt),
    };
  }

  /**
   * A streamed chat completion: yields the provider's chunks, and returns the signed receipt when the
   * stream ends (`const receipt = yield* pr.chatStream(…)`, or read `.value` of the final `next()`).
   */
  async *chatStream(params: StreamParams): AsyncGenerator<OpenAI.Chat.Completions.ChatCompletionChunk, SignedReceipt> {
    let stream;
    try {
      stream = await this.openai.chat.completions.create({ ...params, stream: true });
    } catch (e) {
      throw toPolicyRouterError(e);
    }
    let receipt: SignedReceipt | undefined;
    for await (const chunk of stream) {
      const r = (chunk as { policyrouter_receipt?: ReceiptJson }).policyrouter_receipt;
      if (r) receipt = receiptFromJson(r);
      else yield chunk;
    }
    if (!receipt) throw new PolicyRouterError("The stream ended without a PolicyRouter receipt.", 200, undefined);
    return receipt;
  }

  /** A stored receipt and its settlement (batch, Merkle proof) from the router. */
  async receipt(requestId: string): Promise<{ receipt: SignedReceipt; settlement: Settlement | null }> {
    const res = await this.fetchFn(`${this.baseURL}/v1/receipts/${requestId}`);
    if (!res.ok) throw new PolicyRouterError(`The router has no receipt ${requestId} (${res.status}).`, res.status, "not_found");
    return parseReceiptInput(await res.text());
  }

  /** Checks a receipt against X Layer, with read-only calls. Pass a request id to fetch it (and its proof) from the router. */
  async verify(receiptOrRequestId: SignedReceipt | string, opts: Omit<VerifyOptions, "rpcUrl"> = {}): Promise<VerifyResult> {
    if (typeof receiptOrRequestId === "string") {
      const { receipt, settlement } = await this.receipt(receiptOrRequestId);
      return verifyReceipt(receipt, { rpcUrl: this.rpcUrl, settlement, ...opts });
    }
    return verifyReceipt(receiptOrRequestId, { rpcUrl: this.rpcUrl, ...opts });
  }

  /** What each template policy (or a custom rule, "custom:t1-downgrade-s2") would do to this key's recent requests. */
  async simulate(template?: string): Promise<unknown> {
    return this.get(`/v1/simulate${template ? `?template=${encodeURIComponent(template)}` : ""}`);
  }

  /** This key's decision counts, spend and recent requests. */
  async usage(): Promise<unknown> {
    return this.get("/v1/usage");
  }

  private async get(path: string): Promise<unknown> {
    const res = await this.fetchFn(`${this.baseURL}${path}`, { headers: { authorization: `Bearer ${this.apiKey}` } });
    const body = (await res.json()) as { error?: { message: string; code: string } };
    if (!res.ok) throw new PolicyRouterError(body.error?.message ?? `router returned ${res.status}`, res.status, body.error?.code);
    return body;
  }
}

export interface VerifyOptions {
  rpcUrl?: string;
  /** The receipt's settlement, for the settlement check (pending without it) */
  settlement?: Settlement | null;
  chainId?: number;
  processor?: Address;
  registry?: Address;
  escrow?: Address;
  /** Bring your own reader instead of an RPC URL */
  client?: ChainReads;
}

/**
 * The Verify page's checks (signature, chain inputs, policy, settlement), against PolicyRouter's
 * mainnet contracts by default. Accepts a receipt object, its JSON, or a `GET /v1/receipts` response.
 */
export async function verifyReceipt(input: SignedReceipt | ReceiptJson | { receipt: ReceiptJson; settlement?: Settlement | null }, opts: VerifyOptions = {}): Promise<VerifyResult> {
  let receipt: SignedReceipt;
  let settlement = opts.settlement ?? null;
  if ("receipt" in input) {
    const parsed = parseReceiptInput(JSON.stringify(input));
    receipt = parsed.receipt;
    settlement = opts.settlement ?? parsed.settlement;
  } else if (typeof input.agentId === "string") {
    receipt = receiptFromJson(input as ReceiptJson);
  } else {
    receipt = input as SignedReceipt;
  }
  const rpcUrl = opts.rpcUrl ?? env("POLICYROUTER_RPC_URL") ?? "https://rpc.xlayer.tech";
  return verifyReceiptOnChain(
    {
      client: opts.client ?? (createPublicClient({ transport: http(rpcUrl) }) as unknown as ChainReads),
      chainId: opts.chainId ?? XLAYER_CHAIN_ID,
      processor: opts.processor ?? POLICYROUTER.processor,
      registry: opts.registry ?? POLICYROUTER.policyRegistry,
      escrow: opts.escrow ?? POLICYROUTER.creditEscrow,
      rpcUrl,
    },
    receipt,
    settlement,
  );
}
