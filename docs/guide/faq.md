# FAQ

## Is PolicyRouter custodial? Who holds my OKB?

Your deposit sits in the CreditEscrow smart contract, not with us. Only the agent's owner can deposit or withdraw, and the router can only *settle*: take what your agent used, capped by your balance and your daily cap. Nobody, including us, can move your balance anywhere else. See [Security and limits](security-and-limits.md).

## What happens if the router goes down?

Your agent's requests fail. Your funds are safe: withdraw them from CreditEscrow directly ([how](owner-app.md#deposits-and-withdrawals)). The router is the only trusted off-chain piece, and it can refuse to serve you, but it can't take your balance.

## Can the policy be changed after I set it?

The **circuit** never changes. You can point your agent at a **different** circuit, but only you can, it costs a transaction, and it's an event anyone can see.

## Can the router serve a request the policy denied?

It can't do so without leaving evidence. Every request has a signed receipt, and the [Verify page](/verify) checks it against the chain: a served request whose circuit said "deny" fails the *policy decision* check. A response with no receipt at all would show up in your agent's own logs as a reply with nothing to verify.

## Can I trust the router's receipts?

Check them. Signatures, the circuit's decision, the kill switch, the budget flag and settlement are all verified against X Layer without trusting the router. What the chain can't see is the request's tier and size. The receipt records the model requested and served, so you can compare it with your agent's own logs. See [Receipts and verification](receipts-and-verification.md#what-verification-does-and-doesnt-prove).

## Why did my request come back as a cheaper model?

Your agent's policy downgraded it. With Cheap Only or Strict, any request for `premium` or `frontier` is served as `standard`. The receipt shows `modelRequested` and `modelServed`, and you're charged for what was served.

## Why was my request denied?

Check the receipt's `inputBits` (the six bits the circuit saw), read from the right: bit 5 is the kill switch, bit 4 is `budget_ok`, bits 3–2 the size bucket, bits 1–0 the tier. The usual causes:

| Receipt input | Reason |
| --- | --- |
| `kill` = 1 | The kill switch is on |
| `budget_ok` = 0 | No balance, or today's settled spend reached the daily cap |
| `size` = 3 (Small Requests, Strict) | The request was estimated at 32,000 tokens or more |

## Claude Code gets denied with Small Requests or Strict. Why?

Claude Code's requests are big: a large system prompt plus a generous output budget. They land in the *huge* size bucket, which those two policies deny. Use Budget Guard or Cheap Only. See [size buckets](policy-circuits.md#size-buckets).

## Does PolicyRouter store my prompts?

The router stores a receipt per request (token counts, model, cost) but not the content of your prompts or replies. The content does pass through the router on its way to the model provider, so don't send anything to a router you don't trust.

## Which models can I use?

`cheap`, `standard`, `premium` and `frontier`, served by DeepSeek. More providers can be added. See [Pricing](pricing-and-billing.md).

## Do I need a wallet to verify a receipt?

No. The [Verify page](/verify) only makes read-only calls. Anyone with a request id, or a pasted receipt, can use it.

## Can I run my own router?

Yes. The router is open source and configured with environment variables, and the contracts are public. See the [development guide](../development.md). The router that signs receipts must be the one set as `CreditEscrow.router`, and the escrow's router is fixed at deployment, so a different router means a different escrow.

## Is it audited?

Not independently. The contracts are small, have no admin or upgrade proxy, and have unit, fuzz and invariant tests. Treat it as hackathon-grade software, and deposit accordingly.

## Which network and token?

X Layer mainnet (chain ID 196), paid in OKB. The policy circuits are TapeOut circuits, and TapeOut's transistor is the unit used to publish new ones ([Economics](../economics.md)).

## Where is the code?

[github.com/Len3hq/policyrouter](https://github.com/Len3hq/policyrouter). The contract addresses are in [Deployed contracts](../deployments.md).
