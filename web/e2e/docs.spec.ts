// The docs site in a real browser: no wallet, no chain.

import { expect, test } from "@playwright/test";

test.describe("docs", () => {
  test("opens at /docs, navigates between pages without a reload, and keeps the URL in sync", async ({ page }) => {
    await page.goto("/docs");
    await expect(page.getByRole("heading", { level: 1, name: "PolicyRouter" })).toBeVisible();

    await page.evaluate(() => ((window as unknown as { __marker: number }).__marker = 1));
    await page.getByRole("complementary", { name: "Documentation" }).getByRole("link", { name: "Quickstart" }).click();
    await expect(page).toHaveURL(/\/docs\/guide\/quickstart$/);
    await expect(page.getByRole("heading", { level: 1, name: "Quickstart" })).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __marker?: number }).__marker)).toBe(1); // no reload

    await page.getByTestId("docs-next").click();
    await expect(page.getByRole("heading", { level: 1, name: "The owner app" })).toBeVisible();
    await page.goBack();
    await expect(page.getByRole("heading", { level: 1, name: "Quickstart" })).toBeVisible();
  });

  test("a deep link with an anchor scrolls to its heading", async ({ page }) => {
    await page.goto("/docs/guide/owner-app#rotating-a-key");
    const heading = page.locator("#rotating-a-key");
    await expect(heading).toBeInViewport();
  });

  test("search finds pages and opens one", async ({ page }) => {
    await page.goto("/docs");
    await page.getByTestId("docs-search").fill("withdraw");
    const results = page.getByTestId("docs-results");
    await expect(results).toContainText("The owner app");
    await results.getByRole("link", { name: /The owner app/ }).click();
    await expect(page).toHaveURL(/\/docs\/guide\/owner-app$/);
    await expect(page.getByTestId("docs-results")).toHaveCount(0);
  });

  test("links out of the docs: the Verify page and the repository", async ({ page }) => {
    await page.goto("/docs/guide/receipts-and-verification");
    await page.getByRole("article").getByRole("link", { name: "/verify" }).first().click();
    await expect(page.getByRole("heading", { level: 1, name: "Verify a receipt" })).toBeVisible();

    await page.goto("/docs/deployments");
    const repoLink = page.getByRole("link", { name: "PolicyTreasury.sol" }).first();
    await expect(repoLink).toHaveAttribute("href", /github\.com\/Len3hq\/policyrouter\/blob\/main\/contracts\/src\/PolicyTreasury\.sol/);
  });

  test("the example receipt in the docs is valid JSON in the shape the Verify page accepts", async ({ page }) => {
    // It is a real mainnet receipt. Whether it verifies is checked against mainnet by hand (this harness
    // points the app at a fork with its own escrow), so here we only check it's well formed.
    await page.goto("/docs/guide/receipts-and-verification");
    const json = JSON.parse((await page.locator("pre[data-lang='json'] code").last().textContent())!);
    expect(json.receipt.routerSig).toMatch(/^0x[0-9a-f]+$/);
    expect(json.settlement).toMatchObject({ batchId: 0, status: "confirmed" });
    expect(json.settlement.proof).toHaveLength(2);
  });

  test("on a phone the menu opens, and nothing overflows sideways", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
    const page = await ctx.newPage();
    await page.goto("http://localhost:5174/docs/guide/quickstart");
    await expect(page.getByRole("heading", { level: 1, name: "Quickstart" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(page.getByTestId("docs-search")).toBeHidden();
    await page.getByTestId("docs-menu").click();
    await expect(page.getByTestId("docs-search")).toBeVisible();
    await page.getByRole("complementary", { name: "Documentation" }).getByRole("link", { name: "Policy circuits" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Policy circuits" })).toBeVisible();
    await expect(page.getByTestId("docs-search")).toBeHidden(); // menu closes after choosing
    await ctx.close();
  });
});
