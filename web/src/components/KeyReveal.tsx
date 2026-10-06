import { agentLabel } from "../lib/names.ts";
import { CopyButton } from "./common.tsx";

/** Shows a new or rotated API key once. After the owner confirms, the parent stops rendering it. */
export function KeyReveal({ apiKey, agentId, rotated, onConfirm }: { apiKey: string; agentId: bigint; rotated?: boolean; onConfirm: () => void }) {
  return (
    <section className="card key-reveal" aria-labelledby="key-title">
      <h2 id="key-title">
        {agentLabel(agentId)} {rotated ? "has a new key" : "is ready"}. Save its API key now
      </h2>
      <p className="muted">
        This is the only time the full key is shown. PolicyRouter stores only its hash, on chain and in the router, so a lost key
        can't be recovered: rotate it instead.
        {rotated && " The old key has stopped working; put this one in your agent."}
      </p>
      <div className="key-row">
        <code data-testid="api-key">{apiKey}</code>
        <CopyButton text={apiKey} label="Copy key" testId="copy-key" />
      </div>
      <button type="button" className="btn btn-primary" data-testid="key-saved" onClick={onConfirm}>
        I've saved this key
      </button>
    </section>
  );
}
