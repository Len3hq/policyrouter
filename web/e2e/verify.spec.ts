// The Verify page, with no wallet: real receipts from the real router on a mainnet fork, settled by
// the real settler, then checked by the page against the chain. Tampered receipts must fail the
// right check.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { createPublicClient, createWalletClient, http, keccak256, stringToBytes, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { POLICYROUTER, receiptDomain, receiptFromJson, receiptToJson, typedReceipt, type ReceiptJson } from "@policyrouter/policy";
import type { E2EState } from "./global-setup.ts";

const state = () => JSON.parse(readFileSync(new URL("../test-results/e2e-env/state.json", import.meta.url), "utf8")) as E2EState;
const ROOT = new URL("../../", import.meta.url).pathname;

const registryAbi = [
  {
    type: "function",
    name: "registerAgent",
    stateMutability: "nonpayable",
    inputs: [{ type: "bytes32" }, { type: "uint256" }, { type: "uint128" }],
    outputs: [{ type: "uint256" }],
  },
  { type: "function", name: "agentOf", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "setKill", stateMutability: "nonpayable", inputs: [{ type: "uint256" }, { type: "bool" }], outputs: [] },
] as const;
const escrowAbi = [{ type: "function", name: "deposit", stateMutability: "payable", inputs: [{ type: "uint256" }], outputs: [] }] as const;

interface ReceiptResponse {
  receipt: ReceiptJson;
  receiptHash: Hex;
  settlement: { batchId: number; status: string; root: Hex; proof: Hex[]; txHash: Hex } | null;
}

async function chat(key: string, model = "cheap") {
  const res = await fetch(`${state().routerUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, max_tokens: 50, messages: [{ role: "user", content: "hi" }] }),
  });
  return ((await res.json()) as { policyrouter_receipt: ReceiptJson }).policyrouter_receipt;
}

const fetchReceipt = async (id: string) => (await (await fetch(`${state().routerUrl}/v1/receipts/${id}`)).json()) as ReceiptResponse;

async function verifyPasted(page: Page, json: unknown) {
  await page.goto("/verify");
  await page.getByText("…or paste a receipt").click();
  await page.getByTestId("verify-paste").fill(JSON.stringify(json));
  await page.getByTestId("verify-paste-submit").click();
  await expect(page.getByTestId("verdict")).toBeVisible();
}

const status = (page: Page, check: string) => page.getByTestId(`check-${check}`).getAttribute("data-status");

test.describe.serial("verify page (no wallet)", () => {
  let allowedId = "";
  let deniedId = "";
  let unsettledId = "";

  test.beforeAll(async () => {
    const s = state();
    const owner = privateKeyToAccount(s.walletKey);
    const wallet = createWalletClient({ account: owner, transport: http(s.rpcUrl) });
    const pub = createPublicClient({ transport: http(s.rpcUrl) });
    const send = async (address: Hex, abi: readonly unknown[], functionName: string, args: unknown[], value?: bigint) =>
      pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address, abi, functionName, args, value, chain: null } as never) });

    // an agent on the live Cheap Only circuit, funded
    const key = `pr-live-${Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, "0")).join("")}`;
    const keyHash = keccak256(stringToBytes(key));
    await send(s.registry, registryAbi, "registerAgent", [keyHash, POLICYROUTER.circuits["cheap-only"], 10n ** 16n]);
    const agentId = await pub.readContract({ address: s.registry, abi: registryAbi, functionName: "agentOf", args: [keyHash] });
    await send(s.escrow, escrowAbi, "deposit", [agentId], 10n ** 16n);

    allowedId = (await chat(key, "frontier")).requestId; // downgraded to standard
    await send(s.registry, registryAbi, "setKill", [agentId, true]);
    deniedId = (await chat(key)).requestId;
    await send(s.registry, registryAbi, "setKill", [agentId, false]);

    // the router's own settler posts the batch
    execFileSync(`${ROOT}router/node_modules/.bin/tsx`, ["src/cli/settle.ts"], { cwd: `${ROOT}router`, env: { ...process.env, ...s.routerEnv } });
    expect((await fetchReceipt(allowedId)).settlement?.status).toBe("confirmed");

    unsettledId = (await chat(key)).requestId; // after the batch: not settled
  });

  test("a settled allow receipt opened by id is green on every check", async ({ page }) => {
    await page.goto(`/verify?id=${allowedId}`);
    await expect(page.getByTestId("verdict")).toHaveAttribute("data-verdict", "verified");
    for (const c of ["signature", "inputs", "policy", "settlement"]) expect(await status(page, c)).toBe("pass");
    await expect(page.getByTestId("decision")).toHaveText("Allowed: frontier → served as standard");

    // re-run it yourself: the exact eval call at the receipt's block
    await page.getByTestId("check-policy").getByText("Re-run this yourself").click();
    await expect(page.getByTestId("check-policy").locator("pre")).toContainText(`cast call ${POLICYROUTER.processor} "eval(uint256,bytes)(bytes)" ${POLICYROUTER.circuits["cheap-only"]} 0x13 --block`);
  });

  test("a deny receipt is green: the policy check proves the deny was right", async ({ page }) => {
    await page.goto(`/verify?id=${deniedId}`);
    await expect(page.getByTestId("verdict")).toHaveAttribute("data-verdict", "verified");
    await expect(page.getByTestId("decision")).toHaveText("Denied: cheap was refused");
    await expect(page.getByTestId("check-inputs")).toContainText("kill switch on");
  });

  test("changed outputBits → the policy check fails", async ({ page }) => {
    const r = await fetchReceipt(allowedId);
    await verifyPasted(page, { ...r, receipt: { ...r.receipt, outputBits: "0b111" } });
    await expect(page.getByTestId("verdict")).toHaveAttribute("data-verdict", "failed");
    expect(await status(page, "policy")).toBe("fail");
    await expect(page.getByTestId("verdict")).toContainText("policy decision");
  });

  test("changed costWei → the signature check fails, the policy still holds", async ({ page }) => {
    const r = await fetchReceipt(allowedId);
    await verifyPasted(page, { ...r, receipt: { ...r.receipt, costWei: "1" } });
    expect(await status(page, "signature")).toBe("fail");
    expect(await status(page, "policy")).toBe("pass");
  });

  test("a receipt re-signed with another key → the signature check fails", async ({ page }) => {
    const r = await fetchReceipt(allowedId);
    const receipt = receiptFromJson(r.receipt);
    const impostor = privateKeyToAccount(generatePrivateKey());
    const routerSig = await impostor.signTypedData(typedReceipt(receipt, receiptDomain(196, state().escrow)));
    await verifyPasted(page, { ...r, receipt: receiptToJson({ ...receipt, routerSig }) });
    expect(await status(page, "signature")).toBe("fail");
    await expect(page.getByTestId("check-signature")).toContainText(impostor.address);
    expect(await status(page, "settlement")).toBe("pass"); // same signed fields, same leaf
  });

  test("a valid receipt with a wrong proof → the settlement check fails", async ({ page }) => {
    const r = await fetchReceipt(allowedId);
    await verifyPasted(page, { ...r, settlement: { ...r.settlement!, proof: [`0x${"00".repeat(32)}`] } });
    expect(await status(page, "settlement")).toBe("fail");
    for (const c of ["signature", "inputs", "policy"]) expect(await status(page, c)).toBe("pass");
  });

  test("an unsettled receipt shows settlement pending, not failed", async ({ page }) => {
    await page.goto(`/verify?id=${unsettledId}`);
    await expect(page.getByTestId("verdict")).toHaveAttribute("data-verdict", "pending");
    expect(await status(page, "settlement")).toBe("pending");
    for (const c of ["signature", "inputs", "policy"]) expect(await status(page, c)).toBe("pass");
  });

  test("bad input is explained", async ({ page }) => {
    await page.goto("/verify");
    await page.getByTestId("verify-id").fill(`0x${"00".repeat(32)}`);
    await page.getByTestId("verify-id-submit").click();
    await expect(page.getByRole("alert")).toContainText("no receipt with that id");
  });
});
