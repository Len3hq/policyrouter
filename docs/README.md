# PolicyRouter

**The immutable firewall for AI agents.**

Giving an AI agent an API key and a budget is a leap of faith. The limits usually live in a dashboard setting or in the agent's own code, and both can be changed, bypassed or misconfigured without anyone noticing. PolicyRouter moves the rules out of reach.

> **Projects and agents.** Your *agent* is the software that makes AI requests: a bot, a script, a coding tool. A *project* is what you create in PolicyRouter for it: an API key plus its policy, daily cap, kill switch and OKB balance. Rotate the key and the project, its settings and its balance stay. (The contracts call a project an agent, so on chain you'll see `agentId` and `registerAgent`.)

Every AI request your agent makes goes through a **policy circuit**: a small logic circuit published on X Layer that nobody can change once it exists. Not the agent, not you in the middle of a task, and not the people who run the router. The circuit answers three ways:

| Answer | What happens |
| --- | --- |
| **Allow** | The request is served by the model it asked for |
| **Downgrade** | The request is served by a cheaper model, as the policy says |
| **Deny** | The request is refused, and the provider never sees it |

Every answer comes with a signed **receipt**. Anyone can check a receipt on chain, with no wallet and without trusting the router: [verify a receipt](/verify).

```
AI request  →  policy circuit on X Layer  →  allow / downgrade / deny
```

## Why it exists

| If you are… | You want… |
| --- | --- |
| **Building an agent** | A hard ceiling. The agent can never jump to the most expensive model or burn a week's budget in an hour, whatever it decides to do. |
| **Running several agents** | One place to fund them, and one set of rules you can prove were followed. |
| **Using someone else's agent** | Evidence that the agent stayed inside the rules it advertised. |

## What you get

- **An OpenAI-compatible endpoint.** Anything that already works with OpenAI works unchanged: the OpenAI SDKs, LangChain, Codex (Responses API) and Claude Code (Anthropic Messages API). Change a base URL and a key.
- **Four ready-made policies**, each a circuit on X Layer, each proven against its complete truth table: Budget Guard, Cheap Only, Small Requests and Strict.
- **Prepaid OKB credit.** You deposit OKB for a project. You can withdraw whatever is unused, at any time.
- **A kill switch** that takes effect on the next request.
- **A daily spend cap**, enforced by the circuit's budget input.
- **Policy simulation.** See what a policy would have done to your agent's recent requests before you switch to it.
- **Signed receipts for every request**, allowed or denied, settled on chain in batches.

## Where to go next

| I want to… | Read |
| --- | --- |
| Get an agent running in a minute | [Quickstart](guide/quickstart.md) |
| Understand the pieces | [How it works](guide/how-it-works.md) |
| Choose a policy | [Policy circuits](guide/policy-circuits.md) |
| Check a receipt myself | [Receipts and verification](guide/receipts-and-verification.md) |
| Know what it costs | [Pricing and billing](guide/pricing-and-billing.md) |
| Know what it can't do | [Security and limits](guide/security-and-limits.md) |
| Call the API directly | [API reference](api/reference.md) |
| See the contract addresses | [Deployed contracts](deployments.md) |

> **Honest limits, up front.** The circuit makes cheating *detectable*, not impossible. The router is a trusted piece that can refuse to serve you, and the chain can't see the content of your prompts. [Security and limits](guide/security-and-limits.md) says exactly what is and isn't guaranteed.

PolicyRouter was built for the TapeOut Genesis Transistor Hackathon (IGNIX × TapeOut × X Layer). It runs on X Layer mainnet today. The source is at [github.com/Len3hq/policyrouter](https://github.com/Len3hq/policyrouter).
