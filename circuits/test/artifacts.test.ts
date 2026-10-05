import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { POLICYROUTER, TEMPLATES } from "@policyrouter/policy";
import { artifactPath, serialize } from "../build.ts";

describe("deployments/xlayer.json", () => {
  const d = JSON.parse(readFileSync(new URL("../../deployments/xlayer.json", import.meta.url), "utf8"));

  it("matches the addresses in @policyrouter/policy", () => {
    expect(d.chainId).toBe(196);
    expect(d.deployer).toBe(POLICYROUTER.deployer);
    expect(d.treasury).toBe(POLICYROUTER.treasury);
    expect(d.processor).toBe(POLICYROUTER.processor);
    expect(d.transistors).toBe(POLICYROUTER.transistors);
    expect(d.policyRegistry).toBe(POLICYROUTER.policyRegistry);
    expect(d.creditEscrow).toBe(POLICYROUTER.creditEscrow);
    expect(d.router).toBe(POLICYROUTER.router);
    expect(BigInt(d.budgetGuardCircuitId)).toBe(POLICYROUTER.circuits["budget-guard"]);
    expect(BigInt(d.cheapOnlyCircuitId)).toBe(POLICYROUTER.circuits["cheap-only"]);
    expect(BigInt(d.smallRequestsCircuitId)).toBe(POLICYROUTER.circuits["small-requests"]);
    expect(BigInt(d.strictCircuitId)).toBe(POLICYROUTER.circuits.strict);
  });
});

describe("mainnet proofs", () => {
  it.each(TEMPLATES.map((t) => [t.id] as const))("circuits/proof/%s.txt records 64/64 and a matching structure", (id) => {
    const proof = readFileSync(new URL(`../proof/${id}.txt`, import.meta.url), "utf8");
    expect(proof).toContain("64/64 rows match");
    expect(proof).toContain("structure (nIn, nOut, nState = 0, gateCount, netlist bytes): match");
    expect(proof).toContain(`circuit ${POLICYROUTER.circuits[id as keyof typeof POLICYROUTER.circuits]}  block`);
  });
});

describe.each(TEMPLATES.map((t) => [t.id] as const))("circuits/%s.json", (id) => {
  it("matches what the template generates (run `pnpm --filter @policyrouter/circuits build` after changing a template)", () => {
    expect(readFileSync(artifactPath(id), "utf8")).toBe(serialize(id));
  });
});
