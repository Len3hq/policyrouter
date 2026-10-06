import { useCallback, useEffect, useState } from "react";
import { parseEther } from "viem";
import { api, emptyHistory, generateKey, hashKey, isWellFormedKey, sessionKey, type History, type HistoryRange, type SimResponse } from "../lib/api.ts";
import { escrowAbi, okb, readAgent, registryAbi, type AgentState } from "../lib/chain.ts";
import { CONFIG } from "../lib/config.ts";
import { agentLabel, agentNames, MAX_NAME_LENGTH } from "../lib/names.ts";
import type { Wallet } from "../lib/wallet.ts";
import { ErrorNote, errorText } from "./common.tsx";
import { KeyReveal } from "./KeyReveal.tsx";
import { PolicyBuilder } from "./PolicyBuilder.tsx";
import { PolicyCards, templateForCircuit } from "./PolicyCards.tsx";
import { Quickstart } from "./Quickstart.tsx";
import { ReceiptsPanel } from "./ReceiptsPanel.tsx";
import { RangePicker, UsagePanel } from "./UsagePanel.tsx";

export function Dashboard({ agentId, wallet, onChanged }: { agentId: bigint; wallet: Wallet; onChanged?: () => void }) {
  const [agent, setAgent] = useState<AgentState>();
  const [key, setKey] = useState<string | undefined>(() => sessionKey.get(agentId));
  const [tab, setTab] = useState<"usage" | "receipts" | "policy">("usage");
  const [range, setRange] = useState<HistoryRange>("7d");
  const [history, setHistory] = useState<History>();
  const [historyError, setHistoryError] = useState<string>();
  const [sim, setSim] = useState<SimResponse>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [capInput, setCapInput] = useState("");
  const [depositInput, setDepositInput] = useState("0.001");
  const [keyInput, setKeyInput] = useState("");
  const [nameInput, setNameInput] = useState(() => agentNames.get(agentId) ?? "");
  const [rotatedKey, setRotatedKey] = useState<string>();

  const refresh = useCallback(async () => {
    try {
      setAgent(await readAgent(agentId));
    } catch (e) {
      setError(errorText(e));
    }
    // Usage is loaded on its own: when it fails, the tabs still show the empty dashboard and say why.
    if (key) {
      try {
        setHistory(await api.history(key, range));
        setHistoryError(undefined);
      } catch (e) {
        setHistoryError(errorText(e));
      }
    }
    setSim(await api.simulate(key).catch(() => undefined));
  }, [agentId, key, range]);

  useEffect(() => {
    setKey(sessionKey.get(agentId));
    setHistory(undefined);
    setHistoryError(undefined);
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

  function rotate() {
    if (!confirm("Rotate this agent's key? The current key stops working as soon as the transaction confirms.")) return;
    const k = generateKey();
    void act("rotate", async () => {
      await wallet.write({ address: CONFIG.registry, abi: registryAbi, functionName: "rotateKey", args: [agentId, hashKey(k)] });
      sessionKey.set(agentId, k);
      setKey(k);
      setRotatedKey(k);
    });
  }

  if (!agent) return <section className="card">Loading agent #{agentId.toString()}…</section>;

  const policy = templateForCircuit(agent.circuitId);
  // Until real usage arrives (no key, no requests yet, or the router can't serve it), show the empty dashboard.
  const shown = history ?? emptyHistory(range);
  const stale = !!key && !historyError && (!history || history.range !== range);
  const capPct = agent.dailyCap > 0n ? Number((agent.spentToday * 10_000n) / agent.dailyCap) / 100 : 100;
  const status = agent.killed ? "Killed" : !agent.budgetOk ? (agent.balance === 0n ? "Unfunded" : "Over today's cap") : "Active";

  return (
    <div className="dashboard">
      {rotatedKey && <KeyReveal apiKey={rotatedKey} agentId={agentId} rotated onConfirm={() => setRotatedKey(undefined)} />}
      <section className="card">
        <header className="row between">
          <h2>
            {agentLabel(agentId)} <span className="muted">· {policy?.name ?? `custom policy (circuit #${agent.circuitId})`}</span>
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
          <form
            className="control"
            onSubmit={(e) => {
              e.preventDefault();
              agentNames.set(agentId, nameInput);
              setNameInput(agentNames.get(agentId) ?? "");
              onChanged?.();
            }}
          >
            <label className="label" htmlFor="name-input">
              Name (this browser only)
            </label>
            <div className="row">
              <input id="name-input" data-testid="name-input" placeholder={`Agent #${agentId}`} maxLength={MAX_NAME_LENGTH} value={nameInput} onChange={(e) => setNameInput(e.target.value)} />
              <button type="submit" className="btn btn-ghost" data-testid="name-submit">
                Rename
              </button>
            </div>
          </form>
          <div className="control">
            <span className="label">API key</span>
            <button type="button" className="btn btn-ghost" data-testid="rotate-key" disabled={!!busy} onClick={rotate}>
              {busy === "rotate" ? "Confirming…" : "Lost it? Rotate key"}
            </button>
          </div>
        </div>
        <ErrorNote error={error} />
      </section>

      <div className="tabs dash-tabs" role="tablist" aria-label="Agent views">
        {(
          [
            ["usage", "Usage"],
            ["receipts", "Receipts"],
            ["policy", "Policy"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`panel-${id}`}
            className={`tab ${tab === id ? "tab-on" : ""}`}
            data-testid={`tab-${id}`}
            onClick={() => setTab(id)}
          >
            {label}
            {id === "receipts" && history ? <span className="tab-count">{history.totals.requests}</span> : null}
          </button>
        ))}
      </div>

      {tab !== "policy" && (
        <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="dashboard">
          {!key ? (
            <section className="card" data-testid="unlock">
              <p className="muted">Usage and receipts are read with the agent's API key, which this browser session doesn't have. Below is an empty dashboard until you add it.</p>
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
                <input className="grow" aria-label="API key" data-testid="unlock-input" placeholder="Paste this agent's pr-live-… key" value={keyInput} onChange={(e) => setKeyInput(e.target.value)} />
                <button type="submit" className="btn btn-ghost" data-testid="unlock-submit">
                  Unlock
                </button>
              </form>
              <p className="muted small">Lost it? Use “Rotate key” above to get a new one; the history carries over.</p>
            </section>
          ) : (
            historyError && (
              <p className="notice" role="status" data-testid="history-error">
                Couldn't load usage: {historyError} Showing an empty dashboard.
              </p>
            )
          )}
          <RangePicker range={range} onRange={setRange} onRefresh={() => void refresh()} />
          {tab === "usage" ? (
            <UsagePanel history={shown} stale={stale} />
          ) : (
            <ReceiptsPanel receipts={shown.receipts} total={shown.totals.requests} stale={stale} />
          )}
          {tab === "usage" && <Quickstart apiKey={key} />}
        </div>
      )}

      {tab === "policy" && (
        <section role="tabpanel" id="panel-policy" aria-labelledby="tab-policy">
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
      )}
    </div>
  );
}
