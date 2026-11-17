import { useMemo } from "react";
import type { ProjectView } from "../../../server/types";
import { useApi, useDocumentTitle, useMediaQuery } from "../lib/hooks";
import { Link, useRouter } from "../lib/router";
import { fmtCr, fmtDays, plural } from "../lib/format";
import { Card, Empty, ErrorState, HealthBadge, ProgressBar, RiskPill, Skeleton } from "../components/ui";
import { FilterRow, useUrlFilters } from "./Overview";
import { downloadText, toCsv } from "../components/Artifacts";
import { IconArrowDown, IconArrowUp, IconDownload, IconSearch } from "../components/Icons";

type SortKey = "name" | "state" | "health" | "progress" | "spi" | "delay" | "overrun" | "budget" | "risk";
const HEALTH_RANK = { "Off track": 0, "On hold": 1, "At risk": 2, "Not started": 3, "On track": 4, Completed: 5 } as const;

const COLS: { key: SortKey; label: string; numeric?: boolean }[] = [
  { key: "name", label: "Project" },
  { key: "state", label: "State" },
  { key: "health", label: "Health" },
  { key: "progress", label: "Progress (vs plan)" },
  { key: "spi", label: "SPI", numeric: true },
  { key: "delay", label: "Forecast delay", numeric: true },
  { key: "overrun", label: "Cost overrun", numeric: true },
  { key: "budget", label: "Approved cost", numeric: true },
  { key: "risk", label: "Risk", numeric: true },
];

function sortValue(v: ProjectView, k: SortKey): number | string {
  const m = v.metrics;
  switch (k) {
    case "name": return v.name;
    case "state": return v.state;
    case "health": return HEALTH_RANK[m.health];
    case "progress": return m.actualPct;
    case "spi": return m.spi ?? 99;
    case "delay": return m.health === "Completed" ? -9999 : m.delayDays ?? -9999;
    case "overrun": return m.cpiReliable ? m.overrunPct : -9999;
    case "budget": return m.budgetCr;
    case "risk": return m.riskScore;
  }
}

export function Projects() {
  useDocumentTitle("Projects");
  const [filters, setFilters] = useUrlFilters(["q", "state", "scheme", "category", "health", "sort", "dir"]);
  const { sort = "risk", dir = sort === "name" || sort === "state" || sort === "spi" || sort === "health" ? "asc" : "desc", ...rest } = filters;
  const qs = new URLSearchParams(Object.entries(rest).filter(([k]) => k !== "q")).toString();
  const { data, error, loading, refreshing, reload } = useApi<ProjectView[]>(`/api/projects${qs ? `?${qs}` : ""}`);
  const mobile = useMediaQuery("(max-width: 767px)");
  const { navigate } = useRouter();

  const rows = useMemo(() => {
    let list = data ?? [];
    const q = (filters.q ?? "").toLowerCase().trim();
    if (q) list = list.filter((v) => q.split(/\s+/).every((t) => `${v.code} ${v.name} ${v.district} ${v.state} ${v.implementing_agency} ${v.nodal_officer}`.toLowerCase().includes(t)));
    const k = sort as SortKey;
    const sign = dir === "asc" ? 1 : -1;
    return [...list].sort((a, b) => {
      const x = sortValue(a, k);
      const y = sortValue(b, k);
      return (typeof x === "string" ? x.localeCompare(y as string) : (x as number) - (y as number)) * sign;
    });
  }, [data, filters.q, sort, dir]);

  const setSort = (k: SortKey) => {
    const nextDir = sort === k ? (dir === "asc" ? "desc" : "asc") : k === "name" || k === "state" || k === "spi" || k === "health" ? "asc" : "desc";
    setFilters({ ...filters, sort: k, dir: nextDir });
  };

  const exportCsv = () => {
    const cols = ["Code", "Project", "Scheme", "State", "District", "Category", "Agency", "Health", "Risk", "Physical %", "Planned %", "SPI", "CPI", "Approved ₹ cr", "Spent ₹ cr", "EAC ₹ cr", "Forecast overrun %", "Planned end", "Forecast end", "Delay days", "Flags"];
    const data = rows.map((v) => {
      const m = v.metrics;
      return [v.code, v.name, v.scheme, v.state, v.district, v.category, v.implementing_agency, m.health, m.riskScore, m.actualPct, m.plannedPctToday, m.spi, m.cpiReliable ? m.cpi : null, m.budgetCr, m.spentCr, m.eacCr, m.cpiReliable ? m.overrunPct : null, v.planned_end_date, m.forecastEnd, m.delayDays, m.flags.map((f) => f.title).join("; ")];
    });
    downloadText(`projects-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(cols, data));
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <p className="eyebrow">Project register</p>
          <h1><span className="rise">Tourism projects</span></h1>
          <p className="lede">{data ? `${plural(rows.length, "project")}${rows.length !== data.length ? ` of ${data.length}` : ""} · sorted by ${COLS.find((c) => c.key === sort)?.label.toLowerCase() ?? sort}` : "Loading…"}</p>
        </div>
        <button className="btn btn-secondary" onClick={exportCsv} disabled={!rows.length}><IconDownload size={16} />Export CSV</button>
      </div>
      <FilterRow value={filters} onChange={(v) => setFilters({ ...v, ...(filters.sort ? { sort: filters.sort, dir: filters.dir ?? "" } : {}) })} showHealth showSearch />
      {error && <ErrorState error={error} onRetry={reload} />}
      {loading && <div className="stack">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} h={56} />)}</div>}
      {data && rows.length === 0 && (
        <Card><Empty icon={<IconSearch />} title="No projects match" action={<button className="btn btn-secondary" onClick={() => setFilters({})}>Clear filters</button>}>Try removing a filter or searching for a destination, code or district.</Empty></Card>
      )}
      {data && rows.length > 0 && (mobile ? (
        <div className={`stack ${refreshing ? "refetching" : ""}`} style={{ gap: 12 }}>
          <label className="field" style={{ maxWidth: 260 }}>
            <span className="label">Sort by</span>
            <select className="select" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>{COLS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</select>
          </label>
          {rows.map((v) => (
            <Link key={v.id} to={`/projects/${v.id}`} className="card card-pad list-link" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start", flexWrap: "nowrap" }}>
                <div style={{ minWidth: 0 }}><span className="cell-title">{v.name}</span><span className="cell-sub">{v.code} · {v.state}</span></div>
                <RiskPill score={v.metrics.riskScore} level={v.metrics.riskLevel} />
              </div>
              <ProgressBar actual={v.metrics.actualPct} planned={v.metrics.plannedPctToday} />
              <div className="row" style={{ justifyContent: "space-between" }}>
                <HealthBadge health={v.metrics.health} />
                <span className="small muted num">{v.metrics.actualPct}% · {v.metrics.health === "Completed" ? "Completed" : fmtDays(v.metrics.delayDays)}</span>
              </div>
            </Link>
          ))}
        </div>
      ) : (
        <div className={`card ${refreshing ? "refetching" : ""}`}>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  {COLS.map((c) => (
                    <th key={c.key} scope="col" className={c.numeric ? "r" : ""} aria-sort={sort === c.key ? (dir === "asc" ? "ascending" : "descending") : "none"}>
                      <button className="sort-btn" onClick={() => setSort(c.key)}>
                        {c.label}
                        {sort === c.key && (dir === "asc" ? <IconArrowUp size={12} /> : <IconArrowDown size={12} />)}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((v) => {
                  const m = v.metrics;
                  return (
                    <tr key={v.id} className="clickable" onClick={(e) => { if (!(e.target as HTMLElement).closest("a")) navigate(`/projects/${v.id}`); }}>
                      <td style={{ minWidth: 260, maxWidth: 380 }}>
                        <Link to={`/projects/${v.id}`} className="cell-title" style={{ color: "var(--fg)" }}>{v.name}</Link>
                        <span className="cell-sub">{v.code} · {v.scheme}</span>
                      </td>
                      <td style={{ whiteSpace: "nowrap" }}>{v.state}<span className="cell-sub">{v.district}</span></td>
                      <td><HealthBadge health={m.health} /></td>
                      <td style={{ minWidth: 150 }}>
                        <ProgressBar actual={m.actualPct} planned={m.health === "Completed" ? null : m.plannedPctToday} />
                        <span className="cell-sub num">{m.actualPct}%{m.health !== "Completed" ? ` · plan ${m.plannedPctToday}%` : ""}</span>
                      </td>
                      <td className="r">{m.spi?.toFixed(2) ?? "—"}</td>
                      <td className="r" style={{ whiteSpace: "nowrap" }}><span className={(m.delayDays ?? 0) > 90 && m.health !== "Completed" ? "flag-text" : undefined}>{m.health === "Completed" ? "Done" : fmtDays(m.delayDays)}</span></td>
                      <td className="r"><span className={m.cpiReliable && m.overrunPct > 15 && m.health !== "Completed" ? "flag-text" : undefined}>{m.cpiReliable && m.health !== "Completed" ? `${m.overrunPct > 0 ? "+" : ""}${m.overrunPct}%` : "—"}</span></td>
                      <td className="r" style={{ whiteSpace: "nowrap" }}>{fmtCr(m.budgetCr, 1)}</td>
                      <td className="r"><RiskPill score={m.riskScore} level={m.riskLevel} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}
