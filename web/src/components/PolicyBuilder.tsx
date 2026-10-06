import { useEffect, useMemo, useState } from "react";
import { parseEventLogs, type Hex } from "viem";
import {
  POLICYROUTER,
  SIZE_NAMES,
  TIER_NAMES,
  describeRule,
  encodeNetlist,
  evaluateRule,
  matchingTemplate,
  ruleId,
  synthesize,
  toHex,
  type CustomRule,
  type Size,
  type Tier,
} from "@policyrouter/policy";
import { api, type SimResponse } from "../lib/api.ts";
import { findCircuit, okb, processorAbi, publicClient, readTapeoutCosts, registryAbi, transistorsWriteAbi } from "../lib/chain.ts";
import { CONFIG } from "../lib/config.ts";
import type { Wallet } from "../lib/wallet.ts";
import { ErrorNote, errorText } from "./common.tsx";
import { SimulationPanel } from "./SimulationPanel.tsx";

const circuits = POLICYROUTER.circuits as Readonly<Record<string, bigint>>;

/** One cell of the outcome grid: what the rule does to a request of this tier and size (kill switch off, budget fine). */
function outcome(rule: CustomRule, tier: Tier, size: Size) {
  const o = evaluateRule(rule, { tier, size, budgetOk: true, kill: false });
  if (!o.allow) return { text: "deny", kind: "deny" };
  if (o.routeTier < tier) return { text: `→ ${TIER_NAMES[o.routeTier]}`, kind: "down" };
  return { text: "allow", kind: "allow" };
}

/**
 * Build a custom policy: three settings → a NAND circuit proven against the rule on all 64 inputs →
 * a simulation on the agent's own requests → its cost → tape-out on PolicyRouter's processor →
 * point the agent at it. Rules that equal a template, or a circuit someone already taped out, reuse it.
 */
export function PolicyBuilder({ agentId, apiKey, currentCircuit, wallet, onDone }: { agentId: bigint; apiKey?: string; currentCircuit: bigint; wallet: Wallet; onDone: () => void }) {
  const [rule, setRule] = useState<CustomRule>({ maxTier: 2, overTier: "downgrade", maxSize: 2 });
  const [costs, setCosts] = useState<Awaited<ReturnType<typeof readTapeoutCosts>>>();
  const [existing, setExisting] = useState<bigint | null>();
  const [sim, setSim] = useState<SimResponse>();
  const [step, setStep] = useState<string>();
  const [error, setError] = useState<string>();

  const id = ruleId(rule);
  const netlist = useMemo(() => synthesize(rule), [id]); // eslint-disable-line react-hooks/exhaustive-deps
  const netlistHex = useMemo(() => toHex(encodeNetlist(netlist)) as Hex, [netlist]);
  const gates = BigInt(netlist.gates.length);
  const template = matchingTemplate(rule);
  const templateCircuit = template ? circuits[template.id] : undefined;
  const reuse = templateCircuit ?? existing ?? undefined;

  useEffect(() => {
    void readTapeoutCosts().then(setCosts).catch(() => undefined);
  }, []);
  useEffect(() => {
    setExisting(undefined);
    setSim(undefined);
    if (!templateCircuit) void findCircuit(netlistHex).then((c) => setExisting(c ?? null)).catch(() => setExisting(null));
    void fetch(`${CONFIG.routerUrl}/v1/simulate?template=custom:${id}`, { headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {} })
      .then((r) => r.json() as Promise<SimResponse>)
      .then(setSim)
      .catch(() => undefined);
  }, [id, netlistHex, templateCircuit, apiKey]);

  const total = costs ? costs.mintPrice * gates + costs.protocolFee + costs.tapeoutFee : undefined;

  async function apply() {
    setError(undefined);
    try {
      let circuitId = reuse;
      if (circuitId === undefined) {
        if (!costs || !wallet.address) throw new Error("Connect a wallet first.");
        // 1. transistors: use ones the owner already holds (e.g. from a grant), mint the rest
        const held = await publicClient.readContract({ address: CONFIG.transistors, abi: transistorsWriteAbi, functionName: "balanceOf", args: [wallet.address, 0n] });
        if (held < gates) {
          setStep(`Minting ${gates - held} transistors (1 of 3)…`);
          await wallet.write({
            address: CONFIG.transistors,
            abi: transistorsWriteAbi,
            functionName: "mint",
            args: [0n, gates - held],
            value: costs.mintPrice * (gates - held) + costs.protocolFee,
          });
        }
        // 2. tape out: burns one transistor per gate; the new circuit is an NFT owned by the owner
        setStep("Taping out the circuit (2 of 3)…");
        const receipt = await wallet.write({ address: CONFIG.processor, abi: processorAbi, functionName: "tapeout", args: [netlistHex, 6, 3], value: costs.tapeoutFee });
        const minted = parseEventLogs({ abi: processorAbi, logs: receipt.logs, eventName: "Transfer" }).find(
          (l) => l.address.toLowerCase() === CONFIG.processor.toLowerCase() && BigInt(l.args.from) === 0n,
        );
        if (!minted) throw new Error("The tape-out succeeded but its circuit id wasn't found in the transaction.");
        circuitId = minted.args.tokenId;
      }
      // 3. point the agent at it
      if (circuitId !== currentCircuit) {
        setStep(reuse === undefined ? "Switching the agent to it (3 of 3)…" : "Switching the agent…");
        await wallet.write({ address: CONFIG.registry, abi: registryAbi, functionName: "setCircuit", args: [agentId, circuitId] });
      }
      onDone();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setStep(undefined);
    }
  }

  return (
    <section className="card builder" aria-labelledby="builder-title" data-testid="builder">
      <h2 id="builder-title">Build a custom policy</h2>
      <p className="muted">
        Budget Guard is always included: a custom policy can never serve a request while the kill switch is on or the budget is spent.
      </p>

      <div className="builder-controls">
        <fieldset>
          <legend>Highest tier served</legend>
          {TIER_NAMES.map((n, t) => (
            <label key={n} className="radio">
              <input type="radio" name="maxTier" checked={rule.maxTier === t} onChange={() => setRule({ ...rule, maxTier: t as Tier })} data-testid={`b-tier-${n}`} />
              {n}
            </label>
          ))}
        </fieldset>
        <fieldset disabled={rule.maxTier === 3}>
          <legend>A request above it is</legend>
          {(["downgrade", "deny"] as const).map((o) => (
            <label key={o} className="radio">
              <input type="radio" name="overTier" checked={rule.overTier === o} onChange={() => setRule({ ...rule, overTier: o })} data-testid={`b-over-${o}`} />
              {o === "downgrade" ? "downgraded" : "denied"}
            </label>
          ))}
        </fieldset>
        <fieldset>
          <legend>Largest request allowed</legend>
          {SIZE_NAMES.map((n, s) => (
            <label key={n} className="radio">
              <input type="radio" name="maxSize" checked={rule.maxSize === s} onChange={() => setRule({ ...rule, maxSize: s as Size })} data-testid={`b-size-${n}`} />
              {n}
            </label>
          ))}
        </fieldset>
      </div>

      <p className="builder-rule" data-testid="builder-rule">
        {describeRule(rule)}
      </p>

      <div className="table-wrap">
        <table className="grid" data-testid="builder-grid">
          <caption className="muted small">What it does with the kill switch off and budget left. Every other case is a deny.</caption>
          <thead>
            <tr>
              <th>request</th>
              {SIZE_NAMES.map((s) => (
                <th key={s}>{s}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {TIER_NAMES.map((t, ti) => (
              <tr key={t}>
                <th>{t}</th>
                {SIZE_NAMES.map((s, si) => {
                  const o = outcome(rule, ti as Tier, si as Size);
                  return (
                    <td key={s} className={`cell-${o.kind}`}>
                      {o.text}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {sim?.results[0] && <SimulationPanel result={sim.results[0]} source={sim.source} requests={sim.requests} />}

      <div className="builder-cost" data-testid="builder-cost">
        {template ? (
          <p>
            This is <strong>{template.name}</strong>, already on chain as circuit #{templateCircuit?.toString()}. No tape-out needed.
          </p>
        ) : existing ? (
          <p>
            Someone already taped out this exact circuit: <strong>circuit #{existing.toString()}</strong>. You can use it for free.
          </p>
        ) : (
          <p>
            <strong>{netlist.gates.length} NAND gates</strong>, proven against the rule on all 64 inputs. Tape-out:{" "}
            {total !== undefined && costs ? (
              <>
                <span className="mono">{okb(total)}</span> OKB ({netlist.gates.length} transistors × {okb(costs.mintPrice)} + TapeOut fees {okb(costs.protocolFee + costs.tapeoutFee)}), plus gas.
              </>
            ) : (
              "reading fees…"
            )}
          </p>
        )}
      </div>

      <button type="button" className="btn btn-primary" disabled={!!step || existing === undefined && !template} onClick={() => void apply()} data-testid="builder-apply">
        {step ?? (reuse !== undefined ? (reuse === currentCircuit ? "Already this agent's policy" : `Use circuit #${reuse}`) : "Tape out and use this policy")}
      </button>
      <ErrorNote error={error} />
    </section>
  );
}
