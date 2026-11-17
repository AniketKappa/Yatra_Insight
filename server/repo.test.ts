import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "./db.ts";
import { seedDatabase } from "./seed.ts";
import { Repo, ValidationError, NotFoundError } from "./repo.ts";
import { answerOffline } from "./llm/offline.ts";

process.env.AS_OF_DATE = "2026-11-16";

function setup() {
  const db = openDb(":memory:");
  seedDatabase(db.rw, { asOf: "2026-11-16" });
  return { db, repo: new Repo(db.rw) };
}

test("seed produces a deterministic, varied portfolio", () => {
  const { repo } = setup();
  const p = repo.portfolio();
  assert.equal(p.totals.projects, 48);
  for (const h of ["On track", "At risk", "Off track", "Completed", "Not started", "On hold"] as const) assert.ok(p.health[h] > 0, `no ${h} projects`);
  const again = setup().repo.portfolio();
  assert.deepEqual(again.totals, p.totals);
});

test("findProject resolves codes, ids and destination names", () => {
  const { repo } = setup();
  const konark = repo.findProject("konark");
  assert.ok(konark && konark.destination === "Konark");
  assert.equal(repo.findProject(konark.code)?.id, konark.id);
  assert.equal(repo.findProject(String(konark.id))?.id, konark.id);
  assert.equal(repo.findProject("zzzz nowhere"), null);
  assert.equal(repo.findProject(""), null);
});

test("progress validation rejects bad input with field-level messages", () => {
  const { repo } = setup();
  const v = repo.views().find((x) => x.metrics.health === "On track" && x.metrics.actualPct > 20)!;
  const last = repo.detail(v.id).reports.at(-1)!;
  const expectFields = (input: Record<string, unknown>, field: string) => {
    try {
      repo.addProgressReport(v.id, input);
      assert.fail("should have thrown");
    } catch (e) {
      assert.ok(e instanceof ValidationError, String(e));
      assert.ok(field in e.fields, `expected error on ${field}, got ${JSON.stringify(e.fields)}`);
    }
  };
  const ok = { month: "2026-11", physical_pct: last.physical_pct + 1, expenditure_cr: last.expenditure_cr + 0.5, reported_by: "Tester" };
  expectFields({ ...ok, month: "2027-03" }, "month");
  expectFields({ ...ok, month: "11/2026" }, "month");
  expectFields({ ...ok, physical_pct: 101 }, "physical_pct");
  expectFields({ ...ok, physical_pct: last.physical_pct - 5 }, "physical_pct");
  expectFields({ ...ok, expenditure_cr: -1 }, "expenditure_cr");
  expectFields({ ...ok, expenditure_cr: last.expenditure_cr - 1 }, "expenditure_cr");
  expectFields({ ...ok, expenditure_cr: 99999 }, "expenditure_cr");
  expectFields({ ...ok, reported_by: " " }, "reported_by");
  expectFields({ ...ok, physical_pct: "abc" }, "physical_pct");
  assert.throws(() => repo.addProgressReport(99999, ok), NotFoundError);
});

test("saving progress recalculates metrics; reaching 100% completes the project", () => {
  const { repo } = setup();
  const v = repo.views().find((x) => x.metrics.health === "On track" && x.metrics.actualPct > 50)!;
  const last = repo.detail(v.id).reports.at(-1)!;
  const after = repo.addProgressReport(v.id, { month: "2026-11", physical_pct: last.physical_pct + 2, expenditure_cr: last.expenditure_cr + 1, reported_by: "Tester" });
  assert.equal(after.metrics.actualPct, last.physical_pct + 2);
  assert.equal(after.metrics.lastReportMonth, "2026-11");
  // Updating the same month again replaces it rather than duplicating.
  const again = repo.addProgressReport(v.id, { month: "2026-11", physical_pct: 100, expenditure_cr: last.expenditure_cr + 3, reported_by: "Tester" });
  assert.equal(again.reports.filter((r) => r.month === "2026-11").length, 1);
  assert.equal(again.status, "Completed");
  assert.equal(again.metrics.health, "Completed");
  assert.ok(again.milestones.every((m) => m.progress_pct === 100 && m.actual_end));
});

test("issues can be logged and resolved, and change the risk score", () => {
  const { repo } = setup();
  const v = repo.views().find((x) => x.metrics.health === "On track" && x.metrics.openIssues === 0)!;
  assert.throws(() => repo.addIssue(v.id, { title: "", category: "", severity: "Huge", owner: "" }), ValidationError);
  const d = repo.addIssue(v.id, { title: "Forest clearance pending", category: "Statutory clearance", severity: "Critical", owner: "Forest Dept" });
  assert.ok(d.metrics.riskScore > v.metrics.riskScore);
  assert.ok(d.metrics.recommendations.some((r) => /clearance authority/.test(r.action)));
  const issue = d.issues.find((i) => i.title === "Forest clearance pending")!;
  const resolved = repo.updateIssueStatus(issue.id, "Resolved");
  assert.equal(resolved.metrics.criticalIssues, 0);
  assert.throws(() => repo.updateIssueStatus(issue.id, "Gone"), ValidationError);
});

test("offline engine answers the core question types", () => {
  const { repo } = setup();
  const ask = (q: string) => answerOffline(q, repo);

  const delayed = ask("Which projects in Kerala are delayed?");
  assert.match(delayed.text, /Kerala/);
  assert.ok(delayed.artifacts.some((a) => a.type === "table"));

  const ninety = ask("projects delayed by more than 90 days");
  assert.match(ninety.text, /more than 90 days late/);

  const overrun = ask("cost overruns above 15%");
  assert.match(overrun.text, /more than 15%/);

  const project = ask("What is the status of Konark?");
  assert.match(project.text, /Konark/);
  assert.match(project.text, /Health:/);

  const ms = ask("milestones due in the next 30 days");
  assert.match(ms.text, /next 30 days/);

  const stalled = ask("which works have stalled");
  assert.match(stalled.text, /stalled/i);

  const stale = ask("which progress reports are overdue");
  assert.match(stale.text, /overdue|current/);

  const compare = ask("compare states by risk");
  assert.ok(compare.artifacts.some((a) => a.type === "chart"));

  const funds = ask("How much has been spent in Madhya Pradesh?");
  assert.match(funds.text, /Madhya Pradesh/);
  assert.match(funds.text, /utilisation/);

  const actions = ask("what corrective measures do the top 3 risky projects need");
  assert.match(actions.text, /corrective measures/i);

  const nonsense = ask("asdf qwerty");
  assert.match(nonsense.text, /wasn't sure/);

  const empty = ask("   ");
  assert.match(empty.text, /Ask a question/);

  const alias = ask("delayed projects in UP");
  assert.match(alias.text, /Uttar Pradesh/);
});
