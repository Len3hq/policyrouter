import { formatEther } from "viem";
import type { History, HistoryRange } from "../lib/api.ts";
import { okb } from "../lib/chain.ts";
import { BarList, DECISION_COLOR, DecisionChart, LineChart, Legend, bucketLabel, fmtCompact } from "./charts.tsx";

export const RANGES: { id: HistoryRange; label: string }[] = [
  { id: "24h", label: "24 hours" },
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
  { id: "90d", label: "90 days" },
];

const okbNum = (wei: string | bigint) => Number(formatEther(BigInt(wei)));
const okbAxis = (v: number) => (v === 0 ? "0" : v < 0.0001 ? v.toExponential(0) : String(Number(v.toPrecision(2))));
const pct = (n: number, d: number) => (d === 0 ? "0%" : `${Math.round((n / d) * 1000) / 10}%`);

/** The range picker: one row above everything it scopes. */
export function RangePicker({ range, onRange, onRefresh }: { range: HistoryRange; onRange: (r: HistoryRange) => void; onRefresh: () => void }) {
  return (
    <div className="row between filters">
      <div className="segmented" role="radiogroup" aria-label="Time range">
        {RANGES.map((r) => (
          <button
            key={r.id}
            type="button"
            role="radio"
            aria-checked={range === r.id}
            className={range === r.id ? "seg-on" : undefined}
            data-testid={`range-${r.id}`}
            onClick={() => onRange(r.id)}
          >
            {r.label}
          </button>
        ))}
      </div>
      <button type="button" className="btn btn-ghost btn-sm" onClick={onRefresh} data-testid="refresh">
        Refresh
      </button>
    </div>
  );
}

/** Usage charts for one project over the selected range. */
export function UsagePanel({ history, stale }: { history: History; stale: boolean }) {
  const t = history.totals;
  const tokens = t.promptTokens + t.completionTokens;
  const unit = history.bucketMs < 86_400_000 ? "hour" : "day";
  return (
    <div className={`usage ${stale ? "is-stale" : ""}`} data-testid="usage">
      <div className="tiles">
        <Tile label="Requests" value={fmtCompact(t.requests)} testId="usage-requests" />
        <Tile label="Allowed" value={String(t.allowed)} sub={pct(t.allowed, t.requests)} testId="usage-allowed" />
        <Tile label="Downgraded" value={String(t.downgraded)} sub={pct(t.downgraded, t.requests)} testId="usage-downgraded" />
        <Tile label="Denied" value={String(t.denied)} sub={pct(t.denied, t.requests)} testId="usage-denied" />
        <Tile label="Spend (OKB)" value={okb(BigInt(t.spentWei), 8)} sub={`${okb(BigInt(t.unsettledWei), 8)} not settled yet`} testId="usage-spend" />
        <Tile label="Tokens" value={fmtCompact(tokens)} sub={`${fmtCompact(t.promptTokens)} in · ${fmtCompact(t.completionTokens)} out`} testId="usage-tokens" />
      </div>

      <section className="card" aria-labelledby="chart-decisions">
        <header className="row between">
          <h3 id="chart-decisions">Requests per {unit}</h3>
          <Legend
            items={[
              { color: DECISION_COLOR.allowed, label: "Allowed", value: String(t.allowed) },
              { color: DECISION_COLOR.downgraded, label: "Downgraded", value: String(t.downgraded) },
              { color: DECISION_COLOR.denied, label: "Denied", value: String(t.denied) },
            ]}
          />
        </header>
        <DecisionChart data={history.series} bucketMs={history.bucketMs} />
        <details className="viz-table">
          <summary className="muted small">Show as a table</summary>
          <table className="recent">
            <thead>
              <tr>
                <th>{unit === "hour" ? "Hour" : "Day"}</th>
                <th>Allowed</th>
                <th>Downgraded</th>
                <th>Denied</th>
                <th>Spend (OKB)</th>
                <th>Tokens</th>
              </tr>
            </thead>
            <tbody>
              {history.series
                .slice()
                .reverse()
                .map((b) => (
                  <tr key={b.start}>
                    <td>{bucketLabel(b.start, history.bucketMs, true)}</td>
                    <td className="num">{b.allowed}</td>
                    <td className="num">{b.downgraded}</td>
                    <td className="num">{b.denied}</td>
                    <td className="num mono">{okb(BigInt(b.spentWei), 8)}</td>
                    <td className="num">{fmtCompact(b.promptTokens + b.completionTokens)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </details>
      </section>

      <div className="chart-grid">
        <section className="card" aria-labelledby="chart-spend">
          <h3 id="chart-spend">Spend per {unit} (OKB)</h3>
          <LineChart
            label={`Spend per ${unit} in OKB`}
            data={history.series.map((b) => ({ start: b.start, value: okbNum(b.spentWei) }))}
            bucketMs={history.bucketMs}
            format={okbAxis}
          />
        </section>
        <section className="card" aria-labelledby="chart-models">
          <h3 id="chart-models">Spend by model served</h3>
          {history.byModel.length === 0 ? (
            <p className="muted">No requests were served in this range.</p>
          ) : (
            <BarList
              format={(v) => `${okbAxis(v)} OKB`}
              rows={history.byModel.map((m) => ({
                label: m.model,
                value: okbNum(m.spentWei),
                detail: `${m.requests} ${m.requests === 1 ? "request" : "requests"} · ${fmtCompact(m.tokens)} tokens`,
              }))}
            />
          )}
        </section>
      </div>
    </div>
  );
}

function Tile({ label, value, sub, testId }: { label: string; value: string; sub?: string; testId: string }) {
  return (
    <div className="tile">
      <span className="label">{label}</span>
      <span className="tile-value" data-testid={testId}>
        {value}
      </span>
      {sub && <span className="muted small">{sub}</span>}
    </div>
  );
}
