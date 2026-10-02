import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { batchTree, proofFor, verifyReceipt, type Hex32 } from "../src/index.ts";
import { buildVectors, vectorsPath } from "../scripts/merkle-vectors.ts";

const h = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex32;

describe("batch trees", () => {
  it("proves every receipt in batches of 1, 2 and 1,000", () => {
    for (const size of [1, 2, 1000]) {
      const receipts = Array.from({ length: size }, (_, i) => h(i + 1));
      const tree = batchTree(receipts);
      for (const r of receipts) expect(verifyReceipt(tree.root as Hex32, r, proofFor(tree, r))).toBe(true);
    }
  });

  it("rejects a receipt that is not in the batch", () => {
    const tree = batchTree([h(1), h(2), h(3)]);
    expect(verifyReceipt(tree.root as Hex32, h(4), proofFor(tree, h(1)))).toBe(false);
    expect(() => proofFor(tree, h(4))).toThrow(/not in the tree/);
  });

  it("rejects an empty batch", () => {
    expect(() => batchTree([])).toThrow(/at least one/);
  });
});

describe("test/vectors.json", () => {
  it("matches what the generator produces (run `pnpm --filter @policyrouter/policy vectors` after changing merkle.ts)", () => {
    expect(JSON.parse(readFileSync(vectorsPath, "utf8"))).toEqual(buildVectors());
  });
});
