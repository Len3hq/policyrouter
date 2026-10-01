import { describe, expect, it } from "vitest";
import { NetlistBuilder, decodeNetlist, encodeNetlist, fromHex, simulate, toHex } from "../src/index.ts";

describe("netlist encoding", () => {
  it("matches the 2-gate circuit proven on chain in TapeOutSpike.t.sol", () => {
    // out0 = NOT pin0, out1 = NOT pin5
    const b = new NetlistBuilder(6);
    const n0 = b.not(b.input(0));
    const n5 = b.not(b.input(5));
    const n = b.build([n0, n5]);
    expect(toHex(encodeNetlist(n))).toBe("0x0000000200000200000007000007");
  });

  it("round-trips through decode", () => {
    const b = new NetlistBuilder(2);
    const x = b.nand(b.input(0), b.input(1));
    const n = b.build([b.not(x)]);
    expect(decodeNetlist(encodeNetlist(n), 2, 1)).toEqual(n);
  });

  it("rejects gates that read later signals", () => {
    // gate 0 is signal 4 (nIn = 2) and may not read signal 4
    expect(() => decodeNetlist(fromHex("0x00000004000002"), 2, 1)).toThrow(/later signal/);
  });

  it("rejects unknown opcodes and truncated bytes", () => {
    expect(() => decodeNetlist(fromHex("0x01000002000002"), 2, 1)).toThrow(/opcode/);
    expect(() => decodeNetlist(fromHex("0x000000020000"), 2, 1)).toThrow(/multiple of 7/);
  });

  it("refuses outputs that are not the last signals", () => {
    const b = new NetlistBuilder(2);
    const early = b.not(b.input(0));
    b.not(b.input(1));
    expect(() => b.build([early])).toThrow(/must be signal/);
  });
});

describe("simulation", () => {
  it("evaluates NAND, constants and inputs", () => {
    const b = new NetlistBuilder(2);
    const nand = b.nand(b.input(0), b.input(1));
    const one = b.nand(0, 0); // NAND(const0, const0) = 1
    const n = b.build([nand, one]);
    expect(simulate(n, [false, false])).toEqual([true, true]);
    expect(simulate(n, [true, false])).toEqual([true, true]);
    expect(simulate(n, [true, true])).toEqual([false, true]);
  });

  it("checks the input count", () => {
    const b = new NetlistBuilder(2);
    const n = b.build([b.nand(b.input(0), b.input(1))]);
    expect(() => simulate(n, [true])).toThrow(/expected 2 inputs/);
  });
});
