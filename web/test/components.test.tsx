import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { KeyReveal } from "../src/components/KeyReveal.tsx";
import { Quickstart } from "../src/components/Quickstart.tsx";
import { SimulationPanel } from "../src/components/SimulationPanel.tsx";
import type { SimResult } from "../src/lib/api.ts";
import { baseUrl } from "../src/lib/config.ts";

const result: SimResult = {
  template: "cheap-only",
  name: "Cheap Only",
  rule: "…",
  circuitId: "2",
  requests: 20,
  allowed: 11,
  downgraded: 7,
  denied: 2,
  spendWithout: "2000000000000000",
  spendWith: "500000000000000",
  savingsPct: 75,
};

function clipboard() {
  const writeText = vi.fn(async (_text: string) => undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  return writeText;
}

describe("SimulationPanel", () => {
  it("renders the counts and the savings from a fixed response", () => {
    render(<SimulationPanel result={result} source="history" requests={20} />);
    expect(screen.getByTestId("sim-allowed")).toHaveTextContent("11");
    expect(screen.getByTestId("sim-downgraded")).toHaveTextContent("7");
    expect(screen.getByTestId("sim-denied")).toHaveTextContent("2");
    expect(screen.getByTestId("sim-savings")).toHaveTextContent("75.0%");
    expect(screen.getByText(/0\.0005/)).toBeInTheDocument(); // spend with the policy
    expect(screen.getByText(/0\.002/)).toBeInTheDocument(); // spend without
    expect(screen.getByText(/this project's last 20 requests/)).toBeInTheDocument();
  });

  it("says 'request', not '1 requests'", () => {
    render(<SimulationPanel result={result} source="history" requests={1} />);
    expect(screen.getByText("Simulated on this project's last request.")).toBeInTheDocument();
  });

  it("says when it is showing the sample workload because the project has no history", () => {
    render(<SimulationPanel result={result} source="sample" requests={20} />);
    expect(screen.getByText(/sample workload of 20 typical requests/)).toBeInTheDocument();
    expect(screen.getByText(/no history yet/)).toBeInTheDocument();
  });
});

describe("KeyReveal", () => {
  function Harness({ apiKey }: { apiKey: string }) {
    const [shown, setShown] = useState(true);
    return shown ? <KeyReveal apiKey={apiKey} agentId={7n} onConfirm={() => setShown(false)} /> : <p>key hidden</p>;
  }

  it("shows the key once and hides it after the owner confirms", async () => {
    const key = `pr-live-${"ab".repeat(24)}`;
    render(<Harness apiKey={key} />);
    expect(screen.getByTestId("api-key")).toHaveTextContent(key);
    expect(screen.getByText(/only time the full key is shown/)).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("key-saved"));
    expect(screen.queryByTestId("api-key")).not.toBeInTheDocument();
    expect(screen.queryByText(key)).not.toBeInTheDocument();
    expect(screen.getByText("key hidden")).toBeInTheDocument();
  });

  it("copies exactly the key", async () => {
    const user = userEvent.setup();
    const writeText = clipboard();
    const key = `pr-live-${"cd".repeat(24)}`;
    render(<KeyReveal apiKey={key} agentId={1n} onConfirm={() => undefined} />);
    await user.click(screen.getByTestId("copy-key"));
    expect(writeText).toHaveBeenCalledWith(key);
  });
});

describe("Quickstart", () => {
  const key = `pr-live-${"12".repeat(24)}`;

  it("copy buttons copy exactly the base URL, the key, and the two export lines", async () => {
    const user = userEvent.setup();
    const writeText = clipboard();
    render(<Quickstart apiKey={key} />);
    await user.click(screen.getByTestId("copy-base-url"));
    await user.click(screen.getByTestId("copy-quickstart-key"));
    await user.click(screen.getByTestId("copy-env"));
    expect(writeText.mock.calls.map((c) => c[0])).toEqual([
      baseUrl(),
      key,
      `export OPENAI_BASE_URL=${baseUrl()}\nexport OPENAI_API_KEY=${key}`,
    ]);
    expect(baseUrl()).toMatch(/\/v1$/);
  });

  it("without a key shows a placeholder and no key copy button", () => {
    clipboard();
    render(<Quickstart />);
    expect(screen.getByTestId("quickstart-env")).toHaveTextContent("export OPENAI_API_KEY=pr-live-…");
    expect(screen.queryByTestId("copy-quickstart-key")).not.toBeInTheDocument();
  });

  it("gives Claude Code its Anthropic settings (base URL without /v1) and warns about size", async () => {
    render(<Quickstart apiKey={key} />);
    await userEvent.click(screen.getByRole("tab", { name: "Claude Code" }));
    const block = screen.getByTestId("quickstart-claude");
    expect(block).toHaveTextContent(`ANTHROPIC_AUTH_TOKEN=${key}`);
    expect(block.textContent).toMatch(/ANTHROPIC_BASE_URL=\S+\n/);
    expect(block.textContent).not.toMatch(/ANTHROPIC_BASE_URL=\S+\/v1/);
    expect(screen.getByText(/Small Requests and Strict deny most of them/)).toBeInTheDocument();
  });

  it("gives Codex the Responses wire API", async () => {
    render(<Quickstart apiKey={key} />);
    await userEvent.click(screen.getByRole("tab", { name: "Codex" }));
    expect(screen.getByText(/wire_api = "responses"/)).toBeInTheDocument();
  });
});
