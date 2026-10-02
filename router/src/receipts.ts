// Signs receipts with the router key (EIP-712, see @policyrouter/policy receipt.ts).

import { randomBytes } from "node:crypto";
import type { Hex, LocalAccount, TypedDataDomain } from "viem";
import { receiptHash, typedReceipt, type Receipt, type SignedReceipt } from "@policyrouter/policy";

export interface ReceiptSigner {
  readonly address: Hex;
  readonly domain: TypedDataDomain;
  sign(r: Receipt): Promise<{ receipt: SignedReceipt; hash: Hex }>;
}

export function createReceiptSigner(account: LocalAccount, domain: TypedDataDomain): ReceiptSigner {
  return {
    address: account.address,
    domain,
    async sign(r) {
      const routerSig = await account.signTypedData(typedReceipt(r, domain));
      return { receipt: { ...r, routerSig }, hash: receiptHash(r, domain) };
    },
  };
}

export function newRequestId(): Hex {
  return `0x${randomBytes(32).toString("hex")}`;
}
