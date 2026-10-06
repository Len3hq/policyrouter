// The owner flow end to end: web app → test wallet → contracts on a mainnet fork → router.

import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { createTestClient, createWalletClient, http, keccak256, parseEther, toHex, type Address } from "viem";
import type { E2EState } from "./global-setup.ts";

const state = () => JSON.parse(readFileSync(new URL("../test-results/e2e-env/state.json", import.meta.url), "utf8")) as E2EState;

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
  { type: "function", name: "router", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

/** What an agent does: one chat completion through the router with its key. */
async function agentRequest(key: string, model = "cheap") {
  const res = await fetch(`${state().routerUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, max_tokens: 50, messages: [{ role: "user", content: "hi" }] }),
  });
  return { status: res.status, body: (await res.json()) as { error?: { code: string }; model?: string } };
}

async function connect(page: Page, query = "") {
  await page.goto(`/${query}`);
  await page.getByTestId("connect").click();
  await expect(page.getByTestId("account")).toBeVisible();
}

test.describe.serial("owner flow", () => {
  let apiKey = "";
  let agentId = 0n;

  test("connect → create agent → save key → pick Cheap Only → dashboard shows policy and balance", async ({ page }) => {
    await connect(page);

    // a new wallet has no agents, so the create form opens
    await expect(page.getByRole("heading", { name: "New agent" })).toBeVisible();
    await page.getByTestId("create-cap").fill("0.001");
    await page.getByTestId("create-deposit").fill("0.002");
    await page.getByTestId("create-submit").click();

    // the key is shown once
    const keyEl = page.getByTestId("api-key");
    await expect(keyEl).toBeVisible({ timeout: 60_000 });
    apiKey = (await keyEl.textContent())!.trim();
    expect(apiKey).toMatch(/^pr-live-[0-9a-f]{48}$/);
    await page.getByTestId("key-saved").click();
    await expect(page.getByTestId("api-key")).toHaveCount(0);

    // dashboard: Budget Guard (the default), funded
    await expect(page.getByTestId("balance")).toHaveText("0.002 OKB");
    await expect(page.getByTestId("agent-status")).toHaveText("Active");
    const heading = await page.getByRole("heading", { level: 2 }).filter({ hasText: "Agent #" }).first().textContent();
    agentId = BigInt(/Agent #(\d+)/.exec(heading!)![1]!);
    await expect(page.getByTestId("policy-budget-guard").getByTestId("current-policy")).toBeVisible();

    // the simulation panel is there for each policy (sample workload: no history yet)
    await expect(page.getByTestId("policy-cheap-only").getByTestId("sim-cheap-only")).toContainText("sample workload");

    // pick Cheap Only
    await page.getByTestId("use-policy-cheap-only").click();
    await expect(page.getByTestId("policy-cheap-only").getByTestId("current-policy")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId(`agent-${agentId}`)).toContainText("Cheap Only");

    // the key works through the router, and Cheap Only downgrades a frontier request
    const r = await agentRequest(apiKey, "frontier");
    expect(r.status).toBe(200);
    expect(r.body.model).toBe("standard");

    // the dashboard counts it
    await page.getByTestId("refresh").click();
    await expect(page.getByTestId("usage-downgraded")).toHaveText("1");
    await expect(page.getByTestId("quickstart-env")).toContainText(apiKey);
    await page.screenshot({ path: "test-results/screens/dashboard.png", fullPage: true });
  });

  test("custom policy: a rule equal to a template reuses its circuit; a new rule is taped out, used, and enforced", async ({ page }) => {
    await connect(page);
    await page.getByTestId(`agent-${agentId}`).click();
    const builder = page.getByTestId("builder");

    // standard + downgrade + large = Strict: no tape-out, just point at circuit 4
    await builder.getByTestId("b-tier-standard").check();
    await builder.getByTestId("b-over-downgrade").check();
    await builder.getByTestId("b-size-large").check();
    await expect(builder.getByTestId("builder-cost")).toContainText("This is Strict, already on chain as circuit #4");
    await expect(builder.getByTestId("builder-apply")).toHaveText("Use circuit #4");

    // premium, downgrade above it, nothing larger than large: a new circuit
    await builder.getByTestId("b-tier-premium").check();
    await expect(builder.getByTestId("builder-rule")).toHaveText(
      "Budget Guard, and any tier above premium is downgraded to premium, and requests larger than large are denied.",
    );
    await expect(builder.getByTestId("builder-grid")).toContainText("→ premium");
    await expect(builder.getByTestId("builder-cost")).toContainText("14 NAND gates");
    await expect(builder.getByTestId("builder-apply")).toHaveText("Tape out and use this policy");
    await builder.getByTestId("builder-apply").click();

    // three transactions later the agent is on the new circuit
    await expect(page.getByRole("heading", { level: 2 }).filter({ hasText: "Agent #" })).toContainText("custom policy (circuit #", { timeout: 90_000 });
    const heading = await page.getByRole("heading", { level: 2 }).filter({ hasText: "Agent #" }).textContent();
    const circuitId = Number(/circuit #(\d+)/.exec(heading!)![1]);
    expect(circuitId).toBeGreaterThan(4);

    // and the router enforces it: frontier is served as premium, a huge request is denied
    const served = await agentRequest(apiKey, "frontier");
    expect(served.status).toBe(200);
    expect(served.body.model).toBe("premium");
    const res = await fetch(`${state().routerUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: "cheap", max_tokens: 60_000, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(403);

    // choosing the same rule again finds the circuit just taped out instead of taping out a second one
    await page.reload();
    await page.getByTestId("connect").click();
    await page.getByTestId(`agent-${agentId}`).click();
    await page.getByTestId("b-tier-premium").check();
    await page.getByTestId("b-size-large").check();
    await expect(page.getByTestId("builder-apply")).toHaveText("Already this agent's policy");
  });

  test("kill switch on the dashboard → requests are refused (403) → off → served again", async ({ page }) => {
    await connect(page);
    await page.getByTestId(`agent-${agentId}`).click();

    await page.getByTestId("kill-toggle").click();
    await expect(page.getByTestId("agent-status")).toHaveText("Killed", { timeout: 60_000 });
    const denied = await agentRequest(apiKey);
    expect(denied.status).toBe(403);
    expect(denied.body.error?.code).toBe("policy_denied");

    await page.getByTestId("kill-toggle").click();
    await expect(page.getByTestId("agent-status")).toHaveText("Active", { timeout: 60_000 });
    expect((await agentRequest(apiKey)).status).toBe(200);
  });

  test("lowering the cap below today's spend → next request denied, and the deny count goes up", async ({ page }) => {
    const s = state();
    // settle some spend for the agent, as the router's settler would (the escrow only accepts its router)
    const testClient = createTestClient({ mode: "anvil", transport: http(s.rpcUrl) });
    const read = createWalletClient({ transport: http(s.rpcUrl) });
    const pub = (await import("viem")).createPublicClient({ transport: http(s.rpcUrl) });
    const router = (await pub.readContract({ address: s.escrow, abi: escrowAbi, functionName: "router" })) as Address;
    await testClient.impersonateAccount({ address: router });
    await testClient.setBalance({ address: router, value: parseEther("1") });
    const batchId = await pub.readContract({ address: s.escrow, abi: escrowAbi, functionName: "nextBatchId" });
    const hash = await read.writeContract({
      account: router,
      chain: null,
      address: s.escrow,
      abi: escrowAbi,
      functionName: "settle",
      args: [batchId, keccak256(toHex("e2e")), [{ agentId, cost: parseEther("0.0005") }]],
    });
    await pub.waitForTransactionReceipt({ hash });

    await connect(page);
    await page.getByTestId(`agent-${agentId}`).click();
    await expect(page.getByTestId("spent-today")).toContainText("0.0005 /");

    // a new browser session doesn't have the key: the owner pastes it to see usage (a wrong key is refused)
    await page.getByTestId("unlock-input").fill(`pr-live-${"0".repeat(48)}`);
    await page.getByTestId("unlock-submit").click();
    await expect(page.getByRole("alert")).toContainText("isn't this agent's key");
    await page.getByTestId("unlock-input").fill(apiKey);
    await page.getByTestId("unlock-submit").click();
    await expect(page.getByTestId("usage-denied")).toBeVisible();
    const deniedBefore = Number(await page.getByTestId("usage-denied").textContent());

    await page.getByTestId("cap-input").fill("0.0004");
    await page.getByTestId("cap-submit").click();
    await expect(page.getByTestId("agent-status")).toHaveText("Over today's cap", { timeout: 60_000 });

    const r = await agentRequest(apiKey);
    expect(r.status).toBe(403);
    await page.getByTestId("refresh").click();
    await expect(page.getByTestId("usage-denied")).toHaveText(String(deniedBefore + 1));
  });

  test("wrong network → the app asks to switch to X Layer, and switching clears it", async ({ page }) => {
    await connect(page, "?testChainId=1");
    await expect(page.getByTestId("wrong-network")).toBeVisible();
    await expect(page.getByTestId("wrong-network")).toContainText("chain 1");
    await page.getByTestId("switch-network").click();
    await expect(page.getByTestId("wrong-network")).toHaveCount(0);
    await expect(page.getByTestId(`agent-${agentId}`)).toBeVisible();
  });

  test("without a wallet, the landing page shows the quickstart, the policies with a sample simulation, and transistor facts", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByTestId("quickstart-env")).toContainText("OPENAI_BASE_URL=");
    for (const id of ["budget-guard", "cheap-only", "small-requests", "strict"]) {
      await expect(page.getByTestId(`sim-${id}`)).toBeVisible();
    }
    await expect(page.getByTestId("transistor-facts")).toContainText("supply cap 1,000,000");
    await page.screenshot({ path: "test-results/screens/landing.png", fullPage: true });
  });
});
