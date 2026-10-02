# Router

The router is an OpenAI-compatible HTTP service. Every request goes through the agent's policy circuit before any model provider sees it. Source: [`router/`](../router).

```bash
export OPENAI_BASE_URL=http://localhost:8787/v1   # your router
export OPENAI_API_KEY=pr-live-...                 # your agent's key
```

Any client that speaks the OpenAI chat completions API works unchanged: the OpenAI SDKs, LangChain, coding agents with an OpenAI-compatible mode.

## What happens on each request

```
POST /v1/chat/completions
  1. auth          Bearer pr-live-… → keccak256 → key hash          (401 if missing or malformed)
  2. rate limit    token bucket per key hash                         (429)
  3. model         catalog lookup → tier 0–3                         (404 model_not_found)
  4. size          estimated prompt tokens + max tokens → bucket 0–3
  5. chain state   at one pinned block: registry.policyOf(keyHash), escrow.budgetOkForKey(keyHash)
                                                                     (401 if the key isn't registered)
  6. eval          processor.eval(circuitId, input byte) at that same block
                                                                     (503 policy_unavailable if 5 or 6 fails)
  7. decide        deny  → 403 policy_denied + signed receipt, provider never called
                   allow → forward at the tier the circuit chose (may be lower than requested)
  8. meter         provider-reported tokens (cache hit / miss / output) × the served model's
                   peak or off-peak price → cost in wei
  9. receipt       EIP-712 signed by the router key, stored, returned with the response
```

The router **fails closed**: if it can't read chain state or call `eval()`, it refuses the request.

## Endpoints

| Endpoint | What it returns |
| --- | --- |
| `POST /v1/chat/completions` | OpenAI chat completion, streaming or not, plus `policyrouter_receipt` |
| `GET /v1/models` | The catalog: `cheap` (tier 0), `standard` (1), `premium` (2), `frontier` (3) |
| `GET /v1/receipts/:requestId` | A stored receipt, its EIP-712 hash, whether it was allowed, and its settlement batch (Phase 4) |
| `GET /health` | Router address and EIP-712 domain |

### Where the receipt is

| Response | Receipt location |
| --- | --- |
| Allowed, not streaming | `policyrouter_receipt` field in the body, and the `x-policyrouter-receipt` header (base64url JSON) |
| Allowed, streaming | The last chunk before `[DONE]`: `choices: []` plus `policyrouter_receipt`. Request ID in the `x-policyrouter-request-id` header |
| Denied | 403 body `{ error: { code: "policy_denied" }, policyrouter_receipt }`, plus the header |
| Provider failed after policy allowed | 502 body with a zero-cost receipt, kept for the audit trail |

## Receipts

```json
{
  "requestId": "0xbf8e…dd8dd",
  "keyHash": "0x3493…deb2",
  "agentId": "1",
  "processor": "0x11FF9976c86E4C868a803Bc9B5E1ba7749226f99",
  "circuitId": "1",
  "inputBits": "0b010011",
  "outputBits": "0b111",
  "blockNumber": "72157347",
  "modelRequested": "frontier",
  "modelServed": "frontier",
  "promptTokens": 12,
  "cachedPromptTokens": 0,
  "completionTokens": 5,
  "okbUsdE8": "12204000000",
  "costWei": "128000000000",
  "timestamp": "1790933614",
  "routerSig": "0x…"
}
```

- **Signed as EIP-712** typed data. The domain is `{ name: "PolicyRouter", version: "1", chainId: 196, verifyingContract: CreditEscrow }`. The type is defined in [`packages/policy/src/receipt.ts`](../packages/policy/src/receipt.ts).
- **The EIP-712 hash is also the Merkle leaf** when the settler posts the batch (Phase 4), so `CreditEscrow.isInBatch` proves the exact signed receipt was settled.
- **`blockNumber`** is the block the router read chain state at and called `eval()` at, so a verifier sees exactly what the router saw.
- **`costWei` can be recomputed** from the receipt alone: the served model, `timestamp` (which picks peak or off-peak), the prompt, cached and completion token counts, and `okbUsdE8`, the OKB/USD rate used (8 decimals, so `12204000000` = $122.04). `verify-receipt` does this check.

### Verify one

```bash
pnpm --filter @policyrouter/router verify-receipt <requestId>          # fetches from ROUTER_URL
pnpm --filter @policyrouter/router verify-receipt --file response.json
```

It checks that the signature recovers to `ROUTER_ADDRESS`, re-runs `eval(circuitId, inputBits)` at `blockNumber`, and recomputes `costWei` from the catalog and the receipt's own token counts, time and OKB rate. It also prints the `cast call` so anyone can repeat the check without this repo.

## Model catalog

[`router/catalog.json`](../router/catalog.json) maps public model names to a tier, a provider, an upstream model and a thinking mode. DeepSeek has two models, each with thinking on or off, which gives four tiers:

| Model | Tier | Upstream (DeepSeek) | Thinking |
| --- | --- | --- | --- |
| `cheap` | 0 | `deepseek-flash` (DeepSeek-V4.1-Flash) | off |
| `standard` | 1 | `deepseek-flash` | on |
| `premium` | 2 | `deepseek-v4-pro` (DeepSeek-V4-Pro-0813) | off |
| `frontier` | 3 | `deepseek-v4-pro` | on |

**The tier decides thinking mode.** The router sets `thinking: { type }` on every upstream request and drops `reasoning_effort` when thinking is off, so an agent can't buy thinking at a non-thinking tier. When the circuit downgrades a request, the router serves the `defaultForTier` model of the tier the circuit chose.

### Pricing

Provider prices are copied from [DeepSeek's pricing page](https://api-docs.deepseek.com/quick_start/pricing) (checked 2026-10-02) in USD per 1M tokens:

| USD per 1M tokens | flash peak | flash off-peak | v4-pro peak | v4-pro off-peak |
| --- | --- | --- | --- | --- |
| Input, cache hit | 0.006 | 0.003 | 0.044 | 0.022 |
| Input, cache miss | 0.30 | 0.15 | 1.32 | 0.66 |
| Output | 1.20 | 0.60 | 3.96 | 1.98 |

- **Converted to OKB per request at the live OKB price:** USD cost ÷ OKB/USD × (1 + `markupBps` / 10,000), rounded up to the wei. The markup is **10%**. The OKB price comes from [`router/src/price.ts`](../router/src/price.ts) (see below) and is recorded in every receipt as `okbUsdE8`.
- **Peak hours** follow DeepSeek: 01:00–04:00 and 06:00–10:00 UTC, Monday to Friday. Everything else is off-peak, at half price. The router doesn't track Chinese public holidays (off-peak at DeepSeek), so it charges peak on those days. It never charges less than the provider.
- **Cache hits:** DeepSeek reports `prompt_cache_hit_tokens`, and those are billed at the cache-hit rate. OpenAI-style `prompt_tokens_details.cached_tokens` also works. If a provider reports neither, every prompt token is billed as a miss.
- Reasoning tokens are part of `completion_tokens` and billed as output.

### Live OKB price

The router never uses a hard-coded OKB price.

- **Sources**, tried in order (the first valid answer wins):
  1. OKX's OKB-USD index (OKB is OKX's own token)
  2. CoinGecko
  3. CoinPaprika
- **Refresh:** every `PRICE_REFRESH_MS` (default 60 s) in the background. At startup the router waits for the first quote.
- **Fails closed:** a price older than `PRICE_MAX_AGE_MS` (default 10 minutes) is not used. While there is no fresh price, requests that would be charged get **503 `price_unavailable`** and the provider is never called. Denials still work, since they cost nothing.
- **Bad ticks:** a refresh that moves more than 50% from the last fresh price is ignored, unless that last price has already expired.
- **One price per request:** a stream is charged at the rate it started with.

**Size buckets:** prompt tokens are estimated at about 4 characters per token, then `max_tokens` (or `max_completion_tokens`) is added, defaulting to 4,096. Buckets are split at 2,000, 8,000 and 32,000 tokens. The bucket used is recorded in the receipt's input bits.

## Running it

```bash
cp .env.example .env    # fill in ROUTER_PRIVATE_KEY, DEEPSEEK_API_KEY and the Phase 2 addresses
pnpm --filter @policyrouter/router start
```

| Env | Meaning |
| --- | --- |
| `ROUTER_PRIVATE_KEY` | Signs receipts. Must match the escrow's `router`. Export it from the keystore with `cast wallet decrypt-keystore policyrouter-router` (it asks for the keystore password and prints the key, so do it in a private terminal) |
| `PROCESSOR_ADDRESS`, `POLICY_REGISTRY_ADDRESS`, `CREDIT_ESCROW_ADDRESS` | From `deployments/xlayer.json`. The router refuses to start with a zero address |
| `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL` | Provider credentials, server side only |
| `BLOCK_CACHE_MS` | How long a block number is reused (default 1000). Chain state is cached per block, so this bounds how stale a kill switch can be |
| `RATE_LIMIT_PER_MINUTE` | Per key (default 60) |
| `PRICE_REFRESH_MS`, `PRICE_MAX_AGE_MS` | Live OKB price refresh (default 60 s) and the maximum age before charged requests are refused (default 10 min) |
| `DATABASE_PATH` | SQLite file, relative to `router/` |

### Issuing a key

```bash
pnpm --filter @policyrouter/router key:create --label my-agent --circuit 1 --cap 0.001
```

This prints the key once, stores only its hash, and prints the `cast send` commands to register the agent on PolicyRegistry and fund it in CreditEscrow. In Phase 6 the web app takes this over.

## Security notes

- **Keys:** only `keccak256(key)` is stored, on chain and in SQLite. Every log line passes through a redactor that removes `pr-live-…` keys, `sk-…` provider keys, bearer headers and the configured secrets.
- **Provider errors:** upstream failures become a generic `upstream_error`. The provider's own message, which can echo part of its key, is never returned or logged.
- **Order of checks:** malformed keys and rate-limited keys are rejected before any RPC call, so junk traffic can't spend the RPC budget.
- **Storage:** SQLite through Node's built-in `node:sqlite` (Node 22.13+), so there is no native module to build.

## Tests

| Suite | Command | What it covers |
| --- | --- | --- |
| Unit (61) | `pnpm --filter @policyrouter/router test` | Catalog, USD→OKB conversion at the live rate, the price feed (fallback order, junk, expiry, jump guard), peak hours, cache-aware pricing and size buckets; refusing charged requests with no fresh price; forcing the tier's thinking mode; keys; rate limit; log redaction; the policy checker (allow, downgrade, deny, and refusing on eval failure, read failure or empty output); the full HTTP gateway with fake chain and provider (auth, validation, 429, deny, downgrade, 503, 502 without leaks, streaming, receipts, models) |
| Integration (10) | `pnpm --filter @policyrouter/router test:integration` | A real router against an anvil fork of X Layer: Phase 2 deployed on the fork, Cheap Only taped out on the live processor, the real chain reader and provider adapter, and a mock provider. Covers allow, downgrade, kill switch, cap reached, unfunded, unknown key, RPC down, streaming, receipt replay, and checking no secret is logged |

The integration suite needs `anvil` (Foundry) and runs in CI.
