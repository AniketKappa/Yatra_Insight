// HTTP-level tests, plus the Claude agent loop driven by a scripted fake
// client (so the LLM path is exercised without an API key or network).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import Anthropic from "@anthropic-ai/sdk";
import { openDb } from "./db.ts";
import { seedDatabase } from "./seed.ts";
import { createApp } from "./app.ts";
import { Repo } from "./repo.ts";
import { runAgent } from "./llm/agent.ts";

process.env.AS_OF_DATE = "2026-11-16";

type Step = { content: unknown[]; stop_reason: string } | Error;

function fakeClient(steps: Step[]) {
  const calls: any[] = [];
  let i = 0;
  const client = {
    beta: {
      messages: {
        stream(params: any) {
          calls.push(structuredClone(params));
          const step = steps[Math.min(i++, steps.length - 1)];
          const handlers: ((t: string) => void)[] = [];
          return {
            on(ev: string, cb: (t: string) => void) { if (ev === "text") handlers.push(cb); return this; },
            async finalMessage() {
              if (step instanceof Error) throw step;
              for (const b of step.content as any[]) if (b.type === "text") handlers.forEach((h) => h(b.text));
              return { id: `msg_${i}`, type: "message", role: "assistant", model: "claude-opus-5-5", content: step.content, stop_reason: step.stop_reason, usage: {} };
            },
          };
        },
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

async function start(client?: Anthropic | null) {
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
    { content: [{ type: "text", text: "Checking delays." }, { type: "tool_use", id: "tu_1", name: "list_projects", input: { min_delay_days: 180, sort_by: "delay" } }], stop_reason: "tool_use" },
    { content: [{ type: "text", text: "Six projects are more than six months late." }], stop_reason: "end_turn" },
  ]);
  const events: string[] = [];
  const result = await runAgent({ client, repo, ro: db.ro, history: [], question: "Which projects are badly delayed?", emit: (e) => events.push(e.type) });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].model, "claude-opus-5-5");
  assert.equal(calls[0].fallbacks, "default");
  assert.deepEqual(calls[0].betas, ["server-side-fallback-2026-07-01"]);
  assert.ok(calls[0].tools.every((t: any) => t.eager_input_streaming === true));
  const toolResultMsg = calls[1].messages.at(-1);
  assert.equal(toolResultMsg.role, "user");
  assert.equal(toolResultMsg.content[0].type, "tool_result");
  assert.equal(toolResultMsg.content[0].tool_use_id, "tu_1");
  assert.match(toolResultMsg.content[0].content, /"count":/);

  assert.match(result.text, /six months late/);
  assert.equal(result.appended.length, 4); // user, assistant(tool_use), user(tool_result), assistant
  assert.ok(result.artifacts.some((a) => a.type === "table"));
  assert.deepEqual(result.tools, ["list_projects"]);
  assert.ok(events.includes("tool") && events.includes("artifact") && events.includes("text"));
});

test("agent loop: bad tool input becomes an is_error result instead of crashing", async () => {
  const db = openDb(":memory:");
  seedDatabase(db.rw, { asOf: "2026-11-16" });
  const { client, calls } = fakeClient([
    { content: [{ type: "tool_use", id: "tu_1", name: "query_database", input: { sql: "DELETE FROM projects", title: "x" } }], stop_reason: "tool_use" },
    { content: [{ type: "text", text: "I can only read data." }], stop_reason: "end_turn" },
  ]);
  const result = await runAgent({ client, repo: new Repo(db.rw), ro: db.ro, history: [], question: "delete everything", emit: () => {} });
  const tr = calls[1].messages.at(-1).content[0];
  assert.equal(tr.is_error, true);
  assert.match(tr.content, /only SELECT|not allowed/i);
  assert.equal((db.rw.prepare("SELECT COUNT(*) n FROM projects").get() as { n: number }).n, 48);
  assert.match(result.text, /read data/);
});

test("chat falls back to the offline engine when Claude errors or refuses", async () => {
  for (const failure of [new Anthropic.APIConnectionError({ message: "network down" }), { content: [], stop_reason: "refusal" } as Step]) {
    const { client } = fakeClient([failure]);
    const { base, db, close } = await start(client);
    try {
      const conv = await (await fetch(`${base}/api/conversations`, { method: "POST" })).json();
      const r = await ask(base, conv.id, "Which works have stalled?");
      assert.ok(r.done, "should complete");
      assert.equal(r.done.meta.mode, "offline");
      assert.match(r.done.meta.notice, /unavailable/);
      assert.match(r.done.text, /stalled/i);
      // History stays valid for the next Claude turn: a user message then an assistant text reply.
      const rows = db.rw.prepare("SELECT role FROM api_messages WHERE conversation_id=? ORDER BY id").all(conv.id) as { role: string }[];
      assert.deepEqual(rows.map((x) => x.role), ["user", "assistant"]);
    } finally {
      await close();
    }
  }
});
