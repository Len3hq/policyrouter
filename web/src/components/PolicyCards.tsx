import { POLICYROUTER, TEMPLATES } from "@policyrouter/policy";
import type { SimResponse } from "../lib/api.ts";
import { CONFIG } from "../lib/config.ts";
import { SimulationPanel } from "./SimulationPanel.tsx";

const circuits = POLICYROUTER.circuits as Readonly<Record<string, bigint>>;

export const templateForCircuit = (circuitId: bigint) => TEMPLATES.find((t) => circuits[t.id] === circuitId);

/** The four template policies, each with its rule, its circuit, a simulation and (optionally) a "use" button. */
export function PolicyCards({
  current,
  sim,
  onUse,
  busy,
}: {
  current?: bigint;
  sim?: SimResponse;
  onUse?: (circuitId: bigint) => void;
  busy?: boolean;
}) {
  return (
    <div className="policy-grid">
      {TEMPLATES.map((t) => {
        const circuitId = circuits[t.id]!;
        const result = sim?.results.find((r) => r.template === t.id);
        const isCurrent = current === circuitId;
        return (
          <article key={t.id} className={`card policy ${isCurrent ? "policy-current" : ""}`} data-testid={`policy-${t.id}`}>
            <header>
              <h3>
                <span className="policy-num">#{circuitId.toString()}</span> {t.name}
              </h3>
              {isCurrent && (
                <span className="pill pill-ok" data-testid="current-policy">
                  Current policy
                </span>
              )}
            </header>
            <p className="policy-rule">{t.rule}</p>
            <p className="policy-meta">
              <span>{t.circuit().gates.length} NAND gates</span>
              <a href={`${CONFIG.repo}/blob/main/circuits/proof/${t.id}.txt`} target="_blank" rel="noreferrer">
                64/64 proof
              </a>
              <a href={`${CONFIG.explorer}/address/${CONFIG.processor}`} target="_blank" rel="noreferrer">
                processor
              </a>
            </p>
            {result && sim && <SimulationPanel result={result} source={sim.source} requests={sim.requests} />}
            {onUse && !isCurrent && (
              <button type="button" className="btn btn-primary" disabled={busy} data-testid={`use-policy-${t.id}`} onClick={() => onUse(circuitId)}>
                Use this policy
              </button>
            )}
          </article>
        );
      })}
    </div>
  );
}
