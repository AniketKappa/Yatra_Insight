import { useState } from "react";
import type { Artifact, ChartSpec, ProjectView } from "../../../server/types";
import { BarChart, ChartFrame, DataTable, LineChart, SERIES_COLORS } from "./charts";
import { HealthBadge, ProgressBar, RiskPill } from "./ui";
import { IconDatabase, IconDownload, IconChevronRight } from "./Icons";
import { Link } from "../lib/router";
import { fmtDays } from "../lib/format";

export function toCsv(columns: string[], rows: (string | number | null)[][]): string {
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/"/g, '""').replace(/^([=+\-@])/, "'$1")}"` : s;
  };
  return [columns, ...rows].map((r) => r.map(cell).join(",")).join("\r\n");
}

export function downloadText(filename: string, text: string, type = "text/csv;charset=utf-8") {
  const blob = new Blob(["﻿", text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "data";

export function SpecChart({ spec }: { spec: ChartSpec }) {
  const series = spec.series.map((s, i) => ({ name: s.name, values: s.values, color: SERIES_COLORS[i % SERIES_COLORS.length] }));
  const table = { columns: [spec.kind === "line" ? "Period" : "Category", ...spec.series.map((s) => s.name)], rows: spec.categories.map((c, i) => [c, ...spec.series.map((s) => s.values[i])]) };
  return (
    <ChartFrame title={spec.title} sub={spec.unit ? `Unit: ${spec.unit}` : undefined} legend={series.map((s) => ({ name: s.name, color: s.color, kind: spec.kind === "line" ? "line" : "rect" }))} table={table}>
      {spec.kind === "line" ? (
        <LineChart categories={spec.categories} series={series} unit={spec.unit} ariaLabel={spec.title} />
      ) : (
        <BarChart categories={spec.categories} series={series} unit={spec.unit} ariaLabel={spec.title} />
      )}
    </ChartFrame>
  );
}

function TableArtifact({ a }: { a: Extract<Artifact, { type: "table" }> }) {
  const [showSql, setShowSql] = useState(false);
  return (
    <div className="artifact">
      <div className="artifact-head">
        <h4>{a.title} <span className="muted" style={{ fontWeight: 400 }}>· {a.rows.length}{a.truncated ? "+" : ""} rows</span></h4>
        <div className="row">
          {a.sql && <button className="btn btn-ghost btn-sm" onClick={() => setShowSql((s) => !s)} aria-expanded={showSql}><IconDatabase size={14} />{showSql ? "Hide SQL" : "SQL"}</button>}
          <button className="btn btn-ghost btn-sm" onClick={() => downloadText(`${slug(a.title)}.csv`, toCsv(a.columns, a.rows))}><IconDownload size={14} />Download CSV</button>
        </div>
      </div>
      {showSql && a.sql && <pre className="sql-block">{a.sql}</pre>}
      <DataTable columns={a.columns} rows={a.rows} maxHeight={340} />
    </div>
  );
}

function ProjectCards({ ids, index }: { ids: number[]; index: Map<number, ProjectView> | null }) {
  const items = ids.map((id) => index?.get(id)).filter((v): v is ProjectView => Boolean(v));
  if (!items.length) return null;
  return (
    <div className="artifact">
      {items.map((v) => (
        <Link key={v.id} to={`/projects/${v.id}`} className="project-card">
          <div style={{ flex: "1 1 240px", minWidth: 0 }}>
            <span className="cell-title">{v.name}</span>
            <span className="cell-sub">{v.code} · {v.district}, {v.state}</span>
          </div>
          <HealthBadge health={v.metrics.health} />
          <div style={{ width: 120 }}>
            <ProgressBar actual={v.metrics.actualPct} planned={v.metrics.plannedPctToday} />
            <span className="cell-sub num">{v.metrics.actualPct}% · plan {v.metrics.plannedPctToday}%</span>
          </div>
          <span className="small muted">{v.metrics.health === "Completed" ? "Done" : fmtDays(v.metrics.delayDays)}</span>
          <RiskPill score={v.metrics.riskScore} level={v.metrics.riskLevel} />
          <IconChevronRight size={16} />
        </Link>
      ))}
    </div>
  );
}

export function ArtifactView({ artifact, index }: { artifact: Artifact; index: Map<number, ProjectView> | null }) {
  switch (artifact.type) {
    case "table": return <TableArtifact a={artifact} />;
    case "chart": return <div className="artifact card-pad"><SpecChart spec={artifact.spec} /></div>;
    case "projects": return <ProjectCards ids={artifact.ids} index={index} />;
    default: return null;
  }
}
