import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { parseEther } from "viem";
import { sessionKey } from "../src/lib/api.ts";
import type { Wallet } from "../src/lib/wallet.ts";

// A funded project: deposited 0.002, 0.0003 settled → 0.0017 on chain; 0.0001 used but not settled.
vi.mock("../src/lib/chain.ts", async (orig) => ({
  ...(await orig<typeof import("../src/lib/chain.ts")>()),
  readAgent: vi.fn(async (agentId: bigint) => ({
    agentId,
    owner: "0x5b38da6a701c568545dcfcb03fcb875f56beddc4",
    circuitId: 2n,
    killed: false,
    dailyCap: parseEther("0.001"),
    keyHash: "0x" + "ab".repeat(32),
    balance: parseEther("0.0017"),
    spentToday: parseEther("0.0003"),
    budgetOk: true,
  })),
}));
vi.mock("../src/lib/api.ts", async (orig) => {
  const real = await orig<typeof import("../src/lib/api.ts")>();
  return {
    ...real,
    api: {
      ...real.api,
      simulate: vi.fn(async () => ({ source: "sample", requests: 20, results: [] })),
      history: vi.fn(async () => ({ ...real.emptyHistory("7d"), pendingWei: parseEther("0.0001").toString() })),
    },
  };
});

const { Dashboard } = await import("../src/components/Dashboard.tsx");

function wallet(): Wallet {
  return {
    provider: undefined,
    address: "0x5b38da6a701c568545dcfcb03fcb875f56beddc4",
    chainId: 196,
    wrongNetwork: false,
    error: undefined,
    connect: vi.fn(),
    disconnect: vi.fn(),
    switchToXLayer: vi.fn(),
    write: vi.fn(async () => ({ status: "success" }) as never),
  };
}

describe("Dashboard withdraw", () => {
  beforeEach(() => sessionKey.set(7n, `pr-live-${"1".repeat(48)}`));

  it("offers the balance minus unsettled usage, refuses more, and withdraws the exact amount", async () => {
    const w = wallet();
    render(<Dashboard agentId={7n} wallet={w} />);
    await waitFor(() => expect(screen.getByTestId("withdrawable")).toHaveTextContent("0.0016 OKB withdrawable, 0.0001 OKB held for usage not settled yet"));

    // more than allowed: inline error, no transaction
    await userEvent.type(screen.getByTestId("withdraw-input"), "0.0017");
    await userEvent.click(screen.getByTestId("withdraw-submit"));
    expect(screen.getByTestId("withdraw-error")).toHaveTextContent("You can withdraw at most 0.0016 OKB.");
    expect(w.write).not.toHaveBeenCalled();

    // Max fills the exact withdrawable amount, and that is what gets sent
    await userEvent.click(screen.getByTestId("withdraw-max"));
    expect(screen.getByTestId("withdraw-input")).toHaveValue("0.0016");
    await userEvent.click(screen.getByTestId("withdraw-submit"));
    await waitFor(() => expect(w.write).toHaveBeenCalledOnce());
    expect(w.write).toHaveBeenCalledWith(expect.objectContaining({ functionName: "withdraw", args: [7n, parseEther("0.0016")] }));
    await waitFor(() => expect(screen.getByTestId("withdraw-input")).toHaveValue(""));
  });
});
