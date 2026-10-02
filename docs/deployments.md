# Deployments

Every address here is on **X Layer mainnet (chain ID 196)**. The machine-readable record is [`deployments/xlayer.json`](../deployments/xlayer.json), and the same addresses are exported from `@policyrouter/policy` as `POLICYROUTER`. A test keeps the two in sync.

## Contracts

| Contract | Address | What it is |
| --- | --- | --- |
| PolicyRouter processor | [`0x11FF9976c86E4C868a803Bc9B5E1ba7749226f99`](https://www.oklink.com/xlayer/address/0x11FF9976c86E4C868a803Bc9B5E1ba7749226f99) | Created through the official TapeOut factory. Holds the policy circuits (ERC-721) and runs `eval()` |
| Transistors | [`0x8B37B74083Eb87A5B725B152621c729b478262E9`](https://www.oklink.com/xlayer/address/0x8B37B74083Eb87A5B725B152621c729b478262E9) | ERC-1155, token ID 0. Minted at a fixed price, burned one per gate at tape-out |
| PolicyTreasury | [`0xad56De63a2F9F5f1170E9044046C15ee467b6288`](https://www.oklink.com/xlayer/address/0xad56De63a2F9F5f1170E9044046C15ee467b6288) | Our contract. It created the processor in its constructor, so it is the transistor creator and receives every mint payment. Source: [`contracts/src/PolicyTreasury.sol`](../contracts/src/PolicyTreasury.sol) |
| Deployment wallet | [`0x87FD4bE65Ac1Eb485628539379582E8aebdD78d3`](https://www.oklink.com/xlayer/address/0x87FD4bE65Ac1Eb485628539379582E8aebdD78d3) | Sent the deployment transactions. Owns circuit 1. It is also the treasury's `ops` and `granter` address |
| Router wallet | [`0xbFF88F4CBe6723467A1c9BBbF187d8e2aB8FD5f3`](https://www.oklink.com/xlayer/address/0xbFF88F4CBe6723467A1c9BBbF187d8e2aB8FD5f3) | Will sign receipts and call `CreditEscrow.settle()`. No transactions yet |

**TapeOut infrastructure (not ours):**

| Contract | Address |
| --- | --- |
| TapeOut factory | [`0x1f09DAeFA827f02CBb40967cc91b259763760761`](https://www.oklink.com/xlayer/address/0x1f09DAeFA827f02CBb40967cc91b259763760761) |
| Processor beacon | `0xf70d1ed4f62CF3780157B0b421b7E2F45bD0991C` |
| Transistor beacon | `0x1059AD62CaBB6A6925bb65AA617300556C60A51b` |

**Phase 2 (built and tested, deploy pending):** PolicyRegistry and CreditEscrow. See [contracts.md](contracts.md). Their addresses will be added here once they are deployed.

## Circuits

| ID | Policy | Gates | Owner | Proof |
| --- | --- | --- | --- | --- |
| 1 | Budget Guard | 8 | Deployment wallet | [`circuits/proof/budget-guard.txt`](../circuits/proof/budget-guard.txt): 64/64 rows match at block 72,128,138 |

## Permanent parameters

These were fixed at deployment and cannot be changed by anyone.

| Parameter | Value | Where it is enforced |
| --- | --- | --- |
| Processor name / symbol | `PolicyRouter` / `PRT` | TapeOut processor |
| Transistor supply cap | 1,000,000 | Transistor contract `supplyCap()` |
| Transistor price | 0.0001 OKB (`100000000000000` wei) | Transistor contract `mintPrice()` |
| Running-costs share | 50% (`opsBps = 5000`) | PolicyTreasury, immutable |
| Grant pool share | 50% | PolicyTreasury, immutable |
| Max grant per new owner | 50 transistors, once per address | PolicyTreasury `maxGrant`, immutable |
| Treasury owner / admin | None. No setters, no proxy | PolicyTreasury |

## Deployment transactions

Sent by `contracts/script/DeployPhase1.s.sol`. The full record is in `contracts/broadcast/DeployPhase1.s.sol/196/run-latest.json`.

| Step | Transaction | Block |
| --- | --- | --- |
| Deploy PolicyTreasury, which creates the processor | [`0x276284ac…e6c11f`](https://www.oklink.com/xlayer/tx/0x276284acfa83ea859e4e473b36ac511534128936f6bb4cf6405c6d62f1e6c11f) | 72,128,130 |
| Mint 8 transistors | [`0xc6d66938…08449a`](https://www.oklink.com/xlayer/tx/0xc6d6693838f6680eaf9f7d409bcb5bd7861864fcc157767cb12b373cc908449a) | 72,128,133 |
| Tape out Budget Guard (circuit 1) | [`0xf7992aa4…109309`](https://www.oklink.com/xlayer/tx/0xf7992aa41bee95ee9fcbb74db6872059ef642c5ea7d438d6b5f01d96ee109309) | 72,128,136 |

Total cost: 0.00936 OKB in TapeOut fees and the transistor mint, plus 0.000044 OKB in gas.

## Verify every claim

Every check is a read-only call: no wallet and no gas. It needs [Foundry](https://getfoundry.sh)'s `cast`.

```bash
R=https://rpc.xlayer.tech
F=0x1f09DAeFA827f02CBb40967cc91b259763760761
P=0x11FF9976c86E4C868a803Bc9B5E1ba7749226f99
X=0x8B37B74083Eb87A5B725B152621c729b478262E9
T=0xad56De63a2F9F5f1170E9044046C15ee467b6288

# The processor was created by the official TapeOut factory
cast call $F "isCPU(address)(bool)" $P --rpc-url $R                    # true

# The treasury is the transistor creator, and points at our processor
cast call $X "creator()(address)" --rpc-url $R                         # 0xad56…6288
cast call $T "processor()(address)" --rpc-url $R                       # 0x11FF…6f99

# Supply cap, price, minted so far
cast call $X "supplyCap()(uint256)" --rpc-url $R                       # 1000000
cast call $X "mintPrice()(uint256)" --rpc-url $R                       # 100000000000000
cast call $X "minted()(uint256)" --rpc-url $R

# Treasury split and grant limits
cast call $T "opsBps()(uint16)" --rpc-url $R                           # 5000
cast call $T "maxGrant()(uint256)" --rpc-url $R                        # 50

# Budget Guard: 6 inputs, 3 outputs, no state, 8 gates
cast call $P "circuitInfo(uint256)(uint32,uint32,uint32,uint32)" 1 --rpc-url $R

# Ask the circuit directly (see docs/policies.md for the input byte)
cast call $P "eval(uint256,bytes)(bytes)" 1 0x13 --rpc-url $R         # 0x07 allow, tier 3
cast call $P "eval(uint256,bytes)(bytes)" 1 0x33 --rpc-url $R         # 0x00 deny (kill switch on)
```

To check all 64 rows and the stored netlist in one go:

```bash
pnpm install
pnpm --filter @policyrouter/circuits check 1 budget-guard
```
