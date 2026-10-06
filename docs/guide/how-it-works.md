# How it works

PolicyRouter has five pieces. Four are on X Layer or in the cloud; the fifth is you.

| Piece | What it is | Where |
| --- | --- | --- |
| **Policy circuits** | Logic circuits built from NAND gates, stored on chain. Each is one policy. | TapeOut processor on X Layer |
| **PolicyRegistry** | Links each project's API key to its owner, circuit, daily cap and kill switch | Smart contract |
| **CreditEscrow** | Holds each project's prepaid OKB, tracks daily spend, records settlements | Smart contract |
| **The router** | The OpenAI-compatible server your agent talks to. It asks the circuit, then forwards the request | A server |
| **The owner app** | Where you create projects, fund them and choose policies | Web app |

## The life of one request

1. **Your agent calls the router** like any OpenAI-compatible API, with its `pr-live-…` key and a model name (`cheap`, `standard`, `premium` or `frontier`).
2. **The router authenticates the key** by hashing it and looking the hash up on chain. Unknown or malformed keys are rejected before anything else happens.
3. **It reads the chain at one pinned block:** is the kill switch on, and is the project within today's budget?
4. **It builds six input bits** for the circuit: the requested tier (2 bits), the request size bucket (2 bits), `budget_ok` (1 bit) and `kill` (1 bit).
5. **It calls the circuit.** `eval(circuitId, inputBits)` is a free, read-only call on X Layer. The circuit answers with three bits: allow or deny, and the tier to use.
6. **Deny:** the router returns `403 policy_denied` with a signed receipt. The model provider never sees the request.
   **Allow:** the router forwards the request to the model provider, at the tier the circuit chose. That may be lower than the tier requested: a *downgrade*.
7. **It meters the response** (tokens, cached tokens, time of day), prices it at the live OKB price, and signs a **receipt**. The receipt is returned with the response.

If the router can't read the chain or can't run the circuit, it refuses the request. It never guesses and never serves without an answer: it **fails closed**.

## Why a circuit?

A circuit gives you three things a dashboard setting can't:

- **Immutable.** Once a circuit is published ("taped out"), it can never be changed. A new rule means a new circuit, and pointing your project at it is an on-chain event anyone can see.
- **Free to check.** Calling the circuit is a read-only call, so the router can ask it on every request and anyone can ask it again afterwards, at no cost.
- **Small enough to read.** The four policies are 8 to 13 NAND gates. Budget Guard's entire definition is 56 bytes on chain.

A circuit is a pure function: bits in, bits out. It can't hold money, remember anything between calls, read other contracts or touch the internet. That is why the changing facts (is the budget spent? is the kill switch on?) are passed in as input bits. Those facts live in ordinary contracts, and the circuit stays something anyone can re-run.

## Settlement

The router doesn't charge per request on chain. It batches. Every few minutes (five by default):

1. It collects the receipts it hasn't settled yet, allowed and denied alike.
2. It builds a **Merkle tree** over their hashes and sums the cost per project.
3. It posts one transaction to CreditEscrow: the tree's root and each project's total.
4. CreditEscrow debits the projects and stores the root with the block number.

The contract enforces limits no matter what the router sends: a settlement can never take more than a project's balance, and can never push a project's day past its daily cap. Anything over is reported as a *shortfall* and not charged.

Because each receipt's hash is a leaf of the tree, anyone can later prove that a specific receipt was part of a settled batch. That is what the Verify page's *settlement* check does.

> Spend is counted against the daily cap when it is **settled**, not when the request is made. Requests made between two settlements aren't yet counted. See [Security and limits](security-and-limits.md#the-cap-is-enforced-at-settlement).

## What is on chain, and what isn't

| On chain (X Layer) | Off chain (the router) |
| --- | --- |
| The policy circuits | The OpenAI-compatible API |
| Who owns each project, its circuit, cap and kill switch | Forwarding to the model provider |
| Each project's prepaid balance and daily spend | Token counting and pricing |
| The Merkle root of every settled batch | The signed receipt for each request |
| The router's address (the only one allowed to settle) | Your prompts and the model's replies, in transit only |

The router stores each receipt (token counts, model, cost, the circuit's input and output), but **not the content of your prompts or replies**.

For the technical detail, see [Architecture](../architecture.md).
