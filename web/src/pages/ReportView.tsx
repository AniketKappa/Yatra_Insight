import { useMemo } from "react";
import type { Metrics, Portfolio, ProgressReport } from "../../../server/types";
import { api } from "../lib/api";
import { useApi, useDocumentTitle } from "../lib/hooks";
import { Link, useRouter } from "../lib/router";
import { renderMarkdown } from "../lib/markdown";
import { fmtCr, fmtDate, fmtMonth, fmtPct } from "../lib/format";
import { ChartFrame, LineChart, SegmentedBar } from "../components/charts";
import { Empty, ErrorState, HEALTH_ORDER, HealthBadge, PageSkeleton, healthColor, useToast } from "../components/ui";
import { IconDownload, IconPrint, IconTrash, IconSpark } from "../components/Icons";

interface Report { id: number; scope: "portfolio" | "project"; project_id: number | null; title: string; as_of: string; body_md: string; data_json: string; generated_by: string; created_at: string }
type PortfolioData = { kind: "portfolio"; totals: Portfolio["totals"]; health: Portfolio["health"]; sCurve: Portfolio["sCurve"] };
type ProjectData = { kind: "project"; project: { id: number; code: string; name: string; state: string }; metrics: Metrics; reports: ProgressReport[]; plannedSeries: { month: string; plannedPct: number }[] };

export function ReportView({ id }: { id: number }) {
  const { data: r, error, loading, reload } = useApi<Report>(Number.isInteger(id) && id > 0 ? `/api/reports/${id}` : null);
  useDocumentTitle(r?.title ?? "Report");
  const { navigate } = useRouter();
  const toast = useToast();
  const data = useMemo(() => {
    try { return r ? (JSON.parse(r.data_json) as PortfolioData | ProjectData) : null; } catch { return null; }
  }, [r]);
  const html = useMemo(() => (r ? renderMarkdown(r.body_md) : ""), [r]);

  if (!Number.isInteger(id) || error?.status === 404) return <div className="page"><Empty title="Report not found" action={<Link to="/reports" className="btn btn-primary">See all reports</Link>}>It may have been deleted.</Empty></div>;
  if (error) return <div className="page"><ErrorState error={error} onRetry={reload} /></div>;
  if (loading || !r) return <div className="page"><PageSkeleton /></div>;

  const del = async () => {
    if (!window.confirm("Delete this report? This can't be undone.")) return;
    try {
      await api(`/api/reports/${r.id}`, { method: "DELETE" });
      toast("Report deleted.");
      navigate("/reports");
    } catch (e) {
      toast((e as Error).message, "err");
    }
  };

  return (
    <div className="page">
      <nav className="crumbs no-print" aria-label="Breadcrumb"><Link to="/reports">Reports</Link><span aria-hidden="true">/</span><span>#{r.id}</span></nav>
      <article className="report-doc stack">
        <header className="page-head" style={{ marginBottom: 0 }}>
          <div style={{ minWidth: 0, flex: "1 1 480px" }}>
            <p className="eyebrow">{r.scope === "portfolio" ? "Portfolio progress report" : "Project progress report"} · as of {fmtDate(r.as_of)}</p>
            <h1><span className="rise">{r.title.replace(/^(Portfolio|Project) progress report — /, "")}</span></h1>
            <p className="muted small row" style={{ marginTop: 8 }}>
              {/^(groq|claude)/.test(r.generated_by) ? <span className="badge badge-done"><IconSpark size={12} />Narrative by {r.generated_by.replace(/^\w+ \((.*)\)$/, "$1")}</span> : <span className="badge badge-neutral">Template narrative (offline)</span>}
              <span>Figures computed from monthly progress reports; generated {fmtDate(r.created_at.slice(0, 10))}.</span>
            </p>
          </div>
          <div className="row no-print">
            <button className="btn btn-secondary" onClick={() => window.print()}><IconPrint size={16} />Print / PDF</button>
            <a className="btn btn-secondary" href={`/api/reports/${r.id}/download`} download><IconDownload size={16} />Markdown</a>
            <button className="btn btn-danger btn-icon" onClick={del} aria-label="Delete report"><IconTrash size={16} /></button>
          </div>
        </header>

        {data?.kind === "portfolio" && (
          <div className="grid grid-2">
            <div className="card card-pad">
              <h2 style={{ fontSize: "0.9375rem", marginBottom: 12 }}>Health</h2>
              <SegmentedBar label="Projects by health" parts={HEALTH_ORDER.map((h) => ({ name: h, value: data.health[h], color: healthColor(h), ink: h === "At risk" ? "var(--on-warn)" : h === "Completed" ? "var(--bg)" : "var(--on-fill)" }))} />
              <div className="grid grid-2" style={{ marginTop: 16, gap: 12 }}>
                <div><p className="small muted">Physical progress</p><p className="kpi-value" style={{ fontSize: "1.5rem" }}>{fmtPct(data.totals.physicalPct)}</p><p className="small muted">planned {fmtPct(data.totals.plannedPct)}</p></div>
                <div><p className="small muted">Forecast overrun</p><p className="kpi-value" style={{ fontSize: "1.5rem" }}>{fmtCr(data.totals.forecastOverrunCr, 1)}</p><p className="small muted">{data.totals.overBudget} projects &gt; 5%</p></div>
              </div>
            </div>
            <div className="card card-pad">
              <ChartFrame title="Progress against plan" legend={[{ name: "Planned", color: "var(--planned)", kind: "line", dashed: true }, { name: "Actual", color: "var(--series-1)", kind: "line" }]}>
                <LineChart categories={data.sCurve.map((s) => s.month)} formatX={fmtMonth} unit="%" yMin={0} yMax={100} height={200}
                  series={[{ name: "Planned", values: data.sCurve.map((s) => s.plannedPct), color: "var(--planned)", dashed: true }, { name: "Actual", values: data.sCurve.map((s) => s.actualPct), color: "var(--series-1)" }]}
                  markerIndex={data.sCurve.findIndex((s) => s.month === r.as_of.slice(0, 7))} ariaLabel="Planned versus actual progress" />
              </ChartFrame>
            </div>
          </div>
        )}
        {data?.kind === "project" && (
          <div className="card card-pad">
            <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
              <div className="row"><HealthBadge health={data.metrics.health} /><span className="small muted">Risk {data.metrics.riskScore}/100 · {fmtPct(data.metrics.actualPct)} complete · <Link to={`/projects/${data.project.id}`} className="no-print">open project</Link></span></div>
            </div>
            {data.reports.length > 1 && (
              <ChartFrame legend={[{ name: "Planned", color: "var(--planned)", kind: "line", dashed: true }, { name: "Actual", color: "var(--series-1)", kind: "line" }]}>
                <LineChart categories={data.plannedSeries.map((s) => s.month)} formatX={fmtMonth} unit="%" yMin={0} yMax={100} height={200}
                  series={[{ name: "Planned", values: data.plannedSeries.map((s) => s.plannedPct), color: "var(--planned)", dashed: true }, { name: "Actual", values: data.plannedSeries.map((s) => data.reports.find((x) => x.month === s.month)?.physical_pct ?? null), color: "var(--series-1)" }]}
                  markerIndex={data.plannedSeries.findIndex((s) => s.month === r.as_of.slice(0, 7))} ariaLabel="Planned versus actual progress" />
              </ChartFrame>
            )}
          </div>
        )}

        <div className="card card-pad">
          <div className="md" dangerouslySetInnerHTML={{ __html: html }} />
        </div>
      </article>
    </div>
  );
}
