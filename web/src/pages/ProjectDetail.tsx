import { useMemo, useState, type FormEvent } from "react";
import type { Issue, ProjectDetail } from "../../../server/types";
import { api, ApiError } from "../lib/api";
import { useApi, useDocumentTitle } from "../lib/hooks";
import { Link, useRouter } from "../lib/router";
import { useStore } from "../lib/store";
import { fmtCr, fmtDate, fmtDays, fmtMonth, fmtPct } from "../lib/format";
import { ChartFrame, DataTable, LineChart } from "../components/charts";
import { Card, Empty, ErrorState, Field, HealthBadge, Modal, PageSkeleton, ProgressBar, RiskPill, SeverityBadge, riskColor, useToast } from "../components/ui";
import { IconBuilding, IconCalendar, IconCheckCircle, IconEdit, IconMapPin, IconPlus, IconReport, IconSpark, IconUser } from "../components/Icons";

export function ProjectDetailPage({ id }: { id: number }) {
  const { data: d, error, loading, reload, setData, refreshing } = useApi<ProjectDetail>(Number.isInteger(id) && id > 0 ? `/api/projects/${id}` : null);
  useDocumentTitle(d?.name ?? "Project");
  const { navigate } = useRouter();
  const { refreshProjects } = useStore();
  const toast = useToast();
  const [progressOpen, setProgressOpen] = useState(false);
  const [issueOpen, setIssueOpen] = useState(false);
  const [genBusy, setGenBusy] = useState(false);

  if (!Number.isInteger(id) || id <= 0 || error?.status === 404) {
    return <div className="page"><Empty title="Project not found" action={<Link to="/projects" className="btn btn-primary">See all projects</Link>}>It may have been removed, or the link is wrong.</Empty></div>;
  }
  if (error) return <div className="page"><ErrorState error={error} onRetry={reload} /></div>;
  if (loading || !d) return <div className="page"><PageSkeleton /></div>;

  const m = d.metrics;
  const updated = (next: ProjectDetail, msg: string) => {
    setData(next);
    refreshProjects();
    toast(msg);
  };
  const generate = async () => {
    setGenBusy(true);
    try {
      const r = await api<{ id: number }>("/api/reports", { method: "POST", json: { scope: "project", projectId: d.id } });
      navigate(`/reports/${r.id}`);
    } catch (e) {
      toast((e as Error).message, "err");
      setGenBusy(false);
    }
  };
  const askHref = `/assistant?q=${encodeURIComponent(`Give me a status brief on ${d.name.split(" — ")[0]} (${d.code}): what is going wrong and what corrective measures should we take?`)}`;

  return (
    <div className={`page ${refreshing ? "refetching" : ""}`}>
      <nav className="crumbs" aria-label="Breadcrumb"><Link to="/projects">Projects</Link><span aria-hidden="true">/</span><span>{d.code}</span></nav>
      <div className="page-head">
        <div style={{ minWidth: 0, flex: "1 1 520px" }}>
          <p className="eyebrow">{d.scheme} · {d.category}</p>
          <h1><span className="rise">{d.name}</span></h1>
          <div className="row small muted" style={{ marginTop: 8, gap: "8px 16px" }}>
            <span className="row" style={{ gap: 8 }}><IconMapPin size={14} />{d.district}, {d.state}</span>
            <span className="row" style={{ gap: 8 }}><IconBuilding size={14} />{d.implementing_agency}</span>
            <span className="row" style={{ gap: 8 }}><IconUser size={14} />{d.nodal_officer}</span>
            <span className="row" style={{ gap: 8 }}><IconCalendar size={14} />{fmtDate(d.start_date)} → {fmtDate(d.planned_end_date)}</span>
          </div>
          <div className="row" style={{ marginTop: 16 }}>
            <HealthBadge health={m.health} />
            <span className="badge badge-outline">Risk <RiskPill score={m.riskScore} level={m.riskLevel} /></span>
            <span className="badge badge-outline">{d.status}</span>
            {m.lastReportMonth && <span className="small muted">Last report {fmtMonth(m.lastReportMonth)} ({m.daysSinceUpdate} days ago)</span>}
          </div>
        </div>
        <div className="row">
          <Link to={askHref} className="btn btn-secondary"><IconSpark size={16} />Ask about this project</Link>
          <button className="btn btn-secondary" onClick={generate} disabled={genBusy}>{genBusy ? <span className="spinner" /> : <IconReport size={16} />}{genBusy ? "Generating…" : "Generate report"}</button>
          <button className="btn btn-primary" onClick={() => setProgressOpen(true)}><IconEdit size={16} />Record progress</button>
        </div>
      </div>

      <div className="stack">
        <div className="grid grid-kpi">
          <div className="card kpi">
            <span className="kpi-label">Physical progress</span>
            <span className="kpi-value">{fmtPct(m.actualPct)}</span>
            <ProgressBar actual={m.actualPct} planned={m.health === "Completed" ? null : m.plannedPctToday} />
            <span className="kpi-foot">{m.health === "Completed" ? "Completed" : <>Planned {fmtPct(m.plannedPctToday)} by today</>}{m.velocity !== null && m.health !== "Completed" && ` · ${m.velocity} pp/month`}</span>
          </div>
          <div className="card kpi">
            <span className="kpi-label">{m.health === "Completed" ? "Completed on" : "Forecast finish"}</span>
            <span className="kpi-value">{fmtDate(m.health === "Completed" ? d.actual_end_date ?? m.forecastEnd : m.forecastEnd)}</span>
            <span className="kpi-foot">Planned {fmtDate(d.planned_end_date)}{m.delayDays !== null && m.delayDays > 0 && <> · <span className="delta bad">{m.delayDays} days late</span></>}{m.delayDays !== null && m.delayDays <= 0 && m.health !== "Not started" && <> · <span className="delta good">on time</span></>}</span>
          </div>
          <div className="card kpi">
            <span className="kpi-label">Schedule performance</span>
            <span className="kpi-value">{m.spi?.toFixed(2) ?? "—"}<small>SPI</small></span>
            <span className="kpi-foot">{m.spi === null ? "Not enough data yet" : m.spi >= 0.95 ? "Keeping pace with plan" : `Earning ${Math.round(m.spi * 100)} days of plan per 100 days`}</span>
          </div>
          <div className="card kpi">
            <span className="kpi-label">Cost</span>
            <span className="kpi-value">{fmtCr(m.spentCr)}</span>
            <span className="kpi-foot">of {fmtCr(m.budgetCr)} approved{d.revised_cost_cr ? ` (revised +${m.escalationPct}%)` : ""}</span>
            <span className="kpi-foot">{m.cpiReliable ? <>CPI {m.cpi?.toFixed(2)} · EAC {fmtCr(m.eacCr)} <span className={`delta ${m.overrunPct > 5 ? "bad" : "good"}`}>{m.overrunPct > 0 ? "+" : ""}{m.overrunPct}%</span></> : "Too early for a cost forecast"}</span>
          </div>
        </div>

        <div className="grid grid-main">
          <div className="stack">
            <ProgressChart d={d} />
            <CostChart d={d} />
            <Card title="Milestones" sub="Planned window (grey) and progress (blue); the line marks today">
              <Gantt d={d} />
            </Card>
            <Card title="Monthly progress reports" sub={`${d.reports.length} reports filed`} bodyClass="card-body" actions={<button className="btn btn-ghost btn-sm" onClick={() => setProgressOpen(true)}><IconPlus size={14} />Add a report</button>}>
              {d.reports.length === 0 ? <Empty title="No reports yet" action={<button className="btn btn-primary btn-sm" onClick={() => setProgressOpen(true)}>Record the first report</button>}>Progress reporting begins once the work order is issued.</Empty> : (
                <DataTable columns={["Month", "Physical %", "Spent ₹ cr", "Released ₹ cr", "Remarks", "Reported by"]} rows={[...d.reports].reverse().map((r) => [fmtMonth(r.month), r.physical_pct, r.expenditure_cr, r.funds_released_cr, r.remarks, r.reported_by])} maxHeight={360} />
              )}
            </Card>
          </div>
          <div className="stack">
            <Card title="Recommended corrective measures" sub="Generated from flags and open issues">
              {m.recommendations.length === 0 ? <Empty icon={<IconCheckCircle />} title="No action needed">The project is on track; continue routine monitoring.</Empty> : (
                <ol className="list" style={{ margin: 0, padding: 0, listStyle: "none" }}>
                  {m.recommendations.map((r, i) => (
                    <li key={i} className="list-item" style={{ flexDirection: "column", gap: 8 }}>
                      <div className="row"><span className={`badge ${r.priority === "Immediate" ? "badge-crit" : r.priority === "Within 30 days" ? "badge-warn" : "badge-neutral"}`}>{r.priority}</span><span className="small muted">Owner: {r.owner}</span></div>
                      <p style={{ fontWeight: 500 }}>{r.action}</p>
                      <p className="small muted">{r.rationale}</p>
                    </li>
                  ))}
                </ol>
              )}
            </Card>
            <Card title="Flags raised" sub={m.flags.length ? `${m.flags.length} raised automatically` : undefined}>
              {m.flags.length === 0 ? <Empty icon={<IconCheckCircle />} title="No flags raised">No delay, cost, issue or reporting flags.</Empty> : (
                <div className="list">
                  {m.flags.map((f) => (
                    <div key={f.code} className="list-item" style={{ flexDirection: "column", gap: 8 }}>
                      <div className="row"><SeverityBadge severity={f.severity} /><strong style={{ fontWeight: 600 }}>{f.title}</strong></div>
                      <p className="small muted">{f.detail}</p>
                    </div>
                  ))}
                </div>
              )}
            </Card>
            <Card title="Risk score breakdown" sub={`${m.riskScore}/100 · ${m.riskLevel}`}>
              {m.riskBreakdown.length === 0 ? <p className="muted small">Risk scoring applies to active projects.</p> : (
                <div className="meter-list">
                  {m.riskBreakdown.map((c) => (
                    <div key={c.factor} className="meter-row">
                      <span className="small"><strong style={{ fontWeight: 550 }}>{c.factor}</strong> <span className="muted">· {c.note}</span></span>
                      <span className="small num muted">{c.points}/{c.max}</span>
                      <div className="progress" role="img" aria-label={`${c.factor}: ${c.points} of ${c.max} points`}><i style={{ width: `${(c.points / c.max) * 100}%`, background: riskColor((c.points / c.max) * 100) }} /></div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
            <IssuesCard d={d} onChanged={updated} onAdd={() => setIssueOpen(true)} />
          </div>
        </div>
      </div>
      <ProgressForm open={progressOpen} onClose={() => setProgressOpen(false)} d={d} onSaved={(next) => { setProgressOpen(false); updated(next, "Progress recorded and analytics recalculated."); }} />
      <IssueForm open={issueOpen} onClose={() => setIssueOpen(false)} d={d} onSaved={(next) => { setIssueOpen(false); updated(next, "Issue logged."); }} />
    </div>
  );
}

// ---- Charts -------------------------------------------------------------------------------

function ProgressChart({ d }: { d: ProjectDetail }) {
  const m = d.metrics;
  const data = useMemo(() => {
    const months = d.plannedSeries.map((s) => s.month);
    const lastMonth = (m.forecastEnd ?? d.planned_end_date).slice(0, 7);
    const extra: string[] = [];
    let cur = months.at(-1) ?? d.start_date.slice(0, 7);
    let guard = 0;
    while (cur < lastMonth && guard++ < 72) {
      const [y, mo] = cur.split("-").map(Number);
      cur = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, "0")}`;
      extra.push(cur);
    }
    const cats = [...months, ...extra];
    const plannedMap = new Map(d.plannedSeries.map((s) => [s.month, s.plannedPct]));
    const actualMap = new Map(d.reports.map((r) => [r.month, r.physical_pct]));
    const lastRep = d.reports.at(-1);
    const planned = cats.map((c) => plannedMap.get(c) ?? (c > (months.at(-1) ?? "") ? 100 : null));
    const actual = cats.map((c) => actualMap.get(c) ?? null);
    let forecast: (number | null)[] = cats.map(() => null);
    if (lastRep && m.forecastEnd && m.health !== "Completed") {
      const i0 = cats.indexOf(lastRep.month);
      const i1 = cats.indexOf(m.forecastEnd.slice(0, 7));
      if (i0 >= 0 && i1 > i0) forecast = cats.map((_, i) => (i < i0 || i > i1 ? null : lastRep.physical_pct + ((100 - lastRep.physical_pct) * (i - i0)) / (i1 - i0)));
    }
    return { cats, planned, actual, forecast, today: cats.indexOf(m.asOf.slice(0, 7)) };
  }, [d, m]);

  const series = [
    { name: "Planned", values: data.planned, color: "var(--planned)" },
    { name: "Actual", values: data.actual, color: "var(--series-1)", area: true },
    ...(data.forecast.some((v) => v !== null) ? [{ name: "Forecast", values: data.forecast.map((v) => (v === null ? null : Math.round(v * 10) / 10)), color: "var(--series-2)", dashed: true }] : []),
  ];
  return (
    <Card title="Physical progress" sub="Planned S-curve vs reported progress, with the earned-schedule forecast">
      {d.reports.length === 0 && d.metrics.health === "Not started" ? <Empty icon={<IconCalendar />} title="Work hasn't started">Planned start {fmtDate(d.start_date)}.</Empty> : (
        <ChartFrame legend={series.map((s) => ({ name: s.name, color: s.color, kind: "line" as const, dashed: s.dashed }))}
          table={{ columns: ["Month", ...series.map((s) => `${s.name} %`)], rows: data.cats.map((c, i) => [c, ...series.map((s) => s.values[i])]) }}>
          <LineChart categories={data.cats} series={series} unit="%" yMin={0} yMax={100} formatX={fmtMonth} markerIndex={data.today} ariaLabel="Planned versus actual physical progress" />
        </ChartFrame>
      )}
    </Card>
  );
}

function CostChart({ d }: { d: ProjectDetail }) {
  const m = d.metrics;
  if (d.reports.length < 2) return null;
  const plannedMap = new Map(d.plannedSeries.map((s) => [s.month, s.plannedSpendCr]));
  const cats = d.reports.map((r) => r.month);
  const series = [
    { name: "Planned spend", values: cats.map((c) => plannedMap.get(c) ?? null), color: "var(--planned)", dashed: true },
    { name: "Actual spend", values: d.reports.map((r) => r.expenditure_cr), color: "var(--series-2)" },
    { name: "Value of work done", values: d.reports.map((r) => Math.round((r.physical_pct / 100) * m.budgetCr * 100) / 100), color: "var(--series-1)" },
  ];
  return (
    <Card title="Cost vs value of work done" sub="When actual spend runs above the value of work done, the project is over cost (CPI < 1)">
      <ChartFrame legend={series.map((s) => ({ name: s.name, color: s.color, kind: "line" as const, dashed: s.dashed }))}
        table={{ columns: ["Month", ...series.map((s) => `${s.name} (₹ cr)`)], rows: cats.map((c, i) => [c, ...series.map((s) => s.values[i])]) }}>
        <LineChart categories={cats} series={series} unit="₹ cr" yMin={0} formatX={fmtMonth} height={230} ariaLabel="Cumulative planned spend, actual spend and earned value" />
      </ChartFrame>
    </Card>
  );
}

function Gantt({ d }: { d: ProjectDetail }) {
  const start = new Date(d.start_date).getTime();
  const endIso = [d.planned_end_date, d.metrics.forecastEnd ?? d.planned_end_date].sort().at(-1)!;
  const end = new Date(endIso).getTime();
  const span = Math.max(1, end - start);
  const pos = (iso: string) => Math.min(100, Math.max(0, ((new Date(iso).getTime() - start) / span) * 100));
  const today = pos(d.metrics.asOf);
  return (
    <div className="gantt" role="list">
      {d.milestones.map((ms) => {
        const left = pos(ms.planned_start);
        const width = Math.max(1.5, pos(ms.planned_end) - left);
        const overdue = d.metrics.overdueMilestones.some((o) => o.id === ms.id);
        return (
          <div className="gantt-row" role="listitem" key={ms.id}>
            <div className="gantt-name">
              <span style={{ fontWeight: 550 }}>{ms.name}</span>
              <span className="cell-sub">{ms.actual_end ? `Done ${fmtDate(ms.actual_end)}` : `Due ${fmtDate(ms.planned_end)} · ${ms.progress_pct}%`}{overdue && <> · <span className="flag-text">overdue</span></>}</span>
            </div>
            <div className="gantt-track" aria-label={`${ms.name}: planned ${ms.planned_start} to ${ms.planned_end}, ${ms.progress_pct}% complete`}>
              <div className="gantt-plan" style={{ left: `${left}%`, width: `${width}%`, outline: overdue ? "1.5px solid var(--crit)" : undefined }}>
                <i style={{ width: `${ms.progress_pct}%`, background: ms.actual_end ? "var(--good)" : "var(--series-1)" }} />
              </div>
              <span className="gantt-today" style={{ left: `${today}%` }} />
            </div>
          </div>
        );
      })}
      <div className="row small muted" style={{ justifyContent: "space-between", marginTop: 4 }}><span>{fmtDate(d.start_date)}</span><span>{fmtDate(endIso)}</span></div>
    </div>
  );
}

// ---- Issues ----------------------------------------------------------------------------------

function IssuesCard({ d, onChanged, onAdd }: { d: ProjectDetail; onChanged: (n: ProjectDetail, msg: string) => void; onAdd: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState<number | null>(null);
  const setStatus = async (i: Issue, status: string) => {
    setBusy(i.id);
    try {
      onChanged(await api<ProjectDetail>(`/api/issues/${i.id}`, { method: "PATCH", json: { status } }), `Issue marked ${status.toLowerCase()}.`);
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setBusy(null);
    }
  };
  const sorted = [...d.issues].sort((a, b) => Number(a.status === "Resolved") - Number(b.status === "Resolved"));
  return (
    <Card title="Issues register" sub={`${d.issues.filter((i) => i.status !== "Resolved").length} open`} actions={<button className="btn btn-ghost btn-sm" onClick={onAdd}><IconPlus size={14} />Log an issue</button>}>
      {sorted.length === 0 ? <Empty title="No issues logged" action={<button className="btn btn-secondary btn-sm" onClick={onAdd}>Log an issue</button>}>Log hindrances such as land, clearances or contractor problems so they feed the risk score.</Empty> : (
        <div className="list">
          {sorted.map((i) => (
            <div key={i.id} className="list-item" style={{ flexDirection: "column", gap: 8, opacity: i.status === "Resolved" ? 0.65 : 1 }}>
              <div className="row"><SeverityBadge severity={i.severity} /><span className="badge badge-outline">{i.category}</span></div>
              <strong style={{ fontWeight: 600 }}>{i.title}</strong>
              <p className="small muted">{i.description}</p>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <span className="small muted">Owner {i.owner} · raised {fmtDate(i.raised_on)}{i.resolved_on ? ` · resolved ${fmtDate(i.resolved_on)}` : ""}</span>
                <label className="row small" style={{ gap: 8 }}>
                  <span className="visually-hidden">Status of {i.title}</span>
                  {busy === i.id && <span className="spinner" />}
                  <select className="select" style={{ minHeight: 32, width: 140, fontSize: "0.8125rem" }} value={i.status} disabled={busy === i.id} onChange={(e) => setStatus(i, e.target.value)}>
                    <option>Open</option><option>Mitigating</option><option>Resolved</option>
                  </select>
                </label>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// ---- Forms ---------------------------------------------------------------------------------

export function useForm<T extends Record<string, string>>(initial: T) {
  const [values, setValues] = useState<T>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const bind = (k: keyof T & string) => ({
    id: `f-${k}`, name: k, value: values[k],
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
      setValues((v) => ({ ...v, [k]: e.target.value }));
      // Clear this field's error as soon as the user edits it; it's re-checked on blur/submit.
      setErrors((er) => (er[k] || er.form ? Object.fromEntries(Object.entries(er).filter(([key]) => key !== k && key !== "form")) : er));
    },
    "aria-invalid": errors[k] ? true : undefined,
    "aria-describedby": errors[k] ? `f-${k}-err` : undefined,
  });
  return { values, setValues, errors, setErrors, busy, setBusy, bind };
}

function ProgressForm({ open, onClose, d, onSaved }: { open: boolean; onClose: () => void; d: ProjectDetail; onSaved: (n: ProjectDetail) => void }) {
  const last = d.reports.at(-1);
  const now = new Date();
  const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const prevMonth = now.getMonth() === 0 ? `${now.getFullYear() - 1}-12` : `${now.getFullYear()}-${String(now.getMonth()).padStart(2, "0")}`;
  const f = useForm({
    month: last && last.month >= prevMonth ? thisMonth : prevMonth,
    physical_pct: String(last?.physical_pct ?? 0),
    expenditure_cr: String(last?.expenditure_cr ?? 0),
    funds_released_cr: String(last?.funds_released_cr ?? ""),
    remarks: "",
    reported_by: d.nodal_officer,
  });
  const validateField = (k: string) => {
    const v = f.values[k as keyof typeof f.values];
    let msg = "";
    if (k === "physical_pct" && (v === "" || Number(v) < 0 || Number(v) > 100 || !Number.isFinite(Number(v)))) msg = "Enter a percentage between 0 and 100.";
    if (k === "physical_pct" && !msg && last && f.values.month > last.month && Number(v) < last.physical_pct) msg = `Progress is cumulative — it can't fall below last month's ${last.physical_pct}%.`;
    if (k === "expenditure_cr" && (v === "" || Number(v) < 0 || !Number.isFinite(Number(v)))) msg = "Enter cumulative expenditure in ₹ crore.";
    if (k === "reported_by" && !v.trim()) msg = "Enter the reporting officer's name.";
    f.setErrors((e) => { const n = { ...e }; if (msg) n[k] = msg; else delete n[k]; return n; });
    return !msg;
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const ok = ["physical_pct", "expenditure_cr", "reported_by"].map(validateField).every(Boolean);
    if (!ok) return;
    f.setBusy(true);
    try {
      onSaved(await api<ProjectDetail>(`/api/projects/${d.id}/progress`, { method: "POST", json: { ...f.values, physical_pct: Number(f.values.physical_pct), expenditure_cr: Number(f.values.expenditure_cr), funds_released_cr: f.values.funds_released_cr === "" ? null : Number(f.values.funds_released_cr) } }));
    } catch (err) {
      if (err instanceof ApiError && err.fields) f.setErrors(err.fields);
      else f.setErrors({ form: (err as Error).message });
    } finally {
      f.setBusy(false);
    }
  };
  const existing = d.reports.find((r) => r.month === f.values.month);
  return (
    <Modal open={open} onClose={onClose} title="Record monthly progress" labelledBy="progress-title"
      footer={<><button className="btn btn-ghost" onClick={onClose} type="button">Cancel</button><button className="btn btn-primary" form="progress-form" type="submit" disabled={f.busy}>{f.busy && <span className="spinner" />}{existing ? "Update report" : "Save report"}</button></>}>
      <form id="progress-form" className="form-grid" onSubmit={submit} noValidate>
        <p className="muted small">Figures are cumulative from the start of the project. Analytics, flags and recommendations recalculate as soon as you save.</p>
        {f.errors.form && <div className="error-box" role="alert">{f.errors.form}</div>}
        <Field id="f-month" label="Reporting month" error={f.errors.month} hint={existing ? "A report exists for this month — saving will update it." : undefined}>
          <input className="input" type="month" {...f.bind("month")} max={thisMonth} min={d.start_date.slice(0, 7)} required />
        </Field>
        <div className="form-grid two">
          <Field id="f-physical_pct" label="Physical progress (%)" error={f.errors.physical_pct} hint={last ? `Last: ${last.physical_pct}% (${fmtMonth(last.month)})` : undefined}>
            <input className="input" type="number" inputMode="decimal" step="0.1" min={0} max={100} {...f.bind("physical_pct")} onBlur={() => validateField("physical_pct")} required />
          </Field>
          <Field id="f-expenditure_cr" label="Expenditure to date (₹ cr)" error={f.errors.expenditure_cr} hint={last ? `Last: ${fmtCr(last.expenditure_cr)}` : undefined}>
            <input className="input" type="number" inputMode="decimal" step="0.01" min={0} {...f.bind("expenditure_cr")} onBlur={() => validateField("expenditure_cr")} required />
          </Field>
        </div>
        <Field id="f-funds_released_cr" label="Funds released to date (₹ cr) — optional" error={f.errors.funds_released_cr} hint="Leave blank to carry forward the last figure.">
          <input className="input" type="number" inputMode="decimal" step="0.01" min={0} {...f.bind("funds_released_cr")} />
        </Field>
        <Field id="f-remarks" label="Remarks — optional" error={f.errors.remarks}>
          <textarea className="textarea" maxLength={1000} placeholder="Work done this month, hindrances, next steps…" {...f.bind("remarks")} />
        </Field>
        <Field id="f-reported_by" label="Reported by" error={f.errors.reported_by}>
          <input className="input" type="text" autoComplete="name" {...f.bind("reported_by")} onBlur={() => validateField("reported_by")} required />
        </Field>
      </form>
    </Modal>
  );
}

const ISSUE_CATEGORIES = ["Land acquisition", "Statutory clearance", "Litigation", "Utility shifting", "Contractor performance", "Funds release", "Design change", "Price escalation", "Weather", "Approvals", "Material supply", "Other"];

function IssueForm({ open, onClose, d, onSaved }: { open: boolean; onClose: () => void; d: ProjectDetail; onSaved: (n: ProjectDetail) => void }) {
  const f = useForm({ title: "", category: "", severity: "Medium", owner: "", description: "" });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!f.values.title.trim()) errs.title = "Give the issue a short title.";
    if (!f.values.category) errs.category = "Choose a category.";
    if (!f.values.owner.trim()) errs.owner = "Name who owns the resolution.";
    f.setErrors(errs);
    if (Object.keys(errs).length) return;
    f.setBusy(true);
    try {
      onSaved(await api<ProjectDetail>(`/api/projects/${d.id}/issues`, { method: "POST", json: f.values }));
      f.setValues({ title: "", category: "", severity: "Medium", owner: "", description: "" });
    } catch (err) {
      if (err instanceof ApiError && err.fields) f.setErrors(err.fields);
      else f.setErrors({ form: (err as Error).message });
    } finally {
      f.setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title="Log an issue" labelledBy="issue-title"
      footer={<><button className="btn btn-ghost" type="button" onClick={onClose}>Cancel</button><button className="btn btn-primary" form="issue-form" type="submit" disabled={f.busy}>{f.busy && <span className="spinner" />}Log issue</button></>}>
      <form id="issue-form" className="form-grid" onSubmit={submit} noValidate>
        {f.errors.form && <div className="error-box" role="alert">{f.errors.form}</div>}
        <Field id="f-title" label="Title" error={f.errors.title}><input className="input" maxLength={200} {...f.bind("title")} placeholder="e.g. Forest clearance pending for approach road" /></Field>
        <div className="form-grid two">
          <Field id="f-category" label="Category" error={f.errors.category}>
            <select className="select" {...f.bind("category")}><option value="">Choose…</option>{ISSUE_CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select>
          </Field>
          <Field id="f-severity" label="Severity" error={f.errors.severity}>
            <select className="select" {...f.bind("severity")}><option>Low</option><option>Medium</option><option>High</option><option>Critical</option></select>
          </Field>
        </div>
        <Field id="f-owner" label="Owner" error={f.errors.owner} hint="Who is responsible for resolving it"><input className="input" maxLength={120} {...f.bind("owner")} placeholder="e.g. District Collector" /></Field>
        <Field id="f-description" label="Description — optional"><textarea className="textarea" maxLength={2000} {...f.bind("description")} /></Field>
      </form>
    </Modal>
  );
}
