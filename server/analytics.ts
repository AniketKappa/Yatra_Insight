// Project and portfolio analytics. Pure functions over plain rows: no I/O, so
// they are easy to test and to reuse from the API, the LLM tools and reports.
//
// Methods
//  - Schedule: Earned Schedule (Lipke). ES = the time at which the planned curve
//    reached today's actual progress. SPI(t) = ES / actual time. Unlike the
//    classic % based SPI it does not drift back to 1.0 as a late project ends.
//  - Cost: Earned Value. EV = actual% x budget, CPI = EV / actual cost,
//    EAC = budget / CPI. CPI is treated as unreliable below 10% progress
//    because mobilisation advances distort it.
//  - Forecast finish = start + planned duration / SPI(t); if work is stalled,
//    forecast assumes work resumes today at the planned pace.

import type {
  Flag, Health, Issue, Metrics, Milestone, Portfolio, PortfolioFilters, ProgressReport, Project,
  ProjectView, Recommendation, RiskComponent, RiskLevel, GroupStat,
} from "./types.ts";
import { addDays, daysBetween, monthEnd, monthOf, monthRange, parseDate } from "./lib/dates.ts";
import { inverseSCurve, plannedFinancialFraction, plannedPctAt } from "./lib/curves.ts";

const round = (n: number, dp = 2) => Math.round(n * 10 ** dp) / 10 ** dp;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export const THRESHOLDS = {
  staleDays: 45,
  veryStaleDays: 90,
  stalledVelocity: 0.4, // percentage points per month
  minReliableProgressForCpi: 10,
  upcomingWindowDays: 60,
  milestoneGraceDays: 14,
  delayedDays: 30,
  overBudgetPct: 5,
};

export interface ProjectBundle {
  project: Project;
  milestones: Milestone[];
  reports: ProgressReport[]; // ascending by month
  issues: Issue[];
}

export function computeMetrics(b: ProjectBundle, asOf: string): Metrics {
  const p = b.project;
  const reports = [...b.reports].sort((x, y) => x.month.localeCompare(y.month));
  const last = reports.at(-1) ?? null;
  const totalDays = Math.max(1, daysBetween(p.start_date, p.planned_end_date));
  const budget = p.revised_cost_cr ?? p.sanctioned_cost_cr;
  const actualPct = last?.physical_pct ?? 0;
  const spent = last?.expenditure_cr ?? 0;
  const released = last?.funds_released_cr ?? 0;
  const reportDate = last ? monthEnd(last.month) : null;
  const started = parseDate(p.start_date) <= parseDate(asOf);
  const isCompleted = p.status === "Completed" || actualPct >= 100;

  // ---- Schedule ------------------------------------------------------------
  const plannedPctToday = round(plannedPctAt(p.start_date, p.planned_end_date, asOf), 1);
  const plannedPctAtReport = reportDate ? round(plannedPctAt(p.start_date, p.planned_end_date, reportDate), 1) : null;

  let velocity: number | null = null;
  if (reports.length >= 2) {
    const window = reports.slice(-4); // up to 3 months of change
    const first = window[0];
    const months = Math.max(1, monthRange(first.month, last!.month).length - 1);
    velocity = round((last!.physical_pct - first.physical_pct) / months, 2);
  }

  let spi: number | null = null;
  let forecastEnd: string | null = null;
  let forecastBasis: Metrics["forecastBasis"] = "none";
  let stalled = false;

  if (isCompleted) {
    forecastEnd = p.actual_end_date ?? reportDate ?? asOf;
    forecastBasis = "actual";
    const actualDuration = Math.max(1, daysBetween(p.start_date, forecastEnd));
    spi = round(totalDays / actualDuration, 2);
  } else if (!started) {
    forecastEnd = p.planned_end_date;
    forecastBasis = "plan";
  } else {
    const at = reportDate ? daysBetween(p.start_date, reportDate) : daysBetween(p.start_date, asOf);
    const es = inverseSCurve(actualPct / 100) * totalDays;
    if (at > 0 && reportDate) spi = round(clamp(es / at, 0, 3), 2);

    stalled =
      p.status === "On hold" ||
      (actualPct > 0 && velocity !== null && velocity < THRESHOLDS.stalledVelocity && reports.length >= 3);

    if (stalled || spi === null || spi < 0.05) {
      // Work resumes today at the planned pace for the remaining planned duration.
      forecastEnd = addDays(asOf, totalDays - es);
      forecastBasis = "resume-at-plan";
    } else if (at < 60) {
      forecastEnd = p.planned_end_date; // too early to extrapolate
      forecastBasis = "plan";
    } else {
      forecastEnd = addDays(p.start_date, totalDays / spi);
      forecastBasis = "earned-schedule";
    }
    if (parseDate(forecastEnd) <= parseDate(asOf)) forecastEnd = addDays(asOf, 15); // incomplete work cannot finish in the past
  }

  let delayDays: number | null = forecastEnd ? daysBetween(p.planned_end_date, forecastEnd) : null;
  if (!isCompleted && started && delayDays !== null && parseDate(asOf) > parseDate(p.planned_end_date)) {
    delayDays = Math.max(delayDays, daysBetween(p.planned_end_date, asOf));
  }
  if (!started) delayDays = 0;

  // ---- Cost ----------------------------------------------------------------
  const ev = (actualPct / 100) * budget;
  const cpiReliable = actualPct >= THRESHOLDS.minReliableProgressForCpi && spent > 0;
  const cpi = spent > 0 && ev > 0 ? round(ev / spent, 2) : null;
  let eac: number;
  if (isCompleted) eac = spent;
  else if (cpiReliable && cpi) eac = budget / cpi;
  else eac = Math.max(budget, spent);
  eac = round(eac, 2);
  const forecastOverrunCr = round(eac - budget, 2);
  const overrunPct = round(((eac - budget) / budget) * 100, 1);
  const escalationPct = p.revised_cost_cr ? round(((p.revised_cost_cr - p.sanctioned_cost_cr) / p.sanctioned_cost_cr) * 100, 1) : 0;
  const utilisationPct = round((spent / budget) * 100, 1);

  // ---- Milestones, issues, freshness ---------------------------------------
  const overdueMilestones = b.milestones
    .filter((m) => !m.actual_end && daysBetween(m.planned_end, asOf) > THRESHOLDS.milestoneGraceDays)
    .map((m) => ({ id: m.id, name: m.name, plannedEnd: m.planned_end, daysOverdue: daysBetween(m.planned_end, asOf) }))
    .sort((a, z) => z.daysOverdue - a.daysOverdue);
  const upcomingMilestones = b.milestones
    .filter((m) => {
      if (m.actual_end) return false;
      const d = daysBetween(asOf, m.planned_end);
      return d >= 0 && d <= THRESHOLDS.upcomingWindowDays;
    })
    .map((m) => ({ id: m.id, name: m.name, plannedEnd: m.planned_end, daysToGo: daysBetween(asOf, m.planned_end), progressPct: m.progress_pct }));

  const openIssues = b.issues.filter((i) => i.status !== "Resolved");
  const criticalIssues = openIssues.filter((i) => i.severity === "Critical").length;
  const highIssues = openIssues.filter((i) => i.severity === "High").length;
  const mediumIssues = openIssues.filter((i) => i.severity === "Medium").length;

  const daysSinceUpdate = last ? daysBetween(last.reported_at, asOf) : started ? daysBetween(p.start_date, asOf) : null;
  const activeForReporting = !isCompleted && started;

  // ---- Risk score (explainable) --------------------------------------------
  const breakdown: RiskComponent[] = [];
  const add = (factor: string, points: number, max: number, note: string) => {
    const pts = round(clamp(points, 0, max), 1);
    breakdown.push({ factor, points: pts, max, note });
  };
  if (activeForReporting) {
    add("Schedule performance", spi === null ? 0 : (1 - spi) * 100, 30, spi === null ? "Not enough data" : `SPI ${spi.toFixed(2)}`);
    add("Forecast delay", ((delayDays ?? 0) / 365) * 25, 25, delayDays !== null ? `${Math.max(0, delayDays)} days beyond planned finish` : "Not forecastable");
    add("Cost overrun", cpiReliable ? overrunPct * 0.8 + escalationPct * 0.25 : escalationPct * 0.25, 20,
      cpiReliable ? `${overrunPct.toFixed(1)}% forecast overrun, ${escalationPct.toFixed(1)}% escalation` : "CPI not yet reliable");
    add("Open issues", criticalIssues * 8 + highIssues * 4 + mediumIssues * 1.5, 20, `${criticalIssues} critical, ${highIssues} high, ${mediumIssues} medium`);
    add("Overdue milestones", overdueMilestones.length * 3, 10, `${overdueMilestones.length} overdue`);
    add("Stalled work", stalled ? 10 : 0, 10, stalled ? `Velocity ${velocity ?? 0} pp/month` : "Progressing");
    add("Stale reporting", (daysSinceUpdate ?? 0) > THRESHOLDS.veryStaleDays ? 10 : (daysSinceUpdate ?? 0) > THRESHOLDS.staleDays ? 5 : 0, 10,
      daysSinceUpdate !== null ? `Last update ${daysSinceUpdate} days ago` : "No reports");
  } else if (!started) {
    const lateStart = daysBetween(p.start_date, asOf);
    add("Open issues", criticalIssues * 8 + highIssues * 4 + mediumIssues * 1.5, 20, `${openIssues.length} open`);
    add("Start slippage", lateStart > 0 ? (lateStart / 180) * 20 : 0, 20, lateStart > 0 ? `${lateStart} days past planned start` : "Starts as planned");
  }
  const riskScore = Math.round(clamp(breakdown.reduce((s, c) => s + c.points, 0), 0, 100));
  const riskLevel: RiskLevel = riskScore >= 60 ? "Critical" : riskScore >= 40 ? "High" : riskScore >= 20 ? "Moderate" : "Low";

  // ---- Flags ---------------------------------------------------------------
  const flags: Flag[] = [];
  const startOverdue = !reports.length && p.status === "Not started" ? daysBetween(p.start_date, asOf) : 0;

  if (activeForReporting) {
    if (stalled) flags.push({ code: "STALLED", severity: "critical", title: p.status === "On hold" ? "Project on hold" : "Work has stalled", detail: `Physical progress moved ${velocity ?? 0} percentage points per month over the last quarter (threshold ${THRESHOLDS.stalledVelocity}).` });
    if (delayDays !== null && delayDays > 180) flags.push({ code: "SEVERE_DELAY", severity: "critical", title: "Severe schedule slippage", detail: `Forecast to finish ${delayDays} days after the planned date (${p.planned_end_date}).` });
    else if (delayDays !== null && delayDays > THRESHOLDS.delayedDays) flags.push({ code: "DELAY", severity: delayDays > 90 ? "high" : "medium", title: "Behind schedule", detail: `Forecast to finish ${delayDays} days late${spi !== null ? ` (SPI ${spi.toFixed(2)})` : ""}.` });
    if (cpiReliable && overrunPct > 15) flags.push({ code: "COST_OVERRUN", severity: overrunPct > 25 ? "critical" : "high", title: "Cost overrun forecast", detail: `Estimate at completion ₹${eac.toFixed(2)} cr vs approved ₹${budget.toFixed(2)} cr (+${overrunPct.toFixed(1)}%, CPI ${cpi?.toFixed(2)}).` });
    else if (cpiReliable && overrunPct > THRESHOLDS.overBudgetPct) flags.push({ code: "COST_PRESSURE", severity: "medium", title: "Cost pressure", detail: `Spending is running ahead of work done (CPI ${cpi?.toFixed(2)}); forecast +${overrunPct.toFixed(1)}%.` });
    if (escalationPct > 0) flags.push({ code: "ESCALATION", severity: escalationPct > 15 ? "high" : "medium", title: "Cost revised upward", detail: `Approved cost revised from ₹${p.sanctioned_cost_cr.toFixed(2)} cr to ₹${budget.toFixed(2)} cr (+${escalationPct.toFixed(1)}%).` });
    if (overdueMilestones.length) flags.push({ code: "MILESTONE_OVERDUE", severity: overdueMilestones[0].daysOverdue > 90 ? "high" : "medium", title: `${overdueMilestones.length} milestone${overdueMilestones.length > 1 ? "s" : ""} overdue`, detail: `"${overdueMilestones[0].name}" is ${overdueMilestones[0].daysOverdue} days past its planned date.` });
    if (criticalIssues) flags.push({ code: "CRITICAL_ISSUE", severity: "critical", title: `${criticalIssues} critical issue${criticalIssues > 1 ? "s" : ""} open`, detail: openIssues.filter((i) => i.severity === "Critical").map((i) => `${i.category}: ${i.title}`).join("; ") });
    if ((daysSinceUpdate ?? 0) > THRESHOLDS.staleDays) flags.push({ code: "STALE_DATA", severity: (daysSinceUpdate ?? 0) > THRESHOLDS.veryStaleDays ? "high" : "medium", title: "Progress report overdue", detail: last ? `Last report (${last.month}) was filed ${daysSinceUpdate} days ago; figures may be out of date.` : `No progress report filed since the start date (${p.start_date}).` });
    if (released - spent > budget * 0.3 && (velocity ?? 0) < 2) flags.push({ code: "IDLE_FUNDS", severity: "medium", title: "Released funds lying unspent", detail: `₹${(released - spent).toFixed(2)} cr released but not spent while progress is slow.` });
    if (spent > released + 0.01 && released > 0) flags.push({ code: "DATA_QUALITY", severity: "low", title: "Expenditure exceeds funds released", detail: `Reported spend ₹${spent.toFixed(2)} cr exceeds releases ₹${released.toFixed(2)} cr; verify figures or bridge financing.` });
    if (spent > budget) flags.push({ code: "OVERSPENT", severity: "critical", title: "Spending exceeds approved cost", detail: `₹${spent.toFixed(2)} cr spent against ₹${budget.toFixed(2)} cr approved.` });
  }
  if (startOverdue > 30) flags.push({ code: "START_DELAYED", severity: startOverdue > 120 ? "high" : "medium", title: "Start delayed", detail: `Planned start ${p.start_date} has passed by ${startOverdue} days with no progress reported.` });
  const severityRank = { critical: 0, high: 1, medium: 2, low: 3 };
  flags.sort((a, z) => severityRank[a.severity] - severityRank[z.severity]);

  // ---- Health --------------------------------------------------------------
  let health: Health;
  if (isCompleted) health = "Completed";
  else if (p.status === "On hold") health = "On hold";
  else if (!started || (p.status === "Not started" && !reports.length)) health = startOverdue > 90 ? "At risk" : "Not started";
  else if (stalled || (spi !== null && spi < 0.8) || (delayDays ?? 0) > 180 || (cpiReliable && overrunPct > 20) || riskScore >= 60) health = "Off track";
  else if ((spi !== null && spi < 0.93) || (delayDays ?? 0) > 45 || (cpiReliable && overrunPct > 8) || riskScore >= 35 || (daysSinceUpdate ?? 0) > THRESHOLDS.veryStaleDays) health = "At risk";
  else health = "On track";

  const metrics: Metrics = {
    asOf, health, riskScore, riskLevel, riskBreakdown: breakdown,
    plannedPctAtReport, plannedPctToday, actualPct,
    spi, cpi, cpiReliable, budgetCr: round(budget), spentCr: round(spent), releasedCr: round(released),
    utilisationPct, eacCr: eac, forecastOverrunCr, overrunPct, escalationPct,
    forecastEnd, forecastBasis, delayDays, velocity, stalled,
    overdueMilestones, upcomingMilestones,
    openIssues: openIssues.length, criticalIssues,
    lastReportMonth: last?.month ?? null, lastReportedAt: last?.reported_at ?? null, daysSinceUpdate,
    flags, recommendations: [],
  };
  metrics.recommendations = recommend(p, metrics, openIssues);
  return metrics;
}

// ---- Corrective measures -----------------------------------------------------

const ISSUE_PLAYBOOK: Record<string, { action: string; owner: string }> = {
  "Land acquisition": { action: "Escalate the land encumbrance to the District Collector for a time-bound decision, and re-phase works to continue on unencumbered fronts meanwhile.", owner: "District Collector" },
  "Statutory clearance": { action: "Seek a review meeting with the regional clearance authority, track the proposal weekly, and resequence works that do not need the clearance.", owner: "State Forest / Environment Dept." },
  Litigation: { action: "Request an early hearing or vacation of the stay through the government counsel, and prepare an alternate work plan for unaffected components.", owner: "Law Department" },
  "Utility shifting": { action: "Convene a joint site inspection with the utility agency and deposit the shifting estimate so the work front is released.", owner: "Implementing Agency" },
  "Contractor performance": { action: "Issue a final notice under the contract with a 15-day cure period; if labour is not restored, initiate termination and risk-and-cost re-tendering.", owner: "Implementing Agency" },
  "Funds release": { action: "Resubmit the utilisation certificate with compliance on all observations so the next tranche can be released without further delay.", owner: "State Tourism Department" },
  "Design change": { action: "Freeze the scope; route any further changes through the technical committee with a cost and time impact note.", owner: "Technical Committee" },
  "Price escalation": { action: "Verify price-variation claims strictly against the contract formula and published indices before admitting them.", owner: "Executive Engineer" },
  Weather: { action: "Approve a catch-up plan with additional shifts for the dry season and pre-stock critical materials.", owner: "Contractor" },
  Approvals: { action: "Fix a decision date with the approving committee and escalate if it is missed.", owner: "Nodal Officer" },
  "Material supply": { action: "Identify alternate approved suppliers and expedite permit renewals with the mining department.", owner: "Contractor" },
};

function recommend(p: Project, m: Metrics, openIssues: Issue[]): Recommendation[] {
  const out: Recommendation[] = [];
  const has = (code: string) => m.flags.some((f) => f.code === code);

  for (const issue of [...openIssues].sort((a, b) => sevOrder(a.severity) - sevOrder(b.severity))) {
    const play = ISSUE_PLAYBOOK[issue.category];
    if (!play || out.some((r) => r.action === play.action)) continue;
    out.push({
      action: play.action,
      rationale: `Open ${issue.severity.toLowerCase()} issue: ${issue.title}.`,
      owner: play.owner,
      priority: issue.severity === "Critical" ? "Immediate" : issue.severity === "High" ? "Within 30 days" : "Next review",
      flag: "ISSUE",
    });
  }
  if (has("STALLED") && !openIssues.some((i) => i.category === "Contractor performance" || i.category === "Funds release")) {
    out.push({ action: "Hold a site review within 7 days to establish why work has stopped, and record a recovery plan with dated commitments.", rationale: "No measurable progress in the last quarter.", owner: "Nodal Officer", priority: "Immediate", flag: "STALLED" });
  }
  if (has("SEVERE_DELAY") || has("DELAY")) {
    out.push({
      action: "Require a revised catch-up schedule with weekly targets, extra shifts on critical-path activities, and fortnightly review by the nodal officer.",
      rationale: `Forecast finish ${m.forecastEnd} vs planned ${p.planned_end_date} (${m.delayDays} days late).`,
      owner: "Implementing Agency", priority: has("SEVERE_DELAY") ? "Immediate" : "Within 30 days", flag: has("SEVERE_DELAY") ? "SEVERE_DELAY" : "DELAY",
    });
    if ((m.delayDays ?? 0) > 180 && !p.revised_cost_cr) {
      out.push({ action: "Assess liquidated damages for contractor-attributable delay, and process an extension of time only for delays caused by the employer.", rationale: "Long slippage without a recorded time extension.", owner: "Executive Engineer", priority: "Within 30 days", flag: "SEVERE_DELAY" });
    }
  }
  if (has("COST_OVERRUN") || has("COST_PRESSURE")) {
    out.push({ action: "Commission a value-engineering review of balance works before any revised cost estimate is approved; freeze non-essential scope.", rationale: `CPI ${m.cpi?.toFixed(2)}; estimate at completion ₹${m.eacCr.toFixed(2)} cr vs ₹${m.budgetCr.toFixed(2)} cr approved.`, owner: "Technical Committee", priority: has("COST_OVERRUN") ? "Immediate" : "Next review", flag: has("COST_OVERRUN") ? "COST_OVERRUN" : "COST_PRESSURE" });
  }
  if (has("MILESTONE_OVERDUE")) {
    const o = m.overdueMilestones[0];
    out.push({ action: `Hold a milestone review for "${o.name}" and fix a new accountable completion date.`, rationale: `${o.daysOverdue} days past its planned date of ${o.plannedEnd}.`, owner: "Nodal Officer", priority: o.daysOverdue > 90 ? "Immediate" : "Within 30 days", flag: "MILESTONE_OVERDUE" });
  }
  if (has("STALE_DATA")) {
    out.push({ action: "Direct the agency to file the overdue monthly progress report with geo-tagged site photographs before the next review.", rationale: `Last update ${m.daysSinceUpdate} days ago; decisions are being made on old data.`, owner: "Implementing Agency", priority: "Immediate", flag: "STALE_DATA" });
  }
  if (has("IDLE_FUNDS")) {
    out.push({ action: "Review the unspent balance and re-align the release schedule to actual progress, or reallocate within the scheme.", rationale: `₹${(m.releasedCr - m.spentCr).toFixed(2)} cr released but unspent.`, owner: "State Tourism Department", priority: "Next review", flag: "IDLE_FUNDS" });
  }
  if (has("START_DELAYED")) {
    out.push({ action: "Fast-track tender finalisation and site handover; set a firm date for the work order.", rationale: "Planned start date has passed without mobilisation.", owner: "Implementing Agency", priority: "Within 30 days", flag: "START_DELAYED" });
  }
  if (has("DATA_QUALITY")) {
    out.push({ action: "Reconcile expenditure with fund releases in the next report.", rationale: "Reported spend exceeds funds released.", owner: "Finance Officer", priority: "Next review", flag: "DATA_QUALITY" });
  }
  if (m.health === "On track" && m.actualPct >= 80) {
    out.push({ action: "Finalise the operations and maintenance arrangement and the handover protocol ahead of commissioning.", rationale: `${m.actualPct.toFixed(0)}% complete and on schedule.`, owner: "State Tourism Department", priority: "Next review", flag: "NEAR_COMPLETION" });
  }
  if (m.health === "Completed") {
    out.push({ action: "Carry out a post-completion evaluation and start tracking footfall and revenue against the DPR projections.", rationale: "Asset is complete; outcomes now matter more than outputs.", owner: "State Tourism Department", priority: "Next review", flag: "COMPLETED" });
  }
  const prio = { Immediate: 0, "Within 30 days": 1, "Next review": 2 };
  return out.sort((a, b) => prio[a.priority] - prio[b.priority]);
}

function sevOrder(s: Issue["severity"]): number {
  return { Critical: 0, High: 1, Medium: 2, Low: 3 }[s];
}

// ---- Planned series for charts ------------------------------------------------

export function plannedSeries(p: Project): { month: string; plannedPct: number; plannedSpendCr: number }[] {
  const budget = p.revised_cost_cr ?? p.sanctioned_cost_cr;
  return monthRange(monthOf(p.start_date), monthOf(p.planned_end_date)).map((month) => {
    const end = monthEnd(month) > p.planned_end_date ? p.planned_end_date : monthEnd(month);
    return {
      month,
      plannedPct: round(plannedPctAt(p.start_date, p.planned_end_date, end), 1),
      plannedSpendCr: round(budget * plannedFinancialFraction(p.start_date, p.planned_end_date, end), 2),
    };
  });
}

// ---- Portfolio ---------------------------------------------------------------

export function matchesFilters(v: ProjectView, f: PortfolioFilters): boolean {
  if (f.state && v.state !== f.state) return false;
  if (f.scheme && v.scheme !== f.scheme) return false;
  if (f.category && v.category !== f.category) return false;
  if (f.health && v.metrics.health !== f.health) return false;
  if (f.q) {
    const q = f.q.toLowerCase().trim();
    const hay = `${v.code} ${v.name} ${v.state} ${v.district} ${v.scheme} ${v.category} ${v.implementing_agency} ${v.nodal_officer}`.toLowerCase();
    if (!q.split(/\s+/).every((t) => hay.includes(t))) return false;
  }
  return true;
}

export function computePortfolio(all: ProjectView[], bundles: Map<number, ProjectBundle>, filters: PortfolioFilters, asOf: string): Portfolio {
  const views = all.filter((v) => matchesFilters(v, filters));
  const sum = (fn: (v: ProjectView) => number) => views.reduce((s, v) => s + fn(v), 0);
  const budget = sum((v) => v.metrics.budgetCr);
  const weighted = (fn: (v: ProjectView) => number) => (budget > 0 ? sum((v) => fn(v) * v.metrics.budgetCr) / budget : 0);
  const active = views.filter((v) => v.metrics.spi !== null && v.metrics.health !== "Completed" && v.metrics.health !== "Not started");
  const activeBudget = active.reduce((s, v) => s + v.metrics.budgetCr, 0);

  const health: Record<Health, number> = { "On track": 0, "At risk": 0, "Off track": 0, Completed: 0, "Not started": 0, "On hold": 0 };
  const riskLevels: Record<RiskLevel, number> = { Low: 0, Moderate: 0, High: 0, Critical: 0 };
  for (const v of views) {
    health[v.metrics.health]++;
    riskLevels[v.metrics.riskLevel]++;
  }

  const group = (key: (v: ProjectView) => string): GroupStat[] => {
    const m = new Map<string, ProjectView[]>();
    for (const v of views) m.set(key(v), [...(m.get(key(v)) ?? []), v]);
    return [...m.entries()].map(([k, vs]) => {
      const b = vs.reduce((s, v) => s + v.metrics.budgetCr, 0);
      return {
        key: k,
        count: vs.length,
        budgetCr: round(b),
        spentCr: round(vs.reduce((s, v) => s + v.metrics.spentCr, 0)),
        physicalPct: round(b > 0 ? vs.reduce((s, v) => s + v.metrics.actualPct * v.metrics.budgetCr, 0) / b : 0, 1),
        delayed: vs.filter((v) => (v.metrics.delayDays ?? 0) > THRESHOLDS.delayedDays && v.metrics.health !== "Completed").length,
        offTrack: vs.filter((v) => v.metrics.health === "Off track").length,
        avgRisk: Math.round(vs.reduce((s, v) => s + v.metrics.riskScore, 0) / vs.length),
        forecastOverrunCr: round(vs.reduce((s, v) => s + Math.max(0, v.metrics.forecastOverrunCr), 0)),
      };
    }).sort((a, z) => z.budgetCr - a.budgetCr);
  };

  const topRisks = [...views]
    .filter((v) => v.metrics.health !== "Completed")
    .sort((a, z) => z.metrics.riskScore - a.metrics.riskScore)
    .slice(0, 8)
    .map((v) => ({ id: v.id, code: v.code, name: v.name, state: v.state, health: v.metrics.health, riskScore: v.metrics.riskScore, riskLevel: v.metrics.riskLevel, delayDays: v.metrics.delayDays, overrunPct: v.metrics.overrunPct, topFlag: v.metrics.flags[0]?.title ?? null }));

  const upcomingMilestones = views
    .flatMap((v) => v.metrics.upcomingMilestones.map((m) => ({ projectId: v.id, code: v.code, project: v.name, name: m.name, plannedEnd: m.plannedEnd, daysToGo: m.daysToGo, progressPct: m.progressPct, health: v.metrics.health })))
    .sort((a, z) => a.daysToGo - z.daysToGo);
  const overdueMilestones = views
    .flatMap((v) => v.metrics.overdueMilestones.map((m) => ({ projectId: v.id, code: v.code, project: v.name, name: m.name, plannedEnd: m.plannedEnd, daysOverdue: m.daysOverdue })))
    .sort((a, z) => z.daysOverdue - a.daysOverdue);

  // Portfolio S-curve: budget-weighted planned vs actual progress per month.
  let sCurve: Portfolio["sCurve"] = [];
  const dated = views.filter((v) => v.metrics.health !== "Not started");
  if (dated.length) {
    const from = dated.reduce((m, v) => (v.start_date < m ? v.start_date : m), dated[0].start_date);
    const to = dated.reduce((m, v) => (v.planned_end_date > m ? v.planned_end_date : m), dated[0].planned_end_date);
    const lastActualMonth = monthOf(asOf) > monthOf(from) ? monthOf(addDays(asOf.slice(0, 8) + "01", -1)) : monthOf(from);
    const totalB = dated.reduce((s, v) => s + v.metrics.budgetCr, 0);
    sCurve = monthRange(monthOf(from), monthOf(to)).map((month) => {
      const end = monthEnd(month);
      let planned = 0;
      let actual = 0;
      for (const v of dated) {
        planned += plannedPctAt(v.start_date, v.planned_end_date, end) * v.metrics.budgetCr;
        const reps = bundles.get(v.id)?.reports ?? [];
        let pct = 0;
        for (const r of reps) if (r.month <= month) pct = r.physical_pct;
        actual += pct * v.metrics.budgetCr;
      }
      return { month, plannedPct: round(planned / totalB, 1), actualPct: month <= lastActualMonth ? round(actual / totalB, 1) : null };
    });
  }

  const sevRank = { critical: 0, high: 1, medium: 2, low: 3 };
  const alerts = views
    .flatMap((v) => v.metrics.flags.filter((f) => f.severity === "critical" || f.severity === "high").map((flag) => ({ projectId: v.id, code: v.code, project: v.name, flag })))
    .sort((a, z) => sevRank[a.flag.severity] - sevRank[z.flag.severity]);

  return {
    asOf,
    filters,
    totals: {
      projects: views.length,
      sanctionedCr: round(sum((v) => v.sanctioned_cost_cr)),
      budgetCr: round(budget),
      spentCr: round(sum((v) => v.metrics.spentCr)),
      releasedCr: round(sum((v) => v.metrics.releasedCr)),
      eacCr: round(sum((v) => v.metrics.eacCr)),
      forecastOverrunCr: round(sum((v) => Math.max(0, v.metrics.forecastOverrunCr))),
      physicalPct: round(weighted((v) => v.metrics.actualPct), 1),
      plannedPct: round(weighted((v) => v.metrics.plannedPctToday), 1),
      utilisationPct: round(budget > 0 ? (sum((v) => v.metrics.spentCr) / budget) * 100 : 0, 1),
      weightedSpi: activeBudget > 0 ? round(active.reduce((s, v) => s + (v.metrics.spi ?? 0) * v.metrics.budgetCr, 0) / activeBudget, 2) : null,
      delayed: views.filter((v) => (v.metrics.delayDays ?? 0) > THRESHOLDS.delayedDays && v.metrics.health !== "Completed").length,
      overBudget: views.filter((v) => v.metrics.cpiReliable && v.metrics.overrunPct > THRESHOLDS.overBudgetPct && v.metrics.health !== "Completed").length,
      stale: views.filter((v) => v.metrics.flags.some((f) => f.code === "STALE_DATA")).length,
      openCriticalIssues: sum((v) => v.metrics.criticalIssues),
      overdueMilestones: overdueMilestones.length,
    },
    health,
    riskLevels,
    byState: group((v) => v.state),
    byScheme: group((v) => v.scheme),
    byCategory: group((v) => v.category),
    topRisks,
    upcomingMilestones,
    overdueMilestones,
    sCurve,
    alerts,
  };
}
