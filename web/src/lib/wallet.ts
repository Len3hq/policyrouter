// The browser wallet (any EIP-1193 provider: MetaMask, OKX Wallet, Rabby…), with viem on top.

import { useCallback, useEffect, useMemo, useState } from "react";
import { createWalletClient, custom, numberToHex, type Abi, type Address, type Hex, type TransactionReceipt } from "viem";
import { publicClient, xlayer } from "./chain.ts";
import { CONFIG } from "./config.ts";
import { createTestWallet } from "./testWallet.ts";

export interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, cb: (...args: unknown[]) => void): void;
  removeListener?(event: string, cb: (...args: unknown[]) => void): void;
}

let testWallet: Eip1193 | undefined;

// Wallets keep a site authorized, so on load eth_accounts would silently reconnect. After the user
// disconnects we remember it in this browser and skip that until they click Connect again.
const DISCONNECTED = "policyrouter:disconnected";
const wasDisconnected = () => {
  try {
    return localStorage.getItem(DISCONNECTED) === "1";
  } catch {
    return false;
  }
};
const setDisconnected = (on: boolean) => {
  try {
    if (on) localStorage.setItem(DISCONNECTED, "1");
    else localStorage.removeItem(DISCONNECTED);
  } catch {
    // storage unavailable: disconnect still lasts until the page reloads
  }
};

export function getProvider(): Eip1193 | undefined {
  if (CONFIG.testWalletKey) return (testWallet ??= createTestWallet(CONFIG.testWalletKey, CONFIG.testWalletChainId));
  return (globalThis as { ethereum?: Eip1193 }).ethereum;
}

export interface Wallet {
  provider: Eip1193 | undefined;
  address: Address | undefined;
  chainId: number | undefined;
  wrongNetwork: boolean;
  error: string | undefined;
  connect(): Promise<void>;
  /** Forgets the account here, stops auto-reconnecting, and asks the wallet to drop this site's permission if it can. */
  disconnect(): Promise<void>;
  switchToXLayer(): Promise<void>;
  /** Sends a contract call from the connected account and waits for it to be mined. */
  write(args: { address: Address; abi: Abi; functionName: string; args?: unknown[]; value?: bigint }): Promise<TransactionReceipt>;
}

export function useWallet(): Wallet {
  const provider = useMemo(getProvider, []);
  const [address, setAddress] = useState<Address>();
  const [chainId, setChainId] = useState<number>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!provider) return;
    const onAccounts = (a: unknown) => setAddress(wasDisconnected() ? undefined : (((a as string[])[0] as Address | undefined) ?? undefined));
    const onChain = (c: unknown) => setChainId(Number(c));
    provider.on?.("accountsChanged", onAccounts);
    provider.on?.("chainChanged", onChain);
    void provider.request({ method: "eth_accounts" }).then(onAccounts).catch(() => undefined);
    void provider.request({ method: "eth_chainId" }).then(onChain).catch(() => undefined);
    return () => {
      provider.removeListener?.("accountsChanged", onAccounts);
      provider.removeListener?.("chainChanged", onChain);
    };
  }, [provider]);

  const connect = useCallback(async () => {
    setError(undefined);
    if (!provider) {
      setError("No wallet found. Install a browser wallet such as OKX Wallet or MetaMask.");
      return;
    }
    try {
      setDisconnected(false);
      const accounts = (await provider.request({ method: "eth_requestAccounts" })) as Address[];
      setAddress(accounts[0]);
      setChainId(Number(await provider.request({ method: "eth_chainId" })));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [provider]);

  const disconnect = useCallback(async () => {
    setDisconnected(true);
    setAddress(undefined);
    setError(undefined);
    // EIP-2255: supported by MetaMask and some others; wallets without it just keep the site authorized
    await provider?.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] }).catch(() => undefined);
  }, [provider]);

  const switchToXLayer = useCallback(async () => {
    if (!provider) return;
    setError(undefined);
    const chainIdHex = numberToHex(CONFIG.chainId);
    try {
      await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainIdHex }] });
    } catch (e) {
      // 4902: the wallet doesn't know the chain yet
      if ((e as { code?: number }).code !== 4902) {
        setError((e as Error).message);
        return;
      }
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: chainIdHex,
            chainName: "X Layer",
            nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
            rpcUrls: [CONFIG.rpcUrl],
            blockExplorerUrls: [CONFIG.explorer],
          },
        ],
      });
    }
    setChainId(Number(await provider.request({ method: "eth_chainId" })));
  }, [provider]);

  const write = useCallback<Wallet["write"]>(
    async ({ address: to, abi, functionName, args, value }) => {
      if (!provider || !address) throw new Error("Connect a wallet first.");
      const client = createWalletClient({ account: address, chain: xlayer, transport: custom(provider) });
      const hash: Hex = await client.writeContract({ address: to, abi, functionName, args, value } as never);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`Transaction ${hash} reverted.`);
      return receipt;
    },
    [provider, address],
  );

  return {
    provider,
    address,
    chainId,
    wrongNetwork: address !== undefined && chainId !== undefined && chainId !== CONFIG.chainId,
    error,
    connect,
    disconnect,
    switchToXLayer,
    write,
  };
}
