# @policyrouter/sdk

A thin TypeScript client for PolicyRouter: OpenAI-compatible chat with signed receipts, a typed `PolicyDeniedError`, and on-chain receipt verification.

```ts
import { PolicyRouter } from "@policyrouter/sdk";

const pr = new PolicyRouter({ apiKey: "pr-live-…", baseURL: "https://your-router" });
const { text, model, receipt } = await pr.chat({ model: "standard", messages: [{ role: "user", content: "Hi" }] });
const check = await pr.verify(receipt.requestId); // "verified" | "pending" | "failed"
```

Full documentation: [docs/api/sdk.md](../../docs/api/sdk.md). Tests: `pnpm --filter @policyrouter/sdk test` (against the real router app, in-process).
