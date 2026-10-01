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

export const TEMPLATES: readonly Template[] = [budgetGuard];

export function templateById(id: string): Template {
  const t = TEMPLATES.find((x) => x.id === id);
  if (!t) throw new Error(`unknown template ${id}`);
  return t;
}
