import { describe, expect, it } from "vitest";
import { parseEther } from "viem";
import { parseWithdraw, withdrawable } from "../src/lib/withdraw.ts";

const okb = (s: string) => parseEther(s);

describe("withdrawable", () => {
  it("is the on-chain balance (deposits minus settled usage) minus usage not settled yet", () => {
    // deposited 0.002, 0.0003 already settled → balance 0.0017; 0.0001 used but not settled
    expect(withdrawable(okb("0.0017"), okb("0.0001"))).toBe(okb("0.0016"));
  });
  it("never goes below zero when pending usage exceeds the balance", () => {
    expect(withdrawable(okb("0.0001"), okb("0.0005"))).toBe(0n);
  });
  it("is the whole balance when nothing is pending, or pending is unknown", () => {
    expect(withdrawable(okb("0.002"), 0n)).toBe(okb("0.002"));
    expect(withdrawable(okb("0.002"), undefined)).toBe(okb("0.002"));
  });
});

describe("parseWithdraw", () => {
  const max = okb("0.0016");
  it("accepts any amount up to the maximum, including exactly the maximum", () => {
    expect(parseWithdraw("0.001", max)).toEqual({ wei: okb("0.001") });
    expect(parseWithdraw(" 0.0016 ", max)).toEqual({ wei: max });
  });
  it("refuses more than can be withdrawn, by even one wei", () => {
    expect(parseWithdraw("0.0016000000000001", max)).toEqual({ error: "You can withdraw at most 0.0016 OKB." });
    expect(parseWithdraw("1", max)).toEqual({ error: "You can withdraw at most 0.0016 OKB." });
  });
  it("refuses empty, zero, negative and non-numeric input", () => {
    expect(parseWithdraw("", max)).toEqual({ error: "Enter an amount in OKB." });
    expect(parseWithdraw("0", max)).toEqual({ error: "Enter an amount above zero." });
    expect(parseWithdraw("-1", max)).toHaveProperty("error");
    expect(parseWithdraw("abc", max)).toEqual({ error: "Enter an amount in OKB, for example 0.001." });
  });
  it("says so when nothing can be withdrawn", () => {
    expect(parseWithdraw("0.001", 0n)).toEqual({ error: "Nothing to withdraw right now." });
  });
});
