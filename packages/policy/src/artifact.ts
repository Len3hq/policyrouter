// The JSON file written to circuits/<id>.json for each template. Foundry fork tests, the deploy
// script and circuits/check.ts all read this file, so it is the one thing that gets taped out.

import { ALL_INPUTS, inputPins, outputToIndex } from "./bits.ts";
import { encodeNetlist, simulate } from "./netlist.ts";
import { toHex } from "./tapeout.ts";
import type { Template } from "./templates.ts";

export interface CircuitArtifact {
  id: string;
  name: string;
  rule: string;
  nIn: number;
  nOut: number;
  /** Elements in the netlist = transistors burned at tape-out. */
  gateCount: number;
  /** Netlist bytes, 0x-prefixed hex, exactly as passed to tapeout(). */
  netlist: string;
  /** outputs[i] = expected eval() output byte for input byte i, for all 64 inputs. */
  outputs: number[];
}

export function buildArtifact(t: Template): CircuitArtifact {
  const n = t.circuit();
  const outputs = ALL_INPUTS.map((input) => {
    const pins = simulate(n, inputPins(input));
    return pins.reduce((acc, on, i) => acc | (Number(on) << i), 0);
  });
  // The circuit must equal the template's reference function on every input.
  ALL_INPUTS.forEach((input, i) => {
    const want = outputToIndex(t.evaluate(input));
    if (outputs[i] !== want) throw new Error(`${t.id}: circuit gives ${outputs[i]} for input ${i}, rule says ${want}`);
  });
  return {
    id: t.id,
    name: t.name,
    rule: t.rule,
    nIn: n.nIn,
    nOut: n.nOut,
    gateCount: n.gates.length,
    netlist: toHex(encodeNetlist(n)),
    outputs,
  };
}
