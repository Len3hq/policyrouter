# Quickstart

From nothing to a working agent in about a minute. You need a browser wallet (OKX Wallet, MetaMask, Rabby…) with a little OKB on **X Layer**.

## 1. Create a project

Open the web app and connect your wallet. If the wallet is on another network, the app offers to switch it to X Layer (chain 196) and adds the network if your wallet doesn't know it.

On **New project**, choose:

| Field | What it is | Default |
| --- | --- | --- |
| **Policy** | The circuit that decides every request. You can change it later. | Budget Guard |
| **Daily cap** | The most OKB the project may spend per UTC day | 0.001 OKB |
| **First deposit** | The OKB your agent's requests are paid from | 0.001 OKB |

The app sends two transactions: it registers the project, then deposits.

## 2. Save the key

The app shows the project's API key **once**:

```
pr-live-3f9a1c7e5b2d48a06c91e0f4b7d2a85c13e69f0a4d27b8c1
```

It is generated in your browser. Only its hash goes on chain, and the router never stores the key, so a lost key can't be recovered. If you lose it, [rotate it](/docs/guide/owner-app#rotating-a-key).

## 3. Point your agent at PolicyRouter

Set two environment variables. Use the base URL shown in your app's quickstart panel (`YOUR_ROUTER_URL` below).

```bash
export OPENAI_BASE_URL=YOUR_ROUTER_URL/v1
export OPENAI_API_KEY=pr-live-...
```

That's all that most OpenAI-compatible clients need.

### OpenAI SDK (Node)

```js
import OpenAI from "openai";
const client = new OpenAI(); // reads OPENAI_BASE_URL and OPENAI_API_KEY

const r = await client.chat.completions.create({
  model: "standard", // cheap | standard | premium | frontier
  messages: [{ role: "user", content: "Hello" }],
});
console.log(r.choices[0].message.content);
console.log(r.policyrouter_receipt); // the signed receipt
```

### OpenAI SDK (Python)

```python
from openai import OpenAI

client = OpenAI()  # reads OPENAI_BASE_URL and OPENAI_API_KEY
r = client.chat.completions.create(
    model="standard",  # cheap | standard | premium | frontier
    messages=[{"role": "user", "content": "Hello"}],
)
print(r.choices[0].message.content)
```

### Codex

Codex uses OpenAI's Responses API, which PolicyRouter serves at `/v1/responses`. In `~/.codex/config.toml`:

```toml
model = "standard"
model_provider = "policyrouter"

[model_providers.policyrouter]
name = "PolicyRouter"
base_url = "YOUR_ROUTER_URL/v1"
env_key = "OPENAI_API_KEY"
wire_api = "responses"
```

Then run `codex` with `OPENAI_API_KEY` set to your project's key. Codex 0.160 no longer supports `wire_api = "chat"`, so use `"responses"`.

### Claude Code

Claude Code uses the Anthropic Messages API, which PolicyRouter serves at `/v1/messages`. Note that the base URL has **no** `/v1`:

```bash
export ANTHROPIC_BASE_URL=YOUR_ROUTER_URL
export ANTHROPIC_AUTH_TOKEN=pr-live-...
export ANTHROPIC_MODEL=standard
export ANTHROPIC_DEFAULT_OPUS_MODEL=frontier
export ANTHROPIC_DEFAULT_SONNET_MODEL=standard
export ANTHROPIC_DEFAULT_HAIKU_MODEL=cheap
claude
```

> **Use Budget Guard or Cheap Only with Claude Code.** Its requests carry a large system prompt and a big output budget, so they fall in the "huge" size bucket. Small Requests and Strict deny most of them. See [size buckets](policy-circuits.md#size-buckets).

## The models

You ask for one of four model names. Each is a **tier** that the policy circuit sees:

| Model | Tier | Served by | Thinking |
| --- | --- | --- | --- |
| `cheap` | 0 | DeepSeek flash | off |
| `standard` | 1 | DeepSeek flash | on |
| `premium` | 2 | DeepSeek V4 Pro | off |
| `frontier` | 3 | DeepSeek V4 Pro | on |

The tier decides whether the model thinks. An agent can't switch thinking on at a cheaper tier: the router sets it itself.

## 4. Watch it work

Back in the app, the project's dashboard shows its balance, today's spend against the cap, and a count of allowed, downgraded and denied requests. Each request in the list has a **verify** link.

Try the [kill switch](owner-app.md#the-kill-switch): turn it on and your agent's next request gets a `403 policy_denied`. Turn it off and requests flow again.

## Measured setup times

From setting the environment to a signed answer, on mainnet with a real provider (2026-10-02):

| Client | Time |
| --- | --- |
| OpenAI SDK (Node) | 2.5 s |
| OpenAI SDK (Python) | 3.3 s |
| Codex 0.160 | 8.5 s |
| Claude Code 2.1.236 | 4.0 s |
