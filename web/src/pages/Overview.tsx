import { useState } from "react";
import type { Health, Portfolio } from "../../../server/types";
import { useApi, useDocumentTitle } from "../lib/hooks";
import { Link, useRouter } from "../lib/router";
import { useStore } from "../lib/store";
import { fmtCr, fmtCrCompact, fmtDate, fmtDays, fmtMonth, fmtPct, plural } from "../lib/format";
import { BarChart, ChartFrame, LineChart, SegmentedBar } from "../components/charts";
import { Card, Empty, ErrorState, HEALTH_ORDER, HealthBadge, PageSkeleton, ProgressBar, RiskPill, SeverityBadge, healthColor } from "../components/ui";
import { IconArrowRight, IconCalendar, IconSpark, IconChevronRight, IconCheckCircle } from "../components/Icons";

export const SUGGESTIONS = [
  "Which projects are delayed by more than 90 days?",
  "Show cost overruns above 15%",
  "Which works have stalled and why?",
  "Milestones due in the next 30 days",
  "Compare states by risk",
  "What corrective measures do the top 3 risky projects need?",
];

export function FilterRow({ value, onChange, showHealth = false, showSearch = false }: { value: Record<string, string>; onChange: (v: Record<string, string>) => void; showHealth?: boolean; showSearch?: boolean }) {
  const { meta } = useStore();
  const set = (k: string, v: string) => onChange({ ...value, [k]: v });
  const active = Object.values(value).some(Boolean);
  return (
    <div className="filters" role="search" aria-label="Filter projects">
      {showSearch && (
        <div className="input-wrap input-search" style={{ flex: "2 1 220px", maxWidth: 320 }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
          <input className="input" type="search" placeholder="Search name, code, district…" aria-label="Search projects" value={value.q ?? ""} onChange={(e) => set("q", e.target.value)} style={{ minHeight: 36, fontSize: "0.875rem" }} />
        </div>
      )}
      <select className="select" aria-label="State" value={value.state ?? ""} onChange={(e) => set("state", e.target.value)}>
        <option value="">All states</option>
        {meta?.states.map((s) => <option key={s}>{s}</option>)}
      </select>
      <select className="select" aria-label="Scheme" value={value.scheme ?? ""} onChange={(e) => set("scheme", e.target.value)}>
        <option value="">All schemes</option>
        {meta?.schemes.map((s) => <option key={s}>{s}</option>)}
      </select>
      <select className="select" aria-label="Category" value={value.category ?? ""} onChange={(e) => set("category", e.target.value)}>
        <option value="">All categories</option>
        {meta?.categories.map((s) => <option key={s}>{s}</option>)}
      </select>
      {showHealth && (
        <select className="select" aria-label="Health" value={value.health ?? ""} onChange={(e) => set("health", e.target.value)}>
          <option value="">Any health</option>
          {HEALTH_ORDER.map((h) => <option key={h}>{h}</option>)}
        </select>
      )}
      {active && <button className="btn btn-ghost btn-sm" onClick={() => onChange({})}>Clear filters</button>}
    </div>
  );
}

export function useUrlFilters(keys: string[]): [Record<string, string>, (v: Record<string, string>) => void] {
  const { search, path, navigate } = useRouter();
  const value: Record<string, string> = {};
  for (const k of keys) {
    const v = search.get(k);
    if (v) value[k] = v;
  }
  const set = (v: Record<string, string>) => {
    const qs = new URLSearchParams(Object.entries(v).filter(([, x]) => x)).toString();
    navigate(`${path}${qs ? `?${qs}` : ""}`, { replace: true });
  };
  return [value, set];
}

export function AskHero({ compact = false }: { compact?: boolean }) {
  const { navigate } = useRouter();
  const { health } = useStore();
  const [q, setQ] = useState("");
  const go = (question: string) => {
    const t = question.trim();
    if (!t) return;
    navigate(`/assistant?q=${encodeURIComponent(t)}`);
  };
  return (
    <section className="ask-hero" aria-labelledby="ask-h">
      <div className="row" style={{ gap: 8 }}>
        <span className="badge badge-done"><IconSpark size={14} />{health?.llm.configured ? "Groq" : "Offline mode"}</span>
        <h2 id="ask-h" style={{ fontSize: "var(--t-h3)" }}>Ask about your projects in plain language</h2>
      </div>
      {!compact && <p className="muted" style={{ marginTop: 8, maxWidth: "70ch" }}>Delays, cost overruns, stalled works, upcoming milestones, fund utilisation — answered from live project data, with corrective actions.</p>}
      <form className="ask-form" onSubmit={(e) => { e.preventDefault(); go(q); }}>
        <label className="ask-input-wrap">
          <span className="visually-hidden">Your question</span>
          <IconSpark size={18} />
          <input className="ask-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. Which pilgrimage projects in Uttar Pradesh are behind schedule?" maxLength={2000} />
        </label>
        <button className="btn btn-primary" type="submit" disabled={!q.trim()}>Get an answer<IconArrowRight size={16} /></button>
      </form>
      <div className="suggestions" aria-label="Suggested questions">
        {SUGGESTIONS.slice(0, compact ? 4 : 6).map((s) => <button key={s} className="chip" onClick={() => go(s)}>{s}</button>)}
      </div>
    </section>
  );
}

export function Overview() {
  useDocumentTitle("Overview");
  const [filters, setFilters] = useUrlFilters(["state", "scheme", "category"]);
  const qs = new URLSearchParams(filters).toString();
  const { data: p, error, loading, refreshing, reload } = useApi<Portfolio>(`/api/portfolio${qs ? `?${qs}` : ""}`);
  const { navigate } = useRouter();

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <p className="eyebrow">Portfolio overview</p>
          <h1><span className="rise">Tourism projects at a glance</span></h1>
          <p className="lede">{p ? <>As of {fmtDate(p.asOf)} · {plural(p.totals.projects, "project")} · {fmtCr(p.totals.budgetCr, 0)} approved</> : "Loading the latest figures…"}</p>
        </div>
        <Link to="/reports" className="btn btn-secondary">Generate progress report</Link>
      </div>
      <FilterRow value={filters} onChange={setFilters} />
      {error && <ErrorState error={error} onRetry={reload} />}
      {loading && <PageSkeleton />}
      {p && p.totals.projects === 0 && (
        <Empty title="No projects match these filters" action={<button className="btn btn-secondary" onClick={() => setFilters({})}>Clear filters</button>}>Try a different state, scheme or category.</Empty>
      )}
      {p && p.totals.projects > 0 && (
        <div className={`stack ${refreshing ? "refetching" : ""}`}>
          <AskHero />
          <Kpis p={p} />
          <div className="grid grid-main">
            <div className="stack">
              <Card title="Progress against plan" sub="Budget-weighted physical progress across the portfolio">
                <ChartFrame legend={[{ name: "Planned", color: "var(--planned)", kind: "line", dashed: true }, { name: "Actual", color: "var(--series-1)", kind: "line" }]}
                  table={{ columns: ["Month", "Planned %", "Actual %"], rows: p.sCurve.map((s) => [s.month, s.plannedPct, s.actualPct]) }}>
                  <LineChart categories={p.sCurve.map((s) => s.month)} formatX={fmtMonth} unit="%" yMin={0} yMax={100}
                    series={[{ name: "Planned", values: p.sCurve.map((s) => s.plannedPct), color: "var(--planned)", dashed: true }, { name: "Actual", values: p.sCurve.map((s) => s.actualPct), color: "var(--series-1)", area: true }]}
                    markerIndex={p.sCurve.findIndex((s) => s.month === p.asOf.slice(0, 7))} ariaLabel="Portfolio planned versus actual physical progress by month" />
                </ChartFrame>
              </Card>
              <StateCard p={p} onPick={(state) => setFilters({ ...filters, state })} />
              <AlertsCard p={p} />
            </div>
            <div className="stack">
              <Card title="Projects by health" sub="Click a segment to see those projects">
                <SegmentedBar label="Projects by health" onSelect={(h) => navigate(`/projects?health=${encodeURIComponent(h)}${filters.state ? `&state=${encodeURIComponent(filters.state)}` : ""}`)}
                  parts={HEALTH_ORDER.map((h) => ({ name: h, value: p.health[h], color: healthColor(h), ink: h === "At risk" ? "var(--on-warn)" : h === "Completed" ? "var(--bg)" : "var(--on-fill)" }))} />
              </Card>
              <AttentionCard p={p} />
              <MilestonesCard p={p} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Kpis({ p }: { p: Portfolio }) {
  const t = p.totals;
  const gap = Math.round((t.physicalPct - t.plannedPct) * 10) / 10;
  return (
    <div className="grid grid-kpi">
      <div className="card kpi">
        <span className="kpi-label">Physical progress</span>
        <span className="kpi-value">{fmtPct(t.physicalPct)}</span>
        <ProgressBar actual={t.physicalPct} planned={t.plannedPct} />
        <span className="kpi-foot">Planned {fmtPct(t.plannedPct)} · <span className={`delta ${gap < 0 ? "bad" : "good"}`}>{gap > 0 ? "+" : ""}{gap} pp</span></span>
      </div>
      <div className="card kpi">
        <span className="kpi-label">Schedule performance</span>
        <span className="kpi-value">{t.weightedSpi?.toFixed(2) ?? "—"}<small>SPI</small></span>
        <span className="kpi-foot"><span className={t.delayed ? "delta bad" : "delta good"}>{t.delayed}</span> projects forecast &gt; 30 days late</span>
      </div>
      <div className="card kpi">
        <span className="kpi-label">Forecast cost overrun</span>
        <span className="kpi-value">{fmtCrCompact(t.forecastOverrunCr)}</span>
        <span className="kpi-foot"><span className={t.overBudget ? "delta bad" : "delta good"}>{t.overBudget}</span> projects forecast &gt; 5% over cost</span>
      </div>
      <div className="card kpi">
        <span className="kpi-label">Funds utilisation</span>
        <span className="kpi-value">{fmtPct(t.utilisationPct)}</span>
        <span className="kpi-foot">{fmtCrCompact(t.spentCr)} spent · {fmtCrCompact(Math.max(0, t.releasedCr - t.spentCr))} unspent with agencies</span>
      </div>
      <div className="card kpi">
        <span className="kpi-label">Needs escalation</span>
        <span className="kpi-value">{t.openCriticalIssues}<small>critical issues</small></span>
        <span className="kpi-foot">{t.overdueMilestones} overdue milestones · {t.stale} overdue reports</span>
      </div>
    </div>
  );
}

function StateCard({ p, onPick }: { p: Portfolio; onPick: (state: string) => void }) {
  const [metric, setMetric] = useState<"risk" | "progress" | "delayed">("risk");
  const rows = [...p.byState].sort((a, z) => (metric === "risk" ? z.avgRisk - a.avgRisk : metric === "delayed" ? z.delayed - a.delayed || z.avgRisk - a.avgRisk : z.physicalPct - a.physicalPct)).slice(0, 14);
  const vals = rows.map((g) => (metric === "risk" ? g.avgRisk : metric === "delayed" ? g.delayed : g.physicalPct));
  const label = metric === "risk" ? "Average risk score" : metric === "delayed" ? "Projects delayed > 30 days" : "Physical progress %";
  if (p.byState.length < 2) return null;
  return (
    <Card title="Risk by state" sub="Click a bar to focus the dashboard on that state"
      actions={
        <div className="view-toggle" role="group" aria-label="Metric">
          {(["risk", "delayed", "progress"] as const).map((m) => <button key={m} aria-pressed={metric === m} onClick={() => setMetric(m)}>{m === "risk" ? "Risk" : m === "delayed" ? "Delayed" : "Progress"}</button>)}
        </div>
      }>
      <ChartFrame table={{ columns: ["State", "Projects", "Approved ₹ cr", "Physical %", "Delayed", "Off track", "Avg risk"], rows: p.byState.map((g) => [g.key, g.count, g.budgetCr, g.physicalPct, g.delayed, g.offTrack, g.avgRisk]) }} title={label}>
        <BarChart categories={rows.map((g) => g.key)} series={[{ name: label, values: vals, color: "var(--series-1)" }]} unit={metric === "progress" ? "%" : ""} ariaLabel={`${label} by state`} onSelect={(i) => onPick(rows[i].key)} />
      </ChartFrame>
    </Card>
  );
}

function AttentionCard({ p }: { p: Portfolio }) {
  return (
    <Card title="Projects that need attention" sub="Highest risk first" actions={<Link to="/projects?sort=risk" className="btn btn-ghost btn-sm">See all projects<IconChevronRight size={14} /></Link>}>
      {p.topRisks.length === 0 ? <Empty icon={<IconCheckCircle />} title="Nothing at risk">Every project is on track.</Empty> : (
        <div className="list">
          {p.topRisks.slice(0, 4).map((r) => (
            <Link key={r.id} to={`/projects/${r.id}`} className="list-item list-link">
              <div style={{ flex: 1, minWidth: 0 }}>
                <span className="cell-title">{r.name}</span>
                <span className="cell-sub">{r.code} · {r.state}{r.topFlag ? ` · ${r.topFlag}` : ""}</span>
                <div className="row" style={{ marginTop: 8 }}><HealthBadge health={r.health as Health} />{r.delayDays !== null && r.delayDays > 0 && <span className="small muted">{fmtDays(r.delayDays)}</span>}</div>
              </div>
              <RiskPill score={r.riskScore} level={r.riskLevel} />
            </Link>
          ))}
        </div>
      )}
    </Card>
  );
}

function MilestonesCard({ p }: { p: Portfolio }) {
  const items = p.upcomingMilestones.slice(0, 5);
  return (
    <Card title="Milestones in the next 60 days" sub={`${p.upcomingMilestones.length} due · ${p.overdueMilestones.length} already overdue`}>
      {items.length === 0 ? <Empty icon={<IconCalendar />} title="No milestones due">Nothing falls due in the next 60 days.</Empty> : (
        <div className="list">
          {items.map((m, i) => (
            <Link key={i} to={`/projects/${m.projectId}`} className="list-item list-link">
              <div className="icon-tile" style={{ background: "var(--surface-2)", flexDirection: "column", width: 44, height: 44, lineHeight: 1.1 }}>
                <strong className="num" style={{ fontSize: 15 }}>{m.plannedEnd.slice(8, 10)}</strong>
                <span className="muted" style={{ fontSize: 10 }}>{fmtMonth(m.plannedEnd.slice(0, 7)).split(" ")[0]}</span>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <span className="cell-title">{m.name}</span>
                <span className="cell-sub">{m.project}</span>
                <div className="row" style={{ marginTop: 8 }}><span className="small muted num">{m.progressPct}% done · {m.daysToGo === 0 ? "due today" : `in ${m.daysToGo} days`}</span>{(m.health === "Off track" || m.health === "At risk") && <HealthBadge health={m.health} />}</div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </Card>
  );
}

function AlertsCard({ p }: { p: Portfolio }) {
  const items = p.alerts.slice(0, 5);
  if (!items.length) return null;
  return (
    <Card title="Critical and high alerts" sub="Automatically raised from the latest data" actions={<Link to="/alerts" className="btn btn-ghost btn-sm">See all alerts<IconChevronRight size={14} /></Link>}>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th scope="col">Severity</th><th scope="col">Alert</th><th scope="col">Project</th></tr></thead>
          <tbody>
            {items.map((a, i) => (
              <tr key={i}>
                <td><SeverityBadge severity={a.flag.severity} /></td>
                <td><span className="cell-title">{a.flag.title}</span><span className="cell-sub">{a.flag.detail}</span></td>
                <td><Link to={`/projects/${a.projectId}`}>{a.project.split(" — ")[0]}</Link><span className="cell-sub">{a.code}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
