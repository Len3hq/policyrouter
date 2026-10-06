import { useCallback, useEffect, useState } from "react";
import { api, sessionKey, type SimResponse } from "./lib/api.ts";
import { listAgents, short, type AgentState } from "./lib/chain.ts";
import { agentLabel } from "./lib/names.ts";
import { useWallet } from "./lib/wallet.ts";
import { ErrorNote, errorText } from "./components/common.tsx";
import { CreateAgent } from "./components/CreateAgent.tsx";
import { Dashboard } from "./components/Dashboard.tsx";
import { KeyReveal } from "./components/KeyReveal.tsx";
import { templateForCircuit } from "./components/PolicyCards.tsx";
import { TransistorFacts } from "./components/TransistorFacts.tsx";
import { Logo } from "./components/icons.tsx";
import { Landing } from "./components/Landing.tsx";
import { DocsPage } from "./components/DocsPage.tsx";
import { VerifyPage } from "./components/VerifyPage.tsx";

const route = () => location.pathname.replace(/\/$/, "");

/** Three areas: the owner app at /, the public Verify page at /verify (no wallet), and the docs at /docs. */
export function App() {
  const r = route();
  if (r === "/verify") return <Shell active="verify"><VerifyPage /></Shell>;
  if (r === "/docs" || r.startsWith("/docs/")) return <Shell active="docs" wide><DocsPage /></Shell>;
  return <OwnerApp />;
}

function Shell({ children, active, right, wide }: { children: React.ReactNode; active?: "verify" | "docs"; right?: React.ReactNode; wide?: boolean }) {
  return (
    <div className="app">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <a className="brand" href="/" aria-label="PolicyRouter home">
          <span className="logo">
            <Logo />
          </span>
          <div>
            <strong>PolicyRouter</strong>
            <span className="muted small">The immutable firewall for AI agents</span>
          </div>
        </a>
        <nav className="row">
          <a className={`navlink ${active === "docs" ? "navlink-on" : ""}`} href="/docs" data-testid="nav-docs">
            Docs
          </a>
          <a className={`navlink ${active === "verify" ? "navlink-on" : ""}`} href="/verify" data-testid="nav-verify">
            Verify a receipt
          </a>
          {right}
        </nav>
      </header>
      <main id="main" className={wide ? "main-wide" : undefined}>
        {children}
      </main>
      <TransistorFacts />
    </div>
  );
}

function OwnerApp() {
  const wallet = useWallet();
  const [agents, setAgents] = useState<AgentState[]>();
  const [selected, setSelected] = useState<bigint>();
  const [creating, setCreating] = useState(false);
  const [newKey, setNewKey] = useState<{ agentId: bigint; key: string }>();
  const [sampleSim, setSampleSim] = useState<SimResponse>();
  const [error, setError] = useState<string>();

  const loadAgents = useCallback(async () => {
    if (!wallet.address || wallet.wrongNetwork) return;
    try {
      const list = await listAgents(wallet.address);
      setAgents(list);
      setSelected((s) => s ?? list[0]?.agentId);
      if (list.length === 0) setCreating(true);
    } catch (e) {
      setError(errorText(e));
    }
  }, [wallet.address, wallet.wrongNetwork]);

  useEffect(() => {
    void loadAgents();
  }, [loadAgents]);

  useEffect(() => {
    void api.simulate().then(setSampleSim).catch(() => undefined);
  }, []);

  return (
    <Shell
      right={
        wallet.address ? (
          <span className="pill mono" data-testid="account">
            {short(wallet.address)}
          </span>
        ) : (
          <button type="button" className="btn btn-primary" data-testid="connect" onClick={() => void wallet.connect()}>
            Connect wallet
          </button>
        )
      }
    >
      <>
        <ErrorNote error={wallet.error ?? error} />

        {wallet.wrongNetwork && (
          <section className="card banner" role="alert" data-testid="wrong-network">
            <p>
              Your wallet is on chain {wallet.chainId}. PolicyRouter lives on <strong>X Layer</strong> (chain 196).
            </p>
            <button type="button" className="btn btn-primary" data-testid="switch-network" onClick={() => void wallet.switchToXLayer()}>
              Switch to X Layer
            </button>
          </section>
        )}

        {!wallet.address && <Landing onConnect={() => void wallet.connect()} sampleSim={sampleSim} />}

        {wallet.address && !wallet.wrongNetwork && (
          <div className="layout">
            <aside className="card sidebar" aria-label="Your agents">
              <h2>Your agents</h2>
              {agents === undefined && <p className="muted">Loading…</p>}
              {agents?.length === 0 && <p className="muted">None yet.</p>}
              <ul>
                {agents?.map((a) => (
                  <li key={a.agentId.toString()}>
                    <button
                      type="button"
                      data-testid={`agent-${a.agentId}`}
                      className={`agent-item ${selected === a.agentId && !creating ? "agent-on" : ""}`}
                      onClick={() => {
                        setSelected(a.agentId);
                        setCreating(false);
                      }}
                    >
                      <span>{agentLabel(a.agentId)}</span>
                      <span className="muted small">
                        {templateForCircuit(a.circuitId)?.name ?? `circuit ${a.circuitId}`}
                        {a.killed ? " · killed" : ""}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              <button type="button" className="btn btn-ghost" data-testid="new-agent" onClick={() => setCreating(true)}>
                + New agent
              </button>
            </aside>

            <div className="content">
              {newKey && (
                <KeyReveal
                  apiKey={newKey.key}
                  agentId={newKey.agentId}
                  onConfirm={() => setNewKey(undefined)}
                />
              )}
              {creating ? (
                <CreateAgent
                  wallet={wallet}
                  onCancel={agents && agents.length > 0 ? () => setCreating(false) : undefined}
                  onCreated={(agentId, key) => {
                    sessionKey.set(agentId, key);
                    setNewKey({ agentId, key });
                    setSelected(agentId);
                    setCreating(false);
                    void loadAgents();
                  }}
                />
              ) : (
                selected !== undefined && <Dashboard key={selected.toString()} agentId={selected} wallet={wallet} onChanged={() => void loadAgents()} />
              )}
            </div>
          </div>
        )}
      </>
    </Shell>
  );
}
