import { useState } from "react";
import { CONFIG, baseUrl } from "../lib/config.ts";
import { CopyButton } from "./common.tsx";

const TABS = ["OpenAI SDK (Node)", "OpenAI SDK (Python)", "Codex", "Claude Code"] as const;

/** The 60-second setup: two environment variables, then any OpenAI-compatible client. */
export function Quickstart({ apiKey }: { apiKey?: string }) {
  const [tab, setTab] = useState<(typeof TABS)[number]>(TABS[0]);
  const url = baseUrl();
  const key = apiKey ?? "pr-live-…";
  const env = `export OPENAI_BASE_URL=${url}\nexport OPENAI_API_KEY=${key}`;

  return (
    <section className="card" aria-labelledby="qs-title">
      <h2 id="qs-title">Point your agent at PolicyRouter</h2>
      <p className="muted">Any client that speaks the OpenAI API works unchanged. Set two variables:</p>
      <pre className="code" data-testid="quickstart-env">{env}</pre>
      <div className="row">
        <CopyButton text={url} label="Copy base URL" testId="copy-base-url" />
        {apiKey && <CopyButton text={apiKey} label="Copy key" testId="copy-quickstart-key" />}
        <CopyButton text={env} label="Copy both lines" testId="copy-env" />
      </div>
      {!apiKey && <p className="muted small">Your key isn't in this browser session; paste it from where you saved it.</p>}

      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={`tab ${tab === t ? "tab-on" : ""}`} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>
      {tab === "OpenAI SDK (Node)" && (
        <pre className="code">{`import OpenAI from "openai";
const client = new OpenAI(); // reads OPENAI_BASE_URL and OPENAI_API_KEY
const r = await client.chat.completions.create({
  model: "standard", // cheap | standard | premium | frontier
  messages: [{ role: "user", content: "Hello" }],
});
console.log(r.choices[0].message.content, r.policyrouter_receipt);`}</pre>
      )}
      {tab === "OpenAI SDK (Python)" && (
        <pre className="code">{`from openai import OpenAI
client = OpenAI()  # reads OPENAI_BASE_URL and OPENAI_API_KEY
r = client.chat.completions.create(
    model="standard",  # cheap | standard | premium | frontier
    messages=[{"role": "user", "content": "Hello"}],
)
print(r.choices[0].message.content)`}</pre>
      )}
      {tab === "Codex" && (
        <>
          <pre className="code">{`# ~/.codex/config.toml  (Codex uses the Responses API: PolicyRouter serves /v1/responses)
model = "standard"
model_provider = "policyrouter"

[model_providers.policyrouter]
name = "PolicyRouter"
base_url = "${url}"
env_key = "OPENAI_API_KEY"
wire_api = "responses"`}</pre>
          <p className="muted small">Then run <code>codex</code> with OPENAI_API_KEY set to your key.</p>
        </>
      )}
      {tab === "Claude Code" && (
        <>
          <pre className="code" data-testid="quickstart-claude">{`# Claude Code uses the Anthropic Messages API: PolicyRouter serves /v1/messages
export ANTHROPIC_BASE_URL=${CONFIG.routerUrl.replace(/\/$/, "")}
export ANTHROPIC_AUTH_TOKEN=${key}
export ANTHROPIC_MODEL=standard
export ANTHROPIC_DEFAULT_OPUS_MODEL=frontier
export ANTHROPIC_DEFAULT_SONNET_MODEL=standard
export ANTHROPIC_DEFAULT_HAIKU_MODEL=cheap
claude`}</pre>
          <p className="muted small">
            Claude Code's requests are large (its system prompt plus a big output budget), so they fall in the "huge" size bucket:
            Small Requests and Strict deny most of them. Use Budget Guard or Cheap Only for Claude Code.
          </p>
        </>
      )}
    </section>
  );
}
