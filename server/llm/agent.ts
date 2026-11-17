// The natural-language agent: Claude + analysis tools in a streaming loop.

import Anthropic from "@anthropic-ai/sdk";
import type { DatabaseSync } from "node:sqlite";
import type { Artifact } from "../types.ts";
import type { Repo } from "../repo.ts";
import { TOOL_DEFS, runTool } from "../tools.ts";
import { EFFORT, MODEL, RefusalError, fallbackParams } from "./claude.ts";
import { todayISO } from "../lib/dates.ts";

type MessageParam = Anthropic.Beta.BetaMessageParam;

export type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "tool"; name: string; label: string }
  | { type: "artifact"; artifact: Artifact }
  | { type: "status"; message: string };

const MAX_TOOL_ROUNDS = 8;

const SYSTEM_STABLE = `You are Yatra Insight, an analyst assistant for officials of a tourism ministry who monitor tourism infrastructure and development projects (schemes such as Swadesh Darshan 2.0, PRASHAD, Challenge Based Destination Development, SASCI). You sit on top of the Project Monitoring System and answer questions with its live data.

How to work:
- Always get numbers from the tools. Never invent a project, figure or date. If the data can't answer the question, say so and say what data would.
- Prefer list_projects, get_project and portfolio_summary. Use query_database (read-only SQL) only for questions those can't answer. If a tool returns an error, fix the call and retry once.
- Mention projects by name with their code in brackets, e.g. Konark — Sound-and-Light Show (SD2-OD-0288).
- Money is in Indian rupees crore: write ₹12.40 cr. Use Indian conventions.
- Definitions: SPI (earned-schedule) below 1 means behind schedule; CPI below 1 means spending more than the value of work done; EAC is the estimate at completion; delay_days is the forecast slip beyond the planned finish. Explain a term in plain words the first time you use it.
- When you recommend corrective measures, make them specific and actionable: what to do, who owns it, by when. Ground them in the project's flags, open issues and the recommendations the tools return. Typical levers in Indian public works: escalation to the District Collector for land issues, show-cause / termination notices to non-performing contractors, utilisation certificates for the next fund tranche, value-engineering before revised cost estimates, liquidated damages vs extension of time, catch-up schedules with fortnightly review.
- Call show_chart when a comparison or trend is clearer as a picture (one chart per answer is usually enough). The tables your tools return are shown to the user automatically, so don't repeat long tables in your text — summarise the insight and list at most the top 5 items.
- Answer in concise Markdown: lead with the direct answer in one or two sentences, then supporting points. Use short headings only for long answers. No preamble like "Great question".
- If the user writes in Hindi or another language, answer in that language.`;

export interface AgentResult {
  text: string;
  artifacts: Artifact[];
  appended: MessageParam[];
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

export async function runAgent(opts: {
  client: Anthropic;
  repo: Repo;
  ro: DatabaseSync;
  history: MessageParam[];
  question: string;
  emit: (e: AgentEvent) => void;
  signal?: AbortSignal;
}): Promise<AgentResult> {
  const { client, repo, ro, history, question, emit, signal } = opts;
  const appended: MessageParam[] = [{ role: "user", content: question }];
  const artifacts: Artifact[] = [];
  const texts: string[] = [];
  const toolsUsed: string[] = [];
  let model = MODEL;
  let parseRetries = 0;

  const system = [
    { type: "text" as const, text: SYSTEM_STABLE, cache_control: { type: "ephemeral" as const } },
    { type: "text" as const, text: `Today's date (the as-of date for all metrics) is ${todayISO()}.` },
  ];
  const tools = TOOL_DEFS.map((t) => ({ ...t, eager_input_streaming: true }));

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const lastRound = round === MAX_TOOL_ROUNDS;
    const stream = client.beta.messages.stream(
      {
        model: MODEL,
        max_tokens: 16000,
        system,
        tools,
        tool_choice: lastRound ? { type: "none" } : { type: "auto" },
        messages: [...history, ...appended],
        output_config: { effort: EFFORT },
        ...fallbackParams(),
      },
      { signal },
    );
    let roundText = "";
    stream.on("text", (delta) => {
      roundText += delta;
      emit({ type: "text", delta });
    });

    let message: Anthropic.Beta.BetaMessage;
    try {
      message = await stream.finalMessage();
      parseRetries = 0;
    } catch (err) {
      // Only an unparseable streamed tool input is retried; API errors propagate.
      if (err instanceof Anthropic.APIError || (err as Error)?.name === "AbortError" || parseRetries++ >= 2) throw err;
      if (roundText) emit({ type: "status", message: "Retrying a malformed tool call…" });
      round--;
      continue;
    }
    model = message.model ?? model;

    if (message.stop_reason === "refusal") {
      throw new RefusalError("Claude declined to answer this request. Try rephrasing it as a question about the project data.");
    }

    const toolUses = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (message.stop_reason === "max_tokens" && toolUses.length) {
      throw new Error("The response was cut off while calling a tool. Try a narrower question.");
    }
    appended.push({ role: "assistant", content: message.content as unknown as Anthropic.Beta.BetaContentBlockParam[] });
    const finalText = message.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("");
    if (finalText.trim()) texts.push(finalText.trim());

    if (message.stop_reason === "pause_turn") continue;
    if (!toolUses.length) break;

    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      const input = (tu.input && typeof tu.input === "object" ? tu.input : {}) as Record<string, unknown>;
      emit({ type: "tool", name: tu.name, label: toolLabel(tu.name, input) });
      toolsUsed.push(tu.name);
      const r = runTool(repo, ro, tu.name, input);
      for (const a of r.artifacts) {
        artifacts.push(a);
        emit({ type: "artifact", artifact: a });
      }
      results.push({ type: "tool_result", tool_use_id: tu.id, content: r.forModel.slice(0, 60_000), ...(r.isError ? { is_error: true } : {}) });
    }
    // All results go back in ONE user message (keeps parallel tool use working).
    appended.push({ role: "user", content: results });
    emit({ type: "text", delta: "\n\n" });
  }

  const text = texts.join("\n\n").trim() || "I couldn't produce an answer from the available data.";
  return { text, artifacts, appended, model, tools: [...new Set(toolsUsed)] };
}
