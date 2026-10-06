import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AccountMenu } from "../src/components/AccountMenu.tsx";
import type { Wallet } from "../src/lib/wallet.ts";

const wallet = (over: Partial<Wallet> = {}): Wallet => ({
  provider: undefined,
  address: "0x1234567890abcdef1234567890abcdef12345678",
  chainId: 196,
  wrongNetwork: false,
  error: undefined,
  connect: vi.fn(async () => undefined),
  disconnect: vi.fn(async () => undefined),
  switchToXLayer: vi.fn(async () => undefined),
  write: vi.fn(),
  ...over,
});

describe("AccountMenu", () => {
  it("opens from the address, shows the full address, and disconnects back to the landing page", async () => {
    const w = wallet();
    history.replaceState(null, "", "/app");
    render(<AccountMenu wallet={w} />);
    const button = screen.getByTestId("account");
    expect(button).toHaveTextContent("0x1234…5678");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    await userEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menu")).toHaveTextContent(w.address!);

    await userEvent.click(screen.getByTestId("disconnect"));
    expect(w.disconnect).toHaveBeenCalledOnce();
    expect(location.pathname).toBe("/");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("closes on Escape and on a click outside", async () => {
    render(<AccountMenu wallet={wallet()} />);
    await userEvent.click(screen.getByTestId("account"));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId("account"));
    await userEvent.click(document.body);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
