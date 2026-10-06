# Security and limits

PolicyRouter makes cheating **detectable and expensive to hide**. It does not make it impossible. This page says exactly where the guarantees end, so you can decide what to rely on.

## What is guaranteed

| Guarantee | Why it holds |
| --- | --- |
| **A circuit never changes.** | The processor stores its netlist and has no function that edits it. |
| **Only you can change your agent's settings.** | The registry's `setCircuit`, `setDailyCap`, `setKill`, `rotateKey` and `transferAgent` are owner-only. There is no admin and no upgrade proxy. |
| **Only you can withdraw your balance.** | Withdrawals go to the agent's owner, from a reentrancy-guarded function. |
| **The router can't overcharge past your balance or cap.** | `settle` never debits more than an agent's balance, and never pushes the day's spend past the cap. Excess is logged as a shortfall and not charged. |
| **Only the router can settle, and fees go to one fixed address.** | `router` and `payee` are fixed when CreditEscrow is deployed. |
| **A leaked key can be killed.** | Turn the kill switch on, or [rotate the key](owner-app.md#rotating-a-key). A rotated-out key can never be registered again. |
| **Every request leaves a signed receipt.** | And any receipt can be [checked on chain](receipts-and-verification.md) by anyone. |
| **The router refuses rather than guesses.** | If it can't read the chain, can't run the circuit, or has no fresh OKB price, it refuses the request. |

The contracts are small, have no upgrade proxy, and are tested with unit, fuzz and invariant tests (line coverage 100% for the registry and escrow). They are **not independently audited.**

## Where the guarantees end

### The router is trusted for some things

The router sees your requests, decides the **tier** and **size bucket** itself, and serves the response. The chain can verify the kill switch, the budget and the circuit's answer, but not what the router fed it for tier and size. What stops a router from lying about them:

- the receipt records the model **requested** and the model **served**, signed;
- your agent's own logs show what it asked for;
- a mismatch between the two is proof the router misreported.

A router that lies leaves signed evidence of it. That is *detectable*, not *prevented*.

### The router can refuse you

It can go down, rate-limit you, or stop serving your agent. No circuit can prevent that. What protects you: your balance sits in CreditEscrow, you can withdraw it at any time without the router, and the kill switch and policy are yours.

### The cap is enforced at settlement

The daily cap and `budget_ok` use **settled** spend. Requests made between two settlements (about five minutes) aren't counted until the next batch. A fast agent can spend past its cap inside that window. What bounds the damage:

- a settlement can never take more than your **balance**, so deposit what you're willing to spend;
- the router rate-limits each key (60 requests a minute by default);
- the kill switch works immediately.

### The router sees your prompts

Your prompts and the model's replies pass through the router on the way to the provider. The router stores receipts (token counts, model, cost) but **not the content** of prompts or replies, and its logs hold no content. Still, if the content is sensitive, host your own router or don't use one.

### Circuits can't read content

A circuit sees six bits: tier, size, budget, kill. It can't block a topic, detect a secret in a prompt, or judge a reply. Use a content filter in front of the router for that.

### Providers

Only DeepSeek is wired in today. The provider's terms apply to whatever goes through the router.

### Timing and price

- The OKB price comes from public sources and is recorded in each receipt. A price feed that's wrong would misprice requests; the router ignores jumps over 50% and expires prices after 10 minutes.
- A kill switch applies from the next block the router reads, within about a second of confirmation.

## Reporting a problem

Open an issue at [github.com/Len3hq/policyrouter](https://github.com/Len3hq/policyrouter/issues). For something that puts funds at risk, avoid posting exploit details publicly: say you have a security issue and ask for a private channel.
