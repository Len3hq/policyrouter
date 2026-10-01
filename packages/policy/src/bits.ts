// The 6-input, 3-output policy interface shared by every PolicyRouter circuit.
//
// Input pins:  0-1 tier (pin 0 = low bit), 2-3 size (pin 2 = low bit), 4 budget_ok, 5 kill
// Output pins: 0 allow, 1-2 route_tier (pin 1 = low bit)
//
// Because pin i is bit (i % 8) of byte (i >> 3), the six input pins fit in one byte and the
// byte's value equals the input index below. The same holds for the three output pins.

import { packPins, unpackPins } from "./tapeout.ts";

export type Tier = 0 | 1 | 2 | 3;
export type Size = 0 | 1 | 2 | 3;

export interface PolicyInput {
  /** Requested model tier: 0 cheap, 1 standard, 2 premium, 3 frontier */
  tier: Tier;
  /** Request size bucket: 0 small, 1 medium, 2 large, 3 huge */
  size: Size;
  /** Today's spend is under the daily cap */
  budgetOk: boolean;
  /** The owner has hit the kill switch */
  kill: boolean;
}

export interface PolicyOutput {
  allow: boolean;
  /** Tier to actually serve. Always 0 when denied. */
  routeTier: Tier;
}

export const INPUT_PINS = 6;
export const OUTPUT_PINS = 3;
export const INPUT_COUNT = 1 << INPUT_PINS;

const bit = (v: number, i: number) => ((v >> i) & 1) === 1;

export function inputToIndex(input: PolicyInput): number {
  return input.tier | (input.size << 2) | (Number(input.budgetOk) << 4) | (Number(input.kill) << 5);
}

export function indexToInput(index: number): PolicyInput {
  if (!Number.isInteger(index) || index < 0 || index >= INPUT_COUNT) throw new RangeError(`bad input index ${index}`);
  return {
    tier: (index & 3) as Tier,
    size: ((index >> 2) & 3) as Size,
    budgetOk: bit(index, 4),
    kill: bit(index, 5),
  };
}

export function outputToIndex(output: PolicyOutput): number {
  return Number(output.allow) | (output.routeTier << 1);
}

export function indexToOutput(index: number): PolicyOutput {
  if (!Number.isInteger(index) || index < 0 || index >= 1 << OUTPUT_PINS) throw new RangeError(`bad output index ${index}`);
  return { allow: bit(index, 0), routeTier: ((index >> 1) & 3) as Tier };
}

export function inputPins(input: PolicyInput): boolean[] {
  const i = inputToIndex(input);
  return Array.from({ length: INPUT_PINS }, (_, p) => bit(i, p));
}

/** Bytes to pass to eval(circuitId, input). */
export function encodeInput(input: PolicyInput): Uint8Array {
  return packPins(inputPins(input));
}

/** Decode the bytes eval() returns. */
export function decodeOutput(bytes: Uint8Array): PolicyOutput {
  const [allow, r0, r1] = unpackPins(bytes, OUTPUT_PINS) as [boolean, boolean, boolean];
  return { allow, routeTier: (Number(r0) | (Number(r1) << 1)) as Tier };
}

/** All 64 inputs, in index order. */
export const ALL_INPUTS: readonly PolicyInput[] = Array.from({ length: INPUT_COUNT }, (_, n) => indexToInput(n));
