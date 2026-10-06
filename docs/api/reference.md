# API reference

The router speaks three wire formats and a few extras. Replace `YOUR_ROUTER_URL` with your router's address (shown in the app's quickstart).

| Endpoint | Purpose | Auth |
| --- | --- | --- |
| `POST /v1/chat/completions` | OpenAI chat completions, streaming or not | Bearer key |
| `POST /v1/responses` | OpenAI Responses API (Codex) | Bearer key |
| `POST /v1/messages` | Anthropic Messages API (Claude Code) | `x-api-key` or Bearer |
| `POST /v1/messages/count_tokens` | A local token estimate for Claude Code | `x-api-key` or Bearer |
| `GET /v1/models` | The four models and their tiers | none |
| `GET /v1/receipts/:requestId` | A stored receipt, with its settlement and proof | none |
| `GET /v1/simulate` | What each policy would have done to your recent requests | optional |
| `GET /v1/usage` | Your agent's counts, spend and recent requests | Bearer key |
| `GET /health` | The router's address and signing domain | none |

## Authentication

Your agent's API key looks like `pr-live-` followed by 48 hex characters. Send it as a bearer token:

```
Authorization: Bearer pr-live-3f9a…
```

`POST /v1/messages` also accepts the key as `x-api-key`, which is how Anthropic clients send it. Malformed keys get `401` before anything else happens; unknown keys get `401` after an on-chain lookup.

## Chat completions

```bash
curl YOUR_ROUTER_URL/v1/chat/completions \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "standard",
    "max_tokens": 200,
    "messages": [{"role": "user", "content": "Reply with exactly: ok"}]
  }'
```

It's the standard OpenAI request. The response is the provider's completion plus two things:

- `model` is the model **served** (`standard` here), which can differ from the one you asked for if the policy downgraded you;
- `policyrouter_receipt` is the signed [receipt](#receipts).

Set `"stream": true` to stream. The receipt arrives as the **last event** before `[DONE]`: a chunk with `"choices": []` and a `policyrouter_receipt` field.

You can't choose thinking on or off: the tier sets it, and the router overrides any `thinking` field you send. On thinking tiers your `reasoning_effort` is passed through.

## Responses API

`POST /v1/responses` takes an OpenAI Responses request and forwards it to the provider's Responses endpoint. The body and the stream pass through unchanged, with the receipt added to the JSON (`policyrouter_receipt`). For a stream, the response header `x-policyrouter-request-id` names the receipt, which you fetch from `GET /v1/receipts/<id>` once the stream ends.

## Messages API

`POST /v1/messages` takes an Anthropic Messages request. Use `ANTHROPIC_BASE_URL=YOUR_ROUTER_URL` (no `/v1`). Same pass-through and receipt behaviour as above. Errors use Anthropic's shape:

```json
{ "type": "error", "error": { "type": "permission_error", "message": "…" } }
```

A denial is `permission_error`. Model names must be one of the four below, not Anthropic's.

## Models

| Model | Tier | Served by | Thinking |
| --- | --- | --- | --- |
| `cheap` | 0 | DeepSeek flash | off |
| `standard` | 1 | DeepSeek flash | on |
| `premium` | 2 | DeepSeek V4 Pro | off |
| `frontier` | 3 | DeepSeek V4 Pro | on |

An unknown model returns `404 model_not_found`.

## Receipts

Every response has a receipt: in the body (`policyrouter_receipt`), in the `x-policyrouter-receipt` header (the JSON, base64url-encoded), and at `GET /v1/receipts/:requestId`.

```json
{
  "requestId": "0x2bb3…a086",
  "keyHash": "0x30ac…91d2",
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
  "routerSig": "0x664c…ab51c"
}
```

Field meanings are in [Receipts and verification](../guide/receipts-and-verification.md#what-is-in-a-receipt). The `x-policyrouter-request-id` response header carries the request id on every response, which is how you find the receipt of a streamed Responses or Messages request.

### GET /v1/receipts/:requestId

```json
{
  "receipt": { "…": "as above" },
  "receiptHash": "0xb31dc899…",
  "allowed": false,
  "batchId": 0,
  "settlement": {
    "batchId": 0,
    "status": "confirmed",
    "root": "0xe4568b…",
    "proof": ["0x7ee0…", "0xcdc1…"],
    "txHash": "0xd472…",
    "blockNumber": "72161097"
  }
}
```

`settlement` is `null` until the receipt is in a batch. `status` is `pending`, `sent` or `confirmed`. Check a confirmed one on chain with `CreditEscrow.isInBatch(batchId, receiptHash, proof)`, or on the [Verify page](/verify).

## Simulation

`GET /v1/simulate?template=cheap-only&limit=100`

| Parameter | Meaning |
| --- | --- |
| `template` | `budget-guard`, `cheap-only`, `small-requests` or `strict`. Omit for all four. |
| `limit` | How many of your recent requests to replay: 1–500, default 100 |

With your key, it replays **your own** history. Without one, or with no history yet, it uses a fixed 20-request sample workload. The response says which with `"source": "history"` or `"sample"`.

```json
{
  "source": "history",
  "requests": 12,
  "results": [{
    "template": "cheap-only",
    "name": "Cheap Only",
    "circuitId": "2",
    "requests": 12,
    "allowed": 7, "downgraded": 5, "denied": 0,
    "spendWithout": "<wei>", "spendWith": "<wei>",
    "savingsPct": 41.2
  }]
}
```

The counts are exact. The spend is an estimate: see [the owner app](../guide/owner-app.md#choosing-a-policy).

## Usage

`GET /v1/usage` with your key:

```json
{
  "requests": 9, "allowed": 6, "downgraded": 2, "denied": 1,
  "spentWei": "…", "unsettledWei": "…",
  "recent": [{ "requestId": "0x…", "modelRequested": "frontier", "modelServed": "standard",
               "allowed": true, "downgraded": true, "costWei": "…", "timestamp": "…" }]
}
```

## Errors

OpenAI-compatible endpoints return:

```json
{ "error": { "message": "…", "type": "policy_denied", "code": "policy_denied", "param": null } }
```

| Status | `code` | Meaning |
| --- | --- | --- |
| 400 | `invalid_request_error` | The body isn't valid, or `model`/`messages` is missing |
| 401 | `invalid_api_key` | No key, a malformed key, or a key not registered on chain |
| 403 | `policy_denied` | **The circuit said no.** The body includes `policyrouter_receipt`. The provider was not called. |
| 404 | `model_not_found` | Not one of the four models |
| 429 | `rate_limit_exceeded` | Too many requests for this key (60 a minute by default) |
| 502 | `upstream_error` | The model provider failed. A zero-cost receipt is attached. The provider's own message is never passed on. |
| 503 | `policy_unavailable` | The router couldn't read the chain or run the circuit, so it refused |
| 503 | `price_unavailable` | No fresh OKB price to charge with, so it refused |

A `403 policy_denied` is normal behaviour, not an outage: it's the firewall working. The receipt in the body proves it.

## Rate limits

Each key gets 60 requests a minute by default (a token bucket). Exceeding it returns `429` before the chain or the provider is touched.

## Compatibility notes

- **Streaming usage.** For chat completions, the router asks the provider to include usage in the stream so the request is metered exactly.
- **CORS.** Browser calls are allowed from any origin by default; keys are bearer tokens, not cookies.
- **Model names.** Use `cheap`, `standard`, `premium` or `frontier`. Claude Code needs its model variables set (see the [quickstart](../guide/quickstart.md#claude-code)); Codex needs `model = "standard"` or similar.
