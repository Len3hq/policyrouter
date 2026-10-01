import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TEMPLATES } from "@policyrouter/policy";
import { artifactPath, serialize } from "../build.ts";

describe.each(TEMPLATES.map((t) => [t.id] as const))("circuits/%s.json", (id) => {
  it("matches what the template generates (run `pnpm --filter @policyrouter/circuits build` after changing a template)", () => {
    expect(readFileSync(artifactPath(id), "utf8")).toBe(serialize(id));
  });
});
