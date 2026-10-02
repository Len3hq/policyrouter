// Template policies: each one is a plain-English rule, a reference function, and the NAND
// circuit that is taped out. Tests prove the circuit equals the function on all 64 inputs.

import { INPUT_PINS, type PolicyInput, type PolicyOutput } from "./bits.ts";
import { NetlistBuilder, type Netlist } from "./netlist.ts";

export interface Template {
  id: string;
  name: string;
  rule: string;
  evaluate(input: PolicyInput): PolicyOutput;
  circuit(): Netlist;
}

const DENY: PolicyOutput = { allow: false, routeTier: 0 };

export const budgetGuard: Template = {
  id: "budget-guard",
  name: "Budget Guard",
  rule: "Allow only if the kill switch is off and today's spend is under the cap. The requested tier is served unchanged.",
  evaluate(input) {
    return !input.kill && input.budgetOk ? { allow: true, routeTier: input.tier } : DENY;
  },
  circuit() {
    const b = new NetlistBuilder(INPUT_PINS);
    const t0 = b.input(0);
    const t1 = b.input(1);
    const budgetOk = b.input(4);
    const kill = b.input(5);

    const notKill = b.not(kill);
    const deny = b.nand(notKill, budgetOk); // NOT allow
    const allowed = b.not(deny);
    const x0 = b.nand(t0, allowed); // NOT (t0 AND allow)
    const x1 = b.nand(t1, allowed);
    // Outputs must be the last three signals, so allow is produced again here.
    const allow = b.not(deny);
    const r0 = b.not(x0);
    const r1 = b.not(x1);
    return b.build([allow, r0, r1]);
  },
};

export const cheapOnly: Template = {
  id: "cheap-only",
  name: "Cheap Only",
  rule: "Budget Guard, and any tier above standard (1) is downgraded to standard.",
  evaluate(input) {
    if (input.kill || !input.budgetOk) return DENY;
    return { allow: true, routeTier: input.tier > 1 ? 1 : input.tier };
  },
  circuit() {
    const b = new NetlistBuilder(INPUT_PINS);
    const t0 = b.input(0);
    const t1 = b.input(1);
    const budgetOk = b.input(4);
    const kill = b.input(5);

    const notKill = b.not(kill);
    const deny = b.nand(notKill, budgetOk);
    const allowed = b.not(deny);
    // route tier = allow AND (tier != 0) ? 1 : 0, i.e. bit 0 = allow AND (t0 OR t1), bit 1 = 0
    const nt0 = b.not(t0);
    const nt1 = b.not(t1);
    const anyTier = b.nand(nt0, nt1); // t0 OR t1
    const x0 = b.nand(anyTier, allowed);
    const allow = b.not(deny);
    const r0 = b.not(x0);
    const r1 = b.nand(1, 1); // constant 0
    return b.build([allow, r0, r1]);
  },
};

export const smallRequests: Template = {
  id: "small-requests",
  name: "Small Requests",
  rule: "Budget Guard, and huge requests (size bucket 3) are denied. The requested tier is served unchanged.",
  evaluate(input) {
    if (input.kill || !input.budgetOk || input.size === 3) return DENY;
    return { allow: true, routeTier: input.tier };
  },
  circuit() {
    const b = new NetlistBuilder(INPUT_PINS);
    const t0 = b.input(0);
    const t1 = b.input(1);
    const s0 = b.input(2);
    const s1 = b.input(3);
    const budgetOk = b.input(4);
    const kill = b.input(5);

    const notKill = b.not(kill);
    const guardFail = b.nand(notKill, budgetOk); // NOT (not killed AND budget ok)
    const guardOk = b.not(guardFail);
    const notHuge = b.nand(s0, s1); // size != 3
    const deny = b.nand(guardOk, notHuge); // NOT allow
    const allowed = b.not(deny);
    const x0 = b.nand(t0, allowed);
    const x1 = b.nand(t1, allowed);
    const allow = b.not(deny);
    const r0 = b.not(x0);
    const r1 = b.not(x1);
    return b.build([allow, r0, r1]);
  },
};

export const strict: Template = {
  id: "strict",
  name: "Strict",
  rule: "Cheap Only and Small Requests together: huge requests are denied, and any tier above standard (1) is downgraded to standard.",
  evaluate(input) {
    if (input.kill || !input.budgetOk || input.size === 3) return DENY;
    return { allow: true, routeTier: input.tier > 1 ? 1 : input.tier };
  },
  circuit() {
    const b = new NetlistBuilder(INPUT_PINS);
    const t0 = b.input(0);
    const t1 = b.input(1);
    const s0 = b.input(2);
    const s1 = b.input(3);
    const budgetOk = b.input(4);
    const kill = b.input(5);

    const notKill = b.not(kill);
    const guardFail = b.nand(notKill, budgetOk);
    const guardOk = b.not(guardFail);
    const notHuge = b.nand(s0, s1);
    const deny = b.nand(guardOk, notHuge);
    const allowed = b.not(deny);
    const nt0 = b.not(t0);
    const nt1 = b.not(t1);
    const anyTier = b.nand(nt0, nt1); // t0 OR t1
    const x0 = b.nand(anyTier, allowed);
    const allow = b.not(deny);
    const r0 = b.not(x0);
    const r1 = b.nand(1, 1); // constant 0
    return b.build([allow, r0, r1]);
  },
};

export const TEMPLATES: readonly Template[] = [budgetGuard, cheapOnly, smallRequests, strict];

export function templateById(id: string): Template {
  const t = TEMPLATES.find((x) => x.id === id);
  if (!t) throw new Error(`unknown template ${id}`);
  return t;
}
