# PolicyRouter

**The immutable firewall for AI agents.**

Every AI request an agent makes goes through a policy circuit that answers **allow, deny or downgrade**. The circuit is a TapeOut NAND circuit on X Layer, so nobody can change a rule once it is set, including the agent, the owner mid-task, and the router operator. Anyone can re-run the check on chain.

```
traditional firewall:  request    → rules          → allow / deny
PolicyRouter:          AI request → TapeOut policy → allow / deny / downgrade
```

PolicyRouter will expose an OpenAI-compatible endpoint, so an agent that already works with OpenAI can sit behind it by changing two environment variables:

```bash
export OPENAI_BASE_URL=https://api.policyrouter.xyz/v1
export OPENAI_API_KEY=pr-live-...
```

> **Status:** Phase 1 is live on X Layer mainnet. The processor is deployed, and the first policy circuit (Budget Guard) is taped out and checked against its truth table on all 64 inputs. Phase 2's PolicyRegistry and CreditEscrow are built and tested (100% line coverage) and waiting for their mainnet deploy. The router and web app come next; see [BUILD_PLAN.md](BUILD_PLAN.md).

## Deployed on X Layer mainnet (chain 196)

| Contract | Address |
| --- | --- |
| PolicyRouter processor (circuits, ERC-721) | [`0x11FF9976c86E4C868a803Bc9B5E1ba7749226f99`](https://www.oklink.com/xlayer/address/0x11FF9976c86E4C868a803Bc9B5E1ba7749226f99) |
| Transistors (ERC-1155) | [`0x8B37B74083Eb87A5B725B152621c729b478262E9`](https://www.oklink.com/xlayer/address/0x8B37B74083Eb87A5B725B152621c729b478262E9) |
| PolicyTreasury (processor creator) | [`0xad56De63a2F9F5f1170E9044046C15ee467b6288`](https://www.oklink.com/xlayer/address/0xad56De63a2F9F5f1170E9044046C15ee467b6288) |
| Deployment wallet | [`0x87FD4bE65Ac1Eb485628539379582E8aebdD78d3`](https://www.oklink.com/xlayer/address/0x87FD4bE65Ac1Eb485628539379582E8aebdD78d3) |
| Budget Guard circuit | ID `1` on the processor |

| Transistor parameter | Value |
| --- | --- |
| Supply cap | 1,000,000 |
| Price | 0.0001 OKB each |
| Burned | One per gate at tape-out (Budget Guard burned 8) |
| Proceeds | Go to PolicyTreasury: 50% running costs, 50% a pool that grants free transistors for each new owner's first custom policy |

Transaction hashes and the full parameter list are in [docs/deployments.md](docs/deployments.md).

### Check it yourself

No wallet needed. Ask the Budget Guard circuit about a frontier-tier request with budget left and the kill switch off, then the same request with the kill switch on:

```bash
cast call 0x11FF9976c86E4C868a803Bc9B5E1ba7749226f99 "eval(uint256,bytes)(bytes)" 1 0x13 --rpc-url https://rpc.xlayer.tech
# 0x07  → allow, route tier 3
cast call 0x11FF9976c86E4C868a803Bc9B5E1ba7749226f99 "eval(uint256,bytes)(bytes)" 1 0x33 --rpc-url https://rpc.xlayer.tech
# 0x00  → deny
```

Or check all 64 rows: `pnpm --filter @policyrouter/circuits check 1 budget-guard`. The mainnet result is in [circuits/proof/budget-guard.txt](circuits/proof/budget-guard.txt).

## Documentation

| Doc | What it covers |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | How a request flows through the router, the processor and the contracts; what is built and what is planned |
| [docs/contracts.md](docs/contracts.md) | PolicyRegistry and CreditEscrow: every function, the rules they enforce, receipt proofs, tests |
| [docs/policies.md](docs/policies.md) | The 6-in / 3-out policy interface, the template policies, and how to verify a circuit |
| [docs/deployments.md](docs/deployments.md) | Every deployed address, transaction and permanent parameter, with commands to check each one |
| [docs/economics.md](docs/economics.md) | The transistor, the treasury split, grants, and usage fees |
| [docs/development.md](docs/development.md) | Repo layout, setup, tests, fork tests, and deploying |
| [policyrouter-spec.md](policyrouter-spec.md) | The full product spec |
| [BUILD_PLAN.md](BUILD_PLAN.md) | The phase-by-phase build plan, with tests and exit gates |

## Built for

The TapeOut Genesis Transistor Hackathon (IGNIX × TapeOut × X Layer).
