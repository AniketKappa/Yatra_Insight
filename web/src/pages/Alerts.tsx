import { useMemo, useState } from "react";
import type { Flag, Health } from "../../../server/types";
import { useApi, useDocumentTitle } from "../lib/hooks";
import { Link } from "../lib/router";
import { fmtDate } from "../lib/format";
import { Card, Empty, ErrorState, HealthBadge, RiskPill, SeverityBadge, Skeleton } from "../components/ui";
import { IconCheckCircle } from "../components/Icons";

interface AlertRow { projectId: number; code: string; project: string; state: string; health: Health; riskScore: number; flag: Flag }
interface IssueRow { id: number; project_id: number; code: string; project: string; state: string; category: string; severity: string; status: string; title: string; owner: string; raised_on: string }

const SEVS = ["critical", "high", "medium", "low"] as const;

export function Alerts() {
  useDocumentTitle("Risks & alerts");
  const { data, error, loading, reload } = useApi<{ flags: AlertRow[]; issues: IssueRow[] }>("/api/alerts");
  const [tab, setTab] = useState<"flags" | "issues">("flags");
  const [sev, setSev] = useState<string>("");
  const [type, setType] = useState<string>("");

  const flags = useMemo(() => {
    const rank = { critical: 0, high: 1, medium: 2, low: 3 };
    return (data?.flags ?? [])
      .filter((f) => (!sev || f.flag.severity === sev) && (!type || f.flag.code === type))
      .sort((a, b) => rank[a.flag.severity] - rank[b.flag.severity] || b.riskScore - a.riskScore);
  }, [data, sev, type]);
  const issues = useMemo(() => (data?.issues ?? []).filter((i) => !sev || i.severity.toLowerCase() === sev), [data, sev]);
  const types = useMemo(() => [...new Map((data?.flags ?? []).map((f) => [f.flag.code, f.flag.title.replace(/^\d+ /, "")])).entries()], [data]);
  const counts = useMemo(() => Object.fromEntries(SEVS.map((s) => [s, (data?.flags ?? []).filter((f) => f.flag.severity === s).length])), [data]);
  const ageDays = (iso: string) => Math.round((Date.now() - new Date(iso).getTime()) / 86400000);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <p className="eyebrow">Early warning</p>
          <h1><span className="rise">Risks &amp; alerts</span></h1>
          <p className="lede">Alerts are raised automatically from each new progress report: schedule slippage, cost overruns, stalled work, overdue milestones, critical issues and missing reports.</p>
        </div>
      </div>
      {error && <ErrorState error={error} onRetry={reload} />}
      {loading && <div className="stack">{[0, 1, 2, 3].map((i) => <Skeleton key={i} h={64} />)}</div>}
      {data && (
        <div className="stack">
          <div className="grid grid-kpi">
            {SEVS.map((s) => (
              <button key={s} className="card kpi" style={{ textAlign: "left", cursor: "pointer", outline: sev === s ? "2px solid var(--focus)" : undefined }} aria-pressed={sev === s} onClick={() => setSev(sev === s ? "" : s)}>
                <span className="kpi-label"><SeverityBadge severity={s} /></span>
                <span className="kpi-value">{counts[s]}</span>
                <span className="kpi-foot">{sev === s ? "Showing only these · click to clear" : "Click to filter"}</span>
              </button>
            ))}
          </div>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <div className="view-toggle" role="tablist" aria-label="Alert type">
              <button role="tab" aria-selected={tab === "flags"} aria-pressed={tab === "flags"} onClick={() => setTab("flags")}>Automatic alerts ({data.flags.length})</button>
              <button role="tab" aria-selected={tab === "issues"} aria-pressed={tab === "issues"} onClick={() => setTab("issues")}>Open issues ({data.issues.length})</button>
            </div>
            {tab === "flags" && (
              <select className="select" style={{ width: "auto", minHeight: 36, fontSize: "0.875rem" }} value={type} onChange={(e) => setType(e.target.value)} aria-label="Alert type">
                <option value="">All alert types</option>
                {types.map(([code, title]) => <option key={code} value={code}>{title}</option>)}
              </select>
            )}
          </div>
          <Card bodyClass="">
            {tab === "flags" ? (
              flags.length === 0 ? <Empty icon={<IconCheckCircle />} title="No alerts here">Nothing matches these filters.</Empty> : (
                <div className="table-wrap">
                  <table className="table">
                    <thead><tr><th scope="col">Severity</th><th scope="col">Alert</th><th scope="col">Project</th><th scope="col">Health</th><th scope="col" className="r">Risk</th></tr></thead>
                    <tbody>
                      {flags.map((f, i) => (
                        <tr key={i}>
                          <td><SeverityBadge severity={f.flag.severity} /></td>
                          <td style={{ minWidth: 260 }}><span className="cell-title">{f.flag.title}</span><span className="cell-sub">{f.flag.detail}</span></td>
                          <td style={{ minWidth: 200 }}><Link to={`/projects/${f.projectId}`}>{f.project}</Link><span className="cell-sub">{f.code} · {f.state}</span></td>
                          <td><HealthBadge health={f.health} /></td>
                          <td className="r"><RiskPill score={f.riskScore} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            ) : issues.length === 0 ? <Empty icon={<IconCheckCircle />} title="No open issues">Nothing matches these filters.</Empty> : (
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th scope="col">Severity</th><th scope="col">Issue</th><th scope="col">Project</th><th scope="col">Owner</th><th scope="col">Status</th><th scope="col" className="r">Open for</th></tr></thead>
                  <tbody>
                    {issues.map((i) => (
                      <tr key={i.id}>
                        <td><SeverityBadge severity={i.severity} /></td>
                        <td style={{ minWidth: 240 }}><span className="cell-title">{i.title}</span><span className="cell-sub">{i.category}</span></td>
                        <td style={{ minWidth: 200 }}><Link to={`/projects/${i.project_id}`}>{i.project}</Link><span className="cell-sub">{i.code}</span></td>
                        <td>{i.owner}</td>
                        <td><span className="badge badge-outline">{i.status}</span></td>
                        <td className="r num" title={`Raised ${fmtDate(i.raised_on)}`}>{ageDays(i.raised_on)} days</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
