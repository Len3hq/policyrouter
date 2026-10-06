# Deployments

Every address here is on **X Layer mainnet (chain ID 196)**. The machine-readable record is [`deployments/xlayer.json`](../deployments/xlayer.json), and the same addresses are exported from `@policyrouter/policy` as `POLICYROUTER`. A test keeps the two in sync.

## Contracts

| Contract | Address | What it is |
| --- | --- | --- |
| PolicyRouter processor | [`0x11FF9976c86E4C868a803Bc9B5E1ba7749226f99`](https://www.oklink.com/xlayer/address/0x11FF9976c86E4C868a803Bc9B5E1ba7749226f99) | Created through the official TapeOut factory. Holds the policy circuits (ERC-721) and runs `eval()` |
| Transistors | [`0x8B37B74083Eb87A5B725B152621c729b478262E9`](https://www.oklink.com/xlayer/address/0x8B37B74083Eb87A5B725B152621c729b478262E9) | ERC-1155, token ID 0. Minted at a fixed price, burned one per gate at tape-out |
| PolicyTreasury | [`0xad56De63a2F9F5f1170E9044046C15ee467b6288`](https://www.oklink.com/xlayer/address/0xad56De63a2F9F5f1170E9044046C15ee467b6288) | Our contract. It created the processor in its constructor, so it is the transistor creator and receives every mint payment. Source: [`contracts/src/PolicyTreasury.sol`](../contracts/src/PolicyTreasury.sol) |
| Deployment wallet | [`0x87FD4bE65Ac1Eb485628539379582E8aebdD78d3`](https://www.oklink.com/xlayer/address/0x87FD4bE65Ac1Eb485628539379582E8aebdD78d3) | Sent the deployment transactions. Owns circuit 1. It is also the treasury's `ops` and `granter` address |
| PolicyRegistry | [`0x7F05d6c389F973EA3Fb10A3Eb27e338f8eB42D0a`](https://www.oklink.com/xlayer/address/0x7F05d6c389F973EA3Fb10A3Eb27e338f8eB42D0a) | Our contract. Links each agent's API key hash to its owner, policy circuit, daily cap and kill switch. Bound to the processor above. Source: [`contracts/src/PolicyRegistry.sol`](../contracts/src/PolicyRegistry.sol) |
| CreditEscrow | [`0xCc2dd59C8042e42253D1C14d5c34F976226b7F7A`](https://www.oklink.com/xlayer/address/0xCc2dd59C8042e42253D1C14d5c34F976226b7F7A) | Our contract. Holds prepaid OKB, tracks daily spend, settles usage with Merkle roots of receipts. Bound to PolicyRegistry. Source: [`contracts/src/CreditEscrow.sol`](../contracts/src/CreditEscrow.sol) |
| Router wallet | [`0xbFF88F4CBe6723467A1c9BBbF187d8e2aB8FD5f3`](https://www.oklink.com/xlayer/address/0xbFF88F4CBe6723467A1c9BBbF187d8e2aB8FD5f3) | Signs receipts. The only address `CreditEscrow.settle()` accepts. No transactions yet |

**TapeOut infrastructure (not ours):**

| Contract | Address |
| --- | --- |
| TapeOut factory | [`0x1f09DAeFA827f02CBb40967cc91b259763760761`](https://www.oklink.com/xlayer/address/0x1f09DAeFA827f02CBb40967cc91b259763760761) |
| Processor beacon | `0xf70d1ed4f62CF3780157B0b421b7E2F45bD0991C` |
| Transistor beacon | `0x1059AD62CaBB6A6925bb65AA617300556C60A51b` |

PolicyRegistry and CreditEscrow are documented in [contracts.md](contracts.md).

## Circuits

| ID | Policy | Gates | Owner | Proof |
| --- | --- | --- | --- | --- |
| 1 | Budget Guard | 8 | Deployment wallet | [`circuits/proof/budget-guard.txt`](../circuits/proof/budget-guard.txt): 64/64 rows match at block 72,128,138 |
| 2 | Cheap Only | 10 | Deployment wallet | [`circuits/proof/cheap-only.txt`](../circuits/proof/cheap-only.txt): 64/64 rows match at block 72,171,899 |
| 3 | Small Requests | 11 | Deployment wallet | [`circuits/proof/small-requests.txt`](../circuits/proof/small-requests.txt): 64/64 rows match at block 72,171,903 |
| 4 | Strict | 13 | Deployment wallet | [`circuits/proof/strict.txt`](../circuits/proof/strict.txt): 64/64 rows match at block 72,171,906 |

42 transistors have been minted and burned in total (8 + 10 + 11 + 13). Their mint price, 0.0042 OKB, is owed to PolicyTreasury, and anyone can call `sweep()` to split it.

## Settled batches

| Batch | Receipts | Debited | Root | Tx | Block |
| --- | --- | --- | --- | --- | --- |
| 0 | 4 (3 served, 1 denied) from agent 1 | 2,109,162,756,815 wei | `0xe4568b…b31e` | [`0xd472e211…0d66`](https://www.oklink.com/xlayer/tx/0xd472e211c7db8b2fd414ea68b7b5a8e1fc676d73a310dc65cde9830a30c10d66) | 72,161,097 |
| 1 | 4 from agent 1 (the Phase 6 quickstart: OpenAI SDK Node and Python, Codex, Claude Code), settled by the router's own settler | 38,545,416,643,846 wei | `0x54f22f…7b8c` | [`0xae1f4589…b005`](https://www.oklink.com/xlayer/tx/0xae1f4589f1bd6243d47458bf86909fc64f08d8ff12fbbeb6b5f4b24494a6b005) | 72,174,540 |

Check a batch root: `cast call $ESC "batch(uint256)(bytes32,uint64)" 0 --rpc-url $R`.

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
| Registry's processor | `0x11FF…6f99` (only circuits on it, with 6 inputs / 3 outputs / no state, are accepted) | PolicyRegistry, immutable |
| Escrow's registry | `0x7F05…2D0a` | CreditEscrow, immutable |
| Only address that can settle | Router wallet `0xbFF8…D5f3` | CreditEscrow `router`, immutable |
| Receives settled usage fees | Deployment wallet `0x87FD…78d3` | CreditEscrow `payee`, immutable |
| Registry / escrow admin | None. No setters, no proxy | PolicyRegistry, CreditEscrow |

## Deployment transactions

Sent by `contracts/script/DeployPhase1.s.sol`, `DeployPhase2.s.sol` and `DeployPhase5.s.sol`. The full records are in `contracts/broadcast/DeployPhase{1,2,5}.s.sol/196/run-latest.json`.

| Step | Transaction | Block |
| --- | --- | --- |
| Deploy PolicyTreasury, which creates the processor | [`0x276284ac…e6c11f`](https://www.oklink.com/xlayer/tx/0x276284acfa83ea859e4e473b36ac511534128936f6bb4cf6405c6d62f1e6c11f) | 72,128,130 |
| Mint 8 transistors | [`0xc6d66938…08449a`](https://www.oklink.com/xlayer/tx/0xc6d6693838f6680eaf9f7d409bcb5bd7861864fcc157767cb12b373cc908449a) | 72,128,133 |
| Tape out Budget Guard (circuit 1) | [`0xf7992aa4…109309`](https://www.oklink.com/xlayer/tx/0xf7992aa41bee95ee9fcbb74db6872059ef642c5ea7d438d6b5f01d96ee109309) | 72,128,136 |
| Deploy PolicyRegistry | [`0xa6ea342f…46e025`](https://www.oklink.com/xlayer/tx/0xa6ea342f35734bd253dac3ef8a99b1ba6fe3df73f96beb1f5c30c7c3bd46e025) | 72,159,847 |
| Deploy CreditEscrow | [`0x364c121f…f8cfc`](https://www.oklink.com/xlayer/tx/0x364c121f20c842b59e8b18f5ec5a86efd5087c9dbbf91df1f0d0c05c787f8cfc) | 72,159,849 |
| Mint 34 transistors for three templates (one call) | [`0xaa325e3a…9b23fd`](https://www.oklink.com/xlayer/tx/0xaa325e3ab96cd707e5e688abcaf3d4b0730656b03c18fe640bc8d062309b23fd) | 72,171,825 |
| Tape out Cheap Only (circuit 2) | [`0xaf63e240…4f493a`](https://www.oklink.com/xlayer/tx/0xaf63e2405878c195b617cf9da33c1b1ddcfac2ad4f1a3a2daa9ea90c504f493a) | 72,171,828 |
| Tape out Small Requests (circuit 3) | [`0x523cd8ab…8826af`](https://www.oklink.com/xlayer/tx/0x523cd8ab7c1cd5f6edcb9d2f8155456e1e086cbfb5c29b57ac9e51f3238826af) | 72,171,832 |
| Tape out Strict (circuit 4) | [`0x70048bd9…76c04f`](https://www.oklink.com/xlayer/tx/0x70048bd9ea85bdc079e8fd183320e68736a3686041aa59ac04f4ede19d76c04f) | 72,171,835 |

Total cost: Phase 1 was 0.00936 OKB in TapeOut fees and the transistor mint, plus 0.000044 OKB in gas. Phase 2 was 0.000038 OKB in gas. Phase 5 was 0.00796 OKB in TapeOut fees and the transistor mint, plus 0.000016 OKB in gas.

## Verify every claim

Every check is a read-only call: no wallet and no gas. It needs [Foundry](https://getfoundry.sh)'s `cast`.

```bash
R=https://rpc.xlayer.tech
F=0x1f09DAeFA827f02CBb40967cc91b259763760761
P=0x11FF9976c86E4C868a803Bc9B5E1ba7749226f99
X=0x8B37B74083Eb87A5B725B152621c729b478262E9
T=0xad56De63a2F9F5f1170E9044046C15ee467b6288
REG=0x7F05d6c389F973EA3Fb10A3Eb27e338f8eB42D0a
ESC=0xCc2dd59C8042e42253D1C14d5c34F976226b7F7A

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

# Registry and escrow wiring, router and payee
cast call $REG "processor()(address)" --rpc-url $R                     # 0x11FF…6f99
cast call $ESC "registry()(address)" --rpc-url $R                      # 0x7F05…2D0a
cast call $ESC "router()(address)" --rpc-url $R                        # 0xbFF8…D5f3
cast call $ESC "payee()(address)" --rpc-url $R                         # 0x87FD…78d3

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
