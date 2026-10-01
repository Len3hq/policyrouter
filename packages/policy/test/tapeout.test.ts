import { describe, expect, it } from "vitest";
import { TAPEOUT, XLAYER_CHAIN_ID, packPins, unpackPins } from "../src/index.ts";

describe("TapeOut constants", () => {
  it("targets X Layer mainnet", () => {
    expect(XLAYER_CHAIN_ID).toBe(196);
  });

  it("has well-formed addresses", () => {
    for (const addr of Object.values(TAPEOUT)) expect(addr).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});

describe("pin packing", () => {
  // These match the on-chain check in contracts/test/fork/TapeOutSpike.t.sol.
  it("puts pin 0 in the lowest bit of byte 0", () => {
    expect(packPins([true, false, false, false, false, false])).toEqual(Uint8Array.of(0x01));
  });

  it("puts pin 5 in bit 5 of byte 0", () => {
    expect(packPins([false, false, false, false, false, true])).toEqual(Uint8Array.of(0x20));
  });

  it("puts pin 8 in byte 1", () => {
    const pins = Array<boolean>(9).fill(false);
    pins[8] = true;
    expect(packPins(pins)).toEqual(Uint8Array.of(0x00, 0x01));
  });

  it("round-trips all 64 six-pin inputs", () => {
    for (let v = 0; v < 64; v++) {
      const pins = Array.from({ length: 6 }, (_, i) => ((v >> i) & 1) === 1);
      const bytes = packPins(pins);
      expect(bytes).toEqual(Uint8Array.of(v));
      expect(unpackPins(bytes, 6)).toEqual(pins);
    }
  });

  it("rejects asking for more pins than the bytes hold", () => {
    expect(() => unpackPins(Uint8Array.of(0), 9)).toThrow(RangeError);
  });
});
