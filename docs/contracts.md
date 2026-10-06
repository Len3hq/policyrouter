# Contracts

PolicyRouter has three contracts of its own. The TapeOut processor and transistor contracts come from the TapeOut factory. None of our contracts has an admin, a setter for its fixed parameters, or a proxy: what is deployed is what runs.

| Contract | Job | Status |
| --- | --- | --- |
| [PolicyTreasury](../contracts/src/PolicyTreasury.sol) | Created the processor; receives and splits transistor sales | Live: [deployments.md](deployments.md) |
| [PolicyRegistry](../contracts/src/PolicyRegistry.sol) | Links each project's API key to its owner, policy circuit, daily cap and kill switch | Live: [`0x7F05d6c389F973EA3Fb10A3Eb27e338f8eB42D0a`](https://www.oklink.com/xlayer/address/0x7F05d6c389F973EA3Fb10A3Eb27e338f8eB42D0a) |
| [CreditEscrow](../contracts/src/CreditEscrow.sol) | Holds prepaid OKB, tracks daily spend, settles usage in batches with Merkle roots of receipts | Live: [`0xCc2dd59C8042e42253D1C14d5c34F976226b7F7A`](https://www.oklink.com/xlayer/address/0xCc2dd59C8042e42253D1C14d5c34F976226b7F7A) |

ABIs are in [`contracts/abi/`](../contracts/abi). PolicyTreasury is covered in [economics.md](economics.md). This page covers the other two.

## PolicyRegistry

A **project** (the contracts call it an *agent*) has a permanent `agentId` (1, 2, 3, …). Its API key is stored only as `keyHash = keccak256(apiKey)`, so the key itself never touches the chain. The key can be rotated without changing the project's settings or its escrow balance.

### Writes (the project's owner only, except `registerAgent`)

| Function | What it does |
| --- | --- |
| `registerAgent(keyHash, circuitId, dailyCap) → agentId` | Creates a project owned by the caller |
| `setCircuit(agentId, circuitId)` | Points the project at a different policy circuit |
| `setDailyCap(agentId, dailyCap)` | Daily spend cap, in wei of OKB per UTC day |
| `setKill(agentId, bool)` | The kill switch. The router refuses every request while it is on |
| `rotateKey(agentId, newKeyHash)` | Replaces the API key. The old key stops working at once |
| `transferAgent(agentId, newOwner)` | Hands the project, and control of its escrow balance, to a new owner |

### Rules it enforces

- **Circuits must be real policies.** The circuit must exist on the PolicyRouter processor and have exactly 6 inputs, 3 outputs and no state. Anything else reverts with `UnknownCircuit` or `NotAPolicyCircuit`. A key can't point at an arbitrary contract.
- **A key hash can be registered once, ever.** A rotated-out key can never come back, so an old leaked key stays dead.
- **Unknown keys fail closed.** `killed(keyHash)` returns `true` for a key that isn't registered.
- Every change emits an event: `AgentRegistered`, `CircuitChanged`, `DailyCapChanged`, `KillSet`, `KeyRotated`, `OwnerChanged`.

### Reads

| Function | Returns |
| --- | --- |
| `policyOf(keyHash)` | `(agentId, owner, circuitId, dailyCap, killed)`, everything the router needs in one call. `agentId` is 0 for an unknown key |
| `killed(keyHash)` | Kill switch state; `true` for unknown keys |
| `agentOf(keyHash)` | The project a live key belongs to, or 0 |
| `agent(agentId)`, `ownerOf(agentId)`, `dailyCapOf(agentId)` | Project details |

## CreditEscrow

Balances and spend are tracked per `agentId`, so they survive key rotation.

### Writes

| Function | Who | What it does |
| --- | --- | --- |
| `deposit(agentId)` (payable) | Project owner | Adds OKB to the project's balance |
| `withdraw(agentId, amount)` | Project owner | Returns unused balance to the owner. Works even while the kill switch is on |
| `settle(batchId, root, entries[])` | Router only | Debits each `(agentId, cost)` entry and stores the batch's receipt Merkle root with the block number |
| `claimEarnings()` | Anyone | Pays settled fees to the fixed `payee` |

### Rules it enforces, whatever the router sends

- **A settle never takes more than a project's balance.**
- **A settle never pushes a project's spend for the day past its daily cap.** The day is the UTC day (`block.timestamp / 1 days`), so spend resets automatically.
- **Capped debits:** if an entry would break either rule, only the allowed amount is debited and the rest is reported as `Shortfall(batchId, agentId, amount)`. It doesn't revert, so one project can't block a whole batch.
- **Batches are numbered 0, 1, 2, …** and must be settled in order, each exactly once. A retried settle can't double-charge.
- **Only the owner can deposit.** If someone front-runs a project registration with a stolen key hash, the real owner's deposit reverts instead of funding the attacker's project.
- Withdrawals and fee claims go only to fixed addresses (the project's owner or `payee`), and both are protected against reentrancy.

### Reads

| Function | Returns |
| --- | --- |
| `budgetOk(agentId)` | `true` if the project has a balance and today's spend is under its cap |
| `budgetOkForKey(keyHash)` | The same, by key; `false` for unknown keys |
| `balanceOf(agentId)`, `spentToday(agentId)` | Balance and today's spend |
| `batch(batchId)` | `(root, blockNumber)` of a settled batch |
| `isInBatch(batchId, receiptHash, proof)` | `true` if the receipt is part of that settled batch |

### Receipt proofs

The settler builds each batch's tree with [`@openzeppelin/merkle-tree`](https://github.com/OpenZeppelin/merkle-tree) (`batchTree` in `@policyrouter/policy`). Each leaf is one `bytes32` receipt hash, and `isInBatch` checks it with OpenZeppelin's `MerkleProof`. A shared test-vector file proves the two sides agree: [`packages/policy/test/vectors.json`](../packages/policy/test/vectors.json) is generated in TypeScript and checked in Solidity by `MerkleCompat.t.sol`, covering 29 proofs across trees of 1 to 16 leaves.

## How the router uses them

For every request, at one pinned block:

```
(agentId, owner, circuitId, cap, killed) = registry.policyOf(keyHash)
budgetOk = escrow.budgetOkForKey(keyHash)
input    = tier + 4·size + 16·budgetOk + 32·killed
output   = processor.eval(circuitId, input)
```

`test/fork/Phase2Fork.t.sol` runs exactly this against the live Budget Guard circuit. The decision flips correctly through no deposit (deny), funded (allow), cap reached (deny), next day (allow), kill switch (deny) and unknown key (deny).

## Tests

| Suite | Kind | Tests |
| --- | --- | --- |
| `PolicyRegistry.t.sol` | Unit | 21 |
| `CreditEscrow.t.sol` | Unit, a reentrancy attack, and a fuzz test (512 runs) | 23 |
| `CreditEscrow.invariant.t.sol` | Invariants over 256,000 random calls: the escrow is always solvent, the balances add up, and a settle never raises spend above the cap | 3 |
| `MerkleCompat.t.sol` | TypeScript-built proofs verified on chain | 4 |
| `fork/Phase2Fork.t.sol` | Against the live processor and Budget Guard | 5 |

Line coverage is 100% for both PolicyRegistry and CreditEscrow.
