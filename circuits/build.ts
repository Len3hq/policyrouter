// Writes circuits/<id>.json for every template. Commit the output: it is what gets taped out.
//   pnpm --filter @policyrouter/circuits build

import { writeFileSync } from "node:fs";
import { TEMPLATES, buildArtifact } from "@policyrouter/policy";

export const artifactPath = (id: string) => new URL(`./${id}.json`, import.meta.url);

export function serialize(id: string): string {
  const t = TEMPLATES.find((x) => x.id === id);
  if (!t) throw new Error(`unknown template ${id}`);
  return `${JSON.stringify(buildArtifact(t), null, 2)}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const t of TEMPLATES) {
    writeFileSync(artifactPath(t.id), serialize(t.id));
    console.log(`wrote circuits/${t.id}.json (${t.circuit().gates.length} gates)`);
  }
}
