// A minimal EIP-1193 wallet for end-to-end tests: it holds one private key, signs locally, and
// forwards everything else to the RPC. It is only constructed when VITE_TEST_WALLET_KEY is set,
// which real builds never do.

import { createWalletClient, http, numberToHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { xlayer } from "./chain.ts";
import { CONFIG } from "./config.ts";
import type { Eip1193 } from "./wallet.ts";

type Listener = (...args: unknown[]) => void;

export function createTestWallet(privateKey: Hex, initialChainId: number): Eip1193 {
  const account = privateKeyToAccount(privateKey);
  const wallet = createWalletClient({ account, chain: xlayer, transport: http(CONFIG.rpcUrl) });
  let chainId = initialChainId;
  // Like a real wallet: no accounts are exposed until the user approves a connection.
  let connected = false;
  const listeners = new Map<string, Set<Listener>>();
  const emit = (ev: string, ...args: unknown[]) => listeners.get(ev)?.forEach((l) => l(...args));

  const rpc = async (method: string, params: unknown[] = []) => {
    const res = await fetch(CONFIG.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
    });
    const j = (await res.json()) as { result?: unknown; error?: { message: string } };
    if (j.error) throw new Error(j.error.message);
    return j.result;
  };

  return {
    async request({ method, params = [] }) {
      switch (method) {
        case "eth_accounts":
          return connected ? [account.address] : [];
        case "eth_requestAccounts":
          connected = true;
          emit("accountsChanged", [account.address]);
          return [account.address];
        case "eth_chainId":
          return numberToHex(chainId);
        case "wallet_switchEthereumChain": {
          chainId = Number((params[0] as { chainId: string }).chainId);
          emit("chainChanged", numberToHex(chainId));
          return null;
        }
        case "wallet_addEthereumChain":
          return null;
        case "eth_sendTransaction": {
          if (chainId !== CONFIG.chainId) throw new Error("test wallet: wrong network");
          const tx = params[0] as { to: Hex; data?: Hex; value?: Hex; gas?: Hex };
          return wallet.sendTransaction({
            to: tx.to,
            data: tx.data,
            value: tx.value ? BigInt(tx.value) : undefined,
            gas: tx.gas ? BigInt(tx.gas) : undefined,
          });
        }
        case "personal_sign":
          return account.signMessage({ message: { raw: params[0] as Hex } });
        default:
          return rpc(method, params as unknown[]);
      }
    },
    on(ev, cb) {
      if (!listeners.has(ev)) listeners.set(ev, new Set());
      listeners.get(ev)!.add(cb);
    },
    removeListener(ev, cb) {
      listeners.get(ev)?.delete(cb);
    },
  };
}
