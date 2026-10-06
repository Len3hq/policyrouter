import { buildSite } from "./model.ts";

// The docs are the markdown files in /docs at the repository root (GitBook format).
const raw = import.meta.glob("../../../docs/**/*.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

export const docsFiles: Record<string, string> = Object.fromEntries(
  Object.entries(raw).map(([k, v]) => [k.replace(/^.*\/docs\//, ""), v]),
);

export const site = buildSite(docsFiles);
