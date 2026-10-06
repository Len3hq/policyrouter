import { useCallback, useEffect, useState } from "react";
import { parseEther } from "viem";
import { api, hashKey, isWellFormedKey, sessionKey, type SimResponse, type Usage } from "../lib/api.ts";
import { escrowAbi, okb, readAgent, registryAbi, type AgentState } from "../lib/chain.ts";
import { CONFIG } from "../lib/config.ts";
import type { Wallet } from "../lib/wallet.ts";
import { ErrorNote, errorText } from "./common.tsx";
import { PolicyBuilder } from "./PolicyBuilder.tsx";
import { PolicyCards, templateForCircuit } from "./PolicyCards.tsx";
import { Quickstart } from "./Quickstart.tsx";

export function Dashboard({ agentId, wallet, onChanged }: { agentId: bigint; wallet: Wallet; onChanged?: () => void }) {
  const [agent, setAgent] = useState<AgentState>();
  const [key, setKey] = useState<string | undefined>(() => sessionKey.get(agentId));
  const [usage, setUsage] = useState<Usage>();
  const [sim, setSim] = useState<SimResponse>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [capInput, setCapInput] = useState("");
  const [depositInput, setDepositInput] = useState("0.001");
  const [keyInput, setKeyInput] = useState("");

  const refresh = useCallback(async () => {
    try {
      const a = await readAgent(agentId);
      setAgent(a);
      if (key) setUsage(await api.usage(key));
      setSim(await api.simulate(key));
    } catch (e) {
      setError(errorText(e));
    }
  }, [agentId, key]);

  useEffect(() => {
    setKey(sessionKey.get(agentId));
    setUsage(undefined);
  }, [agentId]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [refresh]);

  async function act(label: string, fn: () => Promise<unknown>) {
    setError(undefined);
    setBusy(label);
    try {
      await fn();
      await refresh();
      onChanged?.();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(undefined);
    }
  }

  if (!agent) return <section className="card">Loading agent #{agentId.toString()}…</section>;

  const policy = templateForCircuit(agent.circuitId);
  const capPct = agent.dailyCap > 0n ? Number((agent.spentToday * 10_000n) / agent.dailyCap) / 100 : 100;
  const status = agent.killed ? "Killed" : !agent.budgetOk ? (agent.balance === 0n ? "Unfunded" : "Over today's cap") : "Active";

  return (
    <div className="dashboard">
      <section className="card">
        <header className="row between">
          <h2>
            Agent #{agentId.toString()} <span className="muted">· {policy?.name ?? `custom policy (circuit #${agent.circuitId})`}</span>
          </h2>
          <span className={`pill ${status === "Active" ? "pill-ok" : "pill-bad"}`} data-testid="agent-status">
            {status}
          </span>
        </header>
        <p className="muted small mono">key hash {agent.keyHash.slice(0, 18)}…</p>

        <div className="stats">
          <div className="stat">
            <span className="label">Balance</span>
            <span className="value" data-testid="balance">
              {okb(agent.balance)} OKB
            </span>
          </div>
          <div className="stat">
            <span className="label">Spent today (settled)</span>
            <span className="value" data-testid="spent-today">
              {okb(agent.spentToday, 8)} / {okb(agent.dailyCap)} OKB
            </span>
            <div className="bar" aria-label={`${capPct}% of today's cap`}>
              <div className="bar-fill" style={{ width: `${Math.min(capPct, 100)}%` }} />
            </div>
          </div>
        </div>

        <div className="controls">
          <div className="control">
            <span className="label">Kill switch</span>
            <button
              type="button"
              className={`btn ${agent.killed ? "btn-primary" : "btn-danger"}`}
              data-testid="kill-toggle"
              disabled={!!busy}
              onClick={() => act("kill", () => wallet.write({ address: CONFIG.registry, abi: registryAbi, functionName: "setKill", args: [agentId, !agent.killed] }))}
            >
              {busy === "kill" ? "Confirming…" : agent.killed ? "Turn kill switch off" : "Kill: refuse every request"}
            </button>
          </div>
          <form
            className="control"
            onSubmit={(e) => {
              e.preventDefault();
              let wei: bigint;
              try {
                wei = parseEther(capInput);
              } catch {
                setError("Enter the cap in OKB, for example 0.001.");
                return;
              }
              void act("cap", () => wallet.write({ address: CONFIG.registry, abi: registryAbi, functionName: "setDailyCap", args: [agentId, wei] }));
            }}
          >
            <label className="label" htmlFor="cap-input">
              Daily cap (OKB)
            </label>
            <div className="row">
              <input id="cap-input" data-testid="cap-input" inputMode="decimal" placeholder={okb(agent.dailyCap)} value={capInput} onChange={(e) => setCapInput(e.target.value)} />
              <button type="submit" className="btn btn-ghost" data-testid="cap-submit" disabled={!!busy || !capInput}>
                {busy === "cap" ? "Confirming…" : "Set cap"}
              </button>
            </div>
          </form>
          <form
            className="control"
            onSubmit={(e) => {
              e.preventDefault();
              let wei: bigint;
              try {
                wei = parseEther(depositInput);
              } catch {
                setError("Enter the deposit in OKB, for example 0.001.");
                return;
              }
              void act("deposit", () => wallet.write({ address: CONFIG.escrow, abi: escrowAbi, functionName: "deposit", args: [agentId], value: wei }));
            }}
          >
            <label className="label" htmlFor="deposit-input">
              Deposit (OKB)
            </label>
            <div className="row">
              <input id="deposit-input" data-testid="deposit-input" inputMode="decimal" value={depositInput} onChange={(e) => setDepositInput(e.target.value)} />
              <button type="submit" className="btn btn-ghost" data-testid="deposit-submit" disabled={!!busy}>
                {busy === "deposit" ? "Confirming…" : "Deposit"}
              </button>
            </div>
          </form>
        </div>
        <ErrorNote error={error} />
      </section>

      <section className="card" aria-labelledby="usage-title">
        <header className="row between">
          <h2 id="usage-title">Requests</h2>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void refresh()} data-testid="refresh">
            Refresh
          </button>
        </header>
        {usage ? (
          <>
            <dl className="sim-counts">
              <div>
                <dt>Allowed</dt>
                <dd data-testid="usage-allowed">{usage.allowed}</dd>
              </div>
              <div>
                <dt>Downgraded</dt>
                <dd data-testid="usage-downgraded">{usage.downgraded}</dd>
              </div>
              <div>
                <dt>Denied</dt>
                <dd data-testid="usage-denied">{usage.denied}</dd>
              </div>
            </dl>
            {usage.recent.length > 0 && (
              <table className="recent" data-testid="recent">
                <thead>
                  <tr>
                    <th>When (UTC)</th>
                    <th>Request</th>
                    <th>Cost (OKB)</th>
                    <th>Receipt</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.recent.slice(0, 8).map((r) => (
                    <tr key={r.requestId}>
                      <td>{new Date(Number(r.timestamp) * 1000).toISOString().slice(5, 19).replace("T", " ")}</td>
                      <td>
                        {!r.allowed ? `${r.modelRequested}: denied` : r.downgraded ? `${r.modelRequested} → ${r.modelServed}` : r.modelServed}
                      </td>
                      <td className="mono">{okb(BigInt(r.costWei), 8)}</td>
                      <td>
                        <a href={`/verify?id=${r.requestId}`} data-testid="verify-link">
                          verify
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="muted small">
              {usage.requests} {usage.requests === 1 ? "request" : "requests"} · {okb(BigInt(usage.spentWei), 8)} OKB metered · {okb(BigInt(usage.unsettledWei), 8)} OKB not settled yet
            </p>
          </>
        ) : (
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              const k = keyInput.trim();
              if (!isWellFormedKey(k) || hashKey(k) !== agent.keyHash) {
                setError("That isn't this agent's key.");
                return;
              }
              sessionKey.set(agentId, k);
              setKey(k);
              setKeyInput("");
            }}
          >
            <input aria-label="API key" data-testid="unlock-input" placeholder="Paste this agent's pr-live-… key to see its requests" value={keyInput} onChange={(e) => setKeyInput(e.target.value)} />
            <button type="submit" className="btn btn-ghost" data-testid="unlock-submit">
              Unlock
            </button>
          </form>
        )}
      </section>

      <Quickstart apiKey={key} />

      <section aria-labelledby="policy-title">
        <h2 id="policy-title" className="section-title">
          Policy
        </h2>
        <p className="muted">
          A policy is a circuit on X Layer that nobody can change. Switching policy points this agent at a different circuit, an on-chain change anyone can see.
        </p>
        <PolicyCards
          current={agent.circuitId}
          sim={sim}
          busy={!!busy}
          onUse={(circuitId) => act("policy", () => wallet.write({ address: CONFIG.registry, abi: registryAbi, functionName: "setCircuit", args: [agentId, circuitId] }))}
        />
        <PolicyBuilder
          agentId={agentId}
          apiKey={key}
          currentCircuit={agent.circuitId}
          wallet={wallet}
          onDone={() => {
            void refresh();
            onChanged?.();
          }}
        />
      </section>
    </div>
  );
}
