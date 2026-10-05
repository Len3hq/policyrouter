import { useEffect, useState } from "react";
import { okb, readTransistorFacts } from "../lib/chain.ts";
import { CONFIG } from "../lib/config.ts";

/** Footer: the transistor's fixed supply and price, and how many have been minted. */
export function TransistorFacts() {
  const [facts, setFacts] = useState<Awaited<ReturnType<typeof readTransistorFacts>>>();
  useEffect(() => {
    void readTransistorFacts().then(setFacts).catch(() => undefined);
  }, []);
  return (
    <footer className="footer">
      <div>
        <strong>Transistor</strong> (ERC-1155):{" "}
        {facts ? (
          <span data-testid="transistor-facts">
            supply cap {facts.supplyCap.toLocaleString()} · price {okb(facts.mintPrice)} OKB · minted {facts.minted.toLocaleString()} · remaining{" "}
            {(facts.supplyCap - facts.minted).toLocaleString()}
          </span>
        ) : (
          "loading…"
        )}
      </div>
      <div className="muted small">
        One transistor is burned per gate when a policy circuit is taped out. Processor{" "}
        <a href={`${CONFIG.explorer}/address/${CONFIG.processor}`} target="_blank" rel="noreferrer">
          {CONFIG.processor.slice(0, 10)}…
        </a>{" "}
        on X Layer ·{" "}
        <a href={CONFIG.repo} target="_blank" rel="noreferrer">
          source
        </a>
      </div>
    </footer>
  );
}
