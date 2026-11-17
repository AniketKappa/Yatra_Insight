// Guard for model-written SQL. Defence in depth:
//  1. The query runs on a connection opened with readOnly: true (SQLite itself
//     rejects any write).
//  2. Only a single SELECT / WITH statement is accepted; PRAGMA, ATTACH,
//     recursive CTEs (unbounded loops) and multiple statements are refused.
//  3. Results are capped by wrapping the query in an outer LIMIT.

import type { DatabaseSync } from "node:sqlite";

export const MAX_ROWS = 200;

export class SqlRejected extends Error {}

function stripCommentsAndStrings(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""');
}

export function validateSql(raw: string): string {
  if (typeof raw !== "string" || !raw.trim()) throw new SqlRejected("The query is empty.");
  if (raw.length > 6000) throw new SqlRejected("The query is too long (max 6000 characters).");
  const sql = raw.trim().replace(/;\s*$/, "");
  const bare = stripCommentsAndStrings(sql);
  if (bare.includes(";")) throw new SqlRejected("Only one statement is allowed.");
  if (!/^\s*(select|with)\b/i.test(bare)) throw new SqlRejected("Only SELECT queries are allowed.");
  const forbidden = /\b(insert|update|delete|drop|alter|create|replace|attach|detach|pragma|vacuum|reindex|analyze|begin|commit|rollback|savepoint|release|recursive|load_extension|readfile|writefile)\b/i;
  const hit = bare.match(forbidden);
  if (hit) throw new SqlRejected(`The keyword "${hit[0].toUpperCase()}" is not allowed in read-only analysis queries.`);
  if (/\b(api_messages|conversations|turns)\b/i.test(bare)) throw new SqlRejected("Conversation tables are not queryable.");
  return sql;
}

export interface SqlResult {
  columns: string[];
  rows: (string | number | null)[][];
  truncated: boolean;
}

export function runReadOnly(db: DatabaseSync, raw: string): SqlResult {
  const sql = validateSql(raw);
  let stmt;
  try {
    stmt = db.prepare(`SELECT * FROM (${sql}) LIMIT ${MAX_ROWS + 1}`);
  } catch (err) {
    throw new SqlRejected(`SQL error: ${(err as Error).message}`);
  }
  let records: Record<string, unknown>[];
  try {
    records = stmt.all() as Record<string, unknown>[];
  } catch (err) {
    throw new SqlRejected(`SQL error: ${(err as Error).message}`);
  }
  const truncated = records.length > MAX_ROWS;
  if (truncated) records = records.slice(0, MAX_ROWS);
  const columns = records.length ? Object.keys(records[0]) : stmt.columns().map((c) => c.name);
  const rows = records.map((r) =>
    columns.map((c) => {
      const v = r[c];
      if (v === null || v === undefined) return null;
      if (typeof v === "number") return Math.round(v * 1000) / 1000;
      if (typeof v === "bigint") return Number(v);
      if (v instanceof Uint8Array) return "[binary]";
      return String(v);
    }),
  );
  return { columns, rows, truncated };
}
