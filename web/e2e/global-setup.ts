// Starts everything the owner flow needs, against a fork of X Layer mainnet where the real
// PolicyRegistry, CreditEscrow, processor and circuits 1-4 already exist:
//   anvil (fork)  →  mock OpenAI-compatible provider  →  the real router process  →  the web app (Vite)
// The web app uses its built-in test wallet with a fresh, funded key. Nothing touches mainnet.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createPublicClient, createTestClient, createWalletClient, http, parseEther, type Abi, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { POLICYROUTER } from "@policyrouter/policy";

export const PORTS = { anvil: 8560, provider: 8561, router: 8562, web: 5174 } as const;
const ROOT = new URL("../../", import.meta.url).pathname;
const OUT = new URL("../test-results/e2e-env/", import.meta.url).pathname;

export interface E2EState {
  rpcUrl: string;
  /** PolicyRegistry and CreditEscrow deployed fresh on the fork, with the e2e router as CreditEscrow.router */
  registry: `0x${string}`;
  escrow: `0x${string}`;
  /** The router's environment, so tests can run its CLIs (e.g. settle) against the same database */
  routerEnv: Record<string, string>;
  routerUrl: string;
  webUrl: string;
  walletKey: `0x${string}`;
  walletAddress: `0x${string}`;
  pids: number[];
}

async function waitFor(check: () => Promise<boolean>, what: string, timeoutMs = 90_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (await check()) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`${what} did not start within ${timeoutMs / 1000}s (logs in ${OUT})`);
}

function start(name: string, cmd: string, args: string[], cwd: string, env: Record<string, string>): ChildProcess {
  const log = openSync(`${OUT}${name}.log`, "w");
  return spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", log, log], detached: false });
}

export default async function globalSetup() {
  mkdirSync(OUT, { recursive: true });
  const rpcUrl = `http://127.0.0.1:${PORTS.anvil}`;
  const routerUrl = `http://127.0.0.1:${PORTS.router}`;
  const webUrl = `http://localhost:${PORTS.web}`;
  const pids: number[] = [];

  // 1. anvil fork of mainnet
  const anvil = start("anvil", "anvil", ["--fork-url", process.env.XLAYER_RPC_URL || "https://rpc.xlayer.tech", "--port", String(PORTS.anvil), "--silent"], ROOT, {});
  pids.push(anvil.pid!);
  const pub = createPublicClient({ transport: http(rpcUrl) });
  await waitFor(async () => (await pub.getChainId()) === 196, "anvil");

  // 2. the test wallet: a fresh key with 10 OKB on the fork
  const walletKey = generatePrivateKey();
  const walletAddress = privateKeyToAccount(walletKey).address;
  await createTestClient({ mode: "anvil", transport: http(rpcUrl) }).setBalance({ address: walletAddress, value: parseEther("10") });

  // 3. a fresh PolicyRegistry and CreditEscrow on the fork, bound to the live processor and circuits,
  //    whose router is this run's router key: receipts then verify, and the real settler can settle.
  const routerKey = generatePrivateKey();
  const routerAddress = privateKeyToAccount(routerKey).address;
  await createTestClient({ mode: "anvil", transport: http(rpcUrl) }).setBalance({ address: routerAddress, value: parseEther("1") });
  const deployer = createWalletClient({ account: privateKeyToAccount(walletKey), transport: http(rpcUrl) });
  const deploy = async (name: string, args: unknown[]) => {
    const a = JSON.parse(readFileSync(`${ROOT}contracts/out/${name}.sol/${name}.json`, "utf8")) as { abi: Abi; bytecode: { object: Hex } };
    const hash = await deployer.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args, chain: null } as never);
    return (await pub.waitForTransactionReceipt({ hash })).contractAddress!;
  };
  const registry = await deploy("PolicyRegistry", [POLICYROUTER.processor]);
  const escrow = await deploy("CreditEscrow", [registry, routerAddress, walletAddress]);

  // 4. mock provider (stands in for DeepSeek)
  await new Promise<void>((resolve) => {
    createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        const { model } = JSON.parse(body || "{}") as { model?: string };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "e2e",
            object: "chat.completion",
            created: 1,
            model,
            choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: `hello from ${model}` } }],
            usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
          }),
        );
      });
    })
      .listen(PORTS.provider, "127.0.0.1", resolve)
      .unref();
  });

  // 5. the real router process. Every setting is explicit, so nothing comes from the repo's .env.
  const routerEnv: Record<string, string> = {
    PORT: String(PORTS.router),
    XLAYER_RPC_URL: rpcUrl,
    CHAIN_ID: "196",
    PROCESSOR_ADDRESS: POLICYROUTER.processor,
    POLICY_REGISTRY_ADDRESS: registry,
    CREDIT_ESCROW_ADDRESS: escrow,
    ROUTER_ADDRESS: routerAddress,
    ROUTER_URL: routerUrl,
    ROUTER_PRIVATE_KEY: routerKey,
    DEEPSEEK_API_KEY: "sk-e2e-not-a-real-key-000000",
    DEEPSEEK_BASE_URL: `http://127.0.0.1:${PORTS.provider}`,
    DATABASE_PATH: `${OUT}router.sqlite`,
    PRICE_STATIC_USD: "122",
    PRICE_SOURCES: "coingecko",
    SETTLE_INTERVAL_MS: "0",
    BLOCK_CACHE_MS: "0",
    RATE_LIMIT_PER_MINUTE: "1000",
    CORS_ORIGINS: "",
  };
  const router = start("router", `${ROOT}router/node_modules/.bin/tsx`, ["src/server.ts"], `${ROOT}router`, routerEnv);
  pids.push(router.pid!);
  await waitFor(async () => (await fetch(`${routerUrl}/health`)).ok, "router");

  // 6. the web app with the test wallet
  const web = start("web", `${ROOT}web/node_modules/.bin/vite`, ["--port", String(PORTS.web), "--strictPort"], `${ROOT}web`, {
    VITE_ROUTER_URL: routerUrl,
    VITE_RPC_URL: rpcUrl,
    VITE_TEST_WALLET_KEY: walletKey,
    VITE_REGISTRY_ADDRESS: registry,
    VITE_ESCROW_ADDRESS: escrow,
  });
  pids.push(web.pid!);
  await waitFor(async () => (await fetch(webUrl)).ok, "web app");

  const state: E2EState = { rpcUrl, registry, escrow, routerEnv, routerUrl, webUrl, walletKey, walletAddress, pids };
  writeFileSync(`${OUT}state.json`, JSON.stringify(state, null, 2));
  process.env.E2E_STATE = `${OUT}state.json`;
}
