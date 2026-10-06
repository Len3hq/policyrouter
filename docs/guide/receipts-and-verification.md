# Receipts and verification

Every request that reaches the router, allowed or denied, gets a **receipt**: a signed record of exactly what the router saw and decided. The receipt is how you stop taking the router's word for anything.

## What is in a receipt

| Field | Meaning |
| --- | --- |
| `requestId` | A unique id. Use it to fetch the receipt and open its Verify page |
| `keyHash`, `agentId` | Which project. The key itself is never in a receipt |
| `processor`, `circuitId` | Which circuit decided |
| `inputBits` | What the circuit was asked: tier, size, `budget_ok`, `kill` |
| `outputBits` | What it answered: allow or deny, and the tier |
| `blockNumber` | The block the router read chain state and called the circuit at |
| `modelRequested`, `modelServed` | What you asked for and what you got. Empty `modelServed` means denied |
| `promptTokens`, `cachedPromptTokens`, `completionTokens` | What was metered |
| `okbUsdE8` | The OKB/USD price used, with 8 decimals (`12204000000` is $122.04) |
| `costWei` | What the request cost, in wei of OKB |
| `timestamp` | When, in Unix seconds. It picks peak or off-peak pricing |
| `routerSig` | The router's signature over all of the above (EIP-712) |

A receipt comes back with every response: in the `policyrouter_receipt` field of the body and in the `x-policyrouter-receipt` header, or as the last event when streaming. See [the API reference](../api/reference.md#receipts).

## Verifying a receipt

Open **[/verify](/verify)** and paste a request id, or open `/verify?id=<requestId>`. No wallet is needed. The page checks the receipt against X Layer with read-only calls. It doesn't ask the router whether the router was right.

| Check | It proves |
| --- | --- |
| **Signature** | The receipt was signed by the router address fixed in CreditEscrow, the only address allowed to settle. A changed field breaks the signature. |
| **Chain inputs** | At the receipt's block, the project, its circuit, its kill switch and its `budget_ok` really were what the receipt says. A router can't claim a project was within budget when it wasn't. |
| **Policy decision** | Asking the circuit the receipt's question at the receipt's block gives the receipt's answer. So a denied request really was denied by the policy, and a downgrade really was ordered by it. |
| **Settlement** | The receipt's hash is in a batch recorded on chain. Until its batch is settled, this check shows *pending*, which is not a failure. |

The result is a green **Verified**, an amber **pending** (nothing failed, but something isn't settled or checkable yet) or a red **Mismatch** naming the check that failed.

### Re-run it yourself

Every check has a **Re-run this yourself** panel with the exact call it made, as a [Foundry](https://getfoundry.sh) command and as raw JSON-RPC. For example, the policy check:

```bash
cast call 0x11FF9976c86E4C868a803Bc9B5E1ba7749226f99 \
  "eval(uint256,bytes)(bytes)" 1 0x10 \
  --block 72160362 --rpc-url https://rpc.xlayer.tech
# 0x01  → allow, tier 0
```

You can also verify from a terminal with the repository's CLI, which adds a fifth check, that the cost recomputes from the published prices:

```bash
pnpm --filter @policyrouter/router verify-receipt <requestId>
```

## What verification does and doesn't prove

It proves the router **followed the policy for the inputs it reported**, and that those inputs are right wherever the chain can see them.

| Proven | Not provable by the chain |
| --- | --- |
| The decision was the circuit's | That the request was really at the tier and size the router says. Only your agent and the router saw the request. Your agent's own logs show the model it asked for, and the receipt records the model requested, so you can compare. |
| `budget_ok` and `kill` were true at that block | What was in your prompt |
| The signature is the router's | That the model provider answered honestly |
| The receipt was settled in a batch | |

Receipts make cheating *detectable*. They don't make it impossible: see [Security and limits](security-and-limits.md).

## Try it with a real receipt

This is a real receipt from X Layer mainnet: a **denied** request, made with the kill switch on, and settled in batch 0. Open [/verify](/verify), expand *or paste a receipt*, paste this, and press *Verify pasted JSON*. All four checks should pass. (Public RPCs keep old chain state for a limited time. If *Chain inputs* ever says *unavailable* for an old receipt, the RPC has pruned that block; an archive RPC will check it.)

```json
{
  "receipt": {
    "requestId": "0x2bb3a79fd39bdeae11786a91c796524f755989804f0ae2f05873bbccdb1aa086",
    "keyHash": "0x30acf86513872ff8e910481e504e347a081dcc2486ef8fd7cc71d34f816191d2",
    "agentId": "1",
    "processor": "0x11FF9976c86E4C868a803Bc9B5E1ba7749226f99",
    "circuitId": "1",
    "inputBits": "0b110000",
    "outputBits": "0b000",
    "blockNumber": "72160411",
    "modelRequested": "cheap",
    "modelServed": "",
    "promptTokens": 0,
    "cachedPromptTokens": 0,
    "completionTokens": 0,
    "okbUsdE8": "12274000000",
    "costWei": "0",
    "timestamp": "1790929448",
    "routerSig": "0x664cad897c973763fd2b467623d2460a0a024c8ac6e1b462cff2efeb337596c25e111a001c615ebb31d70527b1c5d3a11be1267d56d3e56a1862d146a713dab51c"
  },
  "settlement": {
    "batchId": 0,
    "status": "confirmed",
    "proof": [
      "0x7ee013de50f3e0c312309ab992c5e3ad1e96eb7b9d42a4ce29a77a0f5d0c78ca",
      "0xcdc11ddfad91df1f230a8340d0ea73e337a9143dffb41ef2bf80933c96c8d7bd"
    ],
    "txHash": "0xd472e211c7db8b2fd414ea68b7b5a8e1fc676d73a310dc65cde9830a30c10d66"
  }
}
```

Change any value (say `outputBits` to `0b111`) and verify again: the page turns red and names the check that failed.
