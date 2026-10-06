# Development

## Repo layout

```
policyrouter/
  packages/policy/    Shared TS library: TapeOut addresses, pin packing, policy bits,
                      netlist builder and simulator, template policies
  circuits/           Circuit JSON (what gets taped out), build script, on-chain check script, proofs
  contracts/          Foundry: PolicyTreasury, PolicyRegistry, CreditEscrow, TapeOut interfaces,
                      ABIs, unit/fuzz/invariant tests, fork tests, deploy scripts
  deployments/        Deployed addresses (xlayer.json)
  scripts/            Wallet setup, OKLink source verification
  docs/               This documentation
```

  router/             OpenAI-compatible router (Hono): policy check, providers, receipts, SQLite, CLIs

  web/                Owner web app (React + Vite + viem), component tests, Playwright E2E

Planned: `e2e/` (Phase 9).

`packages/policy` is the single source of truth for how bits are encoded and what each template does. The circuit build, the check script and, later, the router, simulation and Verify page all import it.

## Setup

Requires Node 22+, pnpm 10, and [Foundry](https://getfoundry.sh).

```bash
git clone --recurse-submodules https://github.com/Len3hq/policyrouter.git
cd policyrouter
pnpm install
cp .env.example .env
```

## Tests

| Command | What runs |
| --- | --- |
| `pnpm test` | All TypeScript tests: bit encoding, netlists, templates (every circuit equals its rule on all 64 inputs), Merkle batch trees, golden circuit and Merkle vector files, deployment record |
| `pnpm typecheck` | TypeScript type checks |
| `pnpm --filter @policyrouter/web test` / `test:e2e` | Web component tests / the owner flow end to end on an anvil fork (needs `anvil` and `playwright install chromium`) |
| `pnpm --filter @policyrouter/router test:integration` | The router against an anvil fork of X Layer: deploys Phase 2 and tapes out Cheap Only on the fork, runs real requests through a mock provider. Needs `anvil` |
| `pnpm test:contracts` | Foundry unit, fuzz and invariant tests. Fork tests skip themselves when not forking |
| `pnpm test:fork` | Only `test/fork/*`, against a fork of X Layer mainnet. These tape out real circuits on the real TapeOut contracts, locally; nothing is broadcast |
| `cd contracts && forge coverage --no-match-path "test/fork/*" --no-match-coverage "(test\|script)/" --report summary` | Line coverage: PolicyRegistry and CreditEscrow are at 100% |

Don't run the invariant suite in fork mode. Its random calls fetch random accounts over the public RPC, and the RPC rate-limits them (HTTP 403). `pnpm test:fork` already limits itself to `test/fork/*`.

The fork tests:

| Suite | Checks |
| --- | --- |
| `TapeOutSpike.t.sol` | The factory is live; a wallet or a contract can create a processor; the creator is paid the full mint price; the `eval()` pin layout |
| `PolicyTreasuryFork.t.sol` | Treasury creation, the sweep split (including a fuzz test), `withdrawOps`, grant rules, the pool accounting for grants, rejecting stray transfers |
| `BudgetGuardFork.t.sol` | Tape-out burns 8 transistors; the stored netlist equals the JSON; `eval()` matches all 64 rows |
| `Phase2Fork.t.sol` | PolicyRegistry accepts the live Budget Guard and rejects unknown or wrongly shaped circuits; the router's allow/deny decision follows chain state end to end; settle and withdraw move real OKB |

CI runs all of the above on every push. See [`.github/workflows/ci.yml`](../.github/workflows/ci.yml).

## Running the router locally

```bash
pnpm --filter @policyrouter/router start      # reads ../.env; stop with Ctrl-C or SIGTERM
pnpm --filter @policyrouter/router settle     # settle every unsettled receipt now
pnpm --filter @policyrouter/router verify-receipt <requestId>
```

The router shuts down cleanly on SIGINT/SIGTERM: it stops the settler and price feed, finishes in-flight requests and closes SQLite. If a price source's host doesn't resolve from your network, exit waits for that DNS lookup to time out (~30 s), so leave the source out of `PRICE_SOURCES`.

## Writing documentation

The docs are the markdown files in `docs/`, in GitBook's format: `SUMMARY.md` is the table of contents (`## Group` headings and `* [Title](file.md)` lines), and `README.md` is the introduction. The web app renders the same files at `/docs`.

- **Add a page:** create the `.md` file and add it to `SUMMARY.md`. A test fails if a file isn't in the navigation.
- **Links:** use relative `.md` links between pages (`[policies](policy-circuits.md#size-buckets)`), site routes like `/verify` for app pages, and relative paths for repository files (`../contracts/src/PolicyTreasury.sol`, which becomes a GitHub link on the site). A test fails on any broken page link or anchor.
- **Code fences:** close every fence with a bare ` ``` `. A stray word after the closing fence turns the rest of the page into code, and a test catches it.
- **Publishing to GitBook:** connect the repository in GitBook (Git Sync). `.gitbook.yaml` points it at `docs/`.

## Changing or adding a policy

1. Edit or add a template in `packages/policy/src/templates.ts` and add it to `TEMPLATES`.
2. `pnpm test`: the circuit must equal the rule on all 64 inputs.
3. `pnpm --filter @policyrouter/circuits build`: regenerates `circuits/<id>.json`. Commit it.
4. `pnpm test:fork`: tapes it out on a fork and checks `eval()`.

A taped-out circuit can never be edited. Changing a rule means taping out a new circuit.

## Wallets

```bash
scripts/setup-wallets.sh
```

This creates `policyrouter-deployer` and `policyrouter-router` in Foundry's encrypted keystore (`~/.foundry/keystores`) and prints their addresses. Private keys are never written into the repo. Only the addresses go in `.env`.

## Deploying

Every deploy script is rehearsed on a local fork first, sending from the real deployer address with its real balance:

```bash
anvil --fork-url https://rpc.xlayer.tech --port 8547 &
cast rpc anvil_impersonateAccount $DEPLOYER_ADDRESS --rpc-url http://127.0.0.1:8547
cd contracts
DEPLOYMENT_OUT=anvil-rehearsal.json forge script script/DeployPhase1.s.sol \
  --rpc-url http://127.0.0.1:8547 --unlocked --sender $DEPLOYER_ADDRESS --broadcast
rm -rf broadcast/DeployPhase1.s.sol/196 cache/DeployPhase1.s.sol/196   # the rehearsal reuses chain ID 196
```

Then on mainnet (asks for the keystore password):

```bash
forge script script/DeployPhase1.s.sol --rpc-url https://rpc.xlayer.tech \
  --account policyrouter-deployer --sender $DEPLOYER_ADDRESS --broadcast --slow
```

Phase 1 is already deployed. Don't run it again: it would create a second processor.

Phase 2 (`script/DeployPhase2.s.sol`) deploys PolicyRegistry and CreditEscrow and fills in their addresses in `deployments/xlayer.json`. Rehearse it the same way, but point `DEPLOYMENT_OUT` at a copy of the record (`cp deployments/xlayer.json deployments/xlayer-rehearsal.json`), because the script updates the file in place.

## Verifying source on OKLink

```bash
OKLINK_API_KEY=... scripts/verify-contracts.sh
```

This verifies PolicyTreasury and, once they are deployed, PolicyRegistry and CreditEscrow. It reads the addresses and constructor arguments from `deployments/xlayer.json`. The current build reproduces the deployed PolicyTreasury bytecode byte for byte, so don't change compiler settings in `foundry.toml` before verifying.

## Gotchas

- **`vm.prank` covers only the next call**, including calls made while building the arguments. Read values such as `FACTORY.deployFee()` into a local variable before the prank.
- **Anvil's default accounts have contract code on X Layer**, so they can't receive ERC-1155 transistors (`ERC1155InvalidReceiver`). Rehearse with a real address via `anvil_impersonateAccount`.
- **`eval()` takes the last `nOut` signals as outputs**, in order. `NetlistBuilder.build()` enforces this.
