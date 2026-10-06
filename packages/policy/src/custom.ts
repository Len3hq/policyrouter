// Custom policies: an owner picks three settings and gets a policy circuit for exactly that rule.
//
//   maxTier   the highest tier served (0 cheap … 3 frontier)
//   overTier  what happens to a request above it: "downgrade" (serve it at maxTier) or "deny"
//   maxSize   the largest size bucket allowed (0 small … 3 huge); bigger requests are denied
//
// Budget Guard is always part of the rule: a custom policy can never allow a request while the kill
// switch is on or the budget is spent. That gives 4 × 2 × 4 = 32 rules (28 distinct ones: with
// maxTier = 3 nothing is ever above it), and the four templates are among them.
//
// synthesize() turns a rule into a NAND netlist with constant folding and shared negations, so a
// rule that matches a template comes out the same size as the hand-wired template. Every netlist is
// checked against the rule on all 64 inputs before it is returned.

import { ALL_INPUTS, INPUT_PINS, inputPins, outputToIndex, type PolicyInput, type PolicyOutput, type Size, type Tier } from "./bits.ts";
import { NetlistBuilder, simulate, type Netlist } from "./netlist.ts";
import { TEMPLATES, type Template } from "./templates.ts";

export interface CustomRule {
  maxTier: Tier;
  overTier: "downgrade" | "deny";
  maxSize: Size;
}

export const TIER_NAMES = ["cheap", "standard", "premium", "frontier"] as const;
export const SIZE_NAMES = ["small", "medium", "large", "huge"] as const;

/** maxTier 3 has nothing above it, so its overTier is always written as "downgrade". */
export function normalizeRule(r: CustomRule): CustomRule {
  return r.maxTier === 3 ? { ...r, overTier: "downgrade" } : r;
}

/** "t1-downgrade-s2": a stable, URL-safe id for a rule. */
export function ruleId(r: CustomRule): string {
  const n = normalizeRule(r);
  return `t${n.maxTier}-${n.overTier}-s${n.maxSize}`;
}

export function parseRuleId(id: string): CustomRule {
  const m = /^t([0-3])-(downgrade|deny)-s([0-3])$/.exec(id.replace(/^custom:/, ""));
  if (!m) throw new Error(`not a custom rule: ${id}`);
  return normalizeRule({ maxTier: Number(m[1]) as Tier, overTier: m[2] as CustomRule["overTier"], maxSize: Number(m[3]) as Size });
}

/** Every distinct rule. */
export const ALL_RULES: readonly CustomRule[] = (() => {
  const seen = new Set<string>();
  const out: CustomRule[] = [];
  for (const maxTier of [0, 1, 2, 3] as const) {
    for (const overTier of ["downgrade", "deny"] as const) {
      for (const maxSize of [0, 1, 2, 3] as const) {
        const r = normalizeRule({ maxTier, overTier, maxSize });
        if (!seen.has(ruleId(r))) {
          seen.add(ruleId(r));
          out.push(r);
        }
      }
    }
  }
  return out;
})();

export function evaluateRule(r: CustomRule, input: PolicyInput): PolicyOutput {
  if (input.kill || !input.budgetOk || input.size > r.maxSize) return { allow: false, routeTier: 0 };
  if (input.tier > r.maxTier) return r.overTier === "deny" ? { allow: false, routeTier: 0 } : { allow: true, routeTier: r.maxTier };
  return { allow: true, routeTier: input.tier };
}

export function describeRule(r: CustomRule): string {
  const n = normalizeRule(r);
  const parts = ["Budget Guard"];
  if (n.maxTier < 3) {
    parts.push(
      n.overTier === "downgrade"
        ? `any tier above ${TIER_NAMES[n.maxTier]} is downgraded to ${TIER_NAMES[n.maxTier]}`
        : `any tier above ${TIER_NAMES[n.maxTier]} is denied`,
    );
  }
  if (n.maxSize < 3) parts.push(`requests larger than ${SIZE_NAMES[n.maxSize]} are denied`);
  return parts.length === 1 ? "Budget Guard: allow only while the kill switch is off and the budget isn't spent." : `${parts[0]}, and ${parts.slice(1).join(", and ")}.`;
}

// --- synthesis ---

type Sig = number | boolean;

export function synthesize(r: CustomRule): Netlist {
  const rule = normalizeRule(r);
  const b = new NetlistBuilder(INPUT_PINS);
  const negation = new Map<number, number>(); // signal → its complement, both directions

  const not = (x: Sig): Sig => {
    if (typeof x === "boolean") return !x;
    const known = negation.get(x);
    if (known !== undefined) return known;
    const y = b.not(x);
    negation.set(x, y);
    negation.set(y, x);
    return y;
  };
  const nand = (x: Sig, y: Sig): Sig => {
    if (x === false || y === false) return true;
    if (x === true) return not(y);
    if (y === true) return not(x);
    if (x === y) return not(x);
    if (negation.get(x) === y) return true; // x AND NOT x is never true
    return b.nand(x, y);
  };
  const and = (x: Sig, y: Sig): Sig => not(nand(x, y));
  const or = (x: Sig, y: Sig): Sig => nand(not(x), not(y));
  /** value ≤ max for a 2-bit value (lo, hi) */
  const atMost = (lo: number, hi: number, max: number): Sig =>
    max === 3 ? true : max === 2 ? nand(lo, hi) : max === 1 ? not(hi) : and(not(lo), not(hi));

  const [t0, t1, s0, s1, budgetOk, kill] = [0, 1, 2, 3, 4, 5].map((p) => b.input(p)) as [number, number, number, number, number, number];

  const guard = and(not(kill), budgetOk);
  let allow = and(guard, atMost(s0, s1, rule.maxSize));
  if (rule.overTier === "deny") allow = and(allow, atMost(t0, t1, rule.maxTier));

  // The tier served when allowed: min(tier, maxTier). In deny mode a request is only allowed when
  // tier ≤ maxTier, so the bits that can't be set then are simply 0.
  let r0: Sig = t0;
  let r1: Sig = t1;
  if (rule.overTier === "downgrade") {
    if (rule.maxTier === 2) r0 = and(t0, not(t1)); // 3 → 2: low bit off only for tier 3
    if (rule.maxTier === 1) [r0, r1] = [or(t0, t1), false];
    if (rule.maxTier === 0) [r0, r1] = [false, false];
  } else {
    if (rule.maxTier === 1) r1 = false;
    if (rule.maxTier === 0) [r0, r1] = [false, false];
  }

  // Outputs must be the last three signals, in order. Build each output's complement first, then
  // emit one gate per output: NAND(c, c) = NOT c.
  const complements = [not(allow), nand(r0, allow), nand(r1, allow)];
  const outs = complements.map((c) => (c === true ? b.nand(1, 1) : c === false ? b.nand(0, 0) : b.nand(c, c)));
  const net = b.build(outs);

  for (const input of ALL_INPUTS) {
    const pins = simulate(net, inputPins(input));
    const got = pins.reduce((acc, on, i) => acc | (Number(on) << i), 0);
    if (got !== outputToIndex(evaluateRule(rule, input))) throw new Error(`synthesis bug for ${ruleId(rule)} at input ${JSON.stringify(input)}`);
  }
  return net;
}

/** A custom rule as a Template, so everything that takes templates (artifacts, simulation) takes it too. */
export function ruleTemplate(r: CustomRule): Template {
  const rule = normalizeRule(r);
  return {
    id: `custom:${ruleId(rule)}`,
    name: "Custom policy",
    rule: describeRule(rule),
    evaluate: (input) => evaluateRule(rule, input),
    circuit: () => synthesize(rule),
  };
}

/** The template that makes exactly the same decisions on all 64 inputs, if there is one. */
export function matchingTemplate(r: CustomRule): Template | undefined {
  return TEMPLATES.find((t) => ALL_INPUTS.every((i) => outputToIndex(t.evaluate(i)) === outputToIndex(evaluateRule(r, i))));
}
