import { describe, expect, it } from "vitest";
import {
  ALL_INPUTS,
  decodeOutput,
  encodeInput,
  indexToInput,
  indexToOutput,
  inputToIndex,
  outputToIndex,
  type PolicyOutput,
} from "../src/index.ts";

describe("input encoding", () => {
  it("has 64 distinct inputs in index order", () => {
    expect(ALL_INPUTS).toHaveLength(64);
    ALL_INPUTS.forEach((input, i) => expect(inputToIndex(input)).toBe(i));
  });

  it("round-trips every input through the eval() byte", () => {
    for (let i = 0; i < 64; i++) {
      const bytes = encodeInput(indexToInput(i));
      expect(bytes).toEqual(Uint8Array.of(i)); // six pins fit one byte, value = index
    }
  });

  it("places each field on the pins the spec defines", () => {
    expect(encodeInput({ tier: 3, size: 0, budgetOk: false, kill: false })).toEqual(Uint8Array.of(0b000011));
    expect(encodeInput({ tier: 0, size: 3, budgetOk: false, kill: false })).toEqual(Uint8Array.of(0b001100));
    expect(encodeInput({ tier: 0, size: 0, budgetOk: true, kill: false })).toEqual(Uint8Array.of(0b010000));
    expect(encodeInput({ tier: 0, size: 0, budgetOk: false, kill: true })).toEqual(Uint8Array.of(0b100000));
  });

  it("rejects out-of-range indexes", () => {
    expect(() => indexToInput(64)).toThrow(RangeError);
    expect(() => indexToInput(-1)).toThrow(RangeError);
  });
});

describe("output decoding", () => {
  it("decodes all 8 output values", () => {
    for (let v = 0; v < 8; v++) {
      const out = decodeOutput(Uint8Array.of(v));
      expect(out).toEqual(indexToOutput(v));
      expect(outputToIndex(out)).toBe(v);
    }
  });

  it("reads allow from pin 0 and route_tier from pins 1-2", () => {
    const cases: [number, PolicyOutput][] = [
      [0b000, { allow: false, routeTier: 0 }],
      [0b001, { allow: true, routeTier: 0 }],
      [0b011, { allow: true, routeTier: 1 }],
      [0b111, { allow: true, routeTier: 3 }],
    ];
    for (const [byte, want] of cases) expect(decodeOutput(Uint8Array.of(byte))).toEqual(want);
  });

  it("ignores unused high bits in the output byte", () => {
    expect(decodeOutput(Uint8Array.of(0b1111_1011))).toEqual({ allow: true, routeTier: 1 });
  });
});
