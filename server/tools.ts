// Analysis tools. The same implementations serve two callers:
//  - Claude, through tool use (llm/agent.ts)
//  - the offline engine, which calls them directly (llm/offline.ts)
// Every tool returns { forModel: compact JSON the LLM reads, artifacts: what the UI shows }.

import type { DatabaseSync } from "node:sqlite";
import type { Artifact, ChartSpec, ProjectView } from "./types.ts";
import type { Repo } from "./repo.ts";
import { runReadOnly, SqlRejected } from "./sqlguard.ts";
import { SCHEMA_DOC } from "./db.ts";

export interface ToolResult {
  forModel: string;
  artifacts: Artifact[];
  isError?: boolean;
}

export interface ListFilters {
  state?: string;
  scheme?: string;
  category?: string;
  health?: string[];
  risk_level?: string[];
  min_delay_days?: number;
  min_overrun_pct?: number;
  stalled?: boolean;
  stale?: boolean;
  has_overdue_milestones?: boolean;
  text?: string;
  sort_by?: "risk" | "delay" | "overrun" | "progress" | "budget" | "spi";
  limit?: number;
}

const cr = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })} cr`;

function caseFold(v: string | undefined, options: string[]): string | undefined {
  if (!v) return undefined;
  const q = v.toLowerCase().trim();
  return options.find((o) => o.toLowerCase() === q) ?? options.find((o) => o.toLowerCase().includes(q) || q.includes(o.toLowerCase()));
}

export function listProjects(repo: Repo, f: ListFilters): { views: ProjectView[]; unknown: string[] } {
  const facets = repo.facets();
  const unknown: string[] = [];
  const state = caseFold(f.state, facets.states);
  const scheme = caseFold(f.scheme, facets.schemes);
  const category = caseFold(f.category, facets.categories);
  if (f.state && !state) unknown.push(`state "${f.state}"`);
  if (f.scheme && !scheme) unknown.push(`scheme "${f.scheme}"`);
  if (f.category && !category) unknown.push(`category "${f.category}"`);

  let views = repo.views().filter((v) => {
    const m = v.metrics;
    if (state && v.state !== state) return false;
    if (scheme && v.scheme !== scheme) return false;
    if (category && v.category !== category) return false;
    if (f.health?.length && !f.health.some((h) => h.toLowerCase() === m.health.toLowerCase())) return false;
    if (f.risk_level?.length && !f.risk_level.some((r) => r.toLowerCase() === m.riskLevel.toLowerCase())) return false;
    if (f.min_delay_days !== undefined && ((m.delayDays ?? -Infinity) < f.min_delay_days || m.health === "Completed")) return false;
    if (f.min_overrun_pct !== undefined && (!m.cpiReliable || m.overrunPct < f.min_overrun_pct || m.health === "Completed")) return false;
    if (f.stalled && !m.stalled) return false;
    if (f.stale && !m.flags.some((x) => x.code === "STALE_DATA")) return false;
    if (f.has_overdue_milestones && !m.overdueMilestones.length) return false;
    if (f.text) {
      const hay = `${v.code} ${v.name} ${v.district} ${v.implementing_agency}`.toLowerCase();
      if (!hay.includes(f.text.toLowerCase())) return false;
    }
    return true;
  });
  const sorters: Record<string, (a: ProjectView, b: ProjectView) => number> = {
    risk: (a, b) => b.metrics.riskScore - a.metrics.riskScore,
    delay: (a, b) => (b.metrics.delayDays ?? -1e9) - (a.metrics.delayDays ?? -1e9),
    overrun: (a, b) => b.metrics.overrunPct - a.metrics.overrunPct,
    progress: (a, b) => b.metrics.actualPct - a.metrics.actualPct,
    budget: (a, b) => b.metrics.budgetCr - a.metrics.budgetCr,
    spi: (a, b) => (a.metrics.spi ?? 9) - (b.metrics.spi ?? 9),
  };
  views = [...views].sort(sorters[f.sort_by ?? "risk"] ?? sorters.risk);
  const limit = Math.min(Math.max(1, Math.floor(f.limit ?? 25)), 60);
  return { views: views.slice(0, limit), unknown };
}

export function projectsTable(title: string, views: ProjectView[]): Artifact {
  return {
    type: "table",
    title,
    columns: ["Code", "Project", "State", "Health", "Progress %", "SPI", "Delay (days)", "Forecast overrun %", "Risk"],
    rows: views.map((v) => [
      v.code, v.name, v.state, v.metrics.health, v.metrics.actualPct, v.metrics.spi,
      v.metrics.health === "Completed" ? null : v.metrics.delayDays,
      v.metrics.cpiReliable ? v.metrics.overrunPct : null, v.metrics.riskScore,
    ]),
  };
}

function compactProject(v: ProjectView) {
  const m = v.metrics;
  return {
    id: v.id, code: v.code, name: v.name, state: v.state, scheme: v.scheme, category: v.category,
    health: m.health, risk: `${m.riskScore} (${m.riskLevel})`, physical_pct: m.actualPct,
    planned_pct_today: m.plannedPctToday, spi: m.spi, cpi: m.cpiReliable ? m.cpi : null,
    budget_cr: m.budgetCr, spent_cr: m.spentCr, eac_cr: m.eacCr, overrun_pct: m.cpiReliable ? m.overrunPct : null,
    planned_end: v.planned_end_date, forecast_end: m.forecastEnd, delay_days: m.delayDays,
    flags: m.flags.map((f) => f.title),
  };
}

export function toolListProjects(repo: Repo, input: ListFilters): ToolResult {
  const { views, unknown } = listProjects(repo, input);
  const note = unknown.length ? `No match for ${unknown.join(", ")}; that filter was ignored. Valid states: ${repo.facets().states.join(", ")}.` : undefined;
  if (!views.length) return { forModel: JSON.stringify({ count: 0, note, projects: [] }), artifacts: [] };
  return {
    forModel: JSON.stringify({ count: views.length, note, projects: views.map(compactProject) }),
    artifacts: [projectsTable(`${views.length} project${views.length === 1 ? "" : "s"}`, views)],
  };
}

export function toolGetProject(repo: Repo, input: { project: string }): ToolResult {
  const v = repo.findProject(String(input.project ?? ""));
  if (!v) {
    return { forModel: JSON.stringify({ error: `No project matches "${input.project}". Use list_projects or query_database to find the code.` }), artifacts: [], isError: true };
  }
  const d = repo.detail(v.id);
  const m = d.metrics;
  const payload = {
    ...compactProject(d),
    description: d.description,
    implementing_agency: d.implementing_agency,
    nodal_officer: d.nodal_officer,
    sanctioned_cost_cr: d.sanctioned_cost_cr,
    revised_cost_cr: d.revised_cost_cr,
    start_date: d.start_date,
    status: d.status,
    forecast_basis: m.forecastBasis,
    velocity_pp_per_month: m.velocity,
    last_report: m.lastReportMonth, days_since_update: m.daysSinceUpdate,
    risk_breakdown: m.riskBreakdown,
    flags: m.flags,
    recommendations: m.recommendations,
    milestones: d.milestones.map((x) => ({ name: x.name, planned_end: x.planned_end, actual_end: x.actual_end, progress_pct: x.progress_pct })),
    open_issues: d.issues.filter((i) => i.status !== "Resolved").map((i) => ({ category: i.category, severity: i.severity, status: i.status, title: i.title, owner: i.owner, raised_on: i.raised_on })),
    recent_reports: d.reports.slice(-4).map((r) => ({ month: r.month, physical_pct: r.physical_pct, expenditure_cr: r.expenditure_cr, remarks: r.remarks })),
  };
  return { forModel: JSON.stringify(payload), artifacts: [{ type: "projects", title: d.name, ids: [d.id] }] };
}

export function toolPortfolio(repo: Repo, input: { state?: string; scheme?: string; category?: string }): ToolResult {
  const facets = repo.facets();
  const filters = {
    state: caseFold(input.state, facets.states),
    scheme: caseFold(input.scheme, facets.schemes),
    category: caseFold(input.category, facets.categories),
  };
  const p = repo.portfolio(filters);
  if (!p.totals.projects) return { forModel: JSON.stringify({ count: 0, note: "No projects match these filters." }), artifacts: [] };
  const payload = {
    as_of: p.asOf,
    filters,
    totals: p.totals,
    health: p.health,
    risk_levels: p.riskLevels,
    by_state: p.byState.map((g) => ({ state: g.key, projects: g.count, budget_cr: g.budgetCr, spent_cr: g.spentCr, physical_pct: g.physicalPct, delayed: g.delayed, off_track: g.offTrack, avg_risk: g.avgRisk })),
    by_scheme: p.byScheme.map((g) => ({ scheme: g.key, projects: g.count, budget_cr: g.budgetCr, physical_pct: g.physicalPct, delayed: g.delayed, forecast_overrun_cr: g.forecastOverrunCr })),
    top_risks: p.topRisks,
    milestones_due_next_60_days: p.upcomingMilestones.slice(0, 12),
    overdue_milestones: p.overdueMilestones.slice(0, 12),
  };
  return { forModel: JSON.stringify(payload), artifacts: [] };
}

export function toolQuery(ro: DatabaseSync, input: { sql: string; title?: string }): ToolResult {
  try {
    const r = runReadOnly(ro, input.sql);
    const preview = r.rows.slice(0, 60);
    return {
      forModel: JSON.stringify({ columns: r.columns, rows: preview, row_count: r.rows.length, truncated: r.truncated || r.rows.length > preview.length }),
      artifacts: r.rows.length ? [{ type: "table", title: input.title?.slice(0, 120) || "Query result", columns: r.columns, rows: r.rows, sql: input.sql, truncated: r.truncated }] : [],
    };
  } catch (err) {
    const msg = err instanceof SqlRejected ? err.message : `Query failed: ${(err as Error).message}`;
    return { forModel: JSON.stringify({ error: msg, hint: "Check table/column names against the schema." }), artifacts: [], isError: true };
  }
}

export function toolChart(input: unknown): ToolResult {
  const spec = validateChart(input);
  if (typeof spec === "string") return { forModel: JSON.stringify({ error: spec }), artifacts: [], isError: true };
  return { forModel: JSON.stringify({ ok: true, shown: spec.title }), artifacts: [{ type: "chart", spec }] };
}

export function validateChart(input: unknown): ChartSpec | string {
  const i = input as Partial<ChartSpec> | null;
  if (!i || typeof i !== "object") return "Chart input must be an object.";
  if (i.kind !== "bar" && i.kind !== "line") return 'kind must be "bar" or "line".';
  if (!Array.isArray(i.categories) || !i.categories.length) return "categories must be a non-empty array.";
  if (i.categories.length > 40) return "Too many categories (max 40). Aggregate or pick the top items.";
  if (!Array.isArray(i.series) || !i.series.length) return "series must be a non-empty array.";
  if (i.series.length > 4) return "At most 4 series per chart; split into separate charts.";
  for (const s of i.series) {
    if (!s || typeof s.name !== "string" || !Array.isArray(s.values)) return "Each series needs a name and a values array.";
    if (s.values.length !== i.categories.length) return `Series "${s.name}" has ${s.values.length} values but there are ${i.categories.length} categories.`;
    if (s.values.some((v) => v !== null && (typeof v !== "number" || !Number.isFinite(v)))) return `Series "${s.name}" contains non-numeric values.`;
  }
  return {
    kind: i.kind,
    title: String(i.title ?? "Chart").slice(0, 120),
    unit: i.unit ? String(i.unit).slice(0, 24) : undefined,
    categories: i.categories.map((c) => String(c).slice(0, 60)),
    series: i.series.map((s) => ({ name: String(s.name).slice(0, 60), values: s.values.map((v) => (v === null ? null : Number(v))) })),
  };
}

// ---- Claude tool definitions ---------------------------------------------------

export const TOOL_DEFS = [
  {
    name: "list_projects",
    description:
      "Find projects by structured filters and get their key metrics (health, progress, SPI, CPI, delay, forecast overrun, risk, flags). Prefer this over SQL for common questions about delayed, over-budget, stalled, risky or stale projects.",
    input_schema: {
      type: "object" as const,
      properties: {
        state: { type: "string", description: "State/UT name, e.g. Kerala" },
        scheme: { type: "string", description: "Scheme name, e.g. PRASHAD or Swadesh Darshan 2.0" },
        category: { type: "string", description: "Heritage, Pilgrimage, Eco-tourism, Coastal, Adventure, Rural, Buddhist or Wellness" },
        health: { type: "array", items: { type: "string", enum: ["On track", "At risk", "Off track", "Completed", "Not started", "On hold"] } },
        risk_level: { type: "array", items: { type: "string", enum: ["Low", "Moderate", "High", "Critical"] } },
        min_delay_days: { type: "number", description: "Only projects forecast to finish at least this many days late" },
        min_overrun_pct: { type: "number", description: "Only projects with forecast cost overrun at least this % (reliable CPI only)" },
        stalled: { type: "boolean" },
        stale: { type: "boolean", description: "Only projects whose progress report is overdue" },
        has_overdue_milestones: { type: "boolean" },
        text: { type: "string", description: "Free-text match on code, name, district or agency" },
        sort_by: { type: "string", enum: ["risk", "delay", "overrun", "progress", "budget", "spi"] },
        limit: { type: "number", description: "Max rows, default 25, max 60" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_project",
    description:
      "Full dossier for one project: metrics, risk breakdown, flags, recommended corrective measures, milestones, open issues and the latest monthly reports. Accepts a project code (e.g. SD2-KA-0109), id, or destination name (e.g. Hampi).",
    input_schema: {
      type: "object" as const,
      properties: { project: { type: "string", description: "Project code, id or destination name" } },
      required: ["project"],
      additionalProperties: false,
    },
  },
  {
    name: "portfolio_summary",
    description: "Aggregated portfolio view (totals, health mix, by-state and by-scheme breakdowns, top risks, milestones due and overdue), optionally filtered.",
    input_schema: {
      type: "object" as const,
      properties: { state: { type: "string" }, scheme: { type: "string" }, category: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "query_database",
    description:
      `Run ONE read-only SQLite SELECT for questions the other tools can't answer (custom aggregations, trends across months, issue analysis). Max ${200} rows returned. Schema:\n${SCHEMA_DOC}`,
    input_schema: {
      type: "object" as const,
      properties: {
        sql: { type: "string", description: "A single SELECT (or WITH ... SELECT) statement. No RECURSIVE." },
        title: { type: "string", description: "Short human title for the result table shown to the user" },
      },
      required: ["sql", "title"],
      additionalProperties: false,
    },
  },
  {
    name: "show_chart",
    description:
      "Display a simple chart to the user next to your answer. Use when a comparison or trend is clearer visually (e.g. delay by state, spend by scheme, monthly progress). Bar for comparing categories, line for change over time. Max 40 categories, 4 series.",
    input_schema: {
      type: "object" as const,
      properties: {
        kind: { type: "string", enum: ["bar", "line"] },
        title: { type: "string" },
        unit: { type: "string", description: "Unit label such as '%', '₹ cr' or 'days'" },
        categories: { type: "array", items: { type: "string" } },
        series: {
          type: "array",
          items: {
            type: "object",
            properties: { name: { type: "string" }, values: { type: "array", items: { type: ["number", "null"] } } },
            required: ["name", "values"],
            additionalProperties: false,
          },
        },
      },
      required: ["kind", "title", "categories", "series"],
      additionalProperties: false,
    },
  },
];

export function runTool(repo: Repo, ro: DatabaseSync, name: string, input: unknown): ToolResult {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  try {
    switch (name) {
      case "list_projects": return toolListProjects(repo, sanitizeList(obj));
      case "get_project":
        if (typeof obj.project !== "string" || !obj.project.trim()) return { forModel: JSON.stringify({ error: "project is required" }), artifacts: [], isError: true };
        return toolGetProject(repo, { project: obj.project });
      case "portfolio_summary": return toolPortfolio(repo, { state: str(obj.state), scheme: str(obj.scheme), category: str(obj.category) });
      case "query_database":
        if (typeof obj.sql !== "string") return { forModel: JSON.stringify({ error: "sql is required" }), artifacts: [], isError: true };
        return toolQuery(ro, { sql: obj.sql, title: str(obj.title) });
      case "show_chart": return toolChart(obj);
      default: return { forModel: JSON.stringify({ error: `Unknown tool ${name}` }), artifacts: [], isError: true };
    }
  } catch (err) {
    return { forModel: JSON.stringify({ error: `Tool failed: ${(err as Error).message}` }), artifacts: [], isError: true };
  }
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 120) : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const strArr = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 8) : undefined);

function sanitizeList(o: Record<string, unknown>): ListFilters {
  const sort = str(o.sort_by);
  return {
    state: str(o.state), scheme: str(o.scheme), category: str(o.category),
    health: strArr(o.health), risk_level: strArr(o.risk_level),
    min_delay_days: num(o.min_delay_days), min_overrun_pct: num(o.min_overrun_pct),
    stalled: o.stalled === true || undefined, stale: o.stale === true || undefined,
    has_overdue_milestones: o.has_overdue_milestones === true || undefined,
    text: str(o.text),
    sort_by: (["risk", "delay", "overrun", "progress", "budget", "spi"] as const).find((s) => s === sort),
    limit: num(o.limit),
  };
}

export { cr };
