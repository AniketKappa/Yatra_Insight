// Data access + an in-memory analytics cache that is rebuilt after every write.

import type { DatabaseSync } from "node:sqlite";
import type { Issue, Milestone, PortfolioFilters, ProgressReport, Project, ProjectDetail, ProjectView } from "./types.ts";
import { computeMetrics, computePortfolio, plannedSeries, type ProjectBundle } from "./analytics.ts";
import { isValidMonth, monthEnd, monthOf, todayISO } from "./lib/dates.ts";
import { tx } from "./db.ts";

export class ValidationError extends Error {
  fields: Record<string, string>;
  constructor(fields: Record<string, string>) {
    super(Object.values(fields)[0] ?? "Invalid input");
    this.fields = fields;
  }
}

export class NotFoundError extends Error {}

export class Repo {
  private db: DatabaseSync;
  private cache: { asOf: string; views: ProjectView[]; bundles: Map<number, ProjectBundle> } | null = null;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  invalidate() {
    this.cache = null;
  }

  private load(): Map<number, ProjectBundle> {
    const projects = this.db.prepare("SELECT * FROM projects ORDER BY id").all() as unknown as Project[];
    const milestones = this.db.prepare("SELECT * FROM milestones ORDER BY project_id, seq").all() as unknown as Milestone[];
    const reports = this.db.prepare("SELECT * FROM progress_reports ORDER BY project_id, month").all() as unknown as ProgressReport[];
    const issues = this.db.prepare("SELECT * FROM issues ORDER BY project_id, raised_on DESC").all() as unknown as Issue[];
    const map = new Map<number, ProjectBundle>();
    for (const p of projects) map.set(p.id, { project: p, milestones: [], reports: [], issues: [] });
    for (const m of milestones) map.get(m.project_id)?.milestones.push(m);
    for (const r of reports) map.get(r.project_id)?.reports.push(r);
    for (const i of issues) map.get(i.project_id)?.issues.push(i);
    return map;
  }

  /** Recompute every project's metrics and persist them (the LLM queries project_metrics via SQL). */
  state() {
    const asOf = todayISO();
    if (this.cache && this.cache.asOf === asOf) return this.cache;
    const bundles = this.load();
    const views: ProjectView[] = [];
    for (const b of bundles.values()) views.push({ ...b.project, metrics: computeMetrics(b, asOf) });

    const ins = this.db.prepare(`INSERT OR REPLACE INTO project_metrics
      (project_id, as_of, health, risk_score, risk_level, planned_pct, actual_pct, spi, cpi, budget_cr, spent_cr,
       utilisation_pct, eac_cr, forecast_overrun_cr, overrun_pct, escalation_pct, forecast_end_date, delay_days,
       velocity_pp_per_month, overdue_milestones, open_issues, critical_issues, last_report_month, days_since_update, flags)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    tx(this.db, () => {
      this.db.exec("DELETE FROM project_metrics");
      for (const v of views) {
        const m = v.metrics;
        ins.run(v.id, asOf, m.health, m.riskScore, m.riskLevel, m.plannedPctToday, m.actualPct, m.spi, m.cpiReliable ? m.cpi : null,
          m.budgetCr, m.spentCr, m.utilisationPct, m.eacCr, m.forecastOverrunCr, m.overrunPct, m.escalationPct,
          m.forecastEnd, m.delayDays, m.velocity, m.overdueMilestones.length, m.openIssues, m.criticalIssues,
          m.lastReportMonth, m.daysSinceUpdate, JSON.stringify(m.flags.map((f) => f.code)));
      }
    });
    this.cache = { asOf, views, bundles };
    return this.cache;
  }

  views(): ProjectView[] {
    return this.state().views;
  }

  portfolio(filters: PortfolioFilters = {}) {
    const s = this.state();
    return computePortfolio(s.views, s.bundles, filters, s.asOf);
  }

  detail(id: number): ProjectDetail {
    const s = this.state();
    const view = s.views.find((v) => v.id === id);
    const b = s.bundles.get(id);
    if (!view || !b) throw new NotFoundError(`Project ${id} not found`);
    return { ...view, milestones: b.milestones, reports: b.reports, issues: b.issues, plannedSeries: plannedSeries(b.project) };
  }

  /** Resolve a project from a code, id or loose name ("hampi", "SD2-KA-0110"). */
  findProject(ref: string | number): ProjectView | null {
    const views = this.views();
    if (typeof ref === "number" || /^\d+$/.test(String(ref))) {
      return views.find((v) => v.id === Number(ref)) ?? null;
    }
    const q = String(ref).toLowerCase().trim();
    if (!q) return null;
    const exact = views.find((v) => v.code.toLowerCase() === q);
    if (exact) return exact;
    const scored = views
      .map((v) => {
        const hay = `${v.code} ${v.name} ${v.destination} ${v.district}`.toLowerCase();
        const tokens = q.split(/[\s,–—-]+/).filter((t) => t.length > 1);
        const hits = tokens.filter((t) => hay.includes(t)).length;
        const destHit = v.destination.toLowerCase().includes(q) || q.includes(v.destination.toLowerCase().split(" ")[0]) ? 2 : 0;
        return { v, score: tokens.length ? hits / tokens.length + destHit : destHit };
      })
      .filter((x) => x.score >= 0.6)
      .sort((a, z) => z.score - a.score);
    return scored[0]?.v ?? null;
  }

  facets() {
    const views = this.views();
    const uniq = (fn: (v: ProjectView) => string) => [...new Set(views.map(fn))].sort();
    return { states: uniq((v) => v.state), schemes: uniq((v) => v.scheme), categories: uniq((v) => v.category) };
  }

  // ---- Writes ----------------------------------------------------------------

  addProgressReport(projectId: number, input: Record<string, unknown>) {
    const project = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as unknown as Project | undefined;
    if (!project) throw new NotFoundError(`Project ${projectId} not found`);
    const reports = this.db.prepare("SELECT * FROM progress_reports WHERE project_id = ? ORDER BY month").all(projectId) as unknown as ProgressReport[];

    const errors: Record<string, string> = {};
    const month = String(input.month ?? "");
    const physical = Number(input.physical_pct);
    const spent = Number(input.expenditure_cr);
    const releasedRaw = input.funds_released_cr;
    const released = releasedRaw === undefined || releasedRaw === "" || releasedRaw === null ? null : Number(releasedRaw);
    const remarks = String(input.remarks ?? "").trim().slice(0, 1000);
    const reportedBy = String(input.reported_by ?? "").trim().slice(0, 120);
    const today = todayISO();

    if (!isValidMonth(month)) errors.month = "Choose the reporting month (YYYY-MM).";
    else {
      if (month > monthOf(today)) errors.month = "You can't report progress for a future month.";
      else if (monthEnd(month) < project.start_date.slice(0, 8) + "01") errors.month = `The project started in ${monthOf(project.start_date)}; pick that month or later.`;
    }
    if (!Number.isFinite(physical) || physical < 0 || physical > 100) errors.physical_pct = "Enter physical progress between 0 and 100.";
    if (!Number.isFinite(spent) || spent < 0) errors.expenditure_cr = "Enter cumulative expenditure in ₹ crore (0 or more).";
    if (released !== null && (!Number.isFinite(released) || released < 0)) errors.funds_released_cr = "Enter cumulative funds released in ₹ crore, or leave it blank.";
    if (!reportedBy) errors.reported_by = "Enter the name of the reporting officer.";

    if (!errors.month && !errors.physical_pct && !errors.expenditure_cr) {
      const before = [...reports].filter((r) => r.month < month).at(-1);
      const after = reports.find((r) => r.month > month);
      if (before && physical < before.physical_pct) errors.physical_pct = `Progress is cumulative and can't fall below ${before.physical_pct}% (reported for ${before.month}).`;
      if (after && physical > after.physical_pct) errors.physical_pct = `Progress can't exceed ${after.physical_pct}%, the figure already reported for the later month ${after.month}.`;
      if (before && spent < before.expenditure_cr) errors.expenditure_cr = `Expenditure is cumulative and can't fall below ₹${before.expenditure_cr} cr (reported for ${before.month}).`;
      if (after && spent > after.expenditure_cr) errors.expenditure_cr = `Expenditure can't exceed ₹${after.expenditure_cr} cr, already reported for ${after.month}.`;
      const budget = project.revised_cost_cr ?? project.sanctioned_cost_cr;
      if (spent > budget * 3) errors.expenditure_cr = `₹${spent} cr is more than three times the approved cost (₹${budget} cr). Check the unit — figures are in crore.`;
    }
    if (Object.keys(errors).length) throw new ValidationError(errors);

    const prev = [...reports].filter((r) => r.month < month).at(-1);
    const releasedFinal = released ?? prev?.funds_released_cr ?? 0;
    const existing = reports.find((r) => r.month === month);
    tx(this.db, () => {
      if (existing) {
        this.db.prepare(`UPDATE progress_reports SET physical_pct=?, expenditure_cr=?, funds_released_cr=?, remarks=?, reported_by=?, reported_at=? WHERE id=?`)
          .run(physical, spent, releasedFinal, remarks, reportedBy, today, existing.id);
      } else {
        this.db.prepare(`INSERT INTO progress_reports (project_id, month, physical_pct, expenditure_cr, funds_released_cr, remarks, reported_by, reported_at) VALUES (?,?,?,?,?,?,?,?)`)
          .run(projectId, month, physical, spent, releasedFinal, remarks, reportedBy, today);
      }
      // Keep project status and milestone progress consistent with the new figure.
      const latest = this.db.prepare("SELECT physical_pct FROM progress_reports WHERE project_id = ? ORDER BY month DESC LIMIT 1").get(projectId) as { physical_pct: number };
      if (latest.physical_pct >= 100) {
        this.db.prepare("UPDATE projects SET status='Completed', actual_end_date=COALESCE(actual_end_date, ?) WHERE id=?").run(today, projectId);
      } else if (project.status === "Not started" || project.status === "Completed") {
        this.db.prepare("UPDATE projects SET status='In progress', actual_end_date=NULL WHERE id=?").run(projectId);
      }
      const ms = this.db.prepare("SELECT * FROM milestones WHERE project_id = ? ORDER BY seq").all(projectId) as unknown as Milestone[];
      let cum = 0;
      for (const m of ms) {
        const startCum = cum;
        cum += m.weight_pct;
        const prog = Math.round(Math.min(100, Math.max(0, ((latest.physical_pct - startCum) / m.weight_pct) * 100)));
        const done = latest.physical_pct >= cum - 0.05;
        this.db.prepare("UPDATE milestones SET progress_pct=?, actual_start=COALESCE(actual_start, CASE WHEN ? > 0 THEN ? END), actual_end=CASE WHEN ? THEN COALESCE(actual_end, ?) ELSE NULL END WHERE id=?")
          .run(done ? 100 : prog, prog, today, done ? 1 : 0, today, m.id);
      }
    });
    this.invalidate();
    return this.detail(projectId);
  }

  addIssue(projectId: number, input: Record<string, unknown>) {
    if (!this.db.prepare("SELECT id FROM projects WHERE id=?").get(projectId)) throw new NotFoundError(`Project ${projectId} not found`);
    const errors: Record<string, string> = {};
    const title = String(input.title ?? "").trim().slice(0, 200);
    const category = String(input.category ?? "").trim().slice(0, 60);
    const severity = String(input.severity ?? "");
    const description = String(input.description ?? "").trim().slice(0, 2000);
    const owner = String(input.owner ?? "").trim().slice(0, 120);
    if (!title) errors.title = "Give the issue a short title.";
    if (!category) errors.category = "Choose a category.";
    if (!["Low", "Medium", "High", "Critical"].includes(severity)) errors.severity = "Choose a severity.";
    if (!owner) errors.owner = "Name who owns the resolution.";
    if (Object.keys(errors).length) throw new ValidationError(errors);
    this.db.prepare(`INSERT INTO issues (project_id, category, severity, status, title, description, owner, raised_on) VALUES (?,?,?,?,?,?,?,?)`)
      .run(projectId, category, severity, "Open", title, description || title, owner, todayISO());
    this.invalidate();
    return this.detail(projectId);
  }

  updateIssueStatus(issueId: number, status: string) {
    if (!["Open", "Mitigating", "Resolved"].includes(status)) throw new ValidationError({ status: "Status must be Open, Mitigating or Resolved." });
    const row = this.db.prepare("SELECT project_id FROM issues WHERE id=?").get(issueId) as { project_id: number } | undefined;
    if (!row) throw new NotFoundError(`Issue ${issueId} not found`);
    this.db.prepare("UPDATE issues SET status=?, resolved_on=? WHERE id=?").run(status, status === "Resolved" ? todayISO() : null, issueId);
    this.invalidate();
    return this.detail(row.project_id);
  }
}
