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

1. [x] **Bit encoding** in `packages/policy/src/bits.ts`
   - `encodeInput({ tier, size, budgetOk, kill }) → bytes` and `decodeOutput(bytes) → { allow, routeTier }`, following the packing found in Phase 0
2. [x] **Budget Guard truth table** in `packages/policy/src/templates.ts`
   - `budgetGuard(input) → output`: allow if `kill = 0` and `budget_ok = 1`; `route_tier = tier`
   - Decided: `route_tier` is `0` whenever a request is denied, in every template
   - `circuits/budget-guard.json`: all 64 rows generated from the function
3. [x] **Build the netlist** with `NetlistBuilder` in `packages/policy/src/netlist.ts`, simulated locally against all 64 rows. Budget Guard is **8 gates** (`circuits/README.md`)
4. [x] **Treasury contract**: `contracts/src/PolicyTreasury.sol` creates the processor in its constructor and receives all mint proceeds. It sends 50% to running costs and keeps 50% in a pool that grants up to 50 free transistors per new owner for their first custom policy. It has no owner and no setters
5. [x] **Deploy the processor** on X Layer mainnet with supply 1,000,000 and price 0.0001 OKB, using `contracts/script/DeployPhase1.s.sol`. Processor `0x11FF9976c86E4C868a803Bc9B5E1ba7749226f99`, treasury `0xad56De63a2F9F5f1170E9044046C15ee467b6288`, transistors `0x8B37B74083Eb87A5B725B152621c729b478262E9` (`deployments/xlayer.json`, `docs/deployments.md`)
6. [x] **Mint transistors and tape out** Budget Guard: **circuit ID 1**, 8 transistors burned
7. [x] **Check script** `circuits/check.ts <circuitId> <template>` calls `eval()` for all 64 inputs at a pinned block and compares each result with the JSON. It also checks the stored netlist, pin counts and gate count. It printed 64/64 against the fork rehearsal

**Tests**

| Test | Where | Asserts |
| --- | --- | --- |
| ✅ Encode/decode round trip | `packages/policy` Vitest | For all 64 inputs, `decode(encode(x))` returns `x`; output decoding is correct for all 8 output values |
| ✅ Budget Guard table | `packages/policy` Vitest | `kill = 1` always denies; `budget_ok = 0` always denies; otherwise allow with `route_tier = tier` (64 rows); the circuit simulation equals the rule on all 64 |
| ✅ Netlist | `packages/policy` Vitest | Encoding matches the 2-gate circuit proven on chain in Phase 0; decode rejects bad opcodes, truncation and forward references |
| ✅ Golden file | `circuits` Vitest | The generated `budget-guard.json` matches the committed file (catches silent edits) |
| ✅ Treasury | `contracts` forge, fork (12 tests incl. fuzz) | The treasury is the creator of a real processor; proceeds split exactly; `withdrawOps` pays only `ops`; grants are limited to one per address, `maxGrant`, the granter and the pool size; a grant's own mint price returns to the pool; granted transistors can tape out; plain transfers are rejected |
| ✅ Budget Guard on fork | `contracts` forge, fork (4 tests) | Tape-out burns 8 transistors; the stored netlist equals the JSON; `eval()` matches all 64 rows |
| ✅ Deploy rehearsal | anvil fork, real deployer address impersonated | The script broadcasts all three transactions, `eval()` matches 64/64, and 0.0006 OKB is left |
| ✅ On-chain match | `circuits/check.ts` against mainnet | 64 of 64 rows match at block 72,128,138, saved to `circuits/proof/budget-guard.txt` |

**Exit gate:** `check.ts` prints 64/64 on mainnet. Processor address, deployer address, supply, price and cap are in the README. **At this point the project qualifies.** ✅ Passed

---

## Phase 2 — Smart contracts

Built and tested. Reference: [docs/contracts.md](docs/contracts.md).

**Design change from the original plan:** an agent has a permanent `agentId`, and the API key hash points to it. Escrow balances and spend are keyed by `agentId`, so rotating a key never strands a balance. Owner functions take `agentId`; the router's reads (`policyOf`, `killed`, `budgetOkForKey`) take the key hash.

**Tasks**

1. [x] **PolicyRegistry** (`contracts/src/PolicyRegistry.sol`)
   - `registerAgent(keyHash, circuitId, dailyCap)` sets the caller as owner. The circuit must exist on the PolicyRouter processor and have the policy shape (6 in, 3 out, no state)
   - Owner only: `setCircuit`, `setDailyCap`, `setKill(bool)`, `rotateKey`, `transferAgent`
   - Views: `policyOf(keyHash) → (agentId, owner, circuitId, dailyCap, killed)`, `killed(keyHash)` (true for unknown keys), `agentOf`, `agent`, `ownerOf`, `dailyCapOf`
   - A key hash can be registered once, ever; events for every change
2. [x] **CreditEscrow** (`contracts/src/CreditEscrow.sol`)
   - `deposit(agentId)` in OKB, owner only, which blocks the front-run-registration attack. USDT comes later
   - `withdraw(agentId, amount)` owner only, limited to the unused balance, works while killed
   - `settle(batchId, root, entries[])` router only; batches numbered in order, each once; stores root and block number
   - Capped debit with `Shortfall` events; never more than the balance, never past the daily cap
   - `budgetOk(agentId)`, `budgetOkForKey(keyHash)`, `spentToday`, `balanceOf`, `batch`, `isInBatch(batchId, receiptHash, proof)`
   - `claimEarnings()` pays settled fees to the fixed `payee`
3. [x] **Deploy script** `script/DeployPhase2.s.sol` fills in `policyRegistry`, `creditEscrow`, `router` and `escrowPayee` in `deployments/xlayer.json`. Dry-run and anvil rehearsal pass (about 0.0001 OKB of gas)
4. [x] **Broadcast** to mainnet: PolicyRegistry `0x7F05d6c389F973EA3Fb10A3Eb27e338f8eB42D0a` (block 72,159,847), CreditEscrow `0xCc2dd59C8042e42253D1C14d5c34F976226b7F7A` (block 72,159,849). Wiring, roles and circuit checks were confirmed on chain, and the bytecode matches the build
5. [ ] **Verify source on OKLink** with `scripts/verify-contracts.sh` (needs an OKLink API key). This also verifies the Phase 1 PolicyTreasury

**Tests**

PolicyRegistry (`test/PolicyRegistry.t.sol`, 21 unit tests)
- [x] `registerAgent` stores owner, circuit, cap and emits `AgentRegistered`; IDs are sequential
- [x] Reverts for a used key, a zero key, an unknown circuit, an ID above uint64, and circuits with the wrong shape (4 cases); a failed registration doesn't burn the key
- [x] Non-owner calls to every setter revert; unknown agents revert
- [x] Kill switch toggles both ways; unknown keys read as killed
- [x] Key rotation moves the policy, the old hash is unregistered and can never return
- [x] Transfer moves control; zero address rejected
- [x] `policyOf` returns all fields; empty for unknown keys

CreditEscrow (`test/CreditEscrow.t.sol`, 23 tests)
- [x] Deposit raises the balance and emits; owner only; rejects zero; follows agent transfer
- [x] Owner can withdraw unused balance; a non-owner cannot; over-withdraw and zero revert; works while killed
- [x] `settle` from a non-router address reverts; batch IDs must be in order and unique
- [x] `settle` debits correctly and stores the root and block number
- [x] `settle` never debits more than the balance and never pushes spend past the cap (`Shortfall`); a cap lowered below the spend debits nothing
- [x] One bad entry doesn't block the batch; killed agents still pay for work already done
- [x] `budgetOk` flips at the cap (to the wei) and resets after `vm.warp` by one day
- [x] Reentrancy: a malicious owner contract re-entering `withdraw` cannot drain funds
- [x] **Fuzz** (512 runs): random deposits, settles, withdraws and day changes never leave the escrow insolvent, balances always add up, and spend never exceeds the cap
- [x] **Invariant** (`test/CreditEscrow.invariant.t.sol`, 256,000 calls): the escrow is solvent, `totalBalances` equals the sum of balances, and a settle never raises spend above the cap

Merkle compatibility
- [x] Trees built in TypeScript with `@openzeppelin/merkle-tree` (`packages/policy/src/merkle.ts`) verify on chain through `CreditEscrow.isInBatch`: 29 proofs across trees of 1–16 leaves (`test/MerkleCompat.t.sol` + `packages/policy/test/vectors.json`); tampered leaves, tampered proofs and wrong batches fail

Fork (`test/fork/Phase2Fork.t.sol`, against the live processor)
- [x] Registers against the live Budget Guard; rejects circuit 999 and a real 6-in/2-out circuit
- [x] The router's decision (registry + escrow → input byte → live `eval()`) follows chain state: no deposit denies, funded allows, cap reached denies, next day allows, kill switch denies, unknown key denies
- [x] Settle, claim and withdraw move real OKB

**Exit gate:** all forge tests pass on the fork ✅. Coverage is ≥ 90% of lines on both contracts ✅ (100%). Both deployed to mainnet ✅. Verified on OKLink ⬜.

---

## Phase 3 — Router core

Built and tested. Reference: [docs/router.md](docs/router.md).

The goal is one real request going agent → router → `eval()` → DeepSeek → agent, with a signed receipt.

**Tasks**

1. [x] **Database:** SQLite through Node's built-in `node:sqlite`, with no native module and no ORM (`router/src/db.ts`). Tables `keys`, `receipts` (one row per request, which also carries the usage), and `batches`
2. [x] **Key issuing:** `pnpm --filter @policyrouter/router key:create` prints the key once, stores only its hash, and prints the `cast send` commands to register and fund it
3. [x] **Model catalog** `router/catalog.json` + `src/catalog.ts`: `cheap`/`standard`/`premium`/`frontier` for tiers 0–3 = `deepseek-flash` thinking off/on, `deepseek-v4-pro` thinking off/on. DeepSeek's published USD prices (peak and off-peak; cache hit, cache miss, output) are converted to OKB per request at the **live OKB/USD price** (`src/price.ts`: OKX → CoinGecko → CoinPaprika, refreshed every minute, 503 when stale) plus a 10% markup. The rate is recorded in each receipt (`okbUsdE8`). The tier's thinking mode is forced upstream
4. [x] **Chain reader** (`src/chain.ts`): `policyOf` and `budgetOkForKey` at a pinned block, run in parallel; state is cached per block and the block number for `BLOCK_CACHE_MS`. Multicall wasn't needed: the reads are pinned to the same block number
5. [x] **Policy checker** (`src/policy.ts`): `encodeInput` → `eval` at the pinned block → `decodeOutput`; any failure raises `PolicyUnavailable`
6. [x] **Size bucket:** about 4 characters per token plus `max_tokens` (default 4,096), with bounds at 2k/8k/32k. A heuristic, not a tokenizer; the buckets are coarse enough
7. [x] **Gateway** (Hono, `src/app.ts`): `POST /v1/chat/completions` (streaming and not), `GET /v1/models`, `GET /v1/receipts/:id`, `GET /health`; OpenAI error shapes; 403 `policy_denied` with receipt
8. [x] **DeepSeek adapter:** generic OpenAI-compatible adapter (`src/providers/openai-compatible.ts`), streaming with `include_usage`
9. [x] **Metering:** provider-reported usage (cache hit / miss / output), or an estimate if it is missing, priced at the **served** model for the request's time (peak or off-peak), rounded up to the wei. Receipts carry `cachedPromptTokens`, so the cost can be recomputed
10. [x] **Receipt signer:** EIP-712 (types in `packages/policy/src/receipt.ts`, shared with the Verify page), in the `x-policyrouter-receipt` header, the `policyrouter_receipt` body field, and the last SSE chunk when streaming
11. [x] **Rate limit:** in-memory token bucket per key hash
12. [x] **Extra:** `verify-receipt` CLI, which checks the signature and re-runs `eval()` at the receipt's block, and prints the `cast call`
13. [x] **Extra:** Cheap Only template (10 gates) added to `packages/policy` and `circuits/`, for the downgrade tests. Its mainnet tape-out stays in Phase 5

**Must-haves (each one has a test below)**

- [x] Fail closed: if `eval()` or a chain read fails, refuse the request
- [x] Every receipt records the block that was read
- [x] Provider keys never appear in a response or a log

**Tests**

Unit (Vitest, 62 tests at the end of Phase 3, `router/test/unit`)

| Area | Cases |
| --- | --- |
| ✅ Catalog | Every model has a tier from 0 to 3 and a price; one default per tier; broken catalogs rejected; unknown model returns 404 `model_not_found` |
| ✅ Size bucket | Boundary values at each threshold land in the correct bucket; `max_tokens` / `max_completion_tokens` / default |
| ✅ Checker | With a fake `eval`, allow, deny and downgrade decode correctly; an `eval` that throws, a read that throws, or empty output all fail closed; unknown keys never reach `eval` |
| ✅ Metering | Cost for known token counts matches a hand-worked value; rounds up; downgraded requests are charged at the served tier |
| ✅ Receipt | Signature recovers to the router address; changing any of the 14 fields breaks it; it is bound to chain and escrow; JSON matches the spec format (in `packages/policy`) |
| ✅ Auth | Missing, malformed or unknown key returns 401; the key is never logged |
| ✅ Rate limit | Request N+1 in the window returns 429; refills over time |
| ✅ Upstream | 502 never contains the provider's message or key |

Integration (Vitest, 10 tests, `router/test/integration`): Phase 2 deployed on a local `anvil --fork-url`, Cheap Only taped out on the live processor, and a mock provider server

- [x] Allowed request: forwarded at the requested tier, receipt returned, usage row written
- [x] Downgrade: under Cheap Only, a tier-3 request is served by the tier-1 model, and the receipt shows `modelRequested ≠ modelServed`
- [x] Kill switch: `setKill(true)` on chain makes the next request return 403 with no call to the provider
- [x] Cap reached: the next request after the cap returns 403
- [x] Unfunded agent denied; unknown key 401 after the on-chain lookup
- [x] RPC down: the router is pointed at a dead RPC, and the request returns 503 with no provider call
- [x] Streaming: chunks arrive in order, usage is metered, and the receipt arrives as the last event
- [x] Receipt replay: re-running `eval()` at `receipt.blockNumber` with `receipt.inputBits` gives `receipt.outputBits`; the signature is the router's
- [x] No API key or provider key in the logs

Process-level rehearsal (manual, fork): the real server process, `key:create`, `cast` register and deposit, `curl`, and `verify-receipt` give signature OK and policy OK on the live Budget Guard circuit.

Live smoke test (manual, mainnet + real DeepSeek)

- [x] Run on 2026-10-02 against X Layer mainnet and DeepSeek. Agent 1 was registered with Budget Guard and a cap of 0.0001 OKB/day ([tx](https://www.oklink.com/xlayer/tx/0xf9f2be50241e97ca9226440b13a2b7ec970704cdd08aab04d2f25ac39b8e060d)) and funded with 0.0003 OKB ([tx](https://www.oklink.com/xlayer/tx/0xff043383844deea5c99c71f28d766fa53040547113acc1afe6c07d03caf594ab)), owned by the router wallet for the test
  - `cheap`, not streaming: 200, served by `deepseek-flash`, input `0b010000` → output `0b001`, block 72,160,362, 295,964,125,561 wei at OKB $122.65 (peak). `verify-receipt`: signature, policy and cost all OK
  - `frontier`, streaming: 200, `deepseek-v4-pro` with thinking on (13 reasoning chunks), receipt as the last event; all three checks OK
  - Kill switch on ([tx](https://www.oklink.com/xlayer/tx/0x287d4551187b9a15bc6224b200ac8a817e6c0b5dc9c1c95d60ef71ecfaafff34)): 403 `policy_denied`, provider not called, `eval(1, 0x30)` = `0x00` verified. Kill switch off ([tx](https://www.oklink.com/xlayer/tx/0x35b8c43066071e13f6718ca595b3c506afd7b3983afcf5ed7963abb57f583138)): 200 again
  - No API key, DeepSeek key or router key in the server log
  - Found during the run: one public-RPC timeout made the first attempt fail closed (503). Added one retry per RPC URL and comma-separated fallback RPCs (`XLAYER_RPC_URL`)

**Exit gate:** all unit and integration tests pass ✅. One live request is served on mainnet with a receipt that verifies ✅.

---

## Phase 4 — Settler

Built, tested, and run on mainnet. Reference: [docs/router.md#settlement](docs/router.md#settlement).

**Tasks**

1. [x] Every `SETTLE_INTERVAL_MS` (default 5 minutes) inside the router, or once with `pnpm --filter @policyrouter/router settle`, collect unsettled receipts: oldest first, up to 2,000 receipts and 100 distinct agents per batch
2. [x] Build a tree with `@openzeppelin/merkle-tree` (`batchTree` in `packages/policy`); each leaf is the receipt's EIP-712 hash. Denied receipts are included, so denials can be proven settled
3. [x] Sum cost per agent and call `CreditEscrow.settle(batchId, root, entries)` from the router wallet; `batchId` is read from `nextBatchId()` on chain. Record the `debited` amount from the `Settled` event
4. [x] Store the batch, the tx hash, and every receipt's Merkle proof. `GET /v1/receipts/:id` returns `settlement { batchId, status, root, proof, txHash, blockNumber }`. `verify-receipt` checks it on chain through `isInBatch`
5. [x] Retry safely: the batch and proofs are committed before sending. An open batch is reconciled against the chain before anything new: landed means confirmed, pending means wait, gone means resend with the same id, and a different root means conflict and release. A resend of a landed batch reverts on chain and is reconciled, never double debited
6. [x] **Extra:** clean shutdown on SIGINT/SIGTERM
7. [x] **Extra:** price sources back off after failures (5 minutes per failure, up to 30), and `PRICE_SOURCES` chooses them. Found here: OKX's host doesn't resolve on this network, and a hung DNS lookup also delayed process exit

**Tests**

- [x] Unit: tree built from 1, 2 and 1,000 receipts; every proof verifies locally
- [x] Unit: per-agent sums match the sum of receipt costs; zero-cost agents are left out of the entries but kept in the tree; the agent cap carries the rest to the next batch
- [x] Unit (fake escrow that enforces in-order, once-only ids): crash after commit leads to a resend; crash after send with the tx mined is confirmed without resending; tx pending means wait; tx dropped means resend with the same id; a blind resend reverts and is reconciled; conflict releases receipts into the next batch; one cycle at a time; the receipts endpoint returns a proof that verifies
- [x] Integration (anvil fork): after a settle, escrow balances drop by each agent's summed cost, and `batch(batchId)` holds our root
- [x] Integration: each stored proof, a denial included, verifies against the on-chain root via `CreditEscrow.isInBatch`; a proof for the wrong receipt doesn't
- [x] Integration: crash between sending and confirming, and between committing and sending, and with the tx held in the mempool (automine off). Nothing is double debited or lost
- [x] Integration: an empty interval sends no transaction (router nonce unchanged)

**Mainnet run (2026-10-02):** batch 0 settled the 4 receipts from the Phase 3 live test (3 served, 1 denied) in [tx `0xd472e211…`](https://www.oklink.com/xlayer/tx/0xd472e211c7db8b2fd414ea68b7b5a8e1fc676d73a310dc65cde9830a30c10d66) at block 72,161,097, root `0xe4568b…b31e`. Agent 1's balance dropped by exactly 2,109,162,756,815 wei (the receipts' total), and `spentToday` and `earned` match. `verify-receipt` passes all four checks (signature, policy, cost, settlement) for the served `cheap` and `frontier` receipts and for the denied one.

**Exit gate:** a settled batch is visible on OKLink ✅, and a receipt from it verifies against the on-chain root ✅.

---

## Phase 5 — Remaining templates and policy simulation

Built, tested, and live on mainnet.

**Tasks**

1. [x] Add `cheapOnly`, `smallRequests` and `strict` to `packages/policy`, with golden JSON truth tables (`circuits/*.json`)
2. [x] Wire and simulate each one: Cheap Only **10 gates**, Small Requests **11**, Strict **13** (`circuits/README.md`)
3. [x] **Tape out on mainnet** with `contracts/script/DeployPhase5.s.sol`: one mint of 34 transistors (block 72,171,825), then Cheap Only = **circuit 2**, Small Requests = **circuit 3**, Strict = **circuit 4** (blocks 72,171,828 to 72,171,835). 0.00796 OKB in fees and mint, 0.000016 OKB in gas
4. [x] `check.ts` on mainnet for each: structure match and 64/64 rows, saved to `circuits/proof/{cheap-only,small-requests,strict}.txt`. PolicyRegistry accepts circuits 2–4 (simulated registration)
5. [x] **Simulation** `packages/policy/src/simulate.ts`
   - `simulatePolicy(template, requests[], price) → { requests, allowed, downgraded, denied, spendWithout, spendWith, savingsPct }`. The price function is passed in, so the policy package stays independent of the router's catalog
   - The inputs are the key's recent receipts (`simRequestFromReceipt`: tier, size and flags from `inputBits`, plus actual tokens; typical usage per size bucket for denials)
   - With no history: `packages/policy/src/sample-workload.json` (20 requests across every tier and size)
6. [x] Router endpoint `GET /v1/simulate?template=…&limit=…`, authenticated and scoped to the caller's key. Spend uses the router's catalog with each receipt's own time and OKB rate

**Tests**

| Test | Asserts |
| --- | --- |
| ✅ Template tables | Each template's 64 rows match its plain-English rule. Cheap Only never outputs `route_tier > 1`; Small Requests denies every row with `size = 3` and otherwise equals Budget Guard; Strict equals Cheap Only plus Small Requests row by row |
| ✅ Safety properties (exhaustive over all 64 inputs, stronger than random sampling at this size) | No template ever allows when `kill = 1` or `budget_ok = 0`; no template routes above the requested tier; denials always report tier 0 |
| ✅ Fork tape-out (`TemplatesFork.t.sol`) | All three tape out on the live processor, burn exactly their gates, store the netlist verbatim, and match all 64 rows |
| ✅ On-chain match | `check.ts` gives 64/64 for each of the three new circuits on mainnet; a test asserts every proof file records 64/64 and its circuit id |
| ✅ Simulation counts | allowed + downgraded + denied = number of requests, for every template and workload |
| ✅ Simulation money | A hand-built set of 10 requests gives exact expected spends under all four templates (Cheap Only: 15,000 of 26,000 wei, 42.3% saved); denied requests cost 0; `savingsPct` is 0 under a policy that allows everything at the requested tier; empty history gives zeros |
| ✅ Simulation vs router | Unit: traffic across all four circuits (every tier, small and huge, killed and over-budget agents) gives simulated counts equal to the router's actual decisions. Integration: every receipt the Phase 3 fork suite produced, replayed, matches the live circuits' decisions |
| ✅ Endpoint | A key can only simulate its own history (another key gets the sample); needs a key; unknown template is 400; `limit` caps the window |

**Exit gate:** four templates live on mainnet with proofs ✅. Simulation output matches real router decisions ✅.

---

## Phase 6 — Web app

Built and tested. Reference: [docs/web.md](docs/web.md).

**Design changes from the plan**
- **viem directly, not wagmi:** any EIP-1193 wallet works, with fewer dependencies (wagmi is now on v3).
- **Agents listed by a multicall over `agent(1..agentCount)`:** the public RPC caps `eth_getLogs` at 100 blocks, so events can't be used.
- **The router never needs the key hash sent to it:** auth is on chain.

**Tasks**

1. [x] **Connect and fund:** EIP-1193 wallet, an X Layer chain config (with `wallet_addEthereumChain` if the wallet doesn't know it), deposit OKB, show the balance
2. [x] **Create agent:** the key is generated in the browser and shown once; `registerAgent` with its hash, then `deposit`. The agent id comes from the `AgentRegistered` event
3. [x] **Choose a policy:** four template cards, each with its rule, circuit id, gate count, a link to its 64/64 mainnet proof and the processor, and a **Simulate** panel (allowed, downgraded and denied counts plus savings; the sample workload before there's history). **Use this policy** calls `setCircuit`
4. [x] **Agent dashboard:** status, balance, spend today against the cap, allowed/downgraded/denied counts (`GET /v1/usage`), the kill switch, set cap, deposit. A key not in this session can be pasted to unlock usage (checked against the on-chain key hash)
5. [x] **60-second quickstart panel:** copy buttons for the base URL, the key and both `export` lines, plus tabs for the OpenAI SDK (Node and Python), Codex and Claude Code
6. [x] Transistor facts in the footer, read live: supply cap, price, minted, remaining
7. [x] **Router additions for the app:** CORS; `GET /v1/usage`; `GET /v1/simulate` without a key returns the sample workload; `PRICE_STATIC_USD` for tests
8. [x] **Extra, needed for the exit gate: two more wire formats.** The timed test found that Codex 0.160 only speaks the Responses API (`wire_api = "chat"` was removed) and Claude Code only speaks the Anthropic Messages API. The router now serves `POST /v1/responses` and `POST /v1/messages` (+ `count_tokens`) with the same policy check, metering and receipts, forwarded to DeepSeek's endpoints for those formats. Thinking mode is forced per tier in each format (`reasoning.effort = "none"` / `thinking.type = "disabled"`)

**Tests**

Component (Vitest + Testing Library, 11 tests)
- [x] Simulation panel renders counts and savings from a fixed response; renders the "sample workload" notice when there is no history; says "request" for one
- [x] The key is shown once and hidden after confirmation; its copy button copies exactly the key
- [x] Quickstart copy buttons copy exactly the base URL, the key and the two lines; placeholder without a key; Codex uses `wire_api = "responses"`; Claude Code gets its base URL without `/v1` and the size warning
- [x] Browser-generated keys are in the router's format and hash exactly as the router does

E2E (Playwright, 5 tests; anvil fork of mainnet + the real router process + mock provider + Vite, with a built-in test wallet)
- [x] Full owner flow: connect → create agent (deposit) → key shown once → dashboard shows Budget Guard and the balance → pick Cheap Only → a frontier request is downgraded and counted on the dashboard
- [x] Kill switch on the dashboard → a request returns 403 → switch off → it succeeds
- [x] Lowering the cap below today's (settled) spend → next request denied, and the dashboard deny count increases; a pasted wrong key is refused, the right one unlocks usage
- [x] Wrong network → the app prompts a switch to X Layer, and switching clears it
- [x] Landing page without a wallet: quickstart, four simulated policies, transistor facts

Router (passthrough): 14 more unit tests (forwarding, thinking enforcement, usage from JSON and SSE, bytes passed through, Anthropic error shapes, no leaks, count_tokens) and 1 fork integration test (both formats through the live circuits, receipts replayed, kill switch).

60-second test (mainnet, real DeepSeek, 2026-10-02; timed from setting the environment to a signed answer; every receipt verified)
- [x] OpenAI SDK (Node): 2.5 s
- [x] OpenAI SDK (Python): 3.3 s
- [x] Codex 0.160 (`codex exec`, `wire_api = "responses"`): 8.5 s
- [x] Claude Code 2.1.236 (`claude -p`, `ANTHROPIC_BASE_URL`): 4.0 s. Its requests are size bucket 3, so Small Requests and Strict deny most of them (stated in the quickstart)

**Exit gate:** the Playwright suite passes ✅, and the timed quickstart works with at least the OpenAI SDK and one coding agent ✅ (two coding agents: Codex and Claude Code).

---

## Phase 7 — Verify page

Built and tested; verified real mainnet receipts with no wallet. Reference: [docs/web.md#the-verify-page](docs/web.md#the-verify-page).

The Verify page works with no wallet, using only read-only RPC calls.

**Tasks**

1. [x] Paste a receipt (a `/v1/receipts` response, a completion with `policyrouter_receipt`, or a bare receipt), or open `/verify?id=…`, which fetches it from the router
2. [x] Run the checks and show each with the exact calls made. The checks live in `packages/policy/src/verify.ts`, which the router's `verify-receipt` CLI also uses:
   - **Signature:** EIP-712 recovery equals `CreditEscrow.router()`, the router fixed on chain
   - **Chain inputs** *(added)*: agent, circuit, kill switch and `budget_ok` at the receipt's block match the bits the router fed the circuit. This closes the "router lies about inputs" gap for the two flags the chain knows
   - **Policy:** `eval(circuitId, inputBits)` at `blockNumber` equals `outputBits`; the processor must be PolicyRouter's
   - **Settlement:** `CreditEscrow.isInBatch(batchId, receiptHash, proof)`; "pending" if the batch is not settled yet
3. [x] A green "Verified", an amber "pending", or a red "Mismatch" naming the failed checks
4. [x] "Re-run this yourself": the `cast call` at the receipt's block, the raw `eth_call` JSON, and OKLink links
5. [x] **Extra:** the dashboard's recent requests link to their Verify pages; the policy check falls back to the latest block if an RPC lacks historical state (circuits are immutable)

**Tests**

- [x] Unit (14): each check returns pass or fail with a reason for fixed inputs, including a router lying about `budget_ok` or the circuit, a foreign processor, missing historical state, and the exact `cast` and `eth_call` output
- [x] E2E (Playwright, no wallet): a valid allow receipt is green on all four checks
- [x] E2E: a deny receipt is green (the policy check proves the deny was correct)
- [x] E2E tamper tests, each red on the correct check:
  - change `outputBits` → policy check fails
  - change `costWei` → signature check fails (policy still passes)
  - re-sign a fake receipt with another key → signature check fails (it names the impostor)
  - a valid receipt with a wrong proof → settlement check fails (the others pass)
- [x] E2E: an unsettled receipt shows "pending", not "fail"
- [x] Real mainnet receipts with no wallet: the Phase 3 served and denied receipts (batch 0) and the Phase 6 Claude Code receipt (batch 1, settled by the router's own settler at block 72,174,540) are all "Verified", 4/4. Run headless in an iPhone 14 viewport with no wallet: no horizontal overflow
- [ ] Manual: open the hosted URL in a private window on a real phone (needs the app hosted)

**Exit gate:** a stranger with only the URL can verify a real mainnet receipt. ✅ The page does this with no wallet, on desktop and phone viewports. ⬜ It needs a public URL: host the router and the web app (for example on Railway), with an SPA fallback for `/verify`.

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
