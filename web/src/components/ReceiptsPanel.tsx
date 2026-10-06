import { useEffect, useRef, useState } from "react";
import type { Decision, HistoryReceipt } from "../lib/api.ts";
import { okb } from "../lib/chain.ts";
import { DECISION_COLOR } from "./charts.tsx";
import { ErrorNote, errorText } from "./common.tsx";
import { fetchAndVerify, VerifyReport, type Verified } from "./VerifyPage.tsx";

const PAGE = 25;
const FILTERS: { id: Decision | "all"; label: string }[] = [
  { id: "all", label: "All" },
  { id: "allowed", label: "Allowed" },
  { id: "downgraded", label: "Downgraded" },
  { id: "denied", label: "Denied" },
];

/** The project's receipts in the selected range; picking one checks it on X Layer right here. */
export function ReceiptsPanel({ receipts, total, stale }: { receipts: HistoryReceipt[]; total: number; stale: boolean }) {
  const [filter, setFilter] = useState<Decision | "all">("all");
  const [shown, setShown] = useState(PAGE);
  const [selected, setSelected] = useState<string>();
  const [result, setResult] = useState<Verified>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const reportRef = useRef<HTMLDivElement>(null);

  const rows = filter === "all" ? receipts : receipts.filter((r) => r.decision === filter);

  async function verify(id: string) {
    setSelected(id);
    setResult(undefined);
    setError(undefined);
    setBusy(true);
    try {
      setResult(await fetchAndVerify({ id }));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (selected) reportRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [selected]);

  return (
    <div className={`receipts ${stale ? "is-stale" : ""}`}>
      {selected && (
        <div className="receipt-check" ref={reportRef} data-testid="receipt-check">
          <section className="card">
            <header className="row between">
              <h3>
                Receipt <span className="mono">{selected.slice(0, 10)}…{selected.slice(-6)}</span>
              </h3>
              <div className="row">
                <a className="btn btn-ghost btn-sm" href={`/verify?id=${selected}`} target="_blank" rel="noreferrer">
                  Open on its own page
                </a>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSelected(undefined)} data-testid="receipt-close">
                  Close
                </button>
              </div>
            </header>
            {busy && <p className="muted">Checking on X Layer…</p>}
            <ErrorNote error={error} />
          </section>
          {result && <VerifyReport {...result} />}
        </div>
      )}

      <section className="card">
        <header className="row between">
          <div className="segmented" role="radiogroup" aria-label="Decision">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                role="radio"
                aria-checked={filter === f.id}
                className={filter === f.id ? "seg-on" : undefined}
                data-testid={`receipts-filter-${f.id}`}
                onClick={() => {
                  setFilter(f.id);
                  setShown(PAGE);
                }}
              >
                {f.label}
              </button>
            ))}
          </div>
          <span className="muted small">
            {total > receipts.length ? `Newest ${receipts.length} of ${total}` : `${receipts.length} in this range`}
          </span>
        </header>

        {rows.length === 0 ? (
          <p className="muted" data-testid="receipts-empty">
            {receipts.length === 0
              ? "No receipts yet. Every request your agent sends through the router gets a signed receipt, and it shows up here to verify."
              : "No receipts with this decision in this range."}
          </p>
        ) : (
          <div className="table-scroll">
            <table className="recent receipts-table" data-testid="receipts">
              <thead>
                <tr>
                  <th>When (UTC)</th>
                  <th>Decision</th>
                  <th>Model</th>
                  <th className="num">Tokens</th>
                  <th className="num">Cost (OKB)</th>
                  <th>Settled</th>
                  <th>
                    <span className="sr-only">Verify</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, shown).map((r) => (
                  <tr key={r.requestId} className={selected === r.requestId ? "row-on" : undefined} onClick={() => void verify(r.requestId)}>
                    <td>{new Date(r.createdAt).toISOString().slice(5, 19).replace("T", " ")}</td>
                    <td>
                      <span className="decision">
                        <span className="viz-key-rect" style={{ background: DECISION_COLOR[r.decision] }} />
                        {r.decision === "allowed" ? "Allowed" : r.decision === "downgraded" ? "Downgraded" : "Denied"}
                      </span>
                    </td>
                    <td>{r.decision === "downgraded" ? `${r.modelRequested} → ${r.modelServed}` : r.modelRequested}</td>
                    <td className="num">{r.promptTokens + r.completionTokens}</td>
                    <td className="num mono">{okb(BigInt(r.costWei), 8)}</td>
                    <td>{r.settled ? "Yes" : <span className="muted">Pending</span>}</td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        data-testid="verify-link"
                        onClick={(e) => {
                          e.stopPropagation();
                          void verify(r.requestId);
                        }}
                      >
                        Verify
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {rows.length > shown && (
          <button type="button" className="btn btn-ghost" onClick={() => setShown((n) => n + PAGE)} data-testid="receipts-more">
            Show {Math.min(PAGE, rows.length - shown)} more
          </button>
        )}
      </section>
    </div>
  );
}
