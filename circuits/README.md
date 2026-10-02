# Circuits

Each template policy is a 6-input, 3-output NAND circuit. Its rule, reference function and wiring live in [`packages/policy/src/templates.ts`](../packages/policy/src/templates.ts). `pnpm --filter @policyrouter/circuits build` writes `<id>.json`, and that JSON is exactly what gets taped out.

| File | Purpose |
| --- | --- |
| `<id>.json` | Netlist bytes, gate count, and the expected `eval()` output for all 64 inputs |
| `build.ts` | Regenerates the JSON from the templates. A test fails if the committed JSON is stale |
| `check.ts` | Calls `eval()` on a taped-out circuit for all 64 inputs at one pinned block and compares the results with the JSON |
| `proof/<id>.txt` | Output of `check.ts` against mainnet, kept as evidence |

## Pins

| Input pin | Meaning | Output pin | Meaning |
| --- | --- | --- | --- |
| 0–1 | requested tier (0 cheap … 3 frontier) | 0 | allow |
| 2–3 | size bucket (0 small … 3 huge) | 1–2 | route tier (0 when denied) |
| 4 | budget_ok | | |
| 5 | kill | | |

The six input pins fit in one byte, so the byte passed to `eval()` equals the input index (0–63).

## Budget Guard

**Rule:** allow only if the kill switch is off and today's spend is under the cap. The requested tier is served unchanged.

**8 gates, so 8 transistors are burned at tape-out.**

```
s8  = NAND(kill, kill)        not kill
s9  = NAND(s8, budget_ok)     deny
s10 = NAND(s9, s9)            allow (internal)
s11 = NAND(tier0, s10)
s12 = NAND(tier1, s10)
s13 = NAND(s9, s9)            allow       -> output pin 0
s14 = NAND(s11, s11)          tier0 AND allow -> output pin 1
s15 = NAND(s12, s12)          tier1 AND allow -> output pin 2
```

Allow is computed twice because TapeOut takes the last `nOut` signals as the outputs, in order.

Truth table, summarised (the full 64 rows are in `budget-guard.json` and `proof/budget-guard.txt`):

| kill | budget_ok | Output |
| --- | --- | --- |
| 1 | any | deny, route tier 0 (32 rows) |
| 0 | 0 | deny, route tier 0 (16 rows) |
| 0 | 1 | allow, route tier = requested tier (16 rows) |

## Cheap Only (10 gates)

Budget Guard, and any tier above standard is served as standard: route tier = 1 if the request was tier 1, 2 or 3, else 0.

```
s8  = NAND(kill, kill)          not kill
s9  = NAND(s8, budget_ok)       deny
s10 = NAND(s9, s9)              allow (internal)
s11 = NAND(tier0, tier0)        not tier0
s12 = NAND(tier1, tier1)        not tier1
s13 = NAND(s11, s12)            tier0 OR tier1 (any tier above cheap)
s14 = NAND(s13, s10)
s15 = NAND(s9, s9)              allow                           -> output pin 0
s16 = NAND(s14, s14)            allow AND tier>0 → route tier 1  -> output pin 1
s17 = NAND(const1, const1)      0                                -> output pin 2
```

## Small Requests (11 gates)

Budget Guard, and huge requests (size bucket 3) are denied: allow = not kill AND budget_ok AND NOT (size0 AND size1).

## Strict (13 gates)

Both rules: huge requests are denied, and the rest are capped at standard. The wiring is Small Requests' allow logic plus Cheap Only's route logic. Tests check it equals Cheap Only plus Small Requests on every row.

| Template | Gates | File |
| --- | --- | --- |
| Budget Guard | 8 | `budget-guard.json` |
| Cheap Only | 10 | `cheap-only.json` |
| Small Requests | 11 | `small-requests.json` |
| Strict | 13 | `strict.json` |

## Checking a circuit on mainnet

```bash
pnpm --filter @policyrouter/circuits check <circuitId> budget-guard            # processor from deployments/xlayer.json
pnpm --filter @policyrouter/circuits check <circuitId> budget-guard --processor 0x...
```

The script exits 0 only if the stored netlist, the pin counts and all 64 outputs match.
