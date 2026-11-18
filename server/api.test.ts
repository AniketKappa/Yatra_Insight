// HTTP-level tests, plus the Claude agent loop driven by a scripted fake
// client (so the LLM path is exercised without an API key or network).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import Groq from "groq-sdk";
import { openDb } from "./db.ts";
import { seedDatabase } from "./seed.ts";
import { createApp } from "./app.ts";
import { Repo } from "./repo.ts";
import { runAgent, TOOLS } from "./llm/agent.ts";

process.env.AS_OF_DATE = "2026-11-16";

// A scripted step: assistant text and/or tool calls, or an error the API throws.
type Step = { text?: string; calls?: { id: string; name: string; args: unknown }[]; finish?: string } | Error;

/** A fake Groq client that streams OpenAI-style chunks, splitting tool arguments across deltas. */
function fakeClient(steps: Step[]) {
  const calls: any[] = [];
  let i = 0;
  const client = {
    chat: {
      completions: {
        async create(params: any) {
          calls.push(structuredClone(params));
          const step = steps[Math.min(i++, steps.length - 1)];
          if (step instanceof Error) throw step;
          const chunks: any[] = [];
          const base = { id: `c${i}`, model: "openai/gpt-oss-120b", object: "chat.completion.chunk", created: 0 };
          if (step.text) for (const part of step.text.match(/.{1,12}/gs) ?? []) chunks.push({ ...base, choices: [{ index: 0, delta: { content: part }, finish_reason: null }] });
          (step.calls ?? []).forEach((c, idx) => {
            const json = JSON.stringify(c.args);
            const half = Math.floor(json.length / 2);
            chunks.push({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: idx, id: c.id, type: "function", function: { name: c.name, arguments: json.slice(0, half) } }] }, finish_reason: null }] });
            chunks.push({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: idx, function: { arguments: json.slice(half) } }] }, finish_reason: null }] });
          });
          chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: step.finish ?? (step.calls?.length ? "tool_calls" : "stop") }] });
          if (!params.stream) return { model: base.model, choices: [{ message: { role: "assistant", content: step.text ?? "" } }] };
          return (async function* () { for (const c of chunks) yield c; })();
        },
      },
    },
  } as unknown as Groq;
  return { client, calls };
}

async function start(client?: Groq | null) {
  const db = openDb(":memory:");
  seedDatabase(db.rw, { asOf: "2026-11-16" });
  const { app } = createApp(db, { client: client ?? null });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { db, base, close: () => new Promise((r) => server.close(r)) };
}

async function ask(base: string, convId: string, question: string) {
  const res = await fetch(`${base}/api/conversations/${convId}/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question }) });
  const text = await res.text();
  const events = [...text.matchAll(/event: (\w+)\ndata: (.*)\n/g)].map((m) => ({ event: m[1], data: JSON.parse(m[2]) }));
  return { status: res.status, events, done: events.find((e) => e.event === "done")?.data.turn };
}

test("REST endpoints: health, portfolio, projects, 404s and bad input", async () => {
  const { base, close } = await start(null);
  try {
    const h = await (await fetch(`${base}/api/health`)).json();
    assert.equal(h.ok, true);
    assert.equal(h.llm.configured, false);
    const p = await (await fetch(`${base}/api/portfolio?state=Kerala`)).json();
    assert.equal(p.totals.projects, 3);
    const list = await (await fetch(`${base}/api/projects?health=Off%20track`)).json();
    assert.ok(list.length > 0 && list.every((v: any) => v.metrics.health === "Off track"));
    assert.equal((await fetch(`${base}/api/projects/99999`)).status, 404);
    assert.equal((await fetch(`${base}/api/projects/abc`)).status, 404);
    assert.equal((await fetch(`${base}/api/nope`)).status, 404);
    const bad = await fetch(`${base}/api/projects/1/progress`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{not json" });
    assert.equal(bad.status, 400);
    const invalid = await fetch(`${base}/api/projects/1/progress`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ month: "2099-01", physical_pct: 500 }) });
    assert.equal(invalid.status, 422);
    const body = await invalid.json();
    assert.ok(body.fields.month && body.fields.physical_pct);
  } finally {
    await close();
  }
});

test("offline chat streams an answer, persists it, and enforces input limits", async () => {
  const { base, close } = await start(null);
  try {
    const conv = await (await fetch(`${base}/api/conversations`, { method: "POST" })).json();
    const r = await ask(base, conv.id, "Which projects are delayed by more than 90 days?");
    assert.equal(r.status, 200);
    assert.ok(r.events.some((e) => e.event === "text"));
    assert.equal(r.done.meta.mode, "offline");
    assert.match(r.done.text, /90 days/);
    const saved = await (await fetch(`${base}/api/conversations/${conv.id}`)).json();
    assert.equal(saved.turns.length, 2);
    assert.match(saved.title, /delayed by more than 90 days/);

    const empty = await fetch(`${base}/api/conversations/${conv.id}/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: "  " }) });
    assert.equal(empty.status, 422);
    const long = await fetch(`${base}/api/conversations/${conv.id}/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: "x".repeat(2001) }) });
    assert.equal(long.status, 422);
    assert.equal((await fetch(`${base}/api/conversations/nope/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: "hi" }) })).status, 404);
  } finally {
    await close();
  }
});

test("reports: generate portfolio and project reports, download, delete", async () => {
  const { base, close } = await start(null);
  try {
    const post = (json: unknown) => fetch(`${base}/api/reports`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(json) });
    const r = await (await post({ scope: "portfolio", filters: { state: "Odisha" } })).json();
    assert.match(r.title, /Odisha/);
    assert.match(r.body_md, /## Executive summary/);
    assert.match(r.body_md, /## Recommended corrective measures/);
    assert.equal(r.generated_by, "offline");
    const pr = await (await post({ scope: "project", projectId: 37 })).json();
    assert.match(pr.body_md, /## Milestones/);
    assert.equal((await post({ scope: "project" })).status, 422);
    assert.equal((await post({ scope: "project", projectId: 99999 })).status, 404);
    const dl = await fetch(`${base}/api/reports/${r.id}/download`);
    assert.match(dl.headers.get("content-disposition") ?? "", /attachment; filename=".*\.md"/);
    assert.equal((await fetch(`${base}/api/reports/${r.id}`, { method: "DELETE" })).status, 204);
    assert.equal((await fetch(`${base}/api/reports/${r.id}`)).status, 404);
  } finally {
    await close();
  }
});

test("agent loop: calls a tool, feeds the result back, and returns the final answer", async () => {
  const db = openDb(":memory:");
  seedDatabase(db.rw, { asOf: "2026-11-16" });
  const repo = new Repo(db.rw);
  const { client, calls } = fakeClient([
    { text: "Checking delays. ", calls: [{ id: "call_1", name: "list_projects", args: { min_delay_days: 180, sort_by: "delay" } }] },
    { text: "Six projects are more than six months late." },
  ]);
  const events: string[] = [];
  const result = await runAgent({ client, repo, ro: db.ro, history: [], question: "Which projects are badly delayed?", emit: (e) => events.push(e.type) });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].model, "openai/gpt-oss-120b");
  assert.equal(calls[0].stream, true);
  assert.equal(calls[0].messages[0].role, "system");
  assert.ok(calls[0].tools.every((t: any) => t.type === "function" && t.function.name && t.function.parameters));
  assert.equal(calls[0].reasoning_effort, "medium");
  assert.equal(calls[0].include_reasoning, false);
  const msgs = calls[1].messages;
  const assistant = msgs.at(-2);
  assert.equal(assistant.role, "assistant");
  assert.equal(assistant.tool_calls[0].id, "call_1");
  assert.deepEqual(JSON.parse(assistant.tool_calls[0].function.arguments), { min_delay_days: 180, sort_by: "delay" }); // reassembled from split deltas
  const toolMsg = msgs.at(-1);
  assert.equal(toolMsg.role, "tool");
  assert.equal(toolMsg.tool_call_id, "call_1");
  assert.match(toolMsg.content, /"count":/);

  assert.match(result.text, /six months late/);
  assert.equal(result.appended.length, 4); // user, assistant(tool_calls), tool, assistant
  assert.ok(result.artifacts.some((a) => a.type === "table"));
  assert.deepEqual(result.tools, ["list_projects"]);
  assert.ok(events.includes("tool") && events.includes("artifact") && events.includes("text"));
});

test("agent loop: a refused SQL write comes back as a tool error instead of crashing", async () => {
  const db = openDb(":memory:");
  seedDatabase(db.rw, { asOf: "2026-11-16" });
  const { client, calls } = fakeClient([
    { calls: [{ id: "call_1", name: "query_database", args: { sql: "DELETE FROM projects", title: "x" } }] },
    { text: "I can only read data." },
  ]);
  const result = await runAgent({ client, repo: new Repo(db.rw), ro: db.ro, history: [], question: "delete everything", emit: () => {} });
  const toolMsg = calls[1].messages.at(-1);
  assert.equal(toolMsg.role, "tool");
  assert.match(toolMsg.content, /only SELECT|not allowed/i);
  assert.equal((db.rw.prepare("SELECT COUNT(*) n FROM projects").get() as { n: number }).n, 48);
  assert.match(result.text, /read data/);
});

test("chat falls back to the offline engine when Groq errors", async () => {
  for (const failure of [new Groq.APIConnectionError({ message: "network down" }), new Error("unexpected failure")]) {
    const { client } = fakeClient([failure]);
    const { base, db, close } = await start(client);
    try {
      const conv = await (await fetch(`${base}/api/conversations`, { method: "POST" })).json();
      const r = await ask(base, conv.id, "Which works have stalled?");
      assert.ok(r.done, "should complete");
      assert.equal(r.done.meta.mode, "offline");
      assert.match(r.done.meta.notice, /unavailable/);
      assert.match(r.done.text, /stalled/i);
      // History stays valid for the next model turn: a user message then an assistant text reply.
      const rows = db.rw.prepare("SELECT role, content FROM api_messages WHERE conversation_id=? ORDER BY id").all(conv.id) as { role: string; content: string }[];
      assert.deepEqual(rows.map((x) => x.role), ["user", "assistant"]);
      assert.equal(JSON.parse(rows[1].content).role, "assistant");
    } finally {
      await close();
    }
  }
});

test("reports use the model's narrative when Groq is configured", async () => {
  const narrative = "@@SUMMARY\nThe portfolio is behind plan.\n@@CONCERNS\n- Konark is late.\n@@ACTIONS\n1. Hold a review.\n@@OUTLOOK\nWatch the SPI.";
  const { client } = fakeClient([{ text: narrative }]);
  const { base, close } = await start(client);
  try {
    const r = await (await fetch(`${base}/api/reports`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scope: "portfolio" }) })).json();
    assert.match(r.generated_by, /^groq/);
    assert.match(r.body_md, /The portfolio is behind plan/);
  } finally {
    await close();
  }
});

test("tool schemas sent to Groq accept null for optional filters, but not for required ones", () => {
  const summary = (TOOLS.find((t) => t.function?.name === "portfolio_summary")!.function!.parameters as any);
  for (const k of ["state", "scheme", "category"]) assert.deepEqual(summary.properties[k].type, ["string", "null"]);
  const list = (TOOLS.find((t) => t.function?.name === "list_projects")!.function!.parameters as any);
  assert.ok(list.properties.sort_by.enum.includes(null));
  const project = (TOOLS.find((t) => t.function?.name === "get_project")!.function!.parameters as any);
  assert.equal(project.properties.project.type, "string"); // required stays strict
});

test("agent retries once when Groq rejects a tool call's arguments", async () => {
  const db = openDb(":memory:");
  seedDatabase(db.rw, { asOf: "2026-11-16" });
  const rejected = Object.assign(new Error("400 Tool call validation failed: parameters for tool portfolio_summary did not match schema"), { status: 400, error: { error: { code: "tool_use_failed" } } });
  const { client, calls } = fakeClient([
    rejected,
    { calls: [{ id: "call_1", name: "portfolio_summary", args: { state: null, scheme: null, category: null } }] },
    { text: "48 projects; 14 are off track." },
  ]);
  const statuses: string[] = [];
  const result = await runAgent({ client, repo: new Repo(db.rw), ro: db.ro, history: [], question: "Portfolio summary", emit: (e) => { if (e.type === "status") statuses.push(e.message); } });
  assert.equal(calls.length, 3);
  assert.match(result.text, /off track/);
  assert.ok(statuses.some((m) => /Retrying/.test(m)));
  assert.match(calls[2].messages.at(-1).content, /"totals"/); // nulls were treated as "no filter"
});

test("POST /api/projects creates a project; bad input returns field errors", async () => {
  const { base, close } = await start(null);
  try {
    const cat = await (await fetch(`${base}/api/catalog`)).json();
    assert.ok(cat.states.length >= 36 && cat.schemes.includes("PRASHAD") && cat.categories.includes("Heritage"));
    const post = (json: unknown) => fetch(`${base}/api/projects`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(json) });
    const bad = await post({ destination: "" });
    assert.equal(bad.status, 422);
    assert.ok(Object.keys((await bad.json()).fields).length >= 5);
    const res = await post({ destination: "Lepakshi", title: "Visitor centre", state: "Andhra Pradesh", district: "Sri Sathya Sai", scheme: "PRASHAD", category: "Heritage", implementing_agency: "APTDC", nodal_officer: "R. Varma", sanctioned_cost_cr: 24.5, start_date: "2027-01-01", planned_end_date: "2028-12-31" });
    assert.equal(res.status, 201);
    const p = await res.json();
    const list = await (await fetch(`${base}/api/projects`)).json();
    assert.ok(list.some((v: any) => v.id === p.id));
  } finally {
    await close();
  }
});

test("PUT and DELETE /api/projects/:id", async () => {
  const { base, close } = await start(null);
  try {
    const d = await (await fetch(`${base}/api/projects/37`)).json();
    const body = { destination: d.destination, title: "Renamed works", state: d.state, district: d.district, scheme: d.scheme, category: d.category, implementing_agency: d.implementing_agency, nodal_officer: d.nodal_officer, sanctioned_cost_cr: d.sanctioned_cost_cr, start_date: d.start_date, planned_end_date: d.planned_end_date };
    const put = await fetch(`${base}/api/projects/37`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(put.status, 200);
    assert.equal((await put.json()).name, `${d.destination} — Renamed works`);
    const bad = await fetch(`${base}/api/projects/37`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, sanctioned_cost_cr: -1 }) });
    assert.equal(bad.status, 422);
    assert.equal((await fetch(`${base}/api/projects/37`, { method: "DELETE" })).status, 204);
    assert.equal((await fetch(`${base}/api/projects/37`)).status, 404);
    assert.equal((await fetch(`${base}/api/projects/37`, { method: "DELETE" })).status, 404);
  } finally {
    await close();
  }
});
