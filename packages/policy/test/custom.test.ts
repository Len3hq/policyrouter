import { describe, expect, it } from "vitest";
import {
  ALL_INPUTS,
  ALL_RULES,
  TEMPLATES,
  buildArtifact,
  budgetGuard,
  cheapOnly,
  describeRule,
  encodeNetlist,
  evaluateRule,
  inputPins,
  matchingTemplate,
  normalizeRule,
  outputToIndex,
  parseRuleId,
  ruleId,
  ruleTemplate,
  simulate,
  smallRequests,
  strict,
  synthesize,
  toHex,
  type CustomRule,
} from "../src/index.ts";

const outByte = (rule: CustomRule, i: (typeof ALL_INPUTS)[number]) => {
  const pins = simulate(synthesize(rule), inputPins(i));
  return pins.reduce((acc, on, k) => acc | (Number(on) << k), 0);
};

describe("custom rules", () => {
  it("has 28 distinct rules (32 combinations; maxTier 3 makes downgrade and deny the same)", () => {
    expect(ALL_RULES).toHaveLength(28);
    expect(new Set(ALL_RULES.map(ruleId)).size).toBe(28);
  });

  it("round-trips rule ids, with or without the custom: prefix", () => {
    for (const r of ALL_RULES) {
      expect(parseRuleId(ruleId(r))).toEqual(r);
      expect(parseRuleId(`custom:${ruleId(r)}`)).toEqual(r);
    }
    expect(ruleId({ maxTier: 3, overTier: "deny", maxSize: 2 })).toBe("t3-downgrade-s2");
    expect(() => parseRuleId("t4-deny-s1")).toThrow(/not a custom rule/);
  });

  it("describes rules in plain words", () => {
    expect(describeRule({ maxTier: 1, overTier: "downgrade", maxSize: 2 })).toBe(
      "Budget Guard, and any tier above standard is downgraded to standard, and requests larger than large are denied.",
    );
    expect(describeRule({ maxTier: 2, overTier: "deny", maxSize: 3 })).toBe("Budget Guard, and any tier above premium is denied.");
    expect(describeRule({ maxTier: 3, overTier: "deny", maxSize: 3 })).toMatch(/^Budget Guard: allow only/);
  });
});

describe.each(ALL_RULES.map((r) => [ruleId(r), r] as const))("rule %s", (_id, rule) => {
  it("its circuit makes exactly the rule's decision on all 64 inputs", () => {
    for (const i of ALL_INPUTS) expect(outByte(rule, i)).toBe(outputToIndex(evaluateRule(rule, i)));
  });

  it("keeps the safety properties: never allows when killed or over budget, never routes above the request or maxTier", () => {
    for (const i of ALL_INPUTS) {
      const o = evaluateRule(rule, i);
      if (i.kill || !i.budgetOk) expect(o).toEqual({ allow: false, routeTier: 0 });
      expect(o.routeTier).toBeLessThanOrEqual(i.tier);
      expect(o.routeTier).toBeLessThanOrEqual(rule.maxTier);
      if (!o.allow) expect(o.routeTier).toBe(0);
      if (i.size > rule.maxSize) expect(o.allow).toBe(false);
    }
  });

  it("is a 6-in, 3-out netlist that buildArtifact accepts", () => {
    const n = synthesize(rule);
    expect(n.nIn).toBe(6);
    expect(n.nOut).toBe(3);
    expect(buildArtifact(ruleTemplate(rule)).gateCount).toBe(n.gates.length);
    // at most 0.0018 OKB of transistors at today's price
    expect(n.gates.length).toBeLessThanOrEqual(18);
  });
});

describe("rules that are templates", () => {
  const cases = [
    [{ maxTier: 3, overTier: "downgrade", maxSize: 3 }, budgetGuard],
    [{ maxTier: 1, overTier: "downgrade", maxSize: 3 }, cheapOnly],
    [{ maxTier: 3, overTier: "downgrade", maxSize: 2 }, smallRequests],
    [{ maxTier: 1, overTier: "downgrade", maxSize: 2 }, strict],
  ] as const;

  it.each(cases.map(([r, t]) => [t.name, r, t] as const))("%s is recognised, and synthesis is no bigger than the hand-wired circuit", (_n, rule, template) => {
    expect(matchingTemplate(rule)).toBe(template);
    expect(synthesize(rule).gates.length).toBeLessThanOrEqual(template.circuit().gates.length);
  });

  it("Budget Guard and Cheap Only synthesize to exactly the hand-wired netlists", () => {
    expect(toHex(encodeNetlist(synthesize(cases[0][0])))).toBe(toHex(encodeNetlist(budgetGuard.circuit())));
    expect(toHex(encodeNetlist(synthesize(cases[1][0])))).toBe(toHex(encodeNetlist(cheapOnly.circuit())));
  });

  it("other rules match no template", () => {
    const templateIds = new Set(cases.map(([r]) => ruleId(r)));
    for (const r of ALL_RULES.filter((x) => !templateIds.has(ruleId(x)))) expect(matchingTemplate(r), ruleId(r)).toBeUndefined();
    expect(TEMPLATES).toHaveLength(4);
  });

  it("normalizes maxTier 3", () => {
    expect(normalizeRule({ maxTier: 3, overTier: "deny", maxSize: 0 }).overTier).toBe("downgrade");
  });
});
