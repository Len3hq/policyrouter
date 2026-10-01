// TapeOut on X Layer mainnet, confirmed on chain on 2026-10-01 (block ~72,125,953).
// See packages/policy/README.md for how each value was checked.

export const XLAYER_CHAIN_ID = 196;

export const TAPEOUT = {
  /** Factory (ERC-1967 proxy). createCPU(name, symbol, story, transistorSupply, mintPrice) */
  factory: "0x1f09DAeFA827f02CBb40967cc91b259763760761",
  /** Every processor ("circuits", ERC-721) is a beacon proxy on this beacon. */
  processorBeacon: "0xf70d1ed4f62CF3780157B0b421b7E2F45bD0991C",
  /** Every transistor contract (ERC-1155, token id 0) is a beacon proxy on this beacon. */
  transistorBeacon: "0x1059AD62CaBB6A6925bb65AA617300556C60A51b",
} as const;

/**
 * Pin layout used by eval(): pin i is bit (i % 8) of byte (i >> 3).
 * Little-endian across bytes, least significant bit first within a byte.
 */
export function packPins(pins: readonly boolean[]): Uint8Array {
  const out = new Uint8Array(Math.ceil(pins.length / 8));
  pins.forEach((on, i) => {
    if (on) out[i >> 3]! |= 1 << (i % 8);
  });
  return out;
}

export function toHex(bytes: Uint8Array): `0x${string}` {
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function fromHex(hex: string): Uint8Array {
  const s = hex.replace(/^0x/, "");
  if (s.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(s)) throw new Error(`not hex: ${hex}`);
  return Uint8Array.from({ length: s.length / 2 }, (_, i) => parseInt(s.slice(i * 2, i * 2 + 2), 16));
}

export function unpackPins(bytes: Uint8Array, count: number): boolean[] {
  if (count > bytes.length * 8) throw new RangeError(`need ${count} pins, got ${bytes.length * 8}`);
  return Array.from({ length: count }, (_, i) => ((bytes[i >> 3]! >> (i % 8)) & 1) === 1);
}
