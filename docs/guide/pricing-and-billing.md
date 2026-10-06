# Pricing and billing

You pay for what your agent uses, in **OKB**, from the balance you deposited. There are no subscriptions, seats or minimums.

## The formula

For every request the router prices the tokens at the model provider's published USD rates, then converts to OKB at the live price and adds its markup:

```
cost (OKB) = provider cost (USD) ÷ OKB price (USD) × 1.10
```

| Part | Detail |
| --- | --- |
| **Provider cost** | DeepSeek's published per-million-token prices, below. Prompt tokens the provider served from its cache are billed at the cheaper *cache hit* rate. |
| **OKB price** | The live OKB/USD price, refreshed every minute from OKX's index, then CoinGecko, then CoinPaprika. It is recorded in every receipt. |
| **Markup** | **10%** over the provider's cost. |
| **Rounding** | Up to the next wei, so a request never costs less than it should. |

If the router has no OKB price newer than 10 minutes, it refuses requests that would be charged (`503 price_unavailable`) rather than guess. Denials cost nothing and still work.

## Provider rates

USD per million tokens, from [DeepSeek's pricing page](https://api-docs.deepseek.com/quick_start/pricing). Off-peak is half of peak.

| | Flash, peak | Flash, off-peak | V4 Pro, peak | V4 Pro, off-peak |
| --- | --- | --- | --- | --- |
| Input, cache hit | $0.006 | $0.003 | $0.044 | $0.022 |
| Input, cache miss | $0.30 | $0.15 | $1.32 | $0.66 |
| Output | $1.20 | $0.60 | $3.96 | $1.98 |

**Peak hours** are 01:00–04:00 and 06:00–10:00 UTC, Monday to Friday. Every other hour is off-peak. DeepSeek treats Chinese public holidays as off-peak too; the router doesn't track them, so it charges peak on those days. It never charges less than the provider does.

| Your model | Served by |
| --- | --- |
| `cheap`, `standard` | DeepSeek flash (thinking off, on) |
| `premium`, `frontier` | DeepSeek V4 Pro (thinking off, on) |

Reasoning tokens from thinking models count as output tokens.

> **A downgrade is cheaper, and you're charged for what was served.** If a policy downgrades `frontier` to `standard`, the receipt says so and the cost is `standard`'s.

## A worked example

A request to `cheap` at off-peak with OKB at $122: 14 prompt tokens (none cached) and 24 completion tokens.

```
input   14 × $0.15  / 1M  = $0.0000021
output  24 × $0.60  / 1M  = $0.0000144
                      sum = $0.0000165
÷ $122 per OKB  × 1.10    ≈ 0.00000015 OKB
```

At the same OKB price, a million completion tokens on `frontier` at peak costs about $3.96 ÷ $122 × 1.10 ≈ 0.0357 OKB.

## Where the money goes

1. **You deposit OKB** into CreditEscrow for an agent. It sits there, owned by you.
2. **Requests are metered** as they happen, but not charged until settlement.
3. **Every few minutes the router settles.** CreditEscrow takes each agent's total for the batch out of its balance and adds it to the fees the router has earned. It never takes more than the agent's balance, and never pushes the day past the agent's cap.
4. **The fees go to one fixed address.** CreditEscrow's `payee`, set at deployment and unchangeable, receives the settled fees. The router cannot send them elsewhere.

You can see all of it: the deposit, each batch, and every receipt's cost.

## Withdrawing

Anything not yet settled out of your balance is yours. [Withdraw it](owner-app.md#deposits-and-withdrawals) at any time, even while the kill switch is on. Withdrawals are sent only to the agent's owner.

## Policies are separate from this

Publishing a new circuit costs transistors, TapeOut's unit of gate-building; using one of PolicyRouter's four policies costs you nothing extra. See [Economics](../economics.md) for the transistor, and for how its sales fund the project and give new owners free transistors for a first custom policy.
