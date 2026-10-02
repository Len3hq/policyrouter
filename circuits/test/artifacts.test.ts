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
    expect(BigInt(d.budgetGuardCircuitId)).toBe(POLICYROUTER.circuits["budget-guard"]);
  });
});

describe.each(TEMPLATES.map((t) => [t.id] as const))("circuits/%s.json", (id) => {
  it("matches what the template generates (run `pnpm --filter @policyrouter/circuits build` after changing a template)", () => {
    expect(readFileSync(artifactPath(id), "utf8")).toBe(serialize(id));
  });
});
