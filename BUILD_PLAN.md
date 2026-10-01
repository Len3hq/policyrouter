# PolicyRouter — Phase-by-Phase Build Plan

This plan breaks the build plan in [policyrouter-spec.md](policyrouter-spec.md) into phases. Each phase has tasks, the tests that prove it works, and an exit gate. Do not start a phase until the previous gate passes. The only exception is Phase 0, whose spikes can overlap with Phase 1.

Phases 1–4 cover everything that is pass/fail or core. Phases 5–8 only add points.

| Phase | Goal | Spec step |
| --- | --- | --- |
| 0 | Repo, tooling, and answers to the open questions that block code | — |
| 1 | Qualify: processor deployed, Budget Guard taped out and proven | Step 1 |
| 2 | PolicyRegistry and CreditEscrow, tested on a mainnet fork, deployed | Step 2 |
| 3 | Router: one request end to end with an on-chain policy check and signed receipt | Step 2 |
| 4 | Settler: Merkle roots posted, escrow debited | Step 3 |
| 5 | Remaining templates and policy simulation | Step 3 |
| 6 | Web app: fund, choose policy, dashboard, 60-second quickstart | Step 3 |
| 7 | Verify page | Step 3 |
| 8 | Extras: custom policy builder, second provider, thin SDK | Step 4 |
| 9 | Demo rehearsal and submission | — |

---

## Repo layout

One monorepo using pnpm workspaces, so every part shares one copy of the policy definitions.

```
policyrouter/
  contracts/            Foundry: PolicyRegistry, CreditEscrow, Treasury, fork tests
  packages/policy/      Pure TS: bit encoding, template truth tables, receipt type, Merkle leaf hashing
  circuits/             Truth tables (JSON), gate counts, the 64-row eval() check script
  router/               Hono server: gateway, catalog, chain reader, checker, adapters, metering, settler
  web/                  Next.js or Vite + wagmi: owner app, Verify page
  e2e/                  Scripts that drive a real agent through the router
```

`packages/policy` is the single source of truth. The circuit check script, the router, the simulation and the Verify page all import it. If it disagrees with the on-chain circuit, a test fails.

**Test tools:** Foundry (`forge test`) for contracts, Vitest for TypeScript, Playwright for the web app. CI runs `forge test`, `pnpm -r test` and the lint step on every push. Fork tests and live-chain tests run behind an env flag, so CI does not need mainnet keys.

---

## Phase 0 — Setup and blocking questions

**Tasks**

- [x] Create the monorepo skeleton, CI, and `.env.example` (RPC URL, router key, DeepSeek key)
- [ ] Create two wallets: deployer (holds OKB, creates processor) and router (signs receipts, calls `settle`). Run `scripts/setup-wallets.sh`
- [ ] Get OKB on X Layer for gas and fees (at least 0.05 OKB to the deployer)
- [x] Spike: find the TapeOut factory address on X Layer and its function names for create processor, mint transistors, tape out, `eval`. Save the ABI to `contracts/abi/`
- [x] Spike: how `eval(uint256, bytes)` packs input and output bits. Proven by taping out a 2-gate circuit on a mainnet fork
- [x] Spike: transistor token standard on X Layer, whether a contract can be the processor's creator, whether TapeOut takes a cut of mint proceeds
- [x] Check DeepSeek's terms on reselling access through a router

**Tests**

- [x] `packages/policy`: pin-packing and constants tests (7 Vitest tests)
- [x] `contracts`: `test/fork/TapeOutSpike.t.sol`, 5 tests against a fork of `https://rpc.xlayer.tech` (factory deployed, create processor, contract as creator, creator paid in full, `eval` pin layout)
- [ ] CI green on GitHub (needs the repo pushed)

**Exit gate:** CI is green. The bit-packing answer is written down in `packages/policy/README.md`. The factory ABI is checked in.

---

## Phase 1 — Qualify (pass/fail)

The goal is to meet every pass/fail requirement before writing product code.

**Tasks**

1. **Bit encoding** in `packages/policy/src/bits.ts`
   - `encodeInput({ tier, size, budgetOk, kill }) → bytes` and `decodeOutput(bytes) → { allow, routeTier }`, following the packing found in Phase 0
2. **Budget Guard truth table** in `packages/policy/src/templates.ts`
   - `budgetGuard(input) → output`: allow if `kill = 0` and `budget_ok = 1`; `route_tier = tier`
   - Decide what `route_tier` is when denied, for example `0`, and keep it the same across all templates
   - `circuits/budget-guard.json`: all 64 rows generated from the function
3. **Build the netlist.** `tapeout()` takes raw netlist bytes (format in `packages/policy/README.md`), so generate it from the truth table by script, or with Fabrica's Verilog-to-NAND compiler, instead of wiring on the canvas. Simulate it locally against all 64 rows, then record the gate count in `circuits/README.md`
4. **Treasury contract (optional, decide now).** If a contract can be the processor's creator, deploy `Treasury.sol` to create the processor in its constructor, with a fixed public split. If not, create the processor from the deployer wallet
5. **Deploy the processor** on X Layer mainnet with supply 1,000,000, price 0.0001 OKB, and the stated reserve. Record the addresses in `deployments/xlayer.json`
6. **Mint transistors and tape out** Budget Guard. Record its circuit ID
7. **Check script** `circuits/check.ts <circuitId> <template>` calls `eval()` for all 64 inputs and compares each result with `packages/policy`

**Tests**

| Test | Where | Asserts |
| --- | --- | --- |
| Encode/decode round trip | `packages/policy` Vitest | For all 64 inputs, `decode(encode(x))` returns `x`; output decoding is correct for all 8 output values |
| Budget Guard table | `packages/policy` Vitest | `kill = 1` always denies; `budget_ok = 0` always denies; otherwise allow with `route_tier = tier` (64 rows) |
| Golden file | `packages/policy` Vitest | The generated `budget-guard.json` matches the committed file (catches silent edits) |
| Treasury | `contracts` forge, fork | The constructor creates a processor through the real factory; mint proceeds land in the treasury; the split pays out to fixed addresses; nobody can change the split |
| On-chain match | `circuits/check.ts` against mainnet | 64 of 64 rows match. Save the output to `circuits/proof/budget-guard.txt` for the demo |

**Exit gate:** `check.ts` prints 64/64 on mainnet. Processor address, deployer address, supply, price and cap are in the README. **At this point the project qualifies.**

---

## Phase 2 — Smart contracts

**Tasks**

1. **PolicyRegistry**
   - `registerKey(keyHash, circuitId, dailyCap)` sets the caller as owner and checks the circuit exists on the processor
   - Owner only: `setCircuit`, `setDailyCap`, `setKill(bool)`, `transferKey` / key rotation
   - Views: `killed(keyHash)`, `policyOf(keyHash) → (owner, circuitId, dailyCap)`
   - Events for each change
2. **CreditEscrow**
   - `deposit(keyHash, amount)` in OKB (native) first. USDT comes later, as one ERC-20 path through SafeERC20
   - `withdraw(keyHash, amount)` is owner only and limited to the unused balance
   - `settle(batchId, merkleRoot, entries[])` is router only. Each entry is `(keyHash, cost)`. For each entry it debits the balance, adds to the day's spend, and stores the root with `block.number`
   - Capped debit: if an entry exceeds the balance or the remaining daily cap, debit the capped amount and emit `Shortfall(keyHash, amount)`. Do not revert, so one bad key cannot block a whole batch
   - `budgetOk(keyHash)` returns true if `spentToday < dailyCap` and `balance > 0`. The day is `block.timestamp / 1 days`, so spend resets automatically
   - `spentToday(keyHash)`, `rootOf(batchId) → (root, blockNumber)`
3. **Deploy script** `script/Deploy.s.sol` writes the addresses into `deployments/xlayer.json`

**Tests (Foundry, on a fork of X Layer mainnet)**

PolicyRegistry
- [ ] `registerKey` stores owner, circuit, cap and emits `KeyRegistered`
- [ ] `registerKey` reverts if the key is already registered
- [ ] `registerKey` and `setCircuit` revert for a circuit ID that does not exist on the real processor
- [ ] Non-owner calls to `setCircuit`, `setDailyCap`, `setKill` and `rotateKey` revert
- [ ] `setKill(true)` makes `killed()` return true; `setKill(false)` reverses it
- [ ] Key rotation moves the policy to a new hash, and the old hash reads as unregistered

CreditEscrow
- [ ] Deposit raises the balance and emits `Deposit`
- [ ] Owner can withdraw unused balance; a non-owner cannot; withdrawing more than the balance reverts
- [ ] `settle` from a non-router address reverts
- [ ] `settle` debits correctly and stores the root and block number
- [ ] `settle` never debits more than the balance (emits `Shortfall`)
- [ ] `settle` never pushes `spentToday` past the cap (emits `Shortfall`)
- [ ] `budgetOk` flips to false at the cap and back to true after `vm.warp` by one day
- [ ] Re-using a `batchId` reverts
- [ ] Reentrancy: a malicious owner contract re-entering `withdraw` cannot drain funds
- [ ] **Fuzz:** random deposits, settles and withdraws never leave the contract's OKB balance below the sum of key balances
- [ ] **Invariant:** for every key, `spentToday ≤ dailyCap` and `balance ≥ 0`

Merkle compatibility
- [ ] A root built in TypeScript with `@openzeppelin/merkle-tree` verifies in Solidity with `MerkleProof.verify` (shared test vector in `packages/policy/test/vectors.json`)

**Exit gate:** all forge tests pass on the fork, coverage is ≥ 90% lines on both contracts, and both are deployed to mainnet and verified on OKLink.

---

## Phase 3 — Router core

The goal is one real request going agent → router → `eval()` → DeepSeek → agent, with a signed receipt.

**Tasks**

1. **Database (SQLite + Drizzle):** tables for `keys`, `usage`, `receipts`, `batches`
2. **Key issuing:** a CLI command, `pnpm router key:create`, generates `pr-live-…`, stores only its hash, and prints the hash to register on chain. The web app takes this over in Phase 6
3. **Model catalog** `router/src/catalog.ts`: four models mapped to tiers 0–3, provider, price per million input and output tokens
4. **Chain reader:** reads `killed`, `budgetOk` and `policyOf` at a pinned block through viem multicall, with a cache of a few seconds keyed by block
5. **Policy checker:** builds the input with `encodeInput` from `packages/policy`, calls `eval` with `eth_call` at the pinned block, and decodes the output
6. **Size bucket:** count prompt tokens with a tokenizer and add `max_tokens`. Bucket thresholds go in the catalog config
7. **Gateway** (Hono)
   - `POST /v1/chat/completions` (streaming and non-streaming), `GET /v1/models`
   - Auth by `Authorization: Bearer pr-live-…`, looked up by hash
   - Errors use the OpenAI error shape. A deny returns 403 `policy_denied` with the receipt
8. **DeepSeek adapter:** OpenAI SDK with DeepSeek's base URL; streams responses back
9. **Metering:** read `usage` from the provider response, or from the last stream chunk with `stream_options.include_usage`, and compute the cost at the served tier
10. **Receipt signer:** EIP-712 typed data signed by the router key. Returned in the `x-policyrouter-receipt` header and in a `policyrouter_receipt` body field (sent as the final SSE event when streaming)
11. **Rate limit** per key, for example a token bucket in memory

**Must-haves (each one has a test below)**

- Fail closed: if `eval()` or a chain read fails, refuse the request
- Every receipt records the block that was read
- Provider keys never appear in a response or a log

**Tests**

Unit (Vitest)

| Area | Cases |
| --- | --- |
| Catalog | Every model has a tier from 0 to 3 and a price; unknown model returns 404 `model_not_found` |
| Size bucket | Boundary values at each threshold land in the correct bucket |
| Checker | With a mocked `eval`, allow, deny and downgrade decode correctly; an `eval` that throws or times out causes a deny (fail closed) |
| Metering | Cost for known token counts matches a hand-worked value; downgraded requests are charged at the served tier |
| Receipt | Signature recovers to the router address; changing any field breaks it; JSON schema matches the spec |
| Auth | Missing, malformed, or unknown key returns 401; the key itself is never logged |
| Rate limit | Request N+1 in the window returns 429 |

Integration (Vitest, with the contracts deployed to a local `anvil --fork-url` and a mock provider server)

- [ ] Allowed request: forwarded at the requested tier, receipt returned, usage row written
- [ ] Downgrade: under Cheap Only (deployed on the fork for testing), a tier-3 request is served by the tier-1 model, and the receipt shows `modelRequested ≠ modelServed`
- [ ] Kill switch: `setKill(true)` on chain makes the next request return 403 with no call to the provider
- [ ] Cap reached: the next request after the cap returns 403
- [ ] RPC down: stop anvil, and the request returns 503 with no provider call
- [ ] Streaming: chunks arrive in order, usage is metered, and the receipt arrives as the last event
- [ ] Receipt replay: re-running `eval()` at `receipt.blockNumber` with `receipt.inputBits` gives `receipt.outputBits`

Live smoke test (manual, mainnet + real DeepSeek)

- [ ] `curl` one request with a real key and Budget Guard, then confirm the receipt with `circuits/check.ts`-style replay

**Exit gate:** all unit and integration tests pass, and one live request is served on mainnet with a receipt that verifies.

---

## Phase 4 — Settler

**Tasks**

1. Every N minutes (start with 5), collect unsettled receipts
2. Build a tree with `@openzeppelin/merkle-tree`, where each leaf is the hash of the receipt's EIP-712 struct, using `packages/policy`
3. Sum cost per key and call `CreditEscrow.settle(batchId, root, entries)` from the router wallet
4. Store the batch, the tx hash, and every receipt's Merkle proof. Add `GET /v1/receipts/:id` returning the receipt, its proof and `batchId`
5. Retry safely: a batch is only marked settled after the tx is confirmed; a resend uses the same `batchId`, so a double settle reverts

**Tests**

- [ ] Unit: tree built from 1, 2 and 1,000 receipts; every proof verifies locally
- [ ] Unit: per-key sums match the sum of receipt costs
- [ ] Integration (anvil fork): after a settle, escrow balances drop by the summed cost and `rootOf(batchId)` matches
- [ ] Integration: each stored proof verifies against the on-chain root via `MerkleProof.verify` (an `eth_call` to a tiny test helper)
- [ ] Integration: kill the settler between sending and confirming, restart it, and check that nothing is double debited or lost
- [ ] Integration: an empty interval sends no transaction

**Exit gate:** a settled batch is visible on OKLink, and a receipt from it verifies against the on-chain root.

---

## Phase 5 — Remaining templates and policy simulation

**Tasks**

1. Add `cheapOnly`, `smallRequests` and `strict` to `packages/policy`, with golden JSON truth tables
2. Wire, simulate, tape out each one, and run `check.ts` (64/64 each). Record the gate counts
3. **Simulation** `packages/policy/src/simulate.ts`
   - `simulate(template, requests[], catalog) → { allowed, downgraded, denied, spendWithout, spendWith, savingsPct }`
   - The inputs are the last 100 rows from `usage` (requested model, size bucket, flags at the time). Prices come from the catalog
   - When there is no history, use a fixed sample workload in `packages/policy/src/sample-workload.json`
4. Router endpoint `GET /v1/simulate?template=…` for the web app, scoped to the caller's key

**Tests**

| Test | Asserts |
| --- | --- |
| Template tables | Each template's 64 rows match its plain-English rule. Example: Cheap Only never outputs `route_tier > 1`; Small Requests denies every row with `size = 3`; Strict equals Cheap Only plus Small Requests row by row |
| Property tests (fast-check) | No template ever allows when `kill = 1` or `budget_ok = 0`; no template ever routes above the requested tier |
| On-chain match | `check.ts` gives 64/64 for each of the three new circuits |
| Simulation counts | allowed + downgraded + denied = number of requests |
| Simulation money | A hand-built set of 10 requests gives exact expected spends; denied requests cost 0; `savingsPct` is 0 under a policy that allows everything at the requested tier |
| Simulation vs router | Replay the integration-test traffic from Phase 3 through `simulate`. Its allow, downgrade and deny counts equal the router's actual counts |
| Endpoint | A key can only simulate its own history |

**Exit gate:** four templates are live on mainnet with proofs, and simulation output matches real router decisions.

---

## Phase 6 — Web app

**Tasks**

1. **Connect and fund:** wagmi with X Layer chain config, deposit OKB, show the balance
2. **Create agent:** generate the key in the browser, show it once, call `registerKey` with its hash, and send the hash to the router
3. **Choose a policy:** four template cards, each with its plain-English rule, a link to its circuit on the TapeOut processor page, and a **Simulate** panel (allowed, downgraded and denied counts plus savings). The **Use this policy** button calls `setCircuit`
4. **Agent dashboard:** base URL, key, spend today against the cap, allow/downgrade/deny counts, the kill switch, and an "edit cap" field
5. **60-second quickstart panel:** copy buttons for:
   ```bash
   export OPENAI_BASE_URL=https://api.policyrouter.xyz/v1
   export OPENAI_API_KEY=pr-live-...
   ```
   plus short tabs for Claude Code, Codex and the OpenAI SDK
6. Transistor facts shown in the footer: supply, price, cap, amount burned so far

**Tests**

Component (Vitest + Testing Library)
- [ ] Simulation panel renders counts and savings from a fixed response; renders the "sample workload" notice when there is no history
- [ ] The key is shown once and hidden after confirmation
- [ ] Quickstart copy buttons copy exactly the base URL and key

E2E (Playwright, against anvil fork + local router, with a test wallet injected)
- [ ] Full owner flow: connect → deposit → create agent → pick Cheap Only → dashboard shows the policy and balance
- [ ] Kill switch on the dashboard → a `curl` with the key returns 403 → switch off → `curl` succeeds
- [ ] Lowering the cap below today's spend → next request is denied, and the dashboard deny count increases
- [ ] Wrong network → the app prompts a switch to X Layer

60-second test (manual, timed, on mainnet)
- [ ] Starting from a funded agent, set the two env vars and get a response through the router with each of: OpenAI SDK (Node and Python), Claude Code (or its OpenAI-compatible mode, if supported; otherwise note it in the README), Codex. Each is under 60 seconds. Record the results in the README

**Exit gate:** the Playwright suite passes, and the timed quickstart works with at least the OpenAI SDK and one coding agent.

---

## Phase 7 — Verify page

The Verify page must work with no wallet, using only read-only RPC calls.

**Tasks**

1. Paste a receipt, or open `/verify?id=…`, which fetches it from the router
2. Run three checks and show each one with the exact call made:
   - **Signature:** EIP-712 recovery equals the published router address
   - **Policy:** `eval(circuitId, inputBits)` at `blockNumber` equals `outputBits`
   - **Settlement:** the Merkle proof verifies against `rootOf(batchId)`. If the batch is not settled yet, show "pending"
3. Show a green match or a red mismatch, naming the check that failed
4. Show a "re-run this yourself" block with the raw `eth_call` and a link to the block explorer

**Tests**

- [ ] Unit: each check returns pass or fail with a reason, given fixed inputs
- [ ] E2E (Playwright, no wallet extension): a valid allow receipt is green on all three checks
- [ ] E2E: a deny receipt is green (the policy check proves the deny was correct)
- [ ] E2E tamper tests, each red on the correct check:
  - change `outputBits` → policy check fails
  - change `costWei` → signature check fails
  - re-sign a fake receipt with another key → signature check fails
  - use a valid receipt with a wrong proof → settlement check fails
- [ ] E2E: an unsettled receipt shows "pending", not "fail"
- [ ] Manual: open in a private window on a phone, with no wallet, against mainnet

**Exit gate:** a stranger with only the URL can verify a real mainnet receipt.

---

## Phase 8 — Extras

Do these in order.

**8a. Custom policy builder**
- Form with checkboxes for rules (max tier, deny huge requests, and so on) → generated truth table → simulation against recent requests → transistor cost → guided tape-out on our processor → `setCircuit`
- Tests: the generated truth table matches the chosen rules for all 64 rows; the property tests from Phase 5 pass for every combination of checkboxes; E2E on the fork takes a custom policy from form to a served request

**8b. Second provider adapter**
- One more OpenAI-compatible provider for the higher tiers
- Tests: the same adapter contract tests as DeepSeek (non-streaming, streaming, usage, provider errors mapped to OpenAI-shaped errors); the router picks the correct provider for each tier

**8c. Thin TypeScript SDK** (`packages/sdk`)
- `new PolicyRouter({ apiKey }).chat({ model, messages })` wrapping the OpenAI client, plus a `verifyReceipt()` helper that reuses the Verify page's checks
- Tests: it calls the right base URL; a deny comes back as a typed `PolicyDeniedError` carrying the receipt; `verifyReceipt` passes and fails on the same vectors as Phase 7

---

## Phase 9 — Demo and submission

**Tasks**

- [ ] Write `e2e/demo.ts`, which runs the demo script end to end against mainnet and prints each receipt
- [ ] Rehearse the 3-minute demo from the spec three times; time it
- [ ] Record the video
- [ ] README: positioning line, 60-second quickstart, supply, price and cap, all four truth tables with gate counts, contract addresses, how to verify a receipt, honest limits
- [ ] Fill in the submission form: processor address, deployment wallet, demo video and live link, description, GitHub repo

**Tests**

- [ ] `e2e/demo.ts` passes on mainnet before submission
- [ ] A fresh clone: following the README alone, `pnpm i && pnpm test` passes
- [ ] All links in the README resolve; the live URL is up; the Verify page works on a receipt from the recorded demo

**Exit gate:** submitted.

---

## Test summary

| Layer | Tool | Runs in CI | Target |
| --- | --- | --- | --- |
| Policy library (bits, templates, simulation, Merkle leaves) | Vitest + fast-check | Yes | 100% of truth-table rows; properties on every template |
| Contracts | Foundry unit, fuzz, invariant on an X Layer fork | Yes (fork with public RPC) | ≥ 90% line coverage |
| On-chain circuits | `circuits/check.ts` | No (mainnet) | 64/64 per circuit, output saved as proof |
| Router | Vitest unit + integration on anvil fork with a mock provider | Yes | Every must-have has a test |
| Web app and Verify page | Vitest components + Playwright | Yes (anvil fork) | Owner flow, kill switch, tamper tests |
| Live | Smoke tests + `e2e/demo.ts` | No | Passes before submission |
