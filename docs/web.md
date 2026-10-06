# Web app

The owner's app: connect a wallet, create and fund a project, choose its policy (with a simulation of what each one would do), and run the project's dashboard. Source: [`web/`](../web). It uses React, Vite and viem, with no wallet SDK: any EIP-1193 browser wallet (OKX Wallet, MetaMask, Rabby…) works.

## What it does

| Screen | What the owner does there |
| --- | --- |
| Landing (no wallet) | Reads what PolicyRouter is, sees the quickstart and the four policies, each simulated on a sample workload, and connects a wallet |
| Wrong network | Gets a **Switch to X Layer** button. If the wallet doesn't know the chain, the app adds it (chain 196, `rpc.xlayer.tech`, OKLink) |
| New project | Picks a policy, a daily cap and a first deposit. Two transactions: `PolicyRegistry.registerAgent`, then `CreditEscrow.deposit` |
| Key reveal | Sees the new `pr-live-…` key **once**, copies it, and confirms it's saved |
| Dashboard | Balance, spend today against the cap, the **kill switch** (`setKill`), **set cap** (`setDailyCap`), **deposit**, **withdraw** (`CreditEscrow.withdraw`, capped at the balance minus usage not settled yet), request counts (allowed, downgraded, denied), and the quickstart with the real key |
| Policy | The four templates, each with its rule, circuit id, gate count, a link to its 64/64 mainnet proof, and a **simulation** on this project's own recent requests. **Use this policy** calls `setCircuit` |
| Footer | Transistor facts read live from chain: supply cap, price, minted, remaining |

## The Verify page

`/verify?id=<requestId>` fetches a receipt from the router, or you can paste one. Either way the page checks it against X Layer with **read-only calls: no wallet, and no trust in the router**. The checks come from [`packages/policy/src/verify.ts`](../packages/policy/src/verify.ts), the same code as `verify-receipt` in the router.

| Check | Passes when |
| --- | --- |
| **Signature** | The receipt's EIP-712 signature recovers to `CreditEscrow.router()`, the only address allowed to settle, fixed on chain |
| **Chain inputs** | At the receipt's block, `PolicyRegistry.policyOf(keyHash)` gives the receipt's project and circuit, and the kill switch and `budget_ok` bits the router fed the circuit match the chain. A router can't claim a budget was fine when it wasn't. Tier and size come from the request itself, which only the project and router saw |
| **Policy decision** | `eval(circuitId, inputBits)` on PolicyRouter's processor at the receipt's block returns the receipt's `outputBits`. A receipt naming another processor fails |
| **Settlement** | `CreditEscrow.isInBatch(batchId, receiptHash, proof)` is true. Shown as **pending**, not failed, until the receipt's batch is settled |

The page shows a green **Verified**, an amber **pending** (nothing failed, but something isn't settled or checkable yet), or a red **Mismatch** naming the failed checks. Every check has a "Re-run this yourself" panel with the exact `cast call` (at the receipt's block) and the raw `eth_call` JSON, with links to OKLink.

If an RPC has no state for an old block, the policy check falls back to the latest block (circuits can never change, so the answer is the same), and the chain-inputs check reports *unavailable* rather than failing. `rpc.xlayer.tech` served state from about 286,000 blocks back when this was built.

Each request in the dashboard's request list links to its Verify page.

**Hosting note:** `/verify` is a client-side route. A static host must serve `index.html` for `/verify` (an SPA fallback); `vite preview` already does.

## The docs site

The documentation is served by the app at **`/docs`** as a GitBook-style site: grouped navigation, search, an "on this page" outline, previous and next links, and copy buttons on code blocks. It renders the markdown files in [`docs/`](README.md) directly, using `SUMMARY.md` as the table of contents, so the same files can also be published to GitBook (see [`.gitbook.yaml`](../.gitbook.yaml)). The code is in `web/src/docs/` and `web/src/components/DocsPage.tsx`.

Links between pages work both on GitHub and on the site: relative `.md` links become `/docs/...` routes, and links to files outside `docs/` become GitHub links. Like `/verify`, `/docs/...` is a client-side route, so a static host needs an SPA fallback to `index.html`.

## Where the key lives

- The key is generated **in the browser** (`crypto.getRandomValues`). Only `keccak256(key)` goes on chain.
- After creation it is kept in **this tab's session storage**, so the dashboard can show usage and simulate with it. It disappears when the tab closes. It is sent only to the router, as the bearer token.
- In a new session the owner pastes the key to unlock usage. The app checks it against the project's on-chain key hash before using it.

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
| Verifier (14, in `packages/policy`) | `pnpm --filter @policyrouter/policy test` | Each check returns pass or fail with a reason for fixed inputs: a valid allow or deny receipt; changed `outputBits` (policy fails); changed `costWei` (signature fails); re-signed by another key (signature fails); wrong proof (settlement fails); unsettled (pending); a router lying about `budget_ok` or the circuit (inputs fail); a foreign processor; no historical state (latest-block fallback); exact `cast` and `eth_call` output; parsing pasted input |
| Docs (13, in the component suite) | `pnpm --filter @policyrouter/web test` | SUMMARY parsing, link rewriting, heading ids, search; **every markdown file is in the navigation; no broken internal link or anchor; every code fence closed**; the contract addresses in the docs match the deployment record; navigation, search and copy buttons in the page |
| Component (11) | `pnpm --filter @policyrouter/web test` | Simulation panel (counts, savings, sample-workload notice, singular wording); key shown once and hidden after confirming; copy buttons copy exactly the base URL, the key and the two export lines; Codex and Claude Code snippets; browser-generated keys hash exactly as the router does |
| E2E (19) | `pnpm --filter @policyrouter/web test:e2e` | Against an anvil fork of mainnet (real contracts and circuits), the real router process, a mock provider and the Vite dev server, with the test wallet: the full owner flow (connect, create, save key, switch to Cheap Only, a downgraded request counted on the dashboard); kill switch on (403) and off (200); lowering the cap below settled spend (denied, deny count +1); a pasted key unlocking usage (a wrong key is refused); wrong network (switch prompt); the landing page. **Verify page, with no wallet,** on receipts from the real router, settled by the real settler on a fork: an allow and a deny receipt are green on all four checks; changed `outputBits` fails the policy check; changed `costWei` fails the signature; a receipt re-signed by another key fails the signature; a wrong proof fails settlement; an unsettled receipt is pending; a bad id is explained. **Docs**, in a real browser: navigation without a reload, deep links with anchors, search, links to Verify and to GitHub, and the phone menu with no sideways overflow |

The E2E harness sets every router variable explicitly, so nothing from the repo's `.env` is used, and it never touches mainnet. It deploys its own PolicyRegistry and CreditEscrow on the fork (bound to the live processor and circuits) with the test router as `CreditEscrow.router`, so receipts verify and the real settler can settle.
