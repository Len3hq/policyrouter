# Policy circuits

A policy is a circuit published on X Layer through [TapeOut](https://tapeout.net): a fixed arrangement of NAND gates that turns input bits into output bits. PolicyRouter ships four. Every policy has the same shape, **6 inputs and 3 outputs**, so any of them can be swapped for another.

## The four policies

| Policy | Circuit | Gates | The rule |
| --- | --- | --- | --- |
| **Budget Guard** | #1 | 8 | Allow only if the kill switch is off and today's spend is under the cap. The requested tier is served unchanged. |
| **Cheap Only** | #2 | 10 | Budget Guard, and any tier above *standard* is downgraded to *standard*. |
| **Small Requests** | #3 | 11 | Budget Guard, and *huge* requests (size bucket 3) are denied. |
| **Strict** | #4 | 13 | Both: huge requests are denied, and the rest are capped at *standard*. |

Each circuit has been called with all 64 possible inputs on mainnet, and every answer matches its rule. The results are published in `circuits/proof/` in the repository, and you can [re-run the check yourself](../deployments.md#verify-every-claim).

### Which one should I pick?

| You want… | Pick |
| --- | --- |
| A budget and a kill switch, nothing else | **Budget Guard** |
| To stop an agent reaching for the expensive models | **Cheap Only** |
| To refuse enormous prompts (a runaway context, a pasted codebase) | **Small Requests** |
| The tightest ceiling | **Strict** |
| To use Claude Code | **Budget Guard** or **Cheap Only** (see below) |

Not sure? The app's [policy simulation](owner-app.md#choosing-a-policy) shows what each would have done to your agent's last requests.

## The circuit's inputs

The router builds six bits for every request:

| Bits | Name | Meaning | Where it comes from |
| --- | --- | --- | --- |
| 0–1 | `tier` | The model you asked for: 0 *cheap*, 1 *standard*, 2 *premium*, 3 *frontier* | The model name in your request |
| 2–3 | `size` | The request's size bucket: 0 *small*, 1 *medium*, 2 *large*, 3 *huge* | The router's token estimate |
| 4 | `budget_ok` | 1 if the agent has a balance and today's settled spend is under its cap | CreditEscrow, on chain |
| 5 | `kill` | 1 if the owner has turned the kill switch on | PolicyRegistry, on chain |

## The circuit's outputs

| Bit | Name | Meaning |
| --- | --- | --- |
| 0 | `allow` | 1 to serve the request, 0 to refuse it |
| 1–2 | `route_tier` | The tier to serve. Lower than requested means a downgrade. Always 0 when denied. |

## Size buckets

The router estimates the request's size as the prompt's tokens (about four characters per token) plus the output limit you asked for (`max_tokens`, or 4,096 if you didn't set one):

| Bucket | Name | Estimated tokens |
| --- | --- | --- |
| 0 | small | under 2,000 |
| 1 | medium | 2,000 to 7,999 |
| 2 | large | 8,000 to 31,999 |
| 3 | huge | 32,000 or more |

The buckets are coarse on purpose: the policy only needs to tell "ordinary" from "enormous". The bucket used is recorded in the receipt.

> **Coding agents send big requests.** Claude Code's first request is about 18,000 prompt tokens before any output budget, which puts it in the *large* or *huge* bucket. **Small Requests and Strict deny most Claude Code requests.** Use Budget Guard or Cheap Only with it. Codex's typical request lands in the *large* bucket.

## Examples

Cheap Only, an agent asking for `frontier`:

```
input   0b010011   tier 3 (frontier), size 0, budget_ok 1, kill 0
output  0b011      allow, route tier 1 (standard)
```

The agent asked for *frontier* and was served *standard*. The receipt records both.

Any policy with the kill switch on:

```
input   0b110011   tier 3, size 0, budget_ok 1, kill 1
output  0b000      deny
```

## What a circuit can't express

Rules have to fit in the six input bits: tiers, size buckets and the two flags. **A circuit can't read your prompt**, so it can't block "rude prompts", secrets in a prompt, or a particular topic. If you need that, run a content filter in front of the router.

## Immutability, precisely

- **A circuit never changes.** The processor stores its netlist and nobody, including us, has a function that edits it.
- **Your agent's circuit can change, but only you can change it.** `setCircuit` is owner-only, it costs a transaction, and it emits an event on chain. The router can't do it.
- **A new rule is a new circuit.** There is no "edit".

For the gate-level wiring and how circuits are built and tested, see [Circuits and simulation](../policies.md).
