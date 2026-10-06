// Small SVG charts for the agent dashboard: decisions over time (stacked bars), spend over time
// (line), and spend by model (horizontal bars). No chart library; every chart has a hover/focus
// tooltip, and every value is also in the receipts table or the chart's data table.

import { useEffect, useRef, useState, type KeyboardEvent } from "react";

export const DECISION_COLOR = { allowed: "var(--series-allowed)", downgraded: "var(--series-downgraded)", denied: "var(--series-denied)" } as const;
export const DECISIONS = ["allowed", "downgraded", "denied"] as const;
const DECISION_LABEL = { allowed: "Allowed", downgraded: "Downgraded", denied: "Denied" } as const;

const PAD = { top: 12, right: 12, bottom: 26, left: 52 };
const GAP = 2; // surface gap between adjacent bars and stacked segments

/** Tracks an element's width so the SVG draws at real pixels (crisp text, no stretching). */
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(600);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(240, Math.floor(e!.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

/** A round axis maximum and its ticks: 0, max/2, max. */
function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

/** A bar or the top of a stack: rounded 4px at the data end only, square on the baseline side. */
function barPath(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

export const fmtCompact = (n: number) => new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);

export function bucketLabel(start: number, bucketMs: number, long = false): string {
  const d = new Date(start);
  const iso = d.toISOString();
  if (bucketMs < 86_400_000) return long ? `${iso.slice(5, 10)} ${iso.slice(11, 16)} UTC` : iso.slice(11, 16);
  return long ? `${d.toLocaleDateString("en", { month: "short", day: "numeric", timeZone: "UTC" })} (UTC)` : d.toLocaleDateString("en", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** Which x positions get a tick label: about one every 90px, always the last. */
function labelEvery(count: number, plotWidth: number): number {
  return Math.max(1, Math.ceil(count / Math.max(1, Math.floor(plotWidth / 90))));
}

/** Sits beside the hovered position (right of it, or left past the middle) so it never covers the mark. */
function Tooltip({ x, width, children }: { x: number; width: number; children: React.ReactNode }) {
  const side = x > width / 2 ? { right: width - x + 14 } : { left: x + 14 };
  return (
    <div className="viz-tooltip" style={side} role="presentation">
      {children}
    </div>
  );
}

/** Arrow keys move the highlighted position; Escape clears it. */
function useKeyboardIndex(count: number, hover: number | undefined, setHover: (i: number | undefined) => void) {
  return (e: KeyboardEvent) => {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const step = e.key === "ArrowRight" ? 1 : -1;
      setHover(Math.min(count - 1, Math.max(0, (hover ?? (step > 0 ? -1 : count)) + step)));
    } else if (e.key === "Escape") setHover(undefined);
  };
}

export interface DecisionPoint {
  start: number;
  allowed: number;
  downgraded: number;
  denied: number;
}

/** Requests per bucket, stacked allowed → downgraded → denied. */
export function DecisionChart({ data, bucketMs, height = 220 }: { data: DecisionPoint[]; bucketMs: number; height?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number>();
  const onKey = useKeyboardIndex(data.length, hover, setHover);

  const plotW = width - PAD.left - PAD.right;
  const plotH = height - PAD.top - PAD.bottom;
  const total = data.reduce((s, d) => s + d.allowed + d.downgraded + d.denied, 0);
  const max = niceMax(Math.max(0, ...data.map((d) => d.allowed + d.downgraded + d.denied)));
  const band = plotW / Math.max(1, data.length);
  const barW = Math.max(2, Math.min(28, band - GAP));
  const y = (v: number) => PAD.top + plotH - (v / max) * plotH;
  const every = labelEvery(data.length, plotW);
  const h = hover === undefined ? undefined : data[hover];

  return (
    <div className="viz" ref={ref}>
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={`Requests per ${bucketMs < 86_400_000 ? "hour" : "day"}: allowed, downgraded and denied. Use the arrow keys to read each bar.`}
        tabIndex={0}
        onKeyDown={onKey}
        onBlur={() => setHover(undefined)}
        onPointerLeave={() => setHover(undefined)}
      >
        {(total === 0 ? [0] : [0, max / 2, max].filter(Number.isInteger)).map((t) => (
          <g key={t}>
            <line className="viz-grid" x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} />
            <text className="viz-tick" x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end">
              {fmtCompact(t)}
            </text>
          </g>
        ))}
        {data.map((d, i) => {
          const x = PAD.left + i * band + (band - barW) / 2;
          let base = 0;
          const top = DECISIONS.filter((k) => d[k] > 0).at(-1);
          return (
            <g key={d.start} className={hover === i ? "viz-hovered" : undefined}>
              {DECISIONS.map((k) => {
                if (d[k] === 0) return null;
                const y0 = y(base);
                base += d[k];
                const y1 = y(base);
                const segH = Math.max(1, y0 - y1 - (base === d[k] ? 0 : GAP));
                return k === top ? (
                  <path key={k} d={barPath(x, y1, barW, segH, 4)} fill={DECISION_COLOR[k]} />
                ) : (
                  <rect key={k} x={x} y={y1} width={barW} height={segH} fill={DECISION_COLOR[k]} />
                );
              })}
              <rect className="viz-hit" x={PAD.left + i * band} y={PAD.top} width={band} height={plotH} onPointerEnter={() => setHover(i)} />
            </g>
          );
        })}
        <line className="viz-axis" x1={PAD.left} x2={width - PAD.right} y1={y(0)} y2={y(0)} />
        {data.map((d, i) =>
          (data.length - 1 - i) % every === 0 ? (
            <text key={d.start} className="viz-tick" x={PAD.left + i * band + band / 2} y={height - 8} textAnchor="middle">
              {bucketLabel(d.start, bucketMs)}
            </text>
          ) : null,
        )}
        {total === 0 && <EmptyText x={PAD.left + plotW / 2} y={PAD.top + plotH / 2} text="No requests in this range yet" />}
      </svg>
      {h && (
        <Tooltip x={PAD.left + hover! * band + band / 2} width={width}>
          <div className="viz-tooltip-title">{bucketLabel(h.start, bucketMs, true)}</div>
          {DECISIONS.map((k) => (
            <div key={k} className="viz-tooltip-row">
              <span className="viz-key-line" style={{ background: DECISION_COLOR[k] }} />
              <strong>{h[k]}</strong>
              <span className="muted">{DECISION_LABEL[k]}</span>
            </div>
          ))}
        </Tooltip>
      )}
    </div>
  );
}

/** One measure over time as a 2px line over a light area, with a crosshair tooltip. */
export function LineChart({
  data,
  bucketMs,
  format,
  label,
  height = 200,
}: {
  data: { start: number; value: number }[];
  bucketMs: number;
  format: (v: number) => string;
  label: string;
  height?: number;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number>();
  const onKey = useKeyboardIndex(data.length, hover, setHover);

  const plotW = width - PAD.left - PAD.right;
  const plotH = height - PAD.top - PAD.bottom;
  const max = niceMax(Math.max(0, ...data.map((d) => d.value)));
  const x = (i: number) => PAD.left + (data.length <= 1 ? plotW / 2 : (i / (data.length - 1)) * plotW);
  const y = (v: number) => PAD.top + plotH - (v / max) * plotH;
  const line = data.map((d, i) => `${i ? "L" : "M"}${x(i)},${y(d.value)}`).join("");
  const area = data.length ? `${line}L${x(data.length - 1)},${y(0)}L${x(0)},${y(0)}Z` : "";
  const every = labelEvery(data.length, plotW);
  const h = hover === undefined ? undefined : data[hover];
  const empty = data.every((d) => d.value === 0);

  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    const box = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - box.left - PAD.left;
    setHover(Math.min(data.length - 1, Math.max(0, Math.round((px / plotW) * (data.length - 1)))));
  }

  return (
    <div className="viz" ref={ref}>
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={`${label}. Use the arrow keys to read each point.`}
        tabIndex={0}
        onKeyDown={onKey}
        onBlur={() => setHover(undefined)}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(undefined)}
      >
        {(empty ? [0] : [0, max / 2, max]).map((t) => (
          <g key={t}>
            <line className="viz-grid" x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} />
            <text className="viz-tick" x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end">
              {format(t)}
            </text>
          </g>
        ))}
        <path d={area} className="viz-area" />
        <path d={line} className="viz-line" />
        <line className="viz-axis" x1={PAD.left} x2={width - PAD.right} y1={y(0)} y2={y(0)} />
        {data.map((d, i) =>
          (data.length - 1 - i) % every === 0 ? (
            <text key={d.start} className="viz-tick" x={x(i)} y={height - 8} textAnchor="middle">
              {bucketLabel(d.start, bucketMs)}
            </text>
          ) : null,
        )}
        {empty && <EmptyText x={PAD.left + plotW / 2} y={PAD.top + plotH / 2} text="No spend in this range yet" />}
        {h && (
          <>
            <line className="viz-crosshair" x1={x(hover!)} x2={x(hover!)} y1={PAD.top} y2={y(0)} />
            <circle className="viz-dot" cx={x(hover!)} cy={y(h.value)} r={4} />
          </>
        )}
      </svg>
      {h && (
        <Tooltip x={x(hover!)} width={width}>
          <div className="viz-tooltip-title">{bucketLabel(h.start, bucketMs, true)}</div>
          <div className="viz-tooltip-row">
            <span className="viz-key-line" style={{ background: "var(--series-spend)" }} />
            <strong>{format(h.value)}</strong>
          </div>
        </Tooltip>
      )}
    </div>
  );
}

/** Horizontal bars, one per row, each labeled directly with its value. */
export function BarList({ rows, format }: { rows: { label: string; value: number; detail: string }[]; format: (v: number) => string }) {
  const max = Math.max(0, ...rows.map((r) => r.value)) || 1;
  return (
    <ul className="barlist">
      {rows.map((r) => (
        <li key={r.label} tabIndex={0} title={`${r.label}: ${format(r.value)} · ${r.detail}`}>
          <span className="barlist-label">{r.label}</span>
          <span className="barlist-track">
            <span className="barlist-fill" style={{ width: `${Math.max(1, (r.value / max) * 100)}%` }} />
          </span>
          <span className="barlist-value">
            <strong>{format(r.value)}</strong> <span className="muted small">{r.detail}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function EmptyText({ x, y, text }: { x: number; y: number; text: string }) {
  return (
    <text className="viz-empty" x={x} y={y} textAnchor="middle" dy="0.32em">
      {text}
    </text>
  );
}

export function Legend({ items }: { items: { color: string; label: string; value?: string }[] }) {
  return (
    <ul className="viz-legend">
      {items.map((i) => (
        <li key={i.label}>
          <span className="viz-key-rect" style={{ background: i.color }} />
          {i.label}
          {i.value !== undefined && <strong>{i.value}</strong>}
        </li>
      ))}
    </ul>
  );
}
