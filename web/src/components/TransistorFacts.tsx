import { useEffect, useState } from "react";
import { okb, readTransistorFacts } from "../lib/chain.ts";
import { CONFIG } from "../lib/config.ts";
import { Logo } from "./icons.tsx";

/** Site footer: where to go next, and the transistor's live supply (read from X Layer). */
export function TransistorFacts() {
  const [facts, setFacts] = useState<Awaited<ReturnType<typeof readTransistorFacts>>>();
  useEffect(() => {
    void readTransistorFacts().then(setFacts).catch(() => undefined);
  }, []);
  return (
    <footer className="footer">
      <div className="footer-inner">
        <div className="footer-brand">
          <span className="logo">
            <Logo />
          </span>
          <div>
            <strong>PolicyRouter</strong>
            <p className="muted small">Policy circuits on X Layer decide what your AI agents may spend.</p>
          </div>
        </div>
        <nav className="footer-links" aria-label="Footer">
          <a href="/docs">Docs</a>
          <a href="/verify">Verify a receipt</a>
          <a href={CONFIG.repo} target="_blank" rel="noreferrer">
            Source
          </a>
          <a href={`${CONFIG.explorer}/address/${CONFIG.processor}`} target="_blank" rel="noreferrer">
            Processor contract
          </a>
        </nav>
        <div className="footer-facts">
          <span className="label">Transistor (ERC-1155), one burned per gate at tape-out</span>
          {facts ? (
            <span className="mono small" data-testid="transistor-facts">
              supply cap {facts.supplyCap.toLocaleString()}, price {okb(facts.mintPrice)} OKB, minted {facts.minted.toLocaleString()}, remaining{" "}
              {(facts.supplyCap - facts.minted).toLocaleString()}
            </span>
          ) : (
            <span className="mono small muted">Reading supply from X Layer…</span>
          )}
        </div>
      </div>
    </footer>
  );
}
