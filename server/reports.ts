// Progress report generation. A report = deterministic data sections (always
// correct, straight from the analytics) + a narrative (Claude when configured,
// otherwise a rule-based template). The narrative is told to use only the data.

import type Anthropic from "@anthropic-ai/sdk";
import type { DatabaseSync } from "node:sqlite";
import type { Portfolio, PortfolioFilters, ProjectDetail } from "./types.ts";
import type { Repo } from "./repo.ts";
import { NotFoundError, ValidationError } from "./repo.ts";
import { EFFORT, MODEL, describeError, fallbackParams } from "./llm/claude.ts";

const cr = (n: number) => `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} cr`;
const esc = (s: unknown) => String(s ?? "—").replace(/\|/g, "\\|").replace(/\n/g, " ");
const table = (head: string[], rows: unknown[][]) =>
  rows.length ? [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.map(esc).join(" | ")} |`)].join("\n") : "_None._";

export interface ReportRecord {
  id: number;
  scope: "portfolio" | "project";
  project_id: number | null;
  title: string;
  as_of: string;
  filters: string;
  body_md: string;
  data_json: string;
  generated_by: string;
  created_at: string;
}

interface Narrative {
  summary: string;
  concerns: string;
  actions: string;
  outlook: string;
  by: string;
  notice?: string;
}

// ---- Portfolio -------------------------------------------------------------------

function portfolioFacts(p: Portfolio, repo: Repo) {
  const focus = p.topRisks.slice(0, 6).map((r) => {
    const d = repo.detail(r.id);
    return {
      code: d.code, name: d.name, state: d.state, health: d.metrics.health, risk: d.metrics.riskScore,
      delay_days: d.metrics.delayDays, overrun_pct: d.metrics.cpiReliable ? d.metrics.overrunPct : null,
      flags: d.metrics.flags.map((f) => `${f.title}: ${f.detail}`),
      open_issues: d.issues.filter((i) => i.status !== "Resolved").map((i) => `[${i.severity}] ${i.category}: ${i.title}`),
      recommendations: d.metrics.recommendations.slice(0, 3).map((x) => `${x.priority}: ${x.action} (${x.owner})`),
    };
  });
  return { as_of: p.asOf, filters: p.filters, totals: p.totals, health: p.health, risk_levels: p.riskLevels, by_scheme: p.byScheme, by_state: p.byState.slice(0, 12), focus_projects: focus, milestones_due_60d: p.upcomingMilestones.slice(0, 10), overdue_milestones: p.overdueMilestones.slice(0, 10) };
}

function portfolioTemplate(p: Portfolio, repo: Repo): Narrative {
  const t = p.totals;
  const gap = Math.round((t.plannedPct - t.physicalPct) * 10) / 10;
  const worstState = [...p.byState].filter((g) => g.count >= 2).sort((a, z) => z.avgRisk - a.avgRisk)[0];
  const summary = [
    `The portfolio of ${t.projects} projects (approved cost ${cr(t.budgetCr)}) is ${t.physicalPct}% complete against ${t.plannedPct}% planned by ${p.asOf}${gap > 0 ? `, a gap of ${gap} percentage points` : ", ahead of plan"}.`,
    `${p.health["On track"]} projects are on track, ${p.health["At risk"]} at risk and ${p.health["Off track"]} off track; ${p.health.Completed} are complete${p.health["On hold"] ? ` and ${p.health["On hold"]} on hold` : ""}.`,
    `${t.delayed} projects are forecast to finish more than 30 days late, and ${t.overBudget} are forecast to exceed approved cost by more than 5%, adding about ${cr(t.forecastOverrunCr)}.`,
    `Funds utilisation stands at ${t.utilisationPct}% of approved cost, with ${cr(Math.max(0, t.releasedCr - t.spentCr))} released but not yet spent.`,
    worstState ? `${worstState.key} carries the highest average risk among states with more than one project (${worstState.avgRisk}/100).` : "",
  ].filter(Boolean).join(" ");
  const concerns = p.topRisks.slice(0, 5).map((r) => `- **${r.name}** (${r.code}, ${r.state}) — risk ${r.riskScore}/100, ${r.health.toLowerCase()}${r.topFlag ? `: ${r.topFlag.toLowerCase()}` : ""}${r.delayDays && r.delayDays > 0 ? `, forecast ${r.delayDays} days late` : ""}.`).join("\n");
  const actions = p.topRisks.slice(0, 5).flatMap((r) => repo.detail(r.id).metrics.recommendations.slice(0, 1).map((x) => `1. **${r.name.split(" — ")[0]} (${r.code})** — ${x.action} *Owner: ${x.owner}; ${x.priority.toLowerCase()}.*`)).join("\n");
  const outlook = `If current performance continues, the portfolio's forecast cost at completion is ${cr(t.eacCr)} against ${cr(t.budgetCr)} approved${t.weightedSpi !== null ? `, and the budget-weighted schedule performance index of ${t.weightedSpi} implies average slippage of roughly ${Math.round((1 / Math.max(0.1, t.weightedSpi) - 1) * 100)}% on remaining durations` : ""}. ${p.upcomingMilestones.length} milestones fall due in the next 60 days; ${p.overdueMilestones.length} are already overdue. Resolving the ${t.openCriticalIssues} open critical issues is the single largest lever on the schedule.`;
  return { summary, concerns: concerns || "- No significant concerns.", actions: actions || "1. Continue routine monthly monitoring.", outlook, by: "offline" };
}

// ---- Project -----------------------------------------------------------------------

function projectFacts(d: ProjectDetail) {
  const m = d.metrics;
  return {
    code: d.code, name: d.name, scheme: d.scheme, state: d.state, district: d.district, agency: d.implementing_agency,
    sanctioned_cr: d.sanctioned_cost_cr, revised_cr: d.revised_cost_cr, start: d.start_date, planned_end: d.planned_end_date,
    health: m.health, risk: m.riskScore, risk_breakdown: m.riskBreakdown, actual_pct: m.actualPct, planned_pct_today: m.plannedPctToday,
    spi: m.spi, cpi: m.cpiReliable ? m.cpi : null, spent_cr: m.spentCr, released_cr: m.releasedCr, eac_cr: m.eacCr, overrun_pct: m.overrunPct,
    forecast_end: m.forecastEnd, delay_days: m.delayDays, velocity: m.velocity, flags: m.flags, recommendations: m.recommendations,
    milestones: d.milestones.map((x) => ({ name: x.name, planned_end: x.planned_end, actual_end: x.actual_end, progress_pct: x.progress_pct })),
    issues: d.issues.map((i) => ({ severity: i.severity, status: i.status, category: i.category, title: i.title, owner: i.owner })),
    last_reports: d.reports.slice(-6).map((r) => ({ month: r.month, physical_pct: r.physical_pct, spent_cr: r.expenditure_cr, remarks: r.remarks })),
  };
}

function projectTemplate(d: ProjectDetail): Narrative {
  const m = d.metrics;
  const sched = m.health === "Completed"
    ? `The project was completed on ${d.actual_end_date ?? m.forecastEnd} against a planned date of ${d.planned_end_date}.`
    : `It is ${m.actualPct}% complete against ${m.plannedPctToday}% planned by ${m.asOf}${m.spi !== null ? ` (SPI ${m.spi.toFixed(2)})` : ""}, and is forecast to finish on ${m.forecastEnd}${m.delayDays && m.delayDays > 0 ? `, ${m.delayDays} days after the planned ${d.planned_end_date}` : ", in line with plan"}.`;
  const cost = m.cpiReliable
    ? `Spending of ${cr(m.spentCr)} against work worth ${cr((m.actualPct / 100) * m.budgetCr)} gives a CPI of ${m.cpi?.toFixed(2)}; at this rate the cost at completion would be ${cr(m.eacCr)} (${m.overrunPct >= 0 ? "+" : ""}${m.overrunPct}% on the approved ${cr(m.budgetCr)}).`
    : `${cr(m.spentCr)} has been spent so far; it is too early for a reliable cost forecast.`;
  return {
    summary: `**${d.name}** is rated **${m.health}** with a risk score of ${m.riskScore}/100. ${sched} ${cost}`,
    concerns: m.flags.length ? m.flags.map((f) => `- **${f.title}** — ${f.detail}`).join("\n") : "- No significant concerns.",
    actions: m.recommendations.length ? m.recommendations.map((r) => `1. ${r.action} *Owner: ${r.owner}; ${r.priority.toLowerCase()}. Why: ${r.rationale}*`).join("\n") : "1. Continue routine monthly monitoring.",
    outlook: m.health === "Completed" ? "The asset is complete; attention shifts to operations, maintenance and visitor outcomes." : `With progress of ${m.velocity ?? "n/a"} percentage points a month over the last quarter, ${m.stalled ? "the project will not finish without intervention" : `the remaining ${Math.round(100 - m.actualPct)}% of work would take about ${m.velocity && m.velocity > 0 ? Math.ceil((100 - m.actualPct) / m.velocity) : "an indeterminate number of"} months at the current pace`}.`,
    by: "offline",
  };
}

// ---- Claude narrative --------------------------------------------------------------

async function claudeNarrative(client: Anthropic, kind: "portfolio" | "project", facts: unknown): Promise<Narrative> {
  const prompt = `Write the narrative sections of a ${kind === "portfolio" ? "portfolio" : "project"} progress report for senior officials of a tourism ministry, using ONLY the data below. Do not invent figures. Money in ₹ crore (e.g. ₹12.40 cr). Refer to projects by name and code.

Return exactly four sections, each starting with the marker line shown, in Markdown:
@@SUMMARY
(an executive summary of 4–6 sentences: overall status, the biggest risk, the money position, what needs a decision)
@@CONCERNS
(3–6 bullet points of the most important delays, cost overruns and risks, each with the evidence)
@@ACTIONS
(a numbered list of 3–7 specific corrective measures: what, who owns it, by when; most urgent first)
@@OUTLOOK
(2–4 sentences on what happens if nothing changes, and the leading indicators to watch next month)

DATA (JSON):
${JSON.stringify(facts)}`;
  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: 8000,
    output_config: { effort: EFFORT },
    messages: [{ role: "user", content: prompt }],
    ...fallbackParams(),
  });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === "refusal") throw new Error("Claude declined to write this report.");
  const text = msg.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("");
  const grab = (k: string) => text.split(`@@${k}`)[1]?.split(/@@[A-Z]+/)[0]?.trim() ?? "";
  const n = { summary: grab("SUMMARY"), concerns: grab("CONCERNS"), actions: grab("ACTIONS"), outlook: grab("OUTLOOK") };
  if (!n.summary || !n.actions) throw new Error("Claude's report was missing required sections.");
  return { ...n, by: `claude (${msg.model})` };
}

async function narrative(client: Anthropic | null, kind: "portfolio" | "project", facts: unknown, template: () => Narrative): Promise<Narrative> {
  if (!client) return template();
  try {
    return await claudeNarrative(client, kind, facts);
  } catch (err) {
    return { ...template(), notice: `Claude was unavailable (${describeError(err)}), so the narrative was generated by the offline template.` };
  }
}

// ---- Public API ----------------------------------------------------------------------

export async function generateReport(db: DatabaseSync, repo: Repo, client: Anthropic | null, input: { scope?: string; projectId?: number; filters?: PortfolioFilters }): Promise<ReportRecord> {
  const scope = input.scope === "project" ? "project" : "portfolio";
  let title: string;
  let body: string;
  let data: unknown;
  let by: string;
  let asOf: string;
  let projectId: number | null = null;
  const filters: PortfolioFilters = {};

  if (scope === "project") {
    if (!input.projectId || !Number.isInteger(input.projectId)) throw new ValidationError({ projectId: "Choose a project." });
    const d = repo.detail(input.projectId); // throws NotFoundError
    projectId = d.id;
    asOf = d.metrics.asOf;
    const n = await narrative(client, "project", projectFacts(d), () => projectTemplate(d));
    by = n.by;
    const m = d.metrics;
    title = `Project progress report — ${d.name}`;
    data = { kind: "project", project: { id: d.id, code: d.code, name: d.name, state: d.state }, metrics: m, reports: d.reports, plannedSeries: d.plannedSeries };
    body = [
      n.notice ? `> ${n.notice}\n` : "",
      `## Executive summary\n\n${n.summary}`,
      `## Key figures\n\n${table(["Measure", "Value"], [
        ["Code / scheme", `${d.code} · ${d.scheme}`],
        ["Location", `${d.district}, ${d.state}`],
        ["Implementing agency", d.implementing_agency],
        ["Health · risk", `${m.health} · ${m.riskScore}/100 (${m.riskLevel})`],
        ["Physical progress", `${m.actualPct}% (planned ${m.plannedPctToday}%)`],
        ["Schedule performance (SPI)", m.spi?.toFixed(2) ?? "—"],
        ["Planned finish → forecast", `${d.planned_end_date} → ${m.forecastEnd ?? "—"}${m.delayDays && m.delayDays > 0 ? ` (+${m.delayDays} days)` : ""}`],
        ["Approved cost", `${cr(m.budgetCr)}${d.revised_cost_cr ? ` (sanctioned ${cr(d.sanctioned_cost_cr)})` : ""}`],
        ["Released · spent", `${cr(m.releasedCr)} · ${cr(m.spentCr)}`],
        ["Cost performance (CPI) · EAC", m.cpiReliable ? `${m.cpi?.toFixed(2)} · ${cr(m.eacCr)}` : "Not yet reliable"],
      ])}`,
      `## Concerns\n\n${n.concerns}`,
      `## Recommended corrective measures\n\n${n.actions}`,
      `## Milestones\n\n${table(["#", "Milestone", "Planned finish", "Actual finish", "Progress"], d.milestones.map((x) => [x.seq, x.name, x.planned_end, x.actual_end ?? "—", `${x.progress_pct}%`]))}`,
      `## Issues register\n\n${table(["Severity", "Status", "Category", "Issue", "Owner", "Raised"], d.issues.map((i) => [i.severity, i.status, i.category, i.title, i.owner, i.raised_on]))}`,
      `## Recent monthly reports\n\n${table(["Month", "Physical %", "Spent (₹ cr)", "Released (₹ cr)", "Remarks"], d.reports.slice(-6).reverse().map((r) => [r.month, r.physical_pct, r.expenditure_cr, r.funds_released_cr, r.remarks]))}`,
      `## Outlook\n\n${n.outlook}`,
      methodNote(),
    ].filter(Boolean).join("\n\n");
  } else {
    const facets = repo.facets();
    if (input.filters?.state && facets.states.includes(input.filters.state)) filters.state = input.filters.state;
    if (input.filters?.scheme && facets.schemes.includes(input.filters.scheme)) filters.scheme = input.filters.scheme;
    if (input.filters?.category && facets.categories.includes(input.filters.category)) filters.category = input.filters.category;
    const p = repo.portfolio(filters);
    if (!p.totals.projects) throw new ValidationError({ filters: "No projects match these filters." });
    asOf = p.asOf;
    const n = await narrative(client, "portfolio", portfolioFacts(p, repo), () => portfolioTemplate(p, repo));
    by = n.by;
    const scopeLabel = [filters.state, filters.scheme, filters.category].filter(Boolean).join(" · ") || "All projects";
    title = `Portfolio progress report — ${scopeLabel}`;
    const t = p.totals;
    data = { kind: "portfolio", totals: t, health: p.health, riskLevels: p.riskLevels, sCurve: p.sCurve, byState: p.byState, byScheme: p.byScheme };
    body = [
      n.notice ? `> ${n.notice}\n` : "",
      `## Executive summary\n\n${n.summary}`,
      `## Portfolio at a glance\n\n${table(["Measure", "Value"], [
        ["Projects", t.projects],
        ["Approved cost (sanctioned)", `${cr(t.budgetCr)} (${cr(t.sanctionedCr)})`],
        ["Released · spent · utilisation", `${cr(t.releasedCr)} · ${cr(t.spentCr)} · ${t.utilisationPct}%`],
        ["Physical progress (planned)", `${t.physicalPct}% (${t.plannedPct}%)`],
        ["Budget-weighted SPI", t.weightedSpi ?? "—"],
        ["Forecast cost at completion", `${cr(t.eacCr)} (+${cr(t.forecastOverrunCr)})`],
        ["Projects delayed > 30 days", t.delayed],
        ["Projects forecast > 5% over cost", t.overBudget],
        ["Open critical issues · overdue milestones", `${t.openCriticalIssues} · ${t.overdueMilestones}`],
      ])}`,
      `## Health\n\n${table(["On track", "At risk", "Off track", "On hold", "Not started", "Completed"], [[p.health["On track"], p.health["At risk"], p.health["Off track"], p.health["On hold"], p.health["Not started"], p.health.Completed]])}`,
      `## Key concerns\n\n${n.concerns}`,
      `## Recommended corrective measures\n\n${n.actions}`,
      `## Projects needing attention\n\n${table(["Code", "Project", "State", "Health", "Risk", "Delay (days)", "Forecast overrun", "Top concern"], p.topRisks.map((r) => [r.code, r.name, r.state, r.health, r.riskScore, r.delayDays ?? "—", `${r.overrunPct}%`, r.topFlag ?? "—"]))}`,
      `## By scheme\n\n${table(["Scheme", "Projects", "Approved (₹ cr)", "Spent (₹ cr)", "Physical %", "Delayed", "Forecast overrun (₹ cr)"], p.byScheme.map((g) => [g.key, g.count, g.budgetCr, g.spentCr, g.physicalPct, g.delayed, g.forecastOverrunCr]))}`,
      `## By state\n\n${table(["State", "Projects", "Approved (₹ cr)", "Physical %", "Delayed", "Off track", "Avg risk"], p.byState.map((g) => [g.key, g.count, g.budgetCr, g.physicalPct, g.delayed, g.offTrack, g.avgRisk]))}`,
      `## Milestones due in the next 60 days\n\n${table(["Due", "Project", "Milestone", "Progress", "Project health"], p.upcomingMilestones.slice(0, 20).map((m) => [m.plannedEnd, `${m.project} (${m.code})`, m.name, `${m.progressPct}%`, m.health]))}`,
      `## Overdue milestones\n\n${table(["Planned", "Days overdue", "Project", "Milestone"], p.overdueMilestones.slice(0, 20).map((m) => [m.plannedEnd, m.daysOverdue, `${m.project} (${m.code})`, m.name]))}`,
      `## Outlook\n\n${n.outlook}`,
      methodNote(),
    ].filter(Boolean).join("\n\n");
  }

  const res = db.prepare(`INSERT INTO reports (scope, project_id, title, as_of, filters, body_md, data_json, generated_by) VALUES (?,?,?,?,?,?,?,?)`)
    .run(scope, projectId, title, asOf, JSON.stringify(filters), body, JSON.stringify(data), by);
  return getReport(db, Number(res.lastInsertRowid));
}

function methodNote(): string {
  return `## Method\n\n_Schedule performance uses the earned-schedule method (SPI = time at which planned progress equals actual progress ÷ time elapsed). Cost performance uses earned value (CPI = value of work done ÷ actual spend; EAC = approved cost ÷ CPI), treated as unreliable below 10% physical progress. Forecast finish = start + planned duration ÷ SPI; stalled projects are forecast as if work resumed today at the planned pace. Risk score (0–100) sums schedule, delay, cost, open issues, overdue milestones, stalled work and stale reporting._`;
}

export function getReport(db: DatabaseSync, id: number): ReportRecord {
  const r = db.prepare("SELECT * FROM reports WHERE id = ?").get(id) as unknown as ReportRecord | undefined;
  if (!r) throw new NotFoundError(`Report ${id} not found`);
  return r;
}

export function listReports(db: DatabaseSync) {
  return db.prepare("SELECT id, scope, project_id, title, as_of, generated_by, created_at FROM reports ORDER BY id DESC LIMIT 200").all();
}
