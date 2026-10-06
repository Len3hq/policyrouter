import { useCallback, useEffect, useRef, useState } from "react";
import { api, sessionKey, type SimResponse } from "./lib/api.ts";
import { listAgents, type AgentState } from "./lib/chain.ts";
import { agentLabel } from "./lib/names.ts";
import { navigate, onLinkClick, usePath } from "./lib/router.ts";
import { useWallet, type Wallet } from "./lib/wallet.ts";
import { AccountMenu } from "./components/AccountMenu.tsx";
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

/**
 * Four areas: the landing page at /, the owner app at /app, the public Verify page at /verify (no
 * wallet), and the docs at /docs. One wallet connection is shared by all of them.
 */
export function App() {
  const path = usePath();
  const wallet = useWallet();

  // After the user clicks Connect anywhere, take them to the app once the account arrives.
  const goToApp = useRef(false);
  useEffect(() => {
    if (wallet.address && goToApp.current) {
      goToApp.current = false;
      navigate("/app");
    }
  }, [wallet.address]);
  const connect = () => {
    goToApp.current = true;
    void wallet.connect();
  };

  if (path === "/verify")
    return (
      <Shell active="verify" wallet={wallet} onConnect={connect}>
        <VerifyPage />
      </Shell>
    );
  if (path === "/docs" || path.startsWith("/docs/"))
    return (
      <Shell active="docs" wallet={wallet} onConnect={connect} wide>
        <DocsPage />
      </Shell>
    );
  if (path === "/app") return <OwnerApp wallet={wallet} onConnect={connect} />;
  return <Home wallet={wallet} onConnect={connect} />;
}

function Shell({
  children,
  active,
  wallet,
  onConnect,
  wide,
}: {
  children: React.ReactNode;
  active?: "home" | "app" | "verify" | "docs";
  wallet: Wallet;
  onConnect: () => void;
  wide?: boolean;
}) {
  return (
    <div className="app">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <a className="brand" href="/" aria-label="PolicyRouter home" aria-current={active === "home" ? "page" : undefined} onClick={onLinkClick} data-testid="brand">
          <span className="logo">
            <Logo />
          </span>
          <div>
            <strong>PolicyRouter</strong>
            <span className="muted small">The immutable firewall for AI agents</span>
          </div>
        </a>
        <nav className="row">
          {wallet.address && (
            <a className={`navlink navlink-hide-sm ${active === "app" ? "navlink-on" : ""}`} href="/app" onClick={onLinkClick} data-testid="nav-app">
              Dashboard
            </a>
          )}
          <a className={`navlink ${active === "docs" ? "navlink-on" : ""}`} href="/docs" onClick={onLinkClick} data-testid="nav-docs">
            Docs
          </a>
          <a className={`navlink ${active === "verify" ? "navlink-on" : ""}`} href="/verify" onClick={onLinkClick} data-testid="nav-verify">
            Verify a receipt
          </a>
          {wallet.address ? (
            <AccountMenu wallet={wallet} />
          ) : (
            <button type="button" className="btn btn-primary" data-testid="connect" onClick={onConnect}>
              Connect wallet
            </button>
          )}
        </nav>
      </header>
      <main id="main" className={wide ? "main-wide" : undefined}>
        <ErrorNote error={wallet.error} />
        {children}
      </main>
      <TransistorFacts />
    </div>
  );
}

/** The landing page. It stays reachable while connected; its call to action then opens the dashboard. */
function Home({ wallet, onConnect }: { wallet: Wallet; onConnect: () => void }) {
  const [sampleSim, setSampleSim] = useState<SimResponse>();
  useEffect(() => {
    void api.simulate().then(setSampleSim).catch(() => undefined);
  }, []);
  return (
    <Shell active="home" wallet={wallet} onConnect={onConnect}>
      <Landing connected={!!wallet.address} onConnect={wallet.address ? () => navigate("/app") : onConnect} sampleSim={sampleSim} />
    </Shell>
  );
}

function OwnerApp({ wallet, onConnect }: { wallet: Wallet; onConnect: () => void }) {
  const [agents, setAgents] = useState<AgentState[]>();
  const [selected, setSelected] = useState<bigint>();
  const [creating, setCreating] = useState(false);
  const [newKey, setNewKey] = useState<{ agentId: bigint; key: string }>();
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

  // A different account (or a disconnect) means a different set of agents.
  useEffect(() => {
    setAgents(undefined);
    setSelected(undefined);
    setCreating(false);
    setNewKey(undefined);
  }, [wallet.address]);

  return (
    <Shell active="app" wallet={wallet} onConnect={onConnect}>
      <>
        <ErrorNote error={error} />

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

        {!wallet.address && (
          <section className="card connect-card" data-testid="connect-prompt">
            <h1>Connect a wallet to manage your projects</h1>
            <p className="muted">Your projects, their policies, caps and receipts are tied to the wallet that created them.</p>
            <button type="button" className="btn btn-primary btn-lg" onClick={onConnect}>
              Connect wallet
            </button>
          </section>
        )}

        {wallet.address && !wallet.wrongNetwork && (
          <div className="layout">
            <aside className="card sidebar" aria-label="Your projects">
              <h2>Your projects</h2>
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
                + New project
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
