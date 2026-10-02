// JSON-lines logger that redacts secrets before anything is written.

const PATTERNS: [RegExp, string][] = [
  [/pr-live-[0-9a-zA-Z]+/g, "pr-live-[redacted]"],
  [/\bsk-[0-9a-zA-Z_-]{8,}/g, "sk-[redacted]"],
  [/Bearer\s+\S+/gi, "Bearer [redacted]"],
];

/** Removes the given secrets (provider keys, the router key) and anything shaped like an API key. */
export function redact(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const s of secrets) if (s) out = out.split(s).join("[redacted]");
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export function createLogger(secrets: readonly string[], sink: (line: string) => void = (l) => console.log(l)): Logger {
  const write = (level: string, msg: string, fields?: Record<string, unknown>) => {
    const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields }, (_k, v) =>
      typeof v === "bigint" ? v.toString() : v,
    );
    sink(redact(line, secrets));
  };
  return {
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
  };
}
