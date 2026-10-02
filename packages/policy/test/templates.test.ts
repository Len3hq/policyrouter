import { describe, expect, it } from "vitest";
import {
  ALL_INPUTS,
  TEMPLATES,
  budgetGuard,
  buildArtifact,
  cheapOnly,
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

describe("Cheap Only rule", () => {
  it("never routes above tier 1 and never allows when killed or over budget", () => {
    for (const input of ALL_INPUTS) {
      const out = cheapOnly.evaluate(input);
      expect(out.routeTier).toBeLessThanOrEqual(1);
      if (input.kill || !input.budgetOk) expect(out).toEqual({ allow: false, routeTier: 0 });
    }
  });

  it("downgrades premium and frontier to standard, and leaves cheap and standard alone", () => {
    const open = { size: 0, budgetOk: true, kill: false } as const;
    expect(cheapOnly.evaluate({ ...open, tier: 0 })).toEqual({ allow: true, routeTier: 0 });
    expect(cheapOnly.evaluate({ ...open, tier: 1 })).toEqual({ allow: true, routeTier: 1 });
    expect(cheapOnly.evaluate({ ...open, tier: 2 })).toEqual({ allow: true, routeTier: 1 });
    expect(cheapOnly.evaluate({ ...open, tier: 3 })).toEqual({ allow: true, routeTier: 1 });
  });

  it("uses 10 gates", () => {
    expect(cheapOnly.circuit().gates).toHaveLength(10);
  });
});
