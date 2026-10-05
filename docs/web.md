# Web app

The owner's app: connect a wallet, create and fund an agent, choose its policy (with a simulation of what each one would do), and run the agent's dashboard. Source: [`web/`](../web). It uses React, Vite and viem, with no wallet SDK: any EIP-1193 browser wallet (OKX Wallet, MetaMask, Rabby…) works.

## What it does

| Screen | What the owner does there |
| --- | --- |
| Landing (no wallet) | Reads what PolicyRouter is, sees the quickstart and the four policies, each simulated on a sample workload, and connects a wallet |
| Wrong network | Gets a **Switch to X Layer** button. If the wallet doesn't know the chain, the app adds it (chain 196, `rpc.xlayer.tech`, OKLink) |
| New agent | Picks a policy, a daily cap and a first deposit. Two transactions: `PolicyRegistry.registerAgent`, then `CreditEscrow.deposit` |
| Key reveal | Sees the new `pr-live-…` key **once**, copies it, and confirms it's saved |
| Dashboard | Balance, spend today against the cap, the **kill switch** (`setKill`), **set cap** (`setDailyCap`), **deposit**, request counts (allowed, downgraded, denied), and the quickstart with the real key |
| Policy | The four templates, each with its rule, circuit id, gate count, a link to its 64/64 mainnet proof, and a **simulation** on this agent's own recent requests. **Use this policy** calls `setCircuit` |
| Footer | Transistor facts read live from chain: supply cap, price, minted, remaining |

## Where the key lives

- The key is generated **in the browser** (`crypto.getRandomValues`). Only `keccak256(key)` goes on chain.
- After creation it is kept in **this tab's session storage**, so the dashboard can show usage and simulate with it. It disappears when the tab closes. It is sent only to the router, as the bearer token.
- In a new session the owner pastes the key to unlock usage. The app checks it against the agent's on-chain key hash before using it.

## Running it

```bash
cp web/.env.example web/.env      # VITE_ROUTER_URL, VITE_RPC_URL
pnpm --filter @policyrouter/web dev
pnpm --filter @policyrouter/web build   # static files in web/dist
```

| Env | Meaning |
| --- | --- |
| `VITE_ROUTER_URL` | The router's URL. The quickstart shows `<this>/v1` |
| `VITE_RPC_URL` | X Layer RPC for reads (default `https://rpc.xlayer.tech`) |
| `VITE_TEST_WALLET_KEY` | **E2E only.** Replaces the browser wallet with a built-in test wallet that signs with this key. Never set it in a real build |

The router must allow the app's origin. It does by default (`CORS_ORIGINS` unset means any origin; keys are bearer tokens, so there are no cookies to protect).

## Tests

| Suite | Command | Covers |
| --- | --- | --- |
| Component (11) | `pnpm --filter @policyrouter/web test` | Simulation panel (counts, savings, sample-workload notice, singular wording); key shown once and hidden after confirming; copy buttons copy exactly the base URL, the key and the two export lines; Codex and Claude Code snippets; browser-generated keys hash exactly as the router does |
| E2E (5) | `pnpm --filter @policyrouter/web test:e2e` | Against an anvil fork of mainnet (real contracts and circuits), the real router process, a mock provider and the Vite dev server, with the test wallet: the full owner flow (connect, create, save key, switch to Cheap Only, a downgraded request counted on the dashboard); kill switch on (403) and off (200); lowering the cap below settled spend (denied, deny count +1); a pasted key unlocking usage (a wrong key is refused); wrong network (switch prompt); the landing page |

The E2E harness sets every router variable explicitly, so nothing from the repo's `.env` is used, and it never touches mainnet.
