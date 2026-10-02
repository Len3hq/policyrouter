// Merkle trees over receipt hashes, matching CreditEscrow.isInBatch on chain.
// Each leaf is one bytes32 receipt hash, encoded the StandardMerkleTree way:
//   leaf = keccak256(bytes.concat(keccak256(abi.encode(receiptHash))))

import { StandardMerkleTree } from "@openzeppelin/merkle-tree";

export type Hex32 = `0x${string}`;

export function batchTree(receiptHashes: readonly Hex32[]): StandardMerkleTree<[Hex32]> {
  if (receiptHashes.length === 0) throw new Error("a batch needs at least one receipt");
  return StandardMerkleTree.of(
    receiptHashes.map((h) => [h] as [Hex32]),
    ["bytes32"],
  );
}

export function proofFor(tree: StandardMerkleTree<[Hex32]>, receiptHash: Hex32): Hex32[] {
  for (const [i, [h]] of tree.entries()) {
    if (h.toLowerCase() === receiptHash.toLowerCase()) return tree.getProof(i) as Hex32[];
  }
  throw new Error(`receipt ${receiptHash} is not in the tree`);
}

export function verifyReceipt(root: Hex32, receiptHash: Hex32, proof: readonly Hex32[]): boolean {
  return StandardMerkleTree.verify(root, ["bytes32"], [receiptHash], [...proof]);
}
