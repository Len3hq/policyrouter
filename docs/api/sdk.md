# TypeScript SDK

`@policyrouter/sdk` is a thin client over the official OpenAI SDK. Everything the OpenAI client accepts works. What it adds:

- the signed **receipt** with every answer;
- a typed **`PolicyDeniedError`** (carrying the denial's receipt) when the policy circuit says no;
- **`verify()`**: the Verify page's four checks against X Layer, from code.

The SDK lives in [`packages/sdk`](../../packages/sdk) in the repository. It isn't published to npm yet; use it from the workspace, or copy it into your project along with `@policyrouter/policy`.

## Chat

```ts
import { PolicyRouter, PolicyDeniedError } from "@policyrouter/sdk";

const pr = new PolicyRouter({
  apiKey: process.env.POLICYROUTER_KEY!, // pr-live-…
  baseURL: "YOUR_ROUTER_URL",            // without /v1
});

try {
  const { text, model, receipt } = await pr.chat({
    model: "frontier",
    messages: [{ role: "user", content: "Hello" }],
  });
  console.log(text);
  console.log(`served as ${model}`);          // lower than "frontier" if the policy downgraded it
  console.log(`cost ${receipt.costWei} wei`);
} catch (e) {
  if (e instanceof PolicyDeniedError) {
    console.log("denied by the policy", e.receipt.inputBits.toString(2));
  } else {
    throw e;
  }
}
```

| Option | Default |
| --- | --- |
| `apiKey` | required: a `pr-live-…` key |
| `baseURL` | `POLICYROUTER_URL`, or `http://localhost:8787` |
| `rpcUrl` (for verification) | `POLICYROUTER_RPC_URL`, or `https://rpc.xlayer.tech` |
| `fetch` | the global `fetch` |

## Streaming

`chatStream()` yields the provider's chunks and **returns** the receipt when the stream ends:

```ts
const stream = pr.chatStream({ model: "standard", messages: [{ role: "user", content: "Hi" }] });
let step = await stream.next();
while (!step.done) {
  process.stdout.write(step.value.choices[0]?.delta?.content ?? "");
  step = await stream.next();
}
const receipt = step.value;
```

## Errors

| Error | When | Fields |
| --- | --- | --- |
| `PolicyDeniedError` | The circuit refused the request (`403 policy_denied`) | `receipt`: the signed denial |
| `PolicyRouterError` | Any other router error | `status`, `code` (`rate_limit_exceeded`, `model_not_found`, `policy_unavailable`, …), and `receipt` when the router issued one |

`PolicyDeniedError` extends `PolicyRouterError`. A denial is the firewall working, not an outage, so handle it as a normal outcome.

## Verifying receipts

```ts
// by request id: fetches the receipt and its Merkle proof from the router, then checks the chain
const result = await pr.verify(receipt.requestId);
console.log(result.verdict);   // "verified" | "pending" | "failed"
for (const c of result.checks) console.log(c.label, c.status, c.reason);
```

Or without a client, for any receipt:

```ts
import { verifyReceipt } from "@policyrouter/sdk";

const result = await verifyReceipt(receiptJson, { settlement });
```

These are the [Verify page's checks](../guide/receipts-and-verification.md#verifying-a-receipt), run by the same code: signature, chain inputs, policy decision and settlement. They default to PolicyRouter's mainnet contracts; pass `processor`, `registry`, `escrow` and `chainId` to check another deployment.

## Usage and simulation

```ts
await pr.usage();                            // counts, spend, recent requests for this key
await pr.simulate();                         // all four templates on this key's history
await pr.simulate("custom:t2-downgrade-s2"); // a custom rule
```
