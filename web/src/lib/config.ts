import { POLICYROUTER, XLAYER_CHAIN_ID } from "@policyrouter/policy";

export const CONFIG = {
  /** The PolicyRouter service (OpenAI-compatible API) */
  routerUrl: (import.meta.env.VITE_ROUTER_URL as string | undefined) ?? "http://localhost:8787",
  rpcUrl: (import.meta.env.VITE_RPC_URL as string | undefined) ?? "https://rpc.xlayer.tech",
  chainId: XLAYER_CHAIN_ID,
  registry: POLICYROUTER.policyRegistry,
  escrow: POLICYROUTER.creditEscrow,
  processor: POLICYROUTER.processor,
  transistors: POLICYROUTER.transistors,
  explorer: "https://www.oklink.com/xlayer",
  repo: "https://github.com/Len3hq/policyrouter",
  /** E2E only: when set, a built-in wallet signs with this key instead of the browser wallet */
  testWalletKey: import.meta.env.VITE_TEST_WALLET_KEY as `0x${string}` | undefined,
  /** E2E only: the chain the test wallet starts on (`?testChainId=1` simulates a wallet on the wrong network) */
  testWalletChainId: Number(
    (import.meta.env.VITE_TEST_WALLET_KEY && new URLSearchParams(globalThis.location?.search ?? "").get("testChainId")) || XLAYER_CHAIN_ID,
  ),
} as const;

export const baseUrl = () => `${CONFIG.routerUrl.replace(/\/$/, "")}/v1`;
