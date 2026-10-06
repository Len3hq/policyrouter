import { okb } from "../lib/chain.ts";
import type { SimResult } from "../lib/api.ts";

/** What one template would have done to the agent's recent requests (or the sample workload). */
export function SimulationPanel({ result, source, requests }: { result: SimResult; source: "history" | "sample"; requests: number }) {
  const without = BigInt(result.spendWithout);
  const withPolicy = BigInt(result.spendWith);
  return (
    <div className="sim" data-testid={`sim-${result.template}`}>
      <p className="sim-source muted">
        {source === "sample"
          ? `Simulated on a sample workload of ${requests} typical requests: this agent has no history yet.`
          : `Simulated on this agent's last ${requests === 1 ? "request" : `${requests} requests`}.`}
      </p>
      <dl className="sim-counts">
        <div>
          <dt>Allowed</dt>
          <dd data-testid="sim-allowed">{result.allowed}</dd>
        </div>
        <div>
          <dt>Downgraded</dt>
          <dd data-testid="sim-downgraded">{result.downgraded}</dd>
        </div>
        <div>
          <dt>Denied</dt>
          <dd data-testid="sim-denied">{result.denied}</dd>
        </div>
      </dl>
      <p className="sim-savings">
        <strong data-testid="sim-savings">{result.savingsPct.toFixed(1)}%</strong> saved
      </p>
      <p className="muted small sim-spend">
        Spends <span className="mono">{okb(withPolicy, 8)}</span> instead of <span className="mono">{okb(without, 8)}</span> OKB
      </p>
    </div>
  );
}
