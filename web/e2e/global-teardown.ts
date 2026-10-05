import { readFileSync } from "node:fs";
import type { E2EState } from "./global-setup.ts";

export default async function globalTeardown() {
  const state = JSON.parse(readFileSync(new URL("../test-results/e2e-env/state.json", import.meta.url), "utf8")) as E2EState;
  for (const pid of state.pids.reverse()) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
}
