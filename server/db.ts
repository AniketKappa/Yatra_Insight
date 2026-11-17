// SQLite storage via Node's built-in node:sqlite (no native build step).
// Two connections: a read-write one for the app, and a separate READ-ONLY one
// that the LLM's SQL tool uses, so model-written SQL can never modify data.

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.resolve(here, "..", "data");

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id                  INTEGER PRIMARY KEY,
  code                TEXT NOT NULL UNIQUE,
  name                TEXT NOT NULL,
  destination         TEXT NOT NULL,
  scheme              TEXT NOT NULL,
  state               TEXT NOT NULL,
  district            TEXT NOT NULL,
  category            TEXT NOT NULL,
  implementing_agency TEXT NOT NULL,
  nodal_officer       TEXT NOT NULL,
  description         TEXT NOT NULL,
  sanctioned_cost_cr  REAL NOT NULL CHECK (sanctioned_cost_cr > 0),
  revised_cost_cr     REAL CHECK (revised_cost_cr IS NULL OR revised_cost_cr > 0),
  start_date          TEXT NOT NULL,
  planned_end_date    TEXT NOT NULL,
  actual_end_date     TEXT,
  status              TEXT NOT NULL CHECK (status IN ('Not started','In progress','On hold','Completed')),
  lat                 REAL,
  lng                 REAL,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS milestones (
  id                 INTEGER PRIMARY KEY,
  project_id         INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  seq                INTEGER NOT NULL,
  name               TEXT NOT NULL,
  weight_pct         REAL NOT NULL,
  planned_start      TEXT NOT NULL,
  planned_end        TEXT NOT NULL,
  actual_start       TEXT,
  actual_end         TEXT,
  progress_pct       REAL NOT NULL DEFAULT 0 CHECK (progress_pct BETWEEN 0 AND 100),
  UNIQUE (project_id, seq)
);

CREATE TABLE IF NOT EXISTS progress_reports (
  id                    INTEGER PRIMARY KEY,
  project_id            INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  month                 TEXT NOT NULL,
  physical_pct          REAL NOT NULL CHECK (physical_pct BETWEEN 0 AND 100),
  expenditure_cr        REAL NOT NULL CHECK (expenditure_cr >= 0),
  funds_released_cr     REAL NOT NULL DEFAULT 0 CHECK (funds_released_cr >= 0),
  remarks               TEXT NOT NULL DEFAULT '',
  reported_by           TEXT NOT NULL,
  reported_at           TEXT NOT NULL,
  UNIQUE (project_id, month)
);

CREATE TABLE IF NOT EXISTS issues (
  id           INTEGER PRIMARY KEY,
  project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  category     TEXT NOT NULL,
  severity     TEXT NOT NULL CHECK (severity IN ('Low','Medium','High','Critical')),
  status       TEXT NOT NULL CHECK (status IN ('Open','Mitigating','Resolved')),
  title        TEXT NOT NULL,
  description  TEXT NOT NULL,
  owner        TEXT NOT NULL,
  raised_on    TEXT NOT NULL,
  resolved_on  TEXT
);

-- Derived analytics, recomputed from the tables above whenever data changes.
CREATE TABLE IF NOT EXISTS project_metrics (
  project_id            INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  as_of                 TEXT NOT NULL,
  health                TEXT NOT NULL,
  risk_score            INTEGER NOT NULL,
  risk_level            TEXT NOT NULL,
  planned_pct           REAL,
  actual_pct            REAL,
  spi                   REAL,
  cpi                   REAL,
  budget_cr             REAL NOT NULL,
  spent_cr              REAL NOT NULL,
  utilisation_pct       REAL,
  eac_cr                REAL,
  forecast_overrun_cr   REAL,
  overrun_pct           REAL,
  escalation_pct        REAL,
  forecast_end_date     TEXT,
  delay_days            INTEGER,
  velocity_pp_per_month REAL,
  overdue_milestones    INTEGER NOT NULL,
  open_issues           INTEGER NOT NULL,
  critical_issues       INTEGER NOT NULL,
  last_report_month     TEXT,
  days_since_update     INTEGER,
  flags                 TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS reports (
  id            INTEGER PRIMARY KEY,
  scope         TEXT NOT NULL CHECK (scope IN ('portfolio','project')),
  project_id    INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  title         TEXT NOT NULL,
  as_of         TEXT NOT NULL,
  filters       TEXT NOT NULL DEFAULT '{}',
  body_md       TEXT NOT NULL,
  data_json     TEXT NOT NULL,
  generated_by  TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS conversations (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  mode        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- api_messages holds the exact Anthropic message history (append-only, so
-- thinking blocks are replayed unchanged). turns holds what the UI renders.
CREATE TABLE IF NOT EXISTS api_messages (
  id               INTEGER PRIMARY KEY,
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role             TEXT NOT NULL,
  content          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS turns (
  id               INTEGER PRIMARY KEY,
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role             TEXT NOT NULL CHECK (role IN ('user','assistant')),
  text             TEXT NOT NULL,
  artifacts        TEXT NOT NULL DEFAULT '[]',
  meta             TEXT NOT NULL DEFAULT '{}',
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_progress_project ON progress_reports(project_id, month);
CREATE INDEX IF NOT EXISTS idx_milestones_project ON milestones(project_id, seq);
CREATE INDEX IF NOT EXISTS idx_issues_project ON issues(project_id);
CREATE INDEX IF NOT EXISTS idx_turns_conv ON turns(conversation_id, id);
CREATE INDEX IF NOT EXISTS idx_api_conv ON api_messages(conversation_id, id);
`;

export interface Db {
  rw: DatabaseSync;
  ro: DatabaseSync;
  file: string;
}

export function openDb(file = process.env.DB_FILE || path.join(DATA_DIR, "yatra.db")): Db {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const rw = new DatabaseSync(file);
  rw.exec("PRAGMA foreign_keys = ON;");
  if (file !== ":memory:") rw.exec("PRAGMA journal_mode = WAL;");
  rw.exec(SCHEMA);
  // An in-memory DB cannot be shared across connections, so tests reuse rw
  // (the SQL guard still enforces read-only statements there).
  const ro = file === ":memory:" ? rw : new DatabaseSync(file, { readOnly: true });
  return { rw, ro, file };
}

export function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** Column docs fed to the LLM so it writes correct SQL. Keep in sync with SCHEMA. */
export const SCHEMA_DOC = `
projects(id, code, name, destination, scheme, state, district, category, implementing_agency,
  nodal_officer, description, sanctioned_cost_cr, revised_cost_cr, start_date, planned_end_date,
  actual_end_date, status ['Not started'|'In progress'|'On hold'|'Completed'])
  - Money is in Indian Rupees crore (cr). Dates are 'YYYY-MM-DD' text.
  - scheme values: 'Swadesh Darshan 2.0', 'PRASHAD', 'Challenge Based Destination Development',
    'Special Assistance to States (SASCI)', 'Assistance to Central Agencies'.
  - category values: Heritage, Pilgrimage, Eco-tourism, Coastal, Adventure, Rural, Buddhist, Wellness.
milestones(id, project_id, seq, name, weight_pct, planned_start, planned_end, actual_start,
  actual_end, progress_pct)  -- actual_end IS NULL means not finished.
progress_reports(id, project_id, month 'YYYY-MM', physical_pct (cumulative 0-100),
  expenditure_cr (cumulative), funds_released_cr (cumulative), remarks, reported_by, reported_at)
issues(id, project_id, category, severity ['Low'|'Medium'|'High'|'Critical'],
  status ['Open'|'Mitigating'|'Resolved'], title, description, owner, raised_on, resolved_on)
project_metrics(project_id, as_of, health ['On track'|'At risk'|'Off track'|'Completed'|'Not started'|'On hold'],
  risk_score 0-100, risk_level ['Low'|'Moderate'|'High'|'Critical'], planned_pct, actual_pct,
  spi (schedule performance index, earned-schedule method; <1 = behind), cpi (cost performance
  index; <1 = over cost), budget_cr (current approved cost = revised else sanctioned), spent_cr,
  utilisation_pct, eac_cr (estimate at completion), forecast_overrun_cr (eac - budget),
  overrun_pct (forecast overrun as % of budget), escalation_pct (revised vs sanctioned %),
  forecast_end_date, delay_days (forecast slip vs planned end; NULL if not forecastable),
  velocity_pp_per_month (recent physical progress per month), overdue_milestones, open_issues,
  critical_issues, last_report_month, days_since_update, flags (JSON array))
  - Always JOIN project_metrics m ON m.project_id = p.id to filter by health, delay or overrun.
`.trim();
