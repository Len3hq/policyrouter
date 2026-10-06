// How much of a project's escrow balance its owner can withdraw.
//
// CreditEscrow's balance is already deposits minus settled usage, and its withdraw() reverts above
// it. On top of that the app holds back usage the router has metered but not yet settled on chain,
// so those requests can still be paid when the next batch settles (a few minutes).

import { formatEther, parseEther } from "viem";

/** On-chain balance minus pending usage, never below zero. `pending` is unknown without the project's key. */
export function withdrawable(balance: bigint, pending: bigint | undefined): bigint {
  const held = pending ?? 0n;
  return balance > held ? balance - held : 0n;
}

/** Parses the amount typed in OKB and checks it against what can be withdrawn. */
export function parseWithdraw(input: string, max: bigint): { wei: bigint } | { error: string } {
  const text = input.trim();
  if (!text) return { error: "Enter an amount in OKB." };
  let wei: bigint;
  try {
    wei = parseEther(text);
  } catch {
    return { error: "Enter an amount in OKB, for example 0.001." };
  }
  if (wei <= 0n) return { error: "Enter an amount above zero." };
  if (max === 0n) return { error: "Nothing to withdraw right now." };
  if (wei > max) return { error: `You can withdraw at most ${formatEther(max)} OKB.` };
  return { wei };
}
