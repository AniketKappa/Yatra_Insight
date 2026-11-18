// The natural-language agent: a Groq-hosted model + analysis tools in a streaming loop.

import type Groq from "groq-sdk";
import type { DatabaseSync } from "node:sqlite";
import type { Artifact } from "../types.ts";
import type { Repo } from "../repo.ts";
import { TOOL_DEFS, runTool } from "../tools.ts";
import { MODEL, reasoningParams } from "./groq.ts";
import { todayISO } from "../lib/dates.ts";

export type ChatMessage = Groq.Chat.ChatCompletionMessageParam;

export type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "tool"; name: string; label: string }
  | { type: "artifact"; artifact: Artifact }
  | { type: "status"; message: string };

const MAX_TOOL_ROUNDS = 8;

export const SYSTEM_PROMPT = `You are Yatra Insight, an analyst assistant for officials of a tourism ministry who monitor tourism infrastructure and development projects (schemes such as Swadesh Darshan 2.0, PRASHAD, Challenge Based Destination Development, SASCI). You sit on top of the Project Monitoring System and answer questions with its live data.

How to work:
- Always get numbers from the tools. Never invent a project, figure or date. If the data can't answer the question, say so and say what data would.
- Prefer list_projects, get_project and portfolio_summary. Use query_database (read-only SQLite) only for questions those can't answer. If a tool returns an error, fix the call and retry once.
- Mention projects by name with their code in brackets, e.g. Konark — Sound-and-Light Show (SD2-OD-0288).
- Money is in Indian rupees crore: write ₹12.40 cr. Use Indian conventions.
- Definitions: SPI (earned-schedule) below 1 means behind schedule; CPI below 1 means spending more than the value of work done; EAC is the estimate at completion; delay_days is the forecast slip beyond the planned finish. Explain a term in plain words the first time you use it.
- When you recommend corrective measures, make them specific and actionable: what to do, who owns it, by when. Ground them in the project's flags, open issues and the recommendations the tools return. Typical levers in Indian public works: escalation to the District Collector for land issues, show-cause / termination notices to non-performing contractors, utilisation certificates for the next fund tranche, value-engineering before revised cost estimates, liquidated damages vs extension of time, catch-up schedules with fortnightly review.
- Call show_chart when a comparison or trend is clearer as a picture (one chart per answer is usually enough). The tables your tools return are shown to the user automatically, so don't repeat long tables in your text — summarise the insight and list at most the top 5 items.
- Answer in concise Markdown: lead with the direct answer in one or two sentences, then supporting points. Use short headings only for long answers. No preamble.
- If the user writes in Hindi or another language, answer in that language.`;

/** Groq validates tool arguments against the schema, and models often send null for filters they
 * don't use. Optional properties therefore also accept null (tools.ts already ignores nulls). */
function nullableOptionals(schema: Record<string, any>): Record<string, unknown> {
  const required = new Set<string>(schema.required ?? []);
  const properties: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries<any>(schema.properties ?? {})) {
    if (required.has(key) || !prop.type) { properties[key] = prop; continue; }
    const types = Array.isArray(prop.type) ? prop.type : [prop.type];
    properties[key] = { ...prop, type: types.includes("null") ? types : [...types, "null"], ...(prop.enum ? { enum: [...prop.enum, null] } : {}) };
  }
  return { ...schema, properties };
}

export const TOOLS: Groq.Chat.ChatCompletionTool[] = TOOL_DEFS.map((t) => ({
  type: "function" as const,
  function: { name: t.name, description: t.description, parameters: nullableOptionals(t.input_schema as Record<string, any>) },
}));

/** Groq rejects a turn whose tool call fails its own validation ("tool_use_failed"); worth one retry. */
function isToolValidationError(err: unknown): boolean {
  const e = err as { status?: number; message?: string; error?: { error?: { code?: string } } };
  return e?.status === 400 && (e.error?.error?.code === "tool_use_failed" || /tool call validation failed|tool_use_failed/i.test(e.message ?? ""));
}

export interface AgentResult {
  text: string;
  artifacts: Artifact[];
  appended: ChatMessage[];
  model: string;
  tools: string[];
}

function toolLabel(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "list_projects": return `Filtering projects${input.state ? ` in ${input.state}` : ""}${input.min_delay_days !== undefined ? `, delay ≥ ${input.min_delay_days} days` : ""}${input.min_overrun_pct !== undefined ? `, overrun ≥ ${input.min_overrun_pct}%` : ""}`;
    case "get_project": return `Opening project dossier: ${String(input.project ?? "")}`;
    case "portfolio_summary": return "Summarising the portfolio";
    case "query_database": return `Querying: ${String(input.title ?? "custom analysis")}`;
    case "show_chart": return `Drawing chart: ${String(input.title ?? "")}`;
    default: return name;
  }
}

interface PendingCall { id: string; name: string; args: string }

export async function runAgent(opts: {
  client: Groq;
  repo: Repo;
  ro: DatabaseSync;
  history: ChatMessage[];
  question: string;
  emit: (e: AgentEvent) => void;
  signal?: AbortSignal;
}): Promise<AgentResult> {
  const { client, repo, ro, history, question, emit, signal } = opts;
  const appended: ChatMessage[] = [{ role: "user", content: question }];
  const artifacts: Artifact[] = [];
  const texts: string[] = [];
  const toolsUsed: string[] = [];
  let model = MODEL;

  const system: ChatMessage = { role: "system", content: `${SYSTEM_PROMPT}\n\nToday's date (the as-of date for all metrics) is ${todayISO()}.` };

  let validationRetries = 0;
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const lastRound = round === MAX_TOOL_ROUNDS;
    const request = () => client.chat.completions.create(
      {
        model: MODEL,
        messages: [system, ...history, ...appended],
        tools: TOOLS,
        tool_choice: lastRound ? "none" : "auto",
        parallel_tool_calls: true,
        max_completion_tokens: 8192,
        temperature: 0.2,
        stream: true,
        ...reasoningParams(),
      },
      { signal },
    );

    let text = "";
    let finish: string | null = null;
    const calls = new Map<number, PendingCall>();
    try {
      const stream = await request();
      for await (const chunk of stream) {
      model = chunk.model ?? model;
      const choice = chunk.choices[0];
      if (!choice) continue;
      const delta = choice.delta;
      if (delta?.content) {
        text += delta.content;
        emit({ type: "text", delta: delta.content });
      }
      for (const tc of delta?.tool_calls ?? []) {
        const cur = calls.get(tc.index) ?? { id: "", name: "", args: "" };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        calls.set(tc.index, cur);
      }
      if (choice.finish_reason) finish = choice.finish_reason;
      }
    } catch (err) {
      if (!isToolValidationError(err) || validationRetries++ >= 1) throw err;
      emit({ type: "status", message: "Retrying a malformed tool call…" });
      round--;
      continue;
    }

    const toolCalls = [...calls.values()].filter((c) => c.name);
    if (finish === "length" && toolCalls.length) throw new Error("The response was cut off while calling a tool. Try a narrower question.");
    if (text.trim()) texts.push(text.trim());

    appended.push({
      role: "assistant",
      content: text || null,
      ...(toolCalls.length ? { tool_calls: toolCalls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: c.args || "{}" } })) } : {}),
    } as ChatMessage);
    if (!toolCalls.length) break;

    for (const c of toolCalls) {
      let input: Record<string, unknown> = {};
      let parseError: string | null = null;
      try {
        const parsed = JSON.parse(c.args || "{}");
        if (parsed && typeof parsed === "object") input = parsed;
      } catch {
        parseError = "The tool arguments were not valid JSON. Call the tool again with a JSON object.";
      }
      emit({ type: "tool", name: c.name, label: toolLabel(c.name, input) });
      toolsUsed.push(c.name);
      let content: string;
      if (parseError) content = JSON.stringify({ error: parseError });
      else {
        const r = runTool(repo, ro, c.name, input);
        for (const a of r.artifacts) {
          artifacts.push(a);
          emit({ type: "artifact", artifact: a });
        }
        content = r.forModel.slice(0, 60_000);
      }
      appended.push({ role: "tool", tool_call_id: c.id, content });
    }
    emit({ type: "text", delta: "\n\n" });
  }

  const text = texts.join("\n\n").trim() || "I couldn't produce an answer from the available data.";
  return { text, artifacts, appended, model, tools: [...new Set(toolsUsed)] };
}
