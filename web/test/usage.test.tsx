import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReceiptsPanel } from "../src/components/ReceiptsPanel.tsx";
import { UsagePanel } from "../src/components/UsagePanel.tsx";
import { emptyHistory, type History, type HistoryReceipt } from "../src/lib/api.ts";

const DAY = 86_400_000;
const start = Date.UTC(2026, 9, 1);

const receipt = (i: number, decision: HistoryReceipt["decision"]): HistoryReceipt => ({
  requestId: `0x${i.toString(16).padStart(64, "0")}`,
  createdAt: start + 2 * DAY + i * 1000,
  modelRequested: decision === "downgraded" ? "frontier" : "cheap",
  modelServed: decision === "downgraded" ? "standard" : "cheap",
  decision,
  costWei: decision === "denied" ? "0" : "100000000000000",
  promptTokens: 100,
  completionTokens: 50,
  settled: i === 1,
});

const history: History = {
  agentId: "3",
  range: "7d",
  bucketMs: DAY,
  totals: { requests: 4, allowed: 2, downgraded: 1, denied: 1, spentWei: "300000000000000", unsettledWei: "200000000000000", promptTokens: 400, completionTokens: 200 },
  series: [0, 1, 2].map((d) => ({
    start: start + d * DAY,
    allowed: d === 2 ? 2 : 0,
    downgraded: d === 2 ? 1 : 0,
    denied: d === 2 ? 1 : 0,
    spentWei: d === 2 ? "300000000000000" : "0",
    promptTokens: d === 2 ? 400 : 0,
    completionTokens: d === 2 ? 200 : 0,
  })),
  byModel: [
    { model: "cheap", requests: 2, spentWei: "200000000000000", tokens: 300 },
    { model: "standard", requests: 1, spentWei: "100000000000000", tokens: 150 },
  ],
  receipts: [receipt(4, "denied"), receipt(3, "downgraded"), receipt(2, "allowed"), receipt(1, "allowed")],
};

afterEach(() => vi.unstubAllGlobals());

describe("UsagePanel", () => {
  it("shows the range totals, a bar per day, and spend by model", () => {
    render(<UsagePanel history={history} stale={false} />);
    expect(screen.getByTestId("usage-requests")).toHaveTextContent("4");
    expect(screen.getByTestId("usage-allowed")).toHaveTextContent("2");
    expect(screen.getByTestId("usage-downgraded")).toHaveTextContent("1");
    expect(screen.getByTestId("usage-denied")).toHaveTextContent("1");
    expect(screen.getByTestId("usage-spend")).toHaveTextContent("0.0003");
    expect(screen.getByTestId("usage-tokens")).toHaveTextContent("600");
    expect(screen.getByRole("img", { name: /Requests per day/ })).toBeInTheDocument();
    // one hover target per day, and the data table has a row per day
    expect(document.querySelectorAll(".viz-hit")).toHaveLength(3);
    expect(screen.getByText("Show as a table").closest("details")!.querySelectorAll("tbody tr")).toHaveLength(3);
    expect(screen.getByText("standard")).toBeInTheDocument();
  });

  it("shows a tooltip for the bar under the pointer or keyboard focus", async () => {
    render(<UsagePanel history={history} stale={false} />);
    const chart = screen.getByRole("img", { name: /Requests per day/ });
    chart.focus();
    await userEvent.keyboard("{ArrowLeft}");
    const tip = document.querySelector(".viz-tooltip") as HTMLElement;
    expect(tip).toHaveTextContent("Oct 3");
    expect(within(tip).getByText("Denied").previousSibling).toHaveTextContent("1");
  });
});

describe("empty dashboard", () => {
  it("emptyHistory buckets like the router: 24 or 25 hours, 7 or 8 days, all zero", () => {
    const now = Date.UTC(2026, 9, 6, 15, 30);
    const day = emptyHistory("24h", now);
    expect(day.bucketMs).toBe(3_600_000);
    expect(day.series).toHaveLength(25);
    expect(day.series.at(-1)!.start).toBe(Date.UTC(2026, 9, 6, 15));
    expect(emptyHistory("7d", now).series).toHaveLength(8);
    expect(emptyHistory("90d", now).totals.requests).toBe(0);
  });

  it("renders the charts with zeros and says there's nothing yet", () => {
    render(<UsagePanel history={emptyHistory("7d")} stale={false} />);
    expect(screen.getByTestId("usage-requests")).toHaveTextContent("0");
    expect(screen.getByText("No requests in this range yet")).toBeInTheDocument();
    expect(screen.getByText("No spend in this range yet")).toBeInTheDocument();
    expect(screen.queryByText("0.5")).not.toBeInTheDocument(); // request axis stays whole numbers
  });

  it("the receipts tab explains where receipts come from", () => {
    render(<ReceiptsPanel receipts={[]} total={0} stale={false} />);
    expect(screen.getByTestId("receipts-empty")).toHaveTextContent("No receipts yet");
  });
});

describe("ReceiptsPanel", () => {
  it("filters by decision and verifies the receipt that was clicked", async () => {
    const fetch = vi.fn(async () => new Response("{}", { status: 404 }));
    vi.stubGlobal("fetch", fetch);
    render(<ReceiptsPanel receipts={history.receipts} total={4} stale={false} />);
    const rows = () => screen.getByTestId("receipts").querySelectorAll("tbody tr");
    expect(rows()).toHaveLength(4);

    await userEvent.click(screen.getByTestId("receipts-filter-denied"));
    expect(rows()).toHaveLength(1);
    await userEvent.click(screen.getByTestId("receipts-filter-downgraded"));
    expect(screen.getByTestId("receipts")).toHaveTextContent("frontier → standard");

    await userEvent.click(screen.getByTestId("verify-link"));
    expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/\/v1\/receipts\/0x0{63}3$/));
    expect(await screen.findByRole("alert")).toHaveTextContent("The router has no receipt with that id.");
    await userEvent.click(screen.getByTestId("receipt-close"));
    expect(screen.queryByTestId("receipt-check")).not.toBeInTheDocument();
  });
});
