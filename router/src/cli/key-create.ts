// Creates an API key, stores only its hash, and prints the command that registers it on chain.
//   pnpm --filter @policyrouter/router key:create [--label my-agent] [--circuit 1] [--cap 0.001]
// The key is shown once. The web app takes this over in Phase 6.

import { existsSync } from "node:fs";
import { parseEther } from "viem";
import { Store } from "../db.ts";
import { generateKey, hashKey } from "../keys.ts";

const envFile = new URL("../../../.env", import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};

const label = flag("--label");
const circuit = flag("--circuit", "1")!;
const capWei = parseEther(flag("--cap", "0.001")!);

const key = generateKey();
const keyHash = hashKey(key);
const store = new Store(process.env.DATABASE_PATH || "policyrouter.sqlite");
store.addKey(keyHash, label);
store.close();

const registry = process.env.POLICY_REGISTRY_ADDRESS || "<POLICY_REGISTRY_ADDRESS>";
console.log(`
API key (shown once, store it now):
  ${key}

Key hash (safe to share):
  ${keyHash}

Register it on chain as the agent's owner (circuit ${circuit}, daily cap ${capWei} wei):
  cast send ${registry} "registerAgent(bytes32,uint256,uint128)" ${keyHash} ${circuit} ${capWei} \\
    --account <owner-keystore> --rpc-url https://rpc.xlayer.tech

Then fund it (agentId is in the AgentRegistered event):
  cast send ${process.env.CREDIT_ESCROW_ADDRESS || "<CREDIT_ESCROW_ADDRESS>"} "deposit(uint256)" <agentId> --value 0.001ether \\
    --account <owner-keystore> --rpc-url https://rpc.xlayer.tech

Point an agent at the router:
  export OPENAI_BASE_URL=http://localhost:${process.env.PORT ?? 8787}/v1
  export OPENAI_API_KEY=${key}
`);
