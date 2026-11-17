import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "./db.ts";
import { seedDatabase } from "./seed.ts";
import { Repo } from "./repo.ts";
import { MAX_ROWS, SqlRejected, runReadOnly, validateSql } from "./sqlguard.ts";

test("accepts SELECT and WITH queries, including ';' inside strings", () => {
  assert.doesNotThrow(() => validateSql("SELECT * FROM projects"));
  assert.doesNotThrow(() => validateSql("with x as (select 1 as a) select a from x;"));
  assert.doesNotThrow(() => validateSql("SELECT name FROM projects WHERE name LIKE '%; DROP%'"));
});

test("rejects writes, multiple statements and dangerous keywords", () => {
  for (const sql of [
    "DELETE FROM projects",
    "SELECT 1; DROP TABLE projects",
    "UPDATE projects SET name='x'",
    "PRAGMA table_info(projects)",
    "ATTACH DATABASE 'x.db' AS x",
    "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT x FROM c",
    "SELECT * FROM api_messages",
    "",
    "   ",
    "SELECT load_extension('x')",
  ]) {
    assert.throws(() => validateSql(sql), SqlRejected, sql);
  }
});

test("comments can't hide a second statement", () => {
  assert.throws(() => validateSql("SELECT 1 /* ; */ ; DELETE FROM projects"), SqlRejected);
  assert.doesNotThrow(() => validateSql("SELECT 1 -- ; trailing comment"));
});

test("runs on a real read-only connection, caps rows and reports SQL errors cleanly", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yi-"));
  const db = openDb(path.join(dir, "t.db"));
  seedDatabase(db.rw, { asOf: "2026-11-16" });
  new Repo(db.rw).views();

  const r = runReadOnly(db.ro, "SELECT p.code, m.health, m.delay_days FROM projects p JOIN project_metrics m ON m.project_id = p.id ORDER BY m.delay_days DESC");
  assert.deepEqual(r.columns, ["code", "health", "delay_days"]);
  assert.equal(r.rows.length, 48);

  const many = runReadOnly(db.ro, "SELECT a.id FROM progress_reports a");
  assert.equal(many.rows.length, MAX_ROWS);
  assert.equal(many.truncated, true);

  assert.throws(() => runReadOnly(db.ro, "SELECT nope FROM projects"), /SQL error/);
  // Even if the guard were bypassed, the connection itself refuses writes.
  assert.throws(() => db.ro.exec("DELETE FROM projects"));
  db.rw.close();
  db.ro.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
