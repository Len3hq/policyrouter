import { describe, expect, it } from "vitest";
import {
  ALL_INPUTS,
  TEMPLATES,
  budgetGuard,
  buildArtifact,
  decodeOutput,
  inputPins,
  simulate,
  templateById,
} from "../src/index.ts";

describe("Budget Guard rule", () => {
  it("always denies when the kill switch is on", () => {
    for (const input of ALL_INPUTS.filter((i) => i.kill)) {
      expect(budgetGuard.evaluate(input)).toEqual({ allow: false, routeTier: 0 });
    }
  });

  it("always denies when the budget is spent", () => {
    for (const input of ALL_INPUTS.filter((i) => !i.budgetOk)) {
      expect(budgetGuard.evaluate(input)).toEqual({ allow: false, routeTier: 0 });
    }
  });

  it("otherwise allows at the requested tier, whatever the size", () => {
    const open = ALL_INPUTS.filter((i) => !i.kill && i.budgetOk);
    expect(open).toHaveLength(16);
    for (const input of open) expect(budgetGuard.evaluate(input)).toEqual({ allow: true, routeTier: input.tier });
  });
});

describe.each(TEMPLATES.map((t) => [t.id, t] as const))("%s circuit", (_id, t) => {
  const n = t.circuit();

  it("equals the rule on all 64 inputs", () => {
    for (const input of ALL_INPUTS) {
      const pins = simulate(n, inputPins(input));
      const byte = pins.reduce((acc, on, i) => acc | (Number(on) << i), 0);
      expect(decodeOutput(Uint8Array.of(byte))).toEqual(t.evaluate(input));
    }
  });

  it("has 6 inputs and 3 outputs", () => {
    expect(n.nIn).toBe(6);
    expect(n.nOut).toBe(3);
  });

  it("produces an artifact whose outputs match the rule", () => {
    const a = buildArtifact(t);
    expect(a.outputs).toHaveLength(64);
    expect(a.gateCount).toBe(n.gates.length);
  });
});

describe("Budget Guard size", () => {
  it("uses 8 gates (8 transistors burned at tape-out)", () => {
    expect(budgetGuard.circuit().gates).toHaveLength(8);
  });
});

describe("template lookup", () => {
  it("finds templates by id and rejects unknown ids", () => {
    expect(templateById("budget-guard")).toBe(budgetGuard);
    expect(() => templateById("nope")).toThrow(/unknown template/);
  });
});
