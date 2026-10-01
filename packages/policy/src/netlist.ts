// TapeOut netlists: build, encode, decode and simulate, matching what the processor reads.
//
//   signal 0 = constant 0, signal 1 = constant 1,
//   signals 2 .. 2+nIn-1 = input pins, then one new signal per gate, in order.
//   NAND = 0x00 a:u24 b:u24 (7 bytes). The outputs are the LAST nOut signals.
//
// PolicyRouter circuits are combinational, so only NAND gates are supported here.

export const OP_NAND = 0x00;
export const CONST_0 = 0;
export const CONST_1 = 1;

export interface Netlist {
  nIn: number;
  nOut: number;
  /** NAND gates in order; gate g writes signal 2 + nIn + g. */
  gates: readonly (readonly [number, number])[];
}

export function encodeNetlist(n: Netlist): Uint8Array {
  const out = new Uint8Array(n.gates.length * 7);
  n.gates.forEach(([a, b], g) => {
    const o = g * 7;
    out[o] = OP_NAND;
    out.set(u24(a), o + 1);
    out.set(u24(b), o + 4);
  });
  return out;
}

export function decodeNetlist(bytes: Uint8Array, nIn: number, nOut: number): Netlist {
  if (bytes.length % 7 !== 0) throw new Error("netlist length is not a multiple of 7");
  const gates: [number, number][] = [];
  for (let o = 0; o < bytes.length; o += 7) {
    if (bytes[o] !== OP_NAND) throw new Error(`unsupported opcode ${bytes[o]} at byte ${o}`);
    gates.push([r24(bytes, o + 1), r24(bytes, o + 4)]);
  }
  const n = { nIn, nOut, gates };
  validate(n);
  return n;
}

export function validate(n: Netlist): void {
  if (n.nOut > n.gates.length) throw new Error("fewer gates than outputs");
  n.gates.forEach(([a, b], g) => {
    const self = 2 + n.nIn + g;
    if (a >= self || b >= self) throw new Error(`gate ${g} reads a later signal`);
  });
}

/** Evaluate the netlist the way the processor's eval() does. */
export function simulate(n: Netlist, inputs: readonly boolean[]): boolean[] {
  if (inputs.length !== n.nIn) throw new Error(`expected ${n.nIn} inputs, got ${inputs.length}`);
  const sig: boolean[] = [false, true, ...inputs];
  for (const [a, b] of n.gates) sig.push(!(sig[a]! && sig[b]!));
  return sig.slice(sig.length - n.nOut);
}

/** Small helper for wiring circuits by hand. Every method returns the new signal's index. */
export class NetlistBuilder {
  private readonly gates: [number, number][] = [];

  constructor(readonly nIn: number) {}

  input(pin: number): number {
    if (pin < 0 || pin >= this.nIn) throw new RangeError(`no input pin ${pin}`);
    return 2 + pin;
  }

  nand(a: number, b: number): number {
    this.gates.push([a, b]);
    return 1 + this.nIn + this.gates.length;
  }

  not(a: number): number {
    return this.nand(a, a);
  }

  /** Finish the circuit. The outputs must be the last signals created, in pin order. */
  build(outputs: readonly number[]): Netlist {
    const last = 1 + this.nIn + this.gates.length;
    outputs.forEach((s, k) => {
      const expected = last - outputs.length + 1 + k;
      if (s !== expected) throw new Error(`output ${k} is signal ${s}; it must be signal ${expected} (the last ${outputs.length} signals, in order)`);
    });
    const n = { nIn: this.nIn, nOut: outputs.length, gates: this.gates.map(([a, b]) => [a, b] as const) };
    validate(n);
    return n;
  }
}

function u24(v: number): Uint8Array {
  if (!Number.isInteger(v) || v < 0 || v > 0xffffff) throw new RangeError(`signal out of range: ${v}`);
  return Uint8Array.of((v >>> 16) & 255, (v >>> 8) & 255, v & 255);
}

function r24(b: Uint8Array, o: number): number {
  return (b[o]! << 16) | (b[o + 1]! << 8) | b[o + 2]!;
}
