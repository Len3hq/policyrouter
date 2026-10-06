import { useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, MotionConfig, motion, type Variants } from "motion/react";
import { ArrowRight, ArrowUpRight, Gauge, Key, Play, Power, Receipt, Wallet } from "@phosphor-icons/react";
import { POLICYROUTER, SIZE_NAMES, TEMPLATES, TIER_NAMES, inputPins, simulate, type Size, type Tier } from "@policyrouter/policy";
import type { SimResponse } from "../lib/api.ts";
import { PolicyCards } from "./PolicyCards.tsx";
import { Quickstart } from "./Quickstart.tsx";

const circuits = POLICYROUTER.circuits as Readonly<Record<string, bigint>>;

// One easing for the whole page: fast out, long settle.
const EASE = [0.16, 1, 0.3, 1] as const;

/** Enters once, the first time it scrolls into view. Static under reduced motion (MotionConfig below). */
function Reveal({ children, delay = 0, className, as = "div" }: { children: ReactNode; delay?: number; className?: string; as?: "div" | "article" | "li" }) {
  const Tag = motion[as];
  return (
    <Tag
      className={className}
      initial={{ opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.25 }}
      transition={{ duration: 0.6, delay, ease: EASE }}
    >
      {children}
    </Tag>
  );
}

/** The signed-out front page: what PolicyRouter does, why it can be trusted, and how to start. */
export function Landing({ onConnect, sampleSim }: { onConnect: () => void; sampleSim?: SimResponse }) {
  return (
    <MotionConfig reducedMotion="user">
      <div className="landing">
        <section className="lp-hero" aria-labelledby="lp-title">
          <div className="lp-hero-copy">
            <p className="eyebrow">Policy firewall for AI agents on X Layer</p>
            <h1 id="lp-title">Every request your agent sends, checked on chain.</h1>
            <p className="lead">Each agent gets an OpenAI-compatible key. A circuit on X Layer allows, downgrades or denies every call.</p>
            <div className="lp-cta">
              <button type="button" className="btn btn-primary btn-lg" onClick={onConnect}>
                <Wallet weight="bold" /> Connect wallet
              </button>
              <a className="btn btn-text btn-lg" href="/docs">
                Read the docs <ArrowRight weight="bold" />
              </a>
            </div>
          </div>
          <PolicyPlayground />
        </section>

        <section className="lp-section" aria-labelledby="why-title">
          <Reveal>
            <h2 id="why-title" className="lp-h2">
              Rules your agent can't argue with
            </h2>
            <p className="lead lp-sub">A prompt can talk a model out of a guardrail. It can't talk a circuit out of its output.</p>
          </Reveal>
          <div className="bento">
            <Reveal as="article" className="cell cell-circuits">
              <h3>Policies are circuits, not config</h3>
              <p className="muted">Each policy is a NAND-gate netlist taped out on X Layer. Once deployed, nobody can edit it: not you, not us, not the router.</p>
              <GateCounts />
            </Reveal>
            <Reveal as="article" className="cell cell-block" delay={0.08}>
              <Gauge size={28} weight="duotone" className="cell-icon" />
              <h3>Decided before the model runs</h3>
              <p className="muted">The router evaluates the circuit at a pinned block. If the check can't run, the request is refused.</p>
            </Reveal>
            <Reveal as="article" className="cell cell-receipt">
              <Receipt size={28} weight="duotone" className="cell-icon" />
              <h3>A signed receipt for every call</h3>
              <p className="muted">Allowed or denied, each request gets an EIP-712 receipt, settled on chain in a Merkle batch.</p>
              <dl className="receipt-schema mono">
                <dt>circuitId</dt>
                <dd>the policy that decided</dd>
                <dt>inputBits</dt>
                <dd>what it saw</dd>
                <dt>outputBits</dt>
                <dd>what it chose</dd>
                <dt>costWei</dt>
                <dd>what it cost</dd>
              </dl>
            </Reveal>
            <Reveal as="article" className="cell cell-controls" delay={0.08}>
              <h3>Your wallet holds the controls</h3>
              <p className="muted">Only the agent's owner can change its limits, and each change is an on-chain transaction anyone can see.</p>
              <ul className="control-chips">
                <li>
                  <Power weight="bold" /> Kill switch
                </li>
                <li>
                  <Gauge weight="bold" /> Daily OKB cap
                </li>
                <li>
                  <Key weight="bold" /> Key rotation
                </li>
              </ul>
            </Reveal>
          </div>
        </section>

        <section className="lp-section lp-film" aria-labelledby="film-title">
          <Reveal>
            <h2 id="film-title" className="lp-h2">
              How it works, in 30 seconds
            </h2>
            <p className="lead lp-sub">Watch requests pass through your policy circuit: allowed, downgraded, denied, then signed and settled on chain.</p>
          </Reveal>
          <Reveal delay={0.08}>
            <LaunchVideo />
          </Reveal>
        </section>

        <section className="lp-section lp-how" id="how" aria-labelledby="how-title">
          <div className="lp-how-copy">
            <Reveal>
              <h2 id="how-title" className="lp-h2">
                Three changes. No new SDK.
              </h2>
            </Reveal>
            <ol className="how-list">
              <HowStep i={0} title="Create an agent">
                Connect a wallet, pick a policy, set a daily cap and deposit OKB. You get an API key.
              </HowStep>
              <HowStep i={1} title="Point your client at the router">
                Set two environment variables. OpenAI SDKs, LangChain, Codex and Claude Code work unchanged.
              </HowStep>
              <HowStep i={2} title="Watch every decision" last>
                Your dashboard charts usage and lets you verify any receipt against the chain.
              </HowStep>
            </ol>
          </div>
          <Reveal delay={0.1}>
            <Quickstart />
          </Reveal>
        </section>

        <section className="lp-section" id="policies" aria-labelledby="pol-title">
          <Reveal>
            <h2 id="pol-title" className="lp-h2">
              Four policies, already on chain
            </h2>
            <p className="lead lp-sub">Each was replayed against a sample of typical requests, so you can see what it blocks and saves before you choose.</p>
          </Reveal>
          <Reveal delay={0.08}>
            <PolicyCards sim={sampleSim} />
          </Reveal>
        </section>

        <Reveal className="lp-verify">
          <section aria-labelledby="verify-title" className="lp-verify-inner">
            <h2 id="verify-title">Don't trust the router. Check it.</h2>
            <p className="muted">Paste a request id and re-run the decision, the signature and the settlement against X Layer. Read-only, no wallet.</p>
            <a className="btn btn-ghost btn-lg" href="/verify">
              Verify a receipt <ArrowUpRight weight="bold" />
            </a>
          </section>
        </Reveal>
      </div>
    </MotionConfig>
  );
}

/** The explainer film. Nothing downloads until it's played; the poster is its "downgraded" frame. */
function LaunchVideo() {
  const ref = useRef<HTMLVideoElement>(null);
  const [started, setStarted] = useState(false);
  return (
    <figure className="film">
      <video
        ref={ref}
        src="/media/policyrouter-explainer.mp4"
        poster="/media/policyrouter-explainer.jpg"
        preload="none"
        playsInline
        controls={started}
        onPlay={() => setStarted(true)}
        aria-label="PolicyRouter explainer: PolicyRouter sits between your agent and the model, and your policy lives on X Layer. A standard request is allowed, a frontier request is downgraded to standard, and with the kill switch on a request is denied. Each decision gets a signed receipt, settled on chain and debited from escrow."
      />
      {!started && (
        <button type="button" className="film-play" onClick={() => void ref.current?.play()} data-testid="film-play">
          <span className="film-play-icon">
            <Play weight="fill" />
          </span>
          <span className="film-play-label">Play the 30s explainer</span>
        </button>
      )}
    </figure>
  );
}

/** A step in "how it works": enters on scroll, then draws the connector down to the next step. */
function HowStep({ i, title, children, last }: { i: number; title: string; children: ReactNode; last?: boolean }) {
  return (
    <Reveal as="li" delay={i * 0.12}>
      <h3>{title}</h3>
      <p className="muted">{children}</p>
      {!last && (
        <motion.span
          className="how-line"
          aria-hidden
          initial={{ scaleY: 0 }}
          whileInView={{ scaleY: 1 }}
          viewport={{ once: true, amount: 0.5 }}
          transition={{ duration: 0.7, delay: i * 0.12 + 0.35, ease: EASE }}
        />
      )}
    </Reveal>
  );
}

// Gate rows light up one square at a time when the tile scrolls into view: each policy is that many gates.
const gateVariants: Variants = {
  hidden: { opacity: 0.12, scale: 0.55 },
  shown: (delay: number) => ({ opacity: 0.85, scale: 1, transition: { delay, duration: 0.3, ease: EASE } }),
};

/** Each template's real gate count, one square per NAND gate. */
function GateCounts() {
  return (
    <motion.ul className="gates" aria-label="NAND gates per policy circuit" initial="hidden" whileInView="shown" viewport={{ once: true, amount: 0.6 }}>
      {TEMPLATES.map((t, row) => {
        const n = t.circuit().gates.length;
        return (
          <li key={t.id}>
            <span className="gates-name">{t.name}</span>
            <span className="gates-row" aria-hidden>
              {Array.from({ length: n }, (_, i) => (
                <motion.i key={i} variants={gateVariants} custom={0.25 + row * 0.12 + i * 0.035} />
              ))}
            </span>
            <span className="gates-n mono">{n} gates</span>
          </li>
        );
      })}
    </motion.ul>
  );
}

// --- the hero: try a request against a real policy circuit, simulated gate by gate in the browser ---

type Verdict = { kind: "allow" | "downgrade" | "deny"; served?: string };

function bitsToIndex(bits: boolean[]): number {
  return bits.reduce((n, b, i) => n | (Number(b) << i), 0);
}

export function decide(templateId: string, tier: Tier, size: Size, budgetOk: boolean, kill: boolean) {
  const t = TEMPLATES.find((x) => x.id === templateId)!;
  const netlist = t.circuit();
  const input = { tier, size, budgetOk, kill };
  const pins = inputPins(input);
  const out = simulate(netlist, pins);
  const allow = out[0]!;
  const routeTier = (Number(out[1]) | (Number(out[2]) << 1)) as Tier;
  const verdict: Verdict = !allow ? { kind: "deny" } : routeTier < tier ? { kind: "downgrade", served: TIER_NAMES[routeTier] } : { kind: "allow", served: TIER_NAMES[routeTier] };
  return { verdict, gates: netlist.gates.length, inBits: bitsToIndex(pins), outBits: bitsToIndex(out), circuitId: circuits[t.id]! };
}

function Segmented<T extends string | number>({ label, value, options, onChange, name }: { label: string; name: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <fieldset className="pg-field">
      <legend>{label}</legend>
      <div className="segmented">
        {options.map((o) => (
          <label key={String(o.value)} className={value === o.value ? "seg-on" : undefined}>
            <input type="radio" name={name} checked={value === o.value} onChange={() => onChange(o.value)} />
            {value === o.value && <motion.span className="seg-pill" layoutId={`${name}-pill`} transition={{ type: "spring", stiffness: 500, damping: 38 }} />}
            <span className="seg-label">{o.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

const GATE_STEP = 0.028; // seconds between gates in the sweep

function PolicyPlayground() {
  const [policy, setPolicy] = useState("cheap-only");
  const [tier, setTier] = useState<Tier>(3);
  const [size, setSize] = useState<Size>(1);
  const [budgetOk, setBudgetOk] = useState(true);
  const [kill, setKill] = useState(false);
  const r = useMemo(() => decide(policy, tier, size, budgetOk, kill), [policy, tier, size, budgetOk, kill]);
  const v = r.verdict;
  // Every change re-runs the circuit: the sweep replays across its gates, then the verdict lands.
  const run = `${policy}-${tier}-${size}-${budgetOk}-${kill}`;
  const sweep = r.gates * GATE_STEP;
  const label = v.kind === "allow" ? `Allowed as ${v.served}` : v.kind === "downgrade" ? `Downgraded to ${v.served}` : "Denied";

  return (
    <div className="playground" data-testid="playground">
      <div className="pg-head">
        <h2 className="pg-title">Try a request</h2>
        <p className="muted small">Runs the policy's real NAND netlist in your browser, gate by gate.</p>
      </div>
      <Segmented label="Policy" name="pg-policy" value={policy} onChange={setPolicy} options={TEMPLATES.map((t) => ({ value: t.id, label: t.name }))} />
      <Segmented label="Model requested" name="pg-tier" value={tier} onChange={setTier} options={TIER_NAMES.map((n, i) => ({ value: i as Tier, label: n }))} />
      <Segmented label="Request size" name="pg-size" value={size} onChange={setSize} options={SIZE_NAMES.map((n, i) => ({ value: i as Size, label: n }))} />
      <div className="pg-switches">
        <label className="switch">
          <input type="checkbox" checked={budgetOk} onChange={(e) => setBudgetOk(e.target.checked)} />
          <span className="switch-track" aria-hidden />
          Under today's cap
        </label>
        <label className="switch">
          <input type="checkbox" checked={kill} onChange={(e) => setKill(e.target.checked)} />
          <span className="switch-track" aria-hidden />
          Kill switch on
        </label>
      </div>
      <div className={`pg-verdict pg-${v.kind}`} data-testid="pg-verdict">
        <div className="pg-gates" key={run} aria-hidden>
          {Array.from({ length: r.gates }, (_, i) => (
            <motion.i
              key={i}
              initial={{ opacity: 0.15, scaleY: 0.5 }}
              animate={{ opacity: [0.15, 1, 0.5], scaleY: [0.5, 1, 1] }}
              transition={{ duration: 0.32, delay: i * GATE_STEP, times: [0, 0.4, 1], ease: "easeOut" }}
            />
          ))}
        </div>
        <span className="sr-only" aria-live="polite">
          {label}
        </span>
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.div
            key={run}
            className="pg-result"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0, transition: { delay: sweep * 0.8, duration: 0.35, ease: EASE } }}
            exit={{ opacity: 0, y: -6, transition: { duration: 0.12 } }}
            aria-hidden
          >
            <span className="pg-verdict-text">{label}</span>
            <span className="pg-trace mono">
              circuit #{r.circuitId.toString()}, {r.gates} gates: 0b{r.inBits.toString(2).padStart(6, "0")} → 0b{r.outBits.toString(2).padStart(3, "0")}
            </span>
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
