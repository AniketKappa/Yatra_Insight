import { test } from "node:test";
import assert from "node:assert/strict";
import { computeMetrics, computePortfolio, type ProjectBundle } from "./analytics.ts";
import type { Issue, Milestone, ProgressReport, Project } from "./types.ts";
import { inverseSCurve, plannedPctAt, sCurve } from "./lib/curves.ts";
import { addMonths, daysBetween, monthRange, isValidISODate } from "./lib/dates.ts";

const AS_OF = "2026-11-16";

function project(over: Partial<Project> = {}): Project {
  return {
    id: 1, code: "SD2-XX-0001", name: "Test — Visitor Centre", destination: "Test", scheme: "Swadesh Darshan 2.0",
    state: "Kerala", district: "Kottayam", category: "Heritage", implementing_agency: "Agency", nodal_officer: "Officer",
    description: "", sanctioned_cost_cr: 100, revised_cost_cr: null, start_date: "2025-01-01", planned_end_date: "2027-12-31",
    actual_end_date: null, status: "In progress", lat: null, lng: null, ...over,
  };
}

/** Monthly reports that follow the plan scaled by `eff` (1 = on plan), spending `cost` x earned value. */
function reports(p: Project, until: string, eff = 1, cost = 1, flatFrom?: string): ProgressReport[] {
  const out: ProgressReport[] = [];
  let id = 1;
  let last = 0;
  for (const month of monthRange(p.start_date.slice(0, 7), until)) {
    const end = `${month}-28`;
    let pct = plannedPctAt(p.start_date, p.planned_end_date, end) * eff;
    if (flatFrom && month >= flatFrom) pct = last; // stalled
    pct = Math.max(last, Math.min(99, Math.round(pct * 10) / 10));
    last = pct;
    const budget = p.revised_cost_cr ?? p.sanctioned_cost_cr;
    out.push({ id: id++, project_id: p.id, month, physical_pct: pct, expenditure_cr: Math.round((pct / 100) * budget * cost * 100) / 100, funds_released_cr: budget, remarks: "", reported_by: "x", reported_at: `${addMonths(`${month}-01`, 1).slice(0, 7)}-05` });
  }
  return out;
}

const bundle = (p: Project, r: ProgressReport[] = [], issues: Issue[] = [], milestones: Milestone[] = []): ProjectBundle => ({ project: p, reports: r, issues, milestones });

test("S-curve and its inverse agree", () => {
  for (const f of [0, 0.1, 0.5, 0.9, 1]) assert.ok(Math.abs(sCurve(inverseSCurve(f)) - f) < 1e-6);
  assert.equal(sCurve(-1), 0);
  assert.equal(sCurve(2), 1);
});

test("date helpers handle month ends and validation", () => {
  assert.equal(addMonths("2026-01-31", 1), "2026-02-28");
  assert.equal(daysBetween("2026-01-01", "2026-01-31"), 30);
  assert.deepEqual(monthRange("2025-11", "2026-02"), ["2025-11", "2025-12", "2026-01", "2026-02"]);
  assert.equal(isValidISODate("2026-02-30"), false);
  assert.equal(isValidISODate("2026-02-28"), true);
});

test("a project following the plan is on track with SPI ≈ 1 and no overrun", () => {
  const p = project();
  const m = computeMetrics(bundle(p, reports(p, "2026-10")), AS_OF);
  assert.equal(m.health, "On track");
  assert.ok(m.spi! > 0.95 && m.spi! < 1.06, `spi ${m.spi}`);
  assert.ok(Math.abs(m.overrunPct) < 3);
  assert.ok(m.riskScore < 20, `risk ${m.riskScore}`);
  assert.equal(m.forecastBasis, "earned-schedule");
});

test("a slow project is behind schedule with a positive forecast delay", () => {
  const p = project();
  const m = computeMetrics(bundle(p, reports(p, "2026-10", 0.6)), AS_OF);
  assert.ok(m.spi! < 0.85, `spi ${m.spi}`);
  assert.ok((m.delayDays ?? 0) > 60, `delay ${m.delayDays}`);
  assert.ok(m.flags.some((f) => f.code === "DELAY" || f.code === "SEVERE_DELAY"));
  assert.notEqual(m.health, "On track");
  assert.ok(m.recommendations.some((r) => /catch-up schedule/.test(r.action)));
});

test("an over-spending project forecasts a cost overrun via CPI", () => {
  const p = project();
  const m = computeMetrics(bundle(p, reports(p, "2026-10", 1, 1.3)), AS_OF);
  assert.ok(m.cpi! < 0.8, `cpi ${m.cpi}`);
  assert.ok(m.overrunPct > 20);
  assert.ok(m.eacCr > 120);
  assert.ok(m.flags.some((f) => f.code === "COST_OVERRUN"));
  assert.ok(m.recommendations.some((r) => /value-engineering/.test(r.action)));
});

test("CPI is not trusted below 10% progress (mobilisation advances)", () => {
  const p = project({ start_date: "2026-07-01", planned_end_date: "2028-06-30" });
  const r = reports(p, "2026-10", 1, 3); // spending 3x early on
  const m = computeMetrics(bundle(p, r), AS_OF);
  assert.ok(m.actualPct < 10);
  assert.equal(m.cpiReliable, false);
  assert.ok(!m.flags.some((f) => f.code === "COST_OVERRUN"));
});

test("a stalled project is flagged and forecast as if work resumed today", () => {
  const p = project();
  const m = computeMetrics(bundle(p, reports(p, "2026-10", 0.8, 1, "2026-06")), AS_OF);
  assert.equal(m.stalled, true);
  assert.equal(m.health, "Off track");
  assert.equal(m.forecastBasis, "resume-at-plan");
  assert.ok(m.forecastEnd! > AS_OF);
  assert.ok(m.flags[0].code === "STALLED" || m.flags.some((f) => f.code === "STALLED"));
});

test("stale reporting is detected", () => {
  const p = project();
  const m = computeMetrics(bundle(p, reports(p, "2026-05")), AS_OF);
  assert.ok((m.daysSinceUpdate ?? 0) > 90);
  assert.ok(m.flags.some((f) => f.code === "STALE_DATA" && f.severity === "high"));
});

test("a completed project reports actual finish and no risk", () => {
  const p = project({ start_date: "2023-01-01", planned_end_date: "2024-12-31", actual_end_date: "2025-02-15", status: "Completed" });
  const r = reports(p, "2025-01");
  r[r.length - 1].physical_pct = 100;
  const m = computeMetrics(bundle(p, r), AS_OF);
  assert.equal(m.health, "Completed");
  assert.equal(m.forecastEnd, "2025-02-15");
  assert.equal(m.delayDays, 46);
  assert.equal(m.riskScore, 0);
  assert.equal(m.flags.length, 0);
});

test("a not-yet-started project with no reports is 'Not started', and a late start is flagged", () => {
  const future = project({ start_date: "2027-01-01", planned_end_date: "2029-01-01", status: "Not started" });
  const m1 = computeMetrics(bundle(future), AS_OF);
  assert.equal(m1.health, "Not started");
  assert.equal(m1.spi, null);
  assert.equal(m1.delayDays, 0);

  const late = project({ start_date: "2026-03-01", planned_end_date: "2028-03-01", status: "Not started" });
  const m2 = computeMetrics(bundle(late), AS_OF);
  assert.ok(m2.flags.some((f) => f.code === "START_DELAYED"));
  assert.equal(m2.health, "At risk");
});

test("an in-progress project with no reports at all doesn't crash and is flagged stale", () => {
  const p = project({ start_date: "2026-01-01" });
  const m = computeMetrics(bundle(p, []), AS_OF);
  assert.equal(m.actualPct, 0);
  assert.equal(m.spentCr, 0);
  assert.equal(m.cpi, null);
  assert.ok(m.flags.some((f) => f.code === "STALE_DATA"));
});

test("an approved cost revision shows as escalation", () => {
  const p = project({ revised_cost_cr: 125 });
  const m = computeMetrics(bundle(p, reports(p, "2026-10")), AS_OF);
  assert.equal(m.escalationPct, 25);
  assert.equal(m.budgetCr, 125);
  assert.ok(m.flags.some((f) => f.code === "ESCALATION" && f.severity === "high"));
});

test("critical open issues raise risk and map to a playbook action", () => {
  const p = project();
  const issue: Issue = { id: 1, project_id: 1, category: "Land acquisition", severity: "Critical", status: "Open", title: "Encumbrance", description: "", owner: "DC", raised_on: "2026-06-01", resolved_on: null };
  const base = computeMetrics(bundle(p, reports(p, "2026-10")), AS_OF);
  const m = computeMetrics(bundle(p, reports(p, "2026-10"), [issue]), AS_OF);
  assert.ok(m.riskScore > base.riskScore);
  assert.equal(m.recommendations[0].priority, "Immediate");
  assert.match(m.recommendations[0].action, /District Collector/);
});

test("portfolio totals and filters", () => {
  const a = project({ id: 1, state: "Kerala" });
  const b = project({ id: 2, state: "Goa", code: "SD2-GA-0002" });
  const ra = reports(a, "2026-10");
  const rb = reports(b, "2026-10", 0.6);
  const views = [a, b].map((p, i) => ({ ...p, metrics: computeMetrics(bundle(p, i ? rb : ra), AS_OF) }));
  const bundles = new Map([[1, bundle(a, ra)], [2, bundle(b, rb)]]);
  const all = computePortfolio(views, bundles, {}, AS_OF);
  assert.equal(all.totals.projects, 2);
  assert.equal(all.totals.budgetCr, 200);
  assert.equal(all.byState.length, 2);
  assert.ok(all.sCurve.length > 10);
  const goa = computePortfolio(views, bundles, { state: "Goa" }, AS_OF);
  assert.equal(goa.totals.projects, 1);
  const none = computePortfolio(views, bundles, { state: "Nowhere" }, AS_OF);
  assert.equal(none.totals.projects, 0);
  assert.deepEqual(none.sCurve, []);
});
