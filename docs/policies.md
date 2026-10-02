# Policies

A policy is a TapeOut circuit: a fixed arrangement of NAND gates, stored on chain, that turns input bits into output bits. Every PolicyRouter policy has the same interface: **6 inputs and 3 outputs**. The router builds the inputs for each request, calls `eval()`, and does exactly what the outputs say.

A circuit cannot hold money, remember anything between calls, read other contracts or call the internet. That is why the changing numbers (today's spend, the kill switch) are passed in as input bits. Those numbers live in ordinary contracts, and the circuit stays a pure function anyone can re-run.

## The interface

**Inputs (6 bits), built by the router for each request**

| Pin | Name | Meaning |
| --- | --- | --- |
| 0–1 | `tier` | Requested model tier: 0 cheap, 1 standard, 2 premium, 3 frontier (pin 0 is the low bit) |
| 2–3 | `size` | Request size bucket: 0 small, 1 medium, 2 large, 3 huge |
| 4 | `budget_ok` | 1 if today's spend is under the daily cap |
| 5 | `kill` | 1 if the owner has hit the kill switch |

**Outputs (3 bits)**

| Pin | Name | Meaning |
| --- | --- | --- |
| 0 | `allow` | 1 to serve the request, 0 to refuse |
| 1–2 | `route_tier` | Tier to actually serve. Lower than requested means a forced downgrade. Always 0 when denied |

### Bytes on the wire

TapeOut packs pin `i` into bit `i % 8` of byte `i >> 3`. Six inputs fit in one byte, so the byte passed to `eval()` is:

```
input byte = tier + 4·size + 16·budget_ok + 32·kill        (0x00 – 0x3f)
output     = allow + 2·route_tier                          (0x00 – 0x07)
```

| Request | Input byte | Budget Guard output |
| --- | --- | --- |
| Frontier (3), small, budget ok, kill off | `0x13` | `0x07`: allow, tier 3 |
| Standard (1), small, budget ok, kill off | `0x11` | `0x03`: allow, tier 1 |
| Standard (1), huge, budget ok, kill off | `0x1d` | `0x03`: allow, tier 1 |
| Frontier (3), small, budget spent | `0x03` | `0x00`: deny |
| Frontier (3), small, budget ok, kill on | `0x33` | `0x00`: deny |

In TypeScript, use `encodeInput` and `decodeOutput` from `@policyrouter/policy`. Don't pack bits by hand.

## Template policies

| Policy | Rule | Status |
| --- | --- | --- |
| **Budget Guard** | Allow only if the kill switch is off and today's spend is under the cap. The requested tier is served unchanged | **Live: circuit 1, 8 gates** |
| Cheap Only | Budget Guard, and any tier above 1 is downgraded to 1 | Planned (Phase 5) |
| Small Requests | Budget Guard, and huge requests (`size = 3`) are denied | Planned (Phase 5) |
| Strict | Cheap Only and Small Requests combined | Planned (Phase 5) |

Owners will also be able to build a custom policy and tape it out on our processor, burning one transistor per gate (Phase 8).

### Budget Guard

| kill | budget_ok | Output |
| --- | --- | --- |
| 1 | any | deny, route tier 0 (32 of 64 inputs) |
| 0 | 0 | deny, route tier 0 (16 of 64) |
| 0 | 1 | allow, route tier = requested tier (16 of 64) |

The gate-by-gate wiring is in [circuits/README.md](../circuits/README.md). All 64 rows are in [circuits/budget-guard.json](../circuits/budget-guard.json), and the mainnet run is in [circuits/proof/budget-guard.txt](../circuits/proof/budget-guard.txt).

## How a policy goes from idea to chain

1. **Rule:** write the reference function in [`packages/policy/src/templates.ts`](../packages/policy/src/templates.ts).
2. **Circuit:** wire it with `NetlistBuilder` in the same file. Tests simulate the circuit and require it to equal the rule on all 64 inputs.
3. **Artifact:** `pnpm --filter @policyrouter/circuits build` writes `circuits/<id>.json`: the netlist bytes, the gate count and the 64 expected outputs. A test fails if the committed file is stale.
4. **Fork test:** Foundry tapes the JSON out on a fork of the real TapeOut contracts and checks `eval()` on all 64 inputs.
5. **Tape out:** a deploy script mints one transistor per gate and calls `tapeout()` on mainnet.
6. **Proof:** `pnpm --filter @policyrouter/circuits check <id> <template>` reads all 64 outputs and the stored netlist at one pinned block, and writes `circuits/proof/<id>.txt`.

## What circuits cannot express

Anything about prompt content, such as "block rude prompts". A rule has to be expressible in the six input bits: tiers, size buckets and flags.
