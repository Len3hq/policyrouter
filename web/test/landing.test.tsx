import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TEMPLATES, TIER_NAMES, indexToInput } from "@policyrouter/policy";
import { Landing, decide } from "../src/components/Landing.tsx";

describe("hero policy playground", () => {
  it("simulating each netlist gate by gate agrees with the template's reference logic on all 64 inputs", () => {
    for (const t of TEMPLATES) {
      for (let i = 0; i < 64; i++) {
        const input = indexToInput(i);
        const want = t.evaluate(input);
        const got = decide(t.id, input.tier, input.size, input.budgetOk, input.kill).verdict;
        expect(got.kind === "deny", `${t.id} input ${i}`).toBe(!want.allow);
        if (want.allow) expect(got.served).toBe(TIER_NAMES[want.routeTier]);
      }
    }
  });

  it("updates the verdict as the request changes", async () => {
    render(<Landing onConnect={() => undefined} />);
    const verdict = screen.getByTestId("pg-verdict");
    expect(verdict).toHaveTextContent("Downgraded to standard"); // Cheap Only, frontier, medium
    await userEvent.click(screen.getByLabelText("Kill switch on"));
    expect(verdict).toHaveTextContent("Denied");
    await userEvent.click(screen.getByLabelText("Kill switch on"));
    await userEvent.click(screen.getByLabelText("Budget Guard"));
    expect(verdict).toHaveTextContent("Allowed as frontier");
  });
});
