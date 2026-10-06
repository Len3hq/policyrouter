import { useState } from "react";
import { decodeEventLog, parseEther } from "viem";
import { POLICYROUTER, TEMPLATES } from "@policyrouter/policy";
import { generateKey, hashKey } from "../lib/api.ts";
import { escrowAbi, registryAbi } from "../lib/chain.ts";
import { CONFIG } from "../lib/config.ts";
import { agentNames, MAX_NAME_LENGTH } from "../lib/names.ts";
import type { Wallet } from "../lib/wallet.ts";
import { ErrorNote, errorText } from "./common.tsx";

const circuits = POLICYROUTER.circuits as Readonly<Record<string, bigint>>;

/**
 * Creates a project (an agent record in PolicyRegistry) in two transactions: register it (key hash, policy circuit, daily cap), then
 * deposit its first OKB. The key is generated in the browser and only its hash leaves it.
 */
export function CreateAgent({ wallet, onCreated, onCancel }: { wallet: Wallet; onCreated: (agentId: bigint, key: string) => void; onCancel?: () => void }) {
  const [name, setName] = useState("");
  const [template, setTemplate] = useState("budget-guard");
  const [cap, setCap] = useState("0.001");
  const [deposit, setDeposit] = useState("0.001");
  const [step, setStep] = useState<string>();
  const [error, setError] = useState<string>();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(undefined);
    let capWei: bigint;
    let depositWei: bigint;
    try {
      capWei = parseEther(cap);
      depositWei = parseEther(deposit || "0");
    } catch {
      setError("Enter amounts in OKB, for example 0.001.");
      return;
    }
    const key = generateKey();
    try {
      setStep("Registering the project (1 of 2)…");
      const receipt = await wallet.write({
        address: CONFIG.registry,
        abi: registryAbi,
        functionName: "registerAgent",
        args: [hashKey(key), circuits[template]!, capWei],
      });
      const agentId = receipt.logs
        .filter((l) => l.address.toLowerCase() === CONFIG.registry.toLowerCase())
        .map((l) => {
          try {
            return decodeEventLog({ abi: registryAbi, data: l.data, topics: l.topics });
          } catch {
            return undefined;
          }
        })
        .find((ev) => ev?.eventName === "AgentRegistered")?.args.agentId;
      if (agentId === undefined) throw new Error("The registration succeeded but its AgentRegistered event was not found.");
      agentNames.set(agentId, name);

      if (depositWei > 0n) {
        setStep("Depositing OKB (2 of 2)…");
        await wallet.write({ address: CONFIG.escrow, abi: escrowAbi, functionName: "deposit", args: [agentId], value: depositWei });
      }
      onCreated(agentId, key);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setStep(undefined);
    }
  }

  return (
    <form className="card" onSubmit={submit} aria-labelledby="create-title">
      <h2 id="create-title">New project</h2>
      <div className="fields">
        <label>
          Name (optional, kept in this browser)
          <input data-testid="create-name" placeholder="Discord bot" maxLength={MAX_NAME_LENGTH} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
      </div>
      <fieldset className="choices">
        <legend>Policy</legend>
        {TEMPLATES.map((t) => (
          <label key={t.id} className={`choice ${template === t.id ? "choice-on" : ""}`}>
            <input type="radio" name="policy" value={t.id} checked={template === t.id} onChange={() => setTemplate(t.id)} />
            <span>
              <strong>{t.name}</strong>
              <span className="muted small">{t.rule}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="fields">
        <label>
          Daily cap (OKB)
          <input data-testid="create-cap" inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} />
        </label>
        <label>
          First deposit (OKB)
          <input data-testid="create-deposit" inputMode="decimal" value={deposit} onChange={(e) => setDeposit(e.target.value)} />
        </label>
      </div>
      <p className="muted small">Two transactions: register the project, then deposit. Unused OKB can be withdrawn at any time.</p>
      <div className="row">
        <button type="submit" className="btn btn-primary" disabled={!!step} data-testid="create-submit">
          {step ?? "Create project"}
        </button>
        {onCancel && (
          <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={!!step}>
            Cancel
          </button>
        )}
      </div>
      <ErrorNote error={error} />
    </form>
  );
}
