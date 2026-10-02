// Integration harness: an anvil fork of X Layer mainnet with Phase 2 deployed on it, Cheap Only
// taped out on the live PolicyRouter processor, a mock OpenAI-compatible provider, and a real
// router (real chain reader, real provider adapter, real SQLite) wired to them.

import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  http,
  parseEther,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { POLICYROUTER, receiptDomain, type CircuitArtifact } from "@policyrouter/policy";
import { createApp } from "../../src/app.ts";
import { loadCatalog } from "../../src/catalog.ts";
import { createChainReader } from "../../src/chain.ts";
import { Store } from "../../src/db.ts";
import { createLogger } from "../../src/log.ts";
import { createOpenAICompatibleProvider } from "../../src/providers/openai-compatible.ts";
import { staticPriceFeed } from "../../src/price.ts";
import { RateLimiter } from "../../src/ratelimit.ts";
import { createReceiptSigner } from "../../src/receipts.ts";

const ROOT = new URL("../../../", import.meta.url);
export const PROVIDER_KEY = "sk-integration-provider-key-000000";

const artifact = (name: string) =>
  JSON.parse(readFileSync(new URL(`contracts/out/${name}.sol/${name}.json`, ROOT), "utf8")) as {
    abi: Abi;
    bytecode: { object: Hex };
  };

const transistorsAbi = [
  { type: "function", name: "mint", stateMutability: "payable", inputs: [{ type: "uint256" }, { type: "uint256" }], outputs: [] },
  { type: "function", name: "mintPrice", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;
const processorAbi = [
  {
    type: "function",
    name: "tapeout",
    stateMutability: "payable",
    inputs: [{ type: "bytes" }, { type: "uint32" }, { type: "uint32" }],
    outputs: [{ type: "uint256" }],
  },
  { type: "function", name: "TAPEOUT_FEE", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "eval",
    stateMutability: "view",
    inputs: [{ type: "uint256" }, { type: "bytes" }],
    outputs: [{ type: "bytes" }],
  },
] as const;
const factoryAbi = [{ type: "function", name: "protocolFee", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }] as const;

// --- anvil ---

export async function startAnvil(): Promise<{ url: string; stop: () => void }> {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const fork = process.env.XLAYER_RPC_URL || "https://rpc.xlayer.tech";
  const proc: ChildProcess = spawn("anvil", ["--fork-url", fork, "--port", String(port), "--silent"], { stdio: "ignore" });
  const url = `http://127.0.0.1:${port}`;
  const client = createPublicClient({ transport: http(url) });
  for (let i = 0; i < 100; i++) {
    try {
      await client.getChainId();
      return { url, stop: () => proc.kill() };
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  proc.kill();
  throw new Error("anvil did not start");
}

// --- mock provider ---

export interface MockProvider {
  baseURL: string;
  requests: { body: Record<string, unknown>; auth: string | undefined }[];
  close: () => Promise<void>;
}

export async function startMockProvider(): Promise<MockProvider> {
  const requests: MockProvider["requests"] = [];
  const read = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let s = "";
      req.on("data", (d) => (s += d));
      req.on("end", () => resolve(s));
    });
  const server: Server = createServer(async (req, res) => {
    const body = JSON.parse(await read(req)) as Record<string, unknown>;
    requests.push({ body, auth: req.headers.authorization });
    if (req.headers.authorization !== `Bearer ${PROVIDER_KEY}`) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `bad key ${req.headers.authorization}` } }));
      return;
    }
    const model = body.model as string;
    const usage = { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49, prompt_cache_hit_tokens: 10, prompt_cache_miss_tokens: 32 };
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const content of ["Po", "li", "cy"]) {
        res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model, choices: [], usage })}\n\n`);
      res.end("data: [DONE]\n\n");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "c1",
        object: "chat.completion",
        created: 1,
        model,
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "Policy" } }],
        usage,
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { baseURL: `http://127.0.0.1:${port}`, requests, close: () => new Promise((r) => server.close(() => r())) };
}

// --- chain setup ---

export interface World {
  url: string;
  pub: PublicClient;
  test: ReturnType<typeof createTestClient>;
  routerAccount: PrivateKeyAccount;
  owner: PrivateKeyAccount;
  registry: Address;
  escrow: Address;
  cheapOnlyId: bigint;
  registryAbi: Abi;
  escrowAbi: Abi;
  send: (account: PrivateKeyAccount, address: Address, abi: Abi, functionName: string, args: unknown[], value?: bigint) => Promise<unknown>;
}

export async function setupWorld(url: string): Promise<World> {
  const pub = createPublicClient({ transport: http(url) }) as PublicClient;
  const test = createTestClient({ mode: "anvil", transport: http(url) });
  // fresh accounts: anvil's default accounts have contract code on X Layer
  const routerAccount = privateKeyToAccount(generatePrivateKey());
  const owner = privateKeyToAccount(generatePrivateKey());
  for (const a of [routerAccount, owner]) await test.setBalance({ address: a.address, value: parseEther("100") });

  const send: World["send"] = async (account, address, abi, functionName, args, value) => {
    const wallet = createWalletClient({ account, transport: http(url) });
    const { request, result } = await pub.simulateContract({ account, address, abi, functionName, args, value } as never);
    const hash = await wallet.writeContract(request as never);
    const rcpt = await pub.waitForTransactionReceipt({ hash });
    if (rcpt.status !== "success") throw new Error(`${functionName} failed`);
    return result;
  };

  const deploy = async (name: string, args: unknown[]) => {
    const a = artifact(name);
    const wallet = createWalletClient({ account: owner, transport: http(url) });
    const hash = await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args, chain: null } as never);
    const rcpt = await pub.waitForTransactionReceipt({ hash });
    return { address: rcpt.contractAddress!, abi: a.abi };
  };

  const registry = await deploy("PolicyRegistry", [POLICYROUTER.processor]);
  const escrow = await deploy("CreditEscrow", [registry.address, routerAccount.address, owner.address]);

  // tape out Cheap Only on the live processor (fork only)
  const cheap = JSON.parse(readFileSync(new URL("circuits/cheap-only.json", ROOT), "utf8")) as CircuitArtifact;
  const price = await pub.readContract({ address: POLICYROUTER.transistors, abi: transistorsAbi, functionName: "mintPrice" });
  const protocolFee = await pub.readContract({ address: "0x1f09DAeFA827f02CBb40967cc91b259763760761", abi: factoryAbi, functionName: "protocolFee" });
  await send(owner, POLICYROUTER.transistors, transistorsAbi, "mint", [0n, BigInt(cheap.gateCount)], price * BigInt(cheap.gateCount) + protocolFee);
  const fee = await pub.readContract({ address: POLICYROUTER.processor, abi: processorAbi, functionName: "TAPEOUT_FEE" });
  const cheapOnlyId = (await send(owner, POLICYROUTER.processor, processorAbi, "tapeout", [cheap.netlist, cheap.nIn, cheap.nOut], fee)) as bigint;

  return {
    url,
    pub,
    test,
    routerAccount,
    owner,
    registry: registry.address,
    escrow: escrow.address,
    cheapOnlyId,
    registryAbi: registry.abi,
    escrowAbi: escrow.abi,
    send,
  };
}

/** A real router wired to the fork and the mock provider. */
export function startRouter(w: World, provider: MockProvider, opts: { rpcUrl?: string } = {}) {
  const lines: string[] = [];
  const store = new Store(":memory:");
  const domain = receiptDomain(196, w.escrow);
  const app = createApp({
    catalog: loadCatalog(),
    chain: createChainReader({
      rpcUrl: opts.rpcUrl ?? w.url,
      processor: POLICYROUTER.processor,
      registry: w.registry,
      escrow: w.escrow,
      blockCacheMs: 0,
      timeoutMs: 3000,
    }),
    providers: { deepseek: createOpenAICompatibleProvider({ name: "deepseek", baseURL: provider.baseURL, apiKey: PROVIDER_KEY }) },
    signer: createReceiptSigner(w.routerAccount, domain),
    store,
    limiter: new RateLimiter(1000),
    price: staticPriceFeed("122.09"),
    log: createLogger([PROVIDER_KEY], (l) => lines.push(l)),
  });
  return { app, store, lines, domain };
}

export const processorEvalAbi = processorAbi;
