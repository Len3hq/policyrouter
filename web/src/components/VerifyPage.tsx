import { useCallback, useEffect, useState } from "react";
import { parseReceiptInput, rawEthCall, verifyReceiptOnChain, type Check, type Settlement, type VerifyResult } from "@policyrouter/policy";
import type { SignedReceipt } from "@policyrouter/policy";
import { okb, publicClient } from "../lib/chain.ts";
import { CONFIG } from "../lib/config.ts";
import { templateForCircuit } from "./PolicyCards.tsx";
import { CopyButton, ErrorNote, errorText } from "./common.tsx";

const ICON: Record<Check["status"], string> = { pass: "✓", fail: "✕", pending: "…", unavailable: "?" };
const WORD: Record<Check["status"], string> = { pass: "Pass", fail: "Fail", pending: "Pending", unavailable: "Unavailable" };

export interface Verified {
  receipt: SignedReceipt;
  settlement: Settlement | null;
  verify: VerifyResult;
}

/** Fetches a receipt from the router by request id, or parses pasted JSON, then checks it on X Layer. */
export async function fetchAndVerify(input: { id?: string; text?: string }): Promise<Verified> {
  let parsed: { receipt: SignedReceipt; settlement: Settlement | null };
  if (input.id) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(input.id)) throw new Error("A request id is 0x followed by 64 hex characters.");
    const res = await fetch(`${CONFIG.routerUrl}/v1/receipts/${input.id}`);
    if (res.status === 404) throw new Error("The router has no receipt with that id.");
    if (!res.ok) throw new Error(`The router returned ${res.status}.`);
    parsed = parseReceiptInput(await res.text());
  } else {
    parsed = parseReceiptInput(input.text ?? "");
  }
  const verify = await verifyReceiptOnChain(
    { client: publicClient as never, chainId: CONFIG.chainId, processor: CONFIG.processor, registry: CONFIG.registry, escrow: CONFIG.escrow, rpcUrl: CONFIG.rpcUrl },
    parsed.receipt,
    parsed.settlement,
  );
  return { ...parsed, verify };
}

/**
 * Verifies a receipt with read-only calls: no wallet, no trust in the router. Open /verify?id=<requestId>
 * to fetch it from the router, or paste the JSON.
 */
export function VerifyPage() {
  const params = new URLSearchParams(location.search);
  const [id, setId] = useState(params.get("id") ?? "");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<Verified>();

  const run = useCallback(async (input: { id?: string; text?: string }) => {
    setError(undefined);
    setResult(undefined);
    setBusy(true);
    try {
      setResult(await fetchAndVerify(input));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    const initial = params.get("id");
    if (initial) void run({ id: initial });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="verify">
      <section className="hero">
        <h1>Verify a receipt</h1>
        <p className="lead">
          Every request through PolicyRouter gets a signed receipt. This page checks one against X Layer with read-only calls: no wallet, and
          no need to trust the router. Every call is shown, so you can run it yourself.
        </p>
      </section>

      <section className="card">
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            history.replaceState(null, "", `/verify?id=${id.trim()}`);
            void run({ id: id.trim() });
          }}
        >
          <input className="grow mono" aria-label="Request id" data-testid="verify-id" placeholder="Request id: 0x…" value={id} onChange={(e) => setId(e.target.value)} />
          <button type="submit" className="btn btn-primary" disabled={busy || !id.trim()} data-testid="verify-id-submit">
            Fetch and verify
          </button>
        </form>
        <details className="paste">
          <summary className="muted">…or paste a receipt or a router response</summary>
          <textarea data-testid="verify-paste" rows={8} className="mono" value={text} onChange={(e) => setText(e.target.value)} placeholder='{"receipt": {...}, "settlement": {...}}' />
          <button type="button" className="btn btn-ghost" disabled={busy || !text.trim()} data-testid="verify-paste-submit" onClick={() => void run({ text })}>
            Verify pasted JSON
          </button>
        </details>
        {busy && <p className="muted">Checking on X Layer…</p>}
        <ErrorNote error={error} />
      </section>

      {result && <VerifyReport receipt={result.receipt} settlement={result.settlement} verify={result.verify} />}
    </div>
  );
}

export function VerifyReport({ receipt: r, settlement, verify }: Verified) {
  const allowed = (r.outputBits & 1) === 1;
  const policy = templateForCircuit(r.circuitId);
  const verdictText =
    verify.verdict === "verified"
      ? "Verified: the router followed the policy, and this receipt is settled on chain."
      : verify.verdict === "pending"
        ? "Nothing failed. Some checks are pending."
        : `Mismatch: ${verify.failed.map((f) => verify.checks.find((c) => c.id === f)!.label.toLowerCase()).join(", ")} failed.`;
  return (
    <>
      <section className={`card verdict verdict-${verify.verdict}`} role="status" data-testid="verdict" data-verdict={verify.verdict}>
        <h2>{verdictText}</h2>
        <p className="muted small mono">receipt hash {verify.receiptHash}</p>
      </section>

      <section className="card">
        <h2>What happened</h2>
        <dl className="facts">
          <dt>Decision</dt>
          <dd data-testid="decision">
            {allowed ? `Allowed: ${r.modelRequested} → served as ${r.modelServed}` : `Denied: ${r.modelRequested} was refused`}
          </dd>
          <dt>Project</dt>
          <dd>#{r.agentId.toString()}</dd>
          <dt>Policy</dt>
          <dd>
            {policy?.name ?? "custom"} (circuit #{r.circuitId.toString()})
          </dd>
          <dt>Circuit inputs → output</dt>
          <dd className="mono">
            0b{r.inputBits.toString(2).padStart(6, "0")} → 0b{r.outputBits.toString(2).padStart(3, "0")}
          </dd>
          <dt>Decided at block</dt>
          <dd>
            <a href={`${CONFIG.explorer}/block/${r.blockNumber}`} target="_blank" rel="noreferrer">
              {r.blockNumber.toLocaleString()}
            </a>{" "}
            · {new Date(Number(r.timestamp) * 1000).toISOString().replace("T", " ").slice(0, 19)} UTC
          </dd>
          <dt>Tokens · cost</dt>
          <dd>
            {r.promptTokens} prompt ({r.cachedPromptTokens} cached) + {r.completionTokens} completion · {okb(r.costWei, 10)} OKB
          </dd>
          {settlement?.txHash && (
            <>
              <dt>Settled in</dt>
              <dd>
                batch {settlement.batchId} ·{" "}
                <a href={`${CONFIG.explorer}/tx/${settlement.txHash}`} target="_blank" rel="noreferrer">
                  {settlement.txHash.slice(0, 12)}…
                </a>
              </dd>
            </>
          )}
        </dl>
      </section>

      <section className="checks">
        {verify.checks.map((c) => (
          <article key={c.id} className={`card check check-${c.status}`} data-testid={`check-${c.id}`} data-status={c.status}>
            <header className="row between">
              <h3>
                <span className="check-icon" aria-hidden>
                  {ICON[c.status]}
                </span>{" "}
                {c.label}
              </h3>
              <span className={`pill ${c.status === "pass" ? "pill-ok" : c.status === "fail" ? "pill-bad" : ""}`}>{WORD[c.status]}</span>
            </header>
            <p>{c.reason}</p>
            {c.calls.length > 0 && (
              <details>
                <summary className="muted small">Re-run this yourself</summary>
                {c.calls.map((call) => (
                  <div key={call.cast} className="call">
                    <p className="small muted">
                      {call.description} ·{" "}
                      <a href={`${CONFIG.explorer}/address/${call.to}`} target="_blank" rel="noreferrer">
                        {call.to.slice(0, 10)}… on OKLink
                      </a>
                    </p>
                    <pre className="code">{call.cast}</pre>
                    <div className="row">
                      <CopyButton text={call.cast} label="Copy cast command" />
                      <CopyButton text={rawEthCall(call)} label="Copy raw eth_call" />
                    </div>
                  </div>
                ))}
              </details>
            )}
          </article>
        ))}
      </section>
    </>
  );
}
