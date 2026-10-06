# The owner app

The web app is where you create and fund agents, choose their policy, and watch what they do. It needs a browser wallet on X Layer. Everything it does is an on-chain transaction from your wallet, so you stay in control: the router can't change your agent's settings.

## Screens

| Screen | What you do there |
| --- | --- |
| **Landing** (no wallet) | See what PolicyRouter is, the quickstart, and the four policies, each simulated on a sample workload |
| **New agent** | Pick a policy, a daily cap and a first deposit |
| **Key reveal** | Copy the agent's API key. It is shown once |
| **Dashboard** | Balance, spend, kill switch, cap, deposit, request counts, recent requests |
| **Policy** | Compare the four policies on your agent's own traffic and switch |
| **[Verify](/verify)** | Check any receipt. No wallet needed |

## Your agents

The sidebar lists every agent your wallet owns. An agent is identified by a permanent number (Agent #1, #2…). Its API key can change; its number, balance and settings stay.

## The dashboard

| Item | Meaning |
| --- | --- |
| **Status** | *Active*, *Killed*, *Unfunded* or *Over today's cap* |
| **Balance** | OKB deposited and not yet spent |
| **Spent today (settled)** | OKB already settled on chain today, against the daily cap. Requests not yet settled aren't counted until the next [settlement](how-it-works.md#settlement) |
| **Requests** | Allowed (served as asked), downgraded (served by a cheaper tier) and denied, for this agent |
| **Recent requests** | The last requests, each with a **verify** link |

The request counts and recent list come from the router, using the agent's key. In a new browser session the dashboard asks you to paste the key; it checks it against the agent's on-chain hash before using it.

## The kill switch

One button. While it is on, the policy circuit denies every request from this agent. It takes effect on the agent's next request (the router reads the chain at the latest block, with a cache of about one second), and it works even if your agent is misbehaving or compromised.

Your balance is untouched. Turning the switch off restores service.

## Daily cap

The most OKB the agent may spend per UTC day, enforced through the circuit's `budget_ok` input: once the day's *settled* spend reaches the cap, the next request is denied. It resets at 00:00 UTC. Change it any time with **Set cap**. Lowering it below today's spend takes effect immediately.

## Deposits and withdrawals

**Deposit** adds OKB to the agent's balance. Only the agent's owner can deposit, from the wallet that owns it.

Unspent OKB belongs to you and can be withdrawn at any time, even while the kill switch is on. The app doesn't have a withdraw button yet, so call the escrow contract directly. With [Foundry](https://getfoundry.sh):

```bash
cast send 0xCc2dd59C8042e42253D1C14d5c34F976226b7F7A \
  "withdraw(uint256,uint256)" <agentId> <amountInWei> \
  --account <your-keystore> --rpc-url https://rpc.xlayer.tech
```

Or use the **Write Contract** tab for `CreditEscrow` on [OKLink](https://www.oklink.com/xlayer/address/0xCc2dd59C8042e42253D1C14d5c34F976226b7F7A).

## Choosing a policy

Each policy card shows its rule, its circuit, a link to its 64-row proof on mainnet, and a **simulation**: what the policy would have done to your agent's last requests.

- **Allowed**: served as requested.
- **Downgraded**: served by a cheaper tier.
- **Denied**: refused.
- **% saved**: spend under the policy compared with spend without it.

An agent with no history is simulated on a sample workload of 20 typical requests, and the card says so. The decisions in a simulation are exact (they come from the same circuit logic the chain runs); the spend is an estimate, because token counts are reused when a request is re-priced at another tier.

**Use this policy** sends one transaction (`setCircuit`). It doesn't edit any circuit. It points your agent at a different one, and that change is an on-chain event anyone can see.

## Building a custom policy

Below the four templates is **Build a custom policy**: pick the highest tier served, whether requests above it are downgraded or denied, and the largest request allowed. The app shows the rule in words, a grid of what it does to each tier and size, a simulation on your agent's requests, and the cost. The button then either reuses an existing circuit (a template, or one someone already taped out) or tapes out a new one for you. See [custom policies](policy-circuits.md#custom-policies).

## Rotating a key

A lost or leaked key can be replaced without touching your balance or settings. Generate a new key and its hash, then register the hash:

```bash
NEW_KEY="pr-live-$(openssl rand -hex 24)"
echo "$NEW_KEY"                       # your new API key: save it
cast keccak "$NEW_KEY"                # its hash

cast send 0x7F05d6c389F973EA3Fb10A3Eb27e338f8eB42D0a \
  "rotateKey(uint256,bytes32)" <agentId> <newKeyHash> \
  --account <your-keystore> --rpc-url https://rpc.xlayer.tech
```

The old key stops working immediately and can never be registered again. The app doesn't have a rotate button yet.

## Moving an agent to another wallet

`PolicyRegistry.transferAgent(agentId, newOwner)` hands over the agent and control of its balance. See [the contracts](../contracts.md).
