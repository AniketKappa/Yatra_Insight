// SVG charts with no dependency. Rules followed (dataviz skill): thin marks,
// 2px lines, 4px rounded bar ends square at the baseline, hairline solid grid,
// one axis only, legend for >= 2 series, text in ink tokens (never series
// colour), hover/focus tooltips that never gate (table view always available).

import { useMemo, useState, type ReactNode } from "react";
import { useElementWidth } from "../lib/hooks";
import { IconChart, IconTable } from "./Icons";

export interface Series {
  name: string;
  values: (number | null)[];
  color: string;
  dashed?: boolean;
  area?: boolean;
}

export const SERIES_COLORS = ["var(--series-1)", "var(--series-2)", "var(--series-3)", "var(--series-4)"];

function niceTicks(min: number, max: number, count = 4): number[] {
  if (min === max) max = min + 1;
  const span = max - min;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count + 0.5) ?? 10 * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const out: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

const fmtTick = (v: number) => (Math.abs(v) >= 10000 ? `${Math.round(v / 1000)}K` : v.toLocaleString("en-IN", { maximumFractionDigits: 1 }));

// ---- Frame: title, legend, chart/table toggle ----------------------------------------

export function ChartFrame({ title, sub, legend, children, table, actions }: { title?: ReactNode; sub?: ReactNode; legend?: { name: string; color: string; kind?: "line" | "rect"; dashed?: boolean }[]; children: ReactNode; table?: { columns: string[]; rows: (string | number | null)[][] }; actions?: ReactNode }) {
  const [view, setView] = useState<"chart" | "table">("chart");
  return (
    <div className="stack" style={{ gap: 12 }}>
      {(title || table || actions) && (
        <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            {title && <h3 style={{ fontSize: "0.9375rem" }}>{title}</h3>}
            {sub && <p className="muted small" style={{ marginTop: 2 }}>{sub}</p>}
          </div>
          <div className="row">
            {actions}
            {table && (
              <div className="view-toggle" role="group" aria-label="Chart or table view">
                <button aria-pressed={view === "chart"} onClick={() => setView("chart")} title="Chart view"><IconChart size={14} /><span className="visually-hidden">Chart</span></button>
                <button aria-pressed={view === "table"} onClick={() => setView("table")} title="Table view"><IconTable size={14} /><span className="visually-hidden">Table</span></button>
              </div>
            )}
          </div>
        </div>
      )}
      {legend && legend.length > 1 && view === "chart" && (
        <div className="legend" aria-hidden="true">
          {legend.map((l) => (
            <span className="legend-item" key={l.name}>
              {l.kind === "line" ? <i className={`legend-line ${l.dashed ? "dashed" : ""}`} style={{ background: l.color, color: l.color }} /> : <i className="legend-swatch" style={{ background: l.color }} />}
              {l.name}
            </span>
          ))}
        </div>
      )}
      {view === "table" && table ? <DataTable columns={table.columns} rows={table.rows} /> : children}
    </div>
  );
}

export function DataTable({ columns, rows, maxHeight = 320 }: { columns: string[]; rows: (string | number | null)[][]; maxHeight?: number }) {
  return (
    <div className="table-wrap" style={{ maxHeight, overflowY: "auto" }}>
      <table className="table">
        <thead><tr>{columns.map((c, i) => <th key={i} className={i > 0 && typeof rows[0]?.[i] === "number" ? "r" : ""} scope="col">{c}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>{r.map((v, j) => <td key={j} className={typeof v === "number" ? "r" : ""}>{v === null || v === undefined || v === "" ? "—" : typeof v === "number" ? v.toLocaleString("en-IN", { maximumFractionDigits: 2 }) : v}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---- Line chart ------------------------------------------------------------------------

export function LineChart({ categories, series, height = 260, unit = "", yMin, yMax, formatX = (s) => s, markerIndex, markerLabel = "Today", ariaLabel }: {
  categories: string[];
  series: Series[];
  height?: number;
  unit?: string;
  yMin?: number;
  yMax?: number;
  formatX?: (s: string) => string;
  markerIndex?: number;
  markerLabel?: string;
  ariaLabel: string;
}) {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const pad = { l: 44, r: 16, t: 12, b: 28 };
  const w = Math.max(240, width);
  const plotW = w - pad.l - pad.r;
  const plotH = height - pad.t - pad.b;
  const n = categories.length;

  const { ticks, lo, hi } = useMemo(() => {
    const vals = series.flatMap((s) => s.values.filter((v): v is number => v !== null && Number.isFinite(v)));
    const mn = yMin ?? Math.min(0, ...vals);
    const mx = yMax ?? Math.max(1, ...vals);
    const t = yMax !== undefined && yMin !== undefined ? niceTicks(yMin, yMax, 4) : niceTicks(mn, mx, 4);
    return { ticks: t, lo: t[0], hi: t[t.length - 1] };
  }, [series, yMin, yMax]);

  const x = (i: number) => pad.l + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const y = (v: number) => pad.t + plotH - ((v - lo) / (hi - lo || 1)) * plotH;

  const paths = series.map((s) => {
    let d = "";
    let area = "";
    let seg: [number, number][] = [];
    const flush = () => {
      if (seg.length) {
        d += seg.map(([a, b], k) => `${k ? "L" : "M"}${a.toFixed(1)},${b.toFixed(1)}`).join("");
        if (s.area && seg.length > 1) area += `M${seg[0][0]},${y(Math.max(lo, 0))}` + seg.map(([a, b]) => `L${a.toFixed(1)},${b.toFixed(1)}`).join("") + `L${seg[seg.length - 1][0]},${y(Math.max(lo, 0))}Z`;
      }
      seg = [];
    };
    s.values.forEach((v, i) => (v === null || !Number.isFinite(v) ? flush() : seg.push([x(i), y(v)])));
    flush();
    return { d, area };
  });

  const labelEvery = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / 64))));
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * w;
    const i = Math.round(((px - pad.l) / plotW) * (n - 1));
    setHover(Math.min(n - 1, Math.max(0, i)));
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowRight") { setHover((h) => Math.min(n - 1, (h ?? -1) + 1)); e.preventDefault(); }
    if (e.key === "ArrowLeft") { setHover((h) => Math.max(0, (h ?? n) - 1)); e.preventDefault(); }
    if (e.key === "Escape") setHover(null);
  };
  const last = (s: Series) => { for (let i = s.values.length - 1; i >= 0; i--) if (s.values[i] !== null) return i; return -1; };

  return (
    <div className="chart" ref={ref}>
      {width > 0 && (
        <svg viewBox={`0 0 ${w} ${height}`} height={height} role="img" aria-label={ariaLabel} tabIndex={0}
          onPointerMove={onMove} onPointerLeave={() => setHover(null)} onKeyDown={onKey} onBlur={() => setHover(null)} style={{ touchAction: "pan-y" }}>
          {ticks.map((t) => (
            <g key={t}>
              <line className="grid-line" x1={pad.l} x2={w - pad.r} y1={y(t)} y2={y(t)} />
              <text x={pad.l - 8} y={y(t)} dy="0.32em" textAnchor="end">{fmtTick(t)}{unit === "%" ? "%" : ""}</text>
            </g>
          ))}
          <line className="axis-line" x1={pad.l} x2={w - pad.r} y1={y(Math.max(lo, 0))} y2={y(Math.max(lo, 0))} />
          {categories.map((c, i) => (i % labelEvery === 0 || i === n - 1) && (i === n - 1 || n - 1 - i >= labelEvery * 0.95) ? (
            <text key={c + i} x={x(i)} y={height - 8} textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}>{formatX(c)}</text>
          ) : null)}
          {markerIndex !== undefined && markerIndex >= 0 && markerIndex < n && (
            <g>
              <line className="today-line" x1={x(markerIndex)} x2={x(markerIndex)} y1={pad.t} y2={pad.t + plotH} />
              <text x={x(markerIndex) + 4} y={pad.t + 10} style={{ fontSize: 10, fontWeight: 600 }}>{markerLabel}</text>
            </g>
          )}
          {series.map((s, k) => paths[k].area && <path key={`a${k}`} d={paths[k].area} fill={s.color} opacity={0.1} />)}
          {series.map((s, k) => (
            <path key={k} d={paths[k].d} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" strokeDasharray={s.dashed ? "5 4" : undefined} />
          ))}
          {series.map((s, k) => {
            const i = last(s);
            return i >= 0 && !s.dashed ? <circle key={`e${k}`} cx={x(i)} cy={y(s.values[i]!)} r={4} fill={s.color} stroke="var(--surface)" strokeWidth={2} /> : null;
          })}
          {hover !== null && (
            <g>
              <line className="crosshair" x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + plotH} />
              {series.map((s, k) => s.values[hover] !== null && s.values[hover] !== undefined ? (
                <circle key={k} cx={x(hover)} cy={y(s.values[hover]!)} r={4.5} fill={s.color} stroke="var(--surface)" strokeWidth={2} />
              ) : null)}
            </g>
          )}
        </svg>
      )}
      {hover !== null && width > 0 && (
        <div className="chart-tooltip" style={{ left: `${(x(hover) / w) * 100}%`, top: pad.t + 4 }}>
          <div className="tt-title">{formatX(categories[hover])}</div>
          {series.map((s) => (
            <div className="tt-row" key={s.name}>
              <span className="tt-key"><i style={{ background: s.color }} />{s.name}</span>
              <span className="tt-val">{s.values[hover] === null || s.values[hover] === undefined ? "—" : `${s.values[hover]!.toLocaleString("en-IN", { maximumFractionDigits: 2 })}${unit === "%" ? "%" : unit ? ` ${unit}` : ""}`}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Horizontal bar chart -----------------------------------------------------------------

export function BarChart({ categories, series, unit = "", ariaLabel, onSelect, maxLabel = 150 }: {
  categories: string[];
  series: Series[];
  unit?: string;
  ariaLabel: string;
  onSelect?: (index: number) => void;
  maxLabel?: number;
}) {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const [hover, setHover] = useState<{ i: number; k: number } | null>(null);
  const bar = series.length > 1 ? 10 : 14;
  const band = series.length * (bar + 2) + 12;
  const labelW = Math.min(maxLabel, Math.max(80, width * 0.32));
  const pad = { l: labelW + 12, r: 56, t: 4, b: 22 };
  const w = Math.max(260, width);
  const plotW = w - pad.l - pad.r;
  const height = pad.t + categories.length * band + pad.b;

  const vals = series.flatMap((s) => s.values.filter((v): v is number => v !== null && Number.isFinite(v)));
  const ticks = niceTicks(Math.min(0, ...vals), Math.max(1, ...vals), Math.max(2, Math.min(5, Math.floor(plotW / 90))));
  const lo = ticks[0];
  const hi = ticks[ticks.length - 1];
  const xs = (v: number) => pad.l + ((v - lo) / (hi - lo || 1)) * plotW;
  const zero = xs(0);
  const fmtVal = (v: number) => `${v.toLocaleString("en-IN", { maximumFractionDigits: Math.abs(v) >= 100 ? 0 : 1 })}${unit === "%" ? "%" : ""}`;
  const truncate = (s: string) => {
    const maxChars = Math.floor(labelW / 6.6);
    return s.length > maxChars ? `${s.slice(0, maxChars - 1)}…` : s;
  };

  return (
    <div className="chart" ref={ref}>
      {width > 0 && (
        <svg viewBox={`0 0 ${w} ${height}`} height={height} role="img" aria-label={ariaLabel}>
          {ticks.map((t) => (
            <g key={t}>
              <line className="grid-line" x1={xs(t)} x2={xs(t)} y1={pad.t} y2={height - pad.b} />
              <text x={xs(t)} y={height - 6} textAnchor="middle">{fmtTick(t)}</text>
            </g>
          ))}
          {categories.map((c, i) => {
            const top = pad.t + i * band + 6;
            return (
              <g key={c + i}>
                <text className="cat-label" x={pad.l - 10} y={top + (series.length * (bar + 2)) / 2} dy="0.32em" textAnchor="end">
                  <title>{c}</title>{truncate(c)}
                </text>
                {series.map((s, k) => {
                  const v = s.values[i];
                  if (v === null || v === undefined) return null;
                  const yTop = top + k * (bar + 2);
                  const x0 = Math.min(zero, xs(v));
                  const bw = Math.max(1, Math.abs(xs(v) - zero));
                  const r = Math.min(4, bw / 2);
                  const pos = v >= 0;
                  // Rounded data-end, square at the baseline.
                  const d = pos
                    ? `M${x0},${yTop}H${x0 + bw - r}Q${x0 + bw},${yTop} ${x0 + bw},${yTop + r}V${yTop + bar - r}Q${x0 + bw},${yTop + bar} ${x0 + bw - r},${yTop + bar}H${x0}Z`
                    : `M${x0 + bw},${yTop}H${x0 + r}Q${x0},${yTop} ${x0},${yTop + r}V${yTop + bar - r}Q${x0},${yTop + bar} ${x0 + r},${yTop + bar}H${x0 + bw}Z`;
                  const active = hover?.i === i && hover.k === k;
                  return (
                    <g key={k}>
                      <path d={d} fill={s.color} opacity={hover && !active ? 0.55 : 1} />
                      <text className="bar-label" x={pos ? x0 + bw + 6 : x0 - 6} y={yTop + bar / 2} dy="0.32em" textAnchor={pos ? "start" : "end"}>{fmtVal(v)}</text>
                      <rect x={pad.l - labelW} y={yTop - 1} width={w - pad.r + 40 - (pad.l - labelW)} height={bar + 2} fill="transparent"
                        tabIndex={0} role="button" aria-label={`${c}, ${s.name}: ${fmtVal(v)}${unit && unit !== "%" ? ` ${unit}` : ""}`}
                        style={{ cursor: onSelect ? "pointer" : "default", outline: "none" }}
                        onPointerEnter={() => setHover({ i, k })} onPointerLeave={() => setHover(null)}
                        onFocus={() => setHover({ i, k })} onBlur={() => setHover(null)}
                        onClick={() => onSelect?.(i)} onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && onSelect) { e.preventDefault(); onSelect(i); } }} />
                    </g>
                  );
                })}
              </g>
            );
          })}
          {lo < 0 && <line className="axis-line" x1={zero} x2={zero} y1={pad.t} y2={height - pad.b} />}
        </svg>
      )}
      {hover && width > 0 && series[hover.k].values[hover.i] !== null && (
        <div className="chart-tooltip" style={{ left: `${(Math.max(zero, xs(series[hover.k].values[hover.i]!)) / w) * 100}%`, top: pad.t + hover.i * band + hover.k * (bar + 2) + 6 }}>
          <div className="tt-title">{categories[hover.i]}</div>
          {series.map((s) => (
            <div className="tt-row" key={s.name}>
              <span className="tt-key"><i style={{ background: s.color }} />{s.name}</span>
              <span className="tt-val">{s.values[hover.i] === null ? "—" : `${fmtVal(s.values[hover.i]!)}${unit && unit !== "%" ? ` ${unit}` : ""}`}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Segmented bar (one whole split into parts) ----------------------------------------------

export function SegmentedBar({ parts, onSelect, label }: { parts: { name: string; value: number; color: string; ink?: string }[]; onSelect?: (name: string) => void; label: string }) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  const [ref, width] = useElementWidth<HTMLDivElement>();
  if (!total) return <p className="muted small">No data.</p>;
  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="seg-bar" ref={ref} role="group" aria-label={label}>
        {parts.filter((p) => p.value > 0).map((p) => {
          const pct = (p.value / total) * 100;
          const fits = (pct / 100) * width > 34;
          return (
            <button key={p.name} style={{ flexGrow: p.value, flexBasis: 0, background: p.color, color: p.ink ?? "var(--on-fill)" }}
              aria-label={`${p.name}: ${p.value} (${Math.round(pct)}%)`} title={`${p.name}: ${p.value} (${Math.round(pct)}%)`}
              onClick={() => onSelect?.(p.name)}>
              {fits ? p.value : ""}
            </button>
          );
        })}
      </div>
      <div className="legend">
        {parts.map((p) => (
          <span className="legend-item" key={p.name}><i className="legend-swatch" style={{ background: p.color }} />{p.name} <span className="muted num">{p.value}</span></span>
        ))}
      </div>
    </div>
  );
}
