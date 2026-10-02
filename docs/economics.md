# Economics

PolicyRouter has one asset, the **transistor**, and no separate token. Router usage is paid for with prepaid OKB credit.

## The transistor

| Property | Value | Enforced by |
| --- | --- | --- |
| Standard | ERC-1155, token ID 0 | TapeOut transistor contract [`0x8B37…62E9`](https://www.oklink.com/xlayer/address/0x8B37B74083Eb87A5B725B152621c729b478262E9) |
| Supply cap | 1,000,000 | Fixed at creation |
| Price | 0.0001 OKB | Fixed at creation |
| Use | Burned one per gate when a circuit is taped out on our processor | TapeOut processor |
| Resale | Whatever TapeOut already supports. We build no resale mechanics | — |

**Who pays:** anyone who tapes out a policy on the PolicyRouter processor. That includes us for the templates, and owners who want a custom rule. Budget Guard cost 8 transistors (0.0008 OKB).

**TapeOut's own fees** are paid on top and go to TapeOut, not to us: 0.0066 OKB to create a processor (paid once), 0.00066 OKB per mint call, and 0.0013 OKB per tape-out.

## Where the money goes: PolicyTreasury

[PolicyTreasury](../contracts/src/PolicyTreasury.sol) created the processor, so it is the transistor creator. **Every mint payment goes to the treasury, never to a wallet.** The split is fixed in code with no owner and no setters:

```
mint payments ──► PolicyTreasury.sweep()
                    ├── 50% ──► opsOwed ──► withdrawOps() ──► ops address (running costs)
                    └── 50% ──► pool ──► grant() ──► free transistors for a new owner's first custom policy
```

| Function | Who can call | What it does |
| --- | --- | --- |
| `sweep()` | Anyone | Pulls owed mint proceeds from the transistor contract and splits them |
| `withdrawOps()` | Anyone | Sends the running-costs share to `ops`, the only possible recipient |
| `grant(to, amount)` | `granter` only | Mints up to 50 transistors from the pool and sends them to `to`. **Once per address** |

When the treasury mints for a grant, it pays the mint price to itself as creator. On the next sweep that amount goes back to the pool instead of being split again, so a grant really costs the pool only TapeOut's protocol fee. Fork tests check this: `test_selfMintReturnsToPoolOnSweep`.

**Why the grant pool matters:** it turns transistor sales into user growth. Each owner who pays for a custom policy funds part of the next new owner's first one.

## Why the transistor holds value

- **Demand tracks adoption:** every owner who wants a rule beyond the templates has to mint and burn transistors.
- **Burning is permanent:** the supply cap never resets, so every tape-out uses up part of the fixed supply.

## Usage fees (planned)

- Each model has a published price per million tokens: the provider's cost plus a small, stated markup.
- Owners deposit OKB into CreditEscrow as prepaid credit. Unused balance stays withdrawable by the owner at any time.
- The router settles usage on chain in batches. `settle` can never take more than a key's balance or push today's spend past its cap.

## Out of scope

- **A separate IGNIX token:** IGNIX only launches tokens it deploys itself.
- **Trading incentives:** we never push trading volume. The hackathon rules ignore price and volume, and fake trading voids eligibility.
