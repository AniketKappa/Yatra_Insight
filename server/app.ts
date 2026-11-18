// Express application (separate from index.ts so tests can mount it in-memory).

import express, { type NextFunction, type Request, type Response } from "express";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type Groq from "groq-sdk";
import type { Db } from "./db.ts";
import type { Artifact, PortfolioFilters, Turn } from "./types.ts";
import { Repo, NotFoundError, ValidationError } from "./repo.ts";
import { matchesFilters } from "./analytics.ts";
import { seedDatabase } from "./seed.ts";
import { answerOffline } from "./llm/offline.ts";
import { runAgent, type AgentEvent, type ChatMessage } from "./llm/agent.ts";
import { EFFORT, IS_REASONING_MODEL, MODEL, describeError, getClient, llmConfigured } from "./llm/groq.ts";
import { generateReport, getReport, listReports } from "./reports.ts";
import { todayISO } from "./lib/dates.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const MAX_QUESTION = 2000;
const MAX_USER_TURNS = 40;

type MessageParam = ChatMessage;

export function createApp(db: Db, opts: { client?: Groq | null } = {}) {
  const repo = new Repo(db.rw);
  const clientFor = () => (opts.client !== undefined ? opts.client : getClient());
  const busy = new Set<string>();
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "100kb" }));

  // Tiny fixed-window rate limiter for the expensive endpoints.
  const hits = new Map<string, { n: number; reset: number }>();
  const limit = (max: number) => (req: Request, res: Response, next: NextFunction) => {
    const key = `${req.ip}:${req.path.split("/")[2]}`;
    const now = Date.now();
    const h = hits.get(key);
    if (!h || h.reset < now) hits.set(key, { n: 1, reset: now + 60_000 });
    else if (++h.n > max) return void res.status(429).json({ error: "Too many requests — please wait a minute and try again." });
    next();
  };

  const filtersFrom = (q: Request["query"]): PortfolioFilters => {
    const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 120) : undefined);
    return { state: s(q.state), scheme: s(q.scheme), category: s(q.category), health: s(q.health), q: s(q.q) };
  };
  const idParam = (v: string | string[] | undefined) => {
    const n = Number(Array.isArray(v) ? v[0] : v);
    if (!Number.isInteger(n) || n <= 0) throw new NotFoundError("Not found");
    return n;
  };

  // ---- Status ------------------------------------------------------------------
  app.get("/api/health", (_req, res) => {
    const c = db.rw.prepare("SELECT (SELECT COUNT(*) FROM projects) AS projects, (SELECT COUNT(*) FROM progress_reports) AS reports").get() as { projects: number; reports: number };
    res.json({ ok: true, asOf: todayISO(), llm: { configured: clientFor() !== null && (opts.client !== undefined || llmConfigured()), provider: "Groq", model: MODEL, effort: IS_REASONING_MODEL ? EFFORT : null }, data: c });
  });

  app.get("/api/meta", (_req, res) => res.json(repo.facets()));

  // ---- Portfolio & projects ------------------------------------------------------
  app.get("/api/portfolio", (req, res) => res.json(repo.portfolio(filtersFrom(req.query))));

  app.get("/api/projects", (req, res) => {
    const f = filtersFrom(req.query);
    res.json(repo.views().filter((v) => matchesFilters(v, f)));
  });

  app.get("/api/projects/:id", (req, res) => res.json(repo.detail(idParam(req.params.id))));

  app.get("/api/catalog", (_req, res) => res.json(repo.catalog()));
  app.post("/api/projects", (req, res) => res.status(201).json(repo.addProject(req.body ?? {})));
  app.put("/api/projects/:id", (req, res) => res.json(repo.updateProject(idParam(req.params.id), req.body ?? {})));
  app.delete("/api/projects/:id", (req, res) => {
    repo.deleteProject(idParam(req.params.id));
    res.status(204).end();
  });
  app.post("/api/projects/:id/progress", (req, res) => res.status(201).json(repo.addProgressReport(idParam(req.params.id), req.body ?? {})));
  app.post("/api/projects/:id/issues", (req, res) => res.status(201).json(repo.addIssue(idParam(req.params.id), req.body ?? {})));
  app.patch("/api/issues/:id", (req, res) => res.json(repo.updateIssueStatus(idParam(req.params.id), String(req.body?.status ?? ""))));

  app.get("/api/alerts", (_req, res) => {
    const rows = repo.views().flatMap((v) => v.metrics.flags.map((flag) => ({ projectId: v.id, code: v.code, project: v.name, state: v.state, health: v.metrics.health, riskScore: v.metrics.riskScore, flag })));
    const issues = db.rw.prepare(`SELECT i.*, p.code, p.name AS project, p.state FROM issues i JOIN projects p ON p.id = i.project_id WHERE i.status != 'Resolved' ORDER BY CASE i.severity WHEN 'Critical' THEN 0 WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 ELSE 3 END, i.raised_on`).all();
    res.json({ flags: rows, issues });
  });

  // ---- Assistant -----------------------------------------------------------------
  app.get("/api/conversations", (_req, res) => {
    res.json(db.rw.prepare("SELECT c.*, (SELECT COUNT(*) FROM turns t WHERE t.conversation_id = c.id AND t.role='user') AS questions FROM conversations c ORDER BY updated_at DESC LIMIT 100").all());
  });

  app.post("/api/conversations", (_req, res) => {
    const id = randomUUID();
    db.rw.prepare("INSERT INTO conversations (id, title, mode) VALUES (?,?,?)").run(id, "New conversation", clientFor() ? "llm" : "offline");
    res.status(201).json(db.rw.prepare("SELECT * FROM conversations WHERE id=?").get(id));
  });

  const loadTurns = (id: string): Turn[] =>
    (db.rw.prepare("SELECT * FROM turns WHERE conversation_id = ? ORDER BY id").all(id) as Record<string, unknown>[]).map((r) => ({
      id: Number(r.id), role: r.role as Turn["role"], text: String(r.text), artifacts: JSON.parse(String(r.artifacts)), meta: JSON.parse(String(r.meta)), created_at: String(r.created_at),
    }));

  app.get("/api/conversations/:id", (req, res) => {
    const conv = db.rw.prepare("SELECT * FROM conversations WHERE id=?").get(String(req.params.id));
    if (!conv) throw new NotFoundError("Conversation not found");
    res.json({ ...conv, turns: loadTurns(String(req.params.id)) });
  });

  app.delete("/api/conversations/:id", (req, res) => {
    db.rw.prepare("DELETE FROM conversations WHERE id=?").run(String(req.params.id));
    res.status(204).end();
  });

  app.post("/api/conversations/:id/messages", limit(30), async (req, res) => {
    const convId = String(req.params.id);
    const conv = db.rw.prepare("SELECT * FROM conversations WHERE id=?").get(convId) as { title: string } | undefined;
    if (!conv) throw new NotFoundError("Conversation not found");
    const question = typeof req.body?.question === "string" ? req.body.question.trim() : "";
    if (!question) throw new ValidationError({ question: "Type a question first." });
    if (question.length > MAX_QUESTION) throw new ValidationError({ question: `Questions are limited to ${MAX_QUESTION} characters.` });
    const asked = (db.rw.prepare("SELECT COUNT(*) AS n FROM turns WHERE conversation_id=? AND role='user'").get(convId) as { n: number }).n;
    if (asked >= MAX_USER_TURNS) throw new ValidationError({ question: "This conversation is full. Start a new conversation to keep going." });
    if (busy.has(convId)) return void res.status(409).json({ error: "Still answering the previous question in this conversation." });
    busy.add(convId);

    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    const send = (event: string, data: unknown) => {
      if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const abort = new AbortController();
    res.on("close", () => abort.abort());
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);

    try {
      const insTurn = db.rw.prepare("INSERT INTO turns (conversation_id, role, text, artifacts, meta) VALUES (?,?,?,?,?)");
      const userId = Number(insTurn.run(convId, "user", question, "[]", "{}").lastInsertRowid);
      send("start", { userTurnId: userId });
      if (asked === 0) {
        db.rw.prepare("UPDATE conversations SET title=? WHERE id=?").run(question.length > 70 ? `${question.slice(0, 67)}…` : question, convId);
      }

      const client = clientFor();
      let text = "";
      let artifacts: Artifact[] = [];
      let meta: Turn["meta"];
      let appended: MessageParam[] = [];

      if (client) {
        const history = (db.rw.prepare("SELECT role, content FROM api_messages WHERE conversation_id=? ORDER BY id").all(convId) as { role: string; content: string }[])
          .map((r) => JSON.parse(r.content) as MessageParam);
        try {
          const result = await runAgent({ client, repo, ro: db.ro, history, question, signal: abort.signal, emit: (e: AgentEvent) => send(e.type, e) });
          text = result.text;
          artifacts = result.artifacts;
          appended = result.appended;
          meta = { mode: "llm", model: result.model, tools: result.tools };
        } catch (err) {
          if (abort.signal.aborted) throw err;
          const off = answerOffline(question, repo);
          text = off.text;
          artifacts = off.artifacts;
          meta = { mode: "offline", error: describeError(err), notice: `The AI model was unavailable (${describeError(err)}). This answer comes from the offline analysis engine.` };
          send("reset", {});
          send("text", { type: "text", delta: text });
          for (const a of artifacts) send("artifact", { type: "artifact", artifact: a });
          appended = [{ role: "user", content: question }, { role: "assistant", content: text }];
        }
      } else {
        const off = answerOffline(question, repo);
        text = off.text;
        artifacts = off.artifacts;
        meta = { mode: "offline" };
        // Stream the offline answer in small chunks so the UI behaves the same.
        for (const chunk of text.match(/[\s\S]{1,48}/g) ?? []) {
          send("text", { type: "text", delta: chunk });
          await new Promise((r) => setTimeout(r, 8));
          if (abort.signal.aborted) break;
        }
        for (const a of artifacts) send("artifact", { type: "artifact", artifact: a });
      }

      const insApi = db.rw.prepare("INSERT INTO api_messages (conversation_id, role, content) VALUES (?,?,?)");
      db.rw.exec("BEGIN");
      try {
        for (const m of appended) insApi.run(convId, m.role, JSON.stringify(m));
        const turnId = Number(insTurn.run(convId, "assistant", text, JSON.stringify(artifacts), JSON.stringify(meta)).lastInsertRowid);
        db.rw.prepare("UPDATE conversations SET updated_at=datetime('now'), mode=? WHERE id=?").run(meta.mode ?? "offline", convId);
        db.rw.exec("COMMIT");
        send("done", { turn: loadTurns(convId).find((t) => t.id === turnId) });
      } catch (err) {
        db.rw.exec("ROLLBACK");
        throw err;
      }
    } catch (err) {
      if (!abort.signal.aborted) send("error", { message: describeError(err) });
    } finally {
      clearInterval(heartbeat);
      busy.delete(convId);
      res.end();
    }
  });

  // ---- Reports -----------------------------------------------------------------
  app.get("/api/reports", (_req, res) => res.json(listReports(db.rw)));
  app.post("/api/reports", limit(10), async (req, res) => {
    const b = req.body ?? {};
    const r = await generateReport(db.rw, repo, clientFor(), { scope: b.scope, projectId: b.projectId === undefined ? undefined : Number(b.projectId), filters: b.filters });
    res.status(201).json(r);
  });
  app.get("/api/reports/:id", (req, res) => res.json(getReport(db.rw, idParam(req.params.id))));
  app.get("/api/reports/:id/download", (req, res) => {
    const r = getReport(db.rw, idParam(req.params.id));
    const slug = r.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${slug}-${r.as_of}.md"`);
    res.send(`# ${r.title}\n\n_As of ${r.as_of} · generated by ${r.generated_by}_\n\n${r.body_md}\n`);
  });
  app.delete("/api/reports/:id", (req, res) => {
    db.rw.prepare("DELETE FROM reports WHERE id=?").run(idParam(req.params.id));
    res.status(204).end();
  });

  // ---- Admin: reset the demo data ---------------------------------------------------
  app.post("/api/admin/reset-demo", limit(3), (_req, res) => {
    const s = seedDatabase(db.rw);
    db.rw.exec("DELETE FROM conversations");
    repo.invalidate();
    res.json(s);
  });

  app.use("/api", (_req, res) => res.status(404).json({ error: "Unknown API route" }));

  // ---- Static frontend (production build) ---------------------------------------------
  const dist = path.resolve(here, "..", "web", "dist");
  if (fs.existsSync(dist)) {
    app.use(express.static(dist, { index: false, maxAge: "1h" }));
    app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(dist, "index.html")));
  }

  // ---- Errors -------------------------------------------------------------------------
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return void res.end();
    if (err instanceof ValidationError) return void res.status(422).json({ error: err.message, fields: err.fields });
    if (err instanceof NotFoundError) return void res.status(404).json({ error: err.message });
    if ((err as { type?: string })?.type === "entity.parse.failed") return void res.status(400).json({ error: "Malformed JSON body." });
    if ((err as { type?: string })?.type === "entity.too.large") return void res.status(413).json({ error: "Request body too large." });
    console.error(err);
    res.status(500).json({ error: "Something went wrong on the server." });
  });

  return { app, repo };
}
