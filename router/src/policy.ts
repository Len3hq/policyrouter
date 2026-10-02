// The policy check: chain state + request → input byte → eval() → allow / deny / downgrade.
// Any failure to read chain state or evaluate the circuit is a PolicyUnavailable error, and the
// caller must refuse the request (fail closed).

import { decodeOutput, encodeInput, inputToIndex, outputToIndex, type Size, type Tier } from "@policyrouter/policy";
import type { Hex } from "viem";
import type { ChainReader } from "./chain.ts";

export class PolicyUnavailable extends Error {
  constructor(cause: unknown) {
    super("policy check unavailable", { cause });
  }
}

export class UnknownKey extends Error {
  constructor() {
    super("unknown API key");
  }
}

export interface Decision {
  allow: boolean;
  routeTier: Tier;
  agentId: bigint;
  circuitId: bigint;
  blockNumber: bigint;
  inputBits: number;
  outputBits: number;
}

export async function checkPolicy(chain: ChainReader, keyHash: Hex, tier: Tier, size: Size): Promise<Decision> {
  let state;
  try {
    state = await chain.policyState(keyHash);
  } catch (e) {
    throw new PolicyUnavailable(e);
  }
  if (state.agentId === 0n) throw new UnknownKey();

  const input = { tier, size, budgetOk: state.budgetOk, kill: state.killed };
  let out: Uint8Array;
  try {
    out = await chain.evaluate(state.circuitId, encodeInput(input), state.blockNumber);
  } catch (e) {
    throw new PolicyUnavailable(e);
  }
  if (out.length < 1) throw new PolicyUnavailable(new Error("eval returned no bytes"));
  const decided = decodeOutput(out);
  return {
    allow: decided.allow,
    routeTier: decided.routeTier,
    agentId: state.agentId,
    circuitId: state.circuitId,
    blockNumber: state.blockNumber,
    inputBits: inputToIndex(input),
    outputBits: outputToIndex(decided),
  };
}
