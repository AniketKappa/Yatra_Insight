// Offline question answering: a transparent rule-based interpreter used when
// no Anthropic API key is configured (or the API is unreachable). It understands
// the most common monitoring questions and answers them with the same tools the
// LLM uses, so numbers are identical in both modes.

import type { Artifact, ProjectView } from "../types.ts";
import type { Repo } from "../repo.ts";
import { listProjects, projectsTable, type ListFilters, cr } from "../tools.ts";

export interface Answer {
  text: string;
  artifacts: Artifact[];
}

const STATE_ALIASES: Record<string, string> = {
  up: "Uttar Pradesh", mp: "Madhya Pradesh", hp: "Himachal Pradesh", ap: "Andhra Pradesh",
  "j&k": "Jammu & Kashmir", jk: "Jammu & Kashmir", kashmir: "Jammu & Kashmir", tn: "Tamil Nadu",
  wb: "West Bengal", bengal: "West Bengal", andaman: "Andaman & Nicobar", pondicherry: "Puducherry",
  orissa: "Odisha", uk: "Uttarakhand",
};
const SCHEME_ALIASES: [RegExp, string][] = [
  [/swadesh|sd2|sd 2\.0/i, "Swadesh Darshan 2.0"],
  [/prashad|prasad/i, "PRASHAD"],
  [/challenge|cbdd/i, "Challenge Based Destination Development"],
  [/sasci|special assistance/i, "Special Assistance to States (SASCI)"],
  [/central agenc|\baca\b/i, "Assistance to Central Agencies"],
];
const CATEGORY_ALIASES: [RegExp, string][] = [
  [/heritage|monument|fort/i, "Heritage"], [/pilgrim|temple|religious/i, "Pilgrimage"],
  [/eco|nature|wildlife|lake/i, "Eco-tourism"], [/coastal|beach|marine/i, "Coastal"],
  [/adventure|trek|raft/i, "Adventure"], [/rural|village|craft/i, "Rural"],
  [/buddhis/i, "Buddhist"], [/wellness|yoga|ayurved/i, "Wellness"],
];

export function parseFilters(q: string, repo: Repo): { filters: ListFilters; labels: string[] } {
  const facets = repo.facets();
  const lower = ` ${q.toLowerCase()} `;
  const filters: ListFilters = {};
  const labels: string[] = [];
  const state = facets.states.find((s) => lower.includes(` ${s.toLowerCase()}`) || lower.includes(s.toLowerCase()))
    ?? Object.entries(STATE_ALIASES).find(([k]) => new RegExp(`[^a-z&]${k.replace("&", "\\&")}[^a-z&]`).test(lower))?.[1];
  if (state && facets.states.includes(state)) { filters.state = state; labels.push(state); }
  const scheme = SCHEME_ALIASES.find(([re]) => re.test(q))?.[1];
  if (scheme) { filters.scheme = scheme; labels.push(scheme); }
  const category = CATEGORY_ALIASES.find(([re]) => re.test(q))?.[1];
  if (category && !/heritage town/i.test(q)) { filters.category = category; labels.push(category); }
  return { filters, labels };
}

function num(q: string, re: RegExp): number | undefined {
  const m = q.match(re);
  return m ? Number(m[1]) : undefined;
}

const fmtDelay = (d: number | null) => (d === null ? "n/a" : d <= 0 ? "on time" : `${d} days late`);
const scope = (labels: string[]) => (labels.length ? ` in ${labels.join(" · ")}` : "");

function bullets(views: ProjectView[], fn: (v: ProjectView) => string, max = 6): string {
  return views.slice(0, max).map((v) => `- **${v.name}** (${v.code}, ${v.state}) — ${fn(v)}`).join("\n");
}

export function answerOffline(question: string, repo: Repo): Answer {
  const q = question.trim();
  const lower = q.toLowerCase();
  const { filters, labels } = parseFilters(q, repo);
  const topN = num(lower, /\btop\s+(\d{1,2})\b/) ?? num(lower, /\b(\d{1,2})\s+(?:riskiest|worst|most)\b/);

  if (!q) return { text: "Ask a question about the project portfolio — for example *Which projects in Kerala are delayed?*", artifacts: [] };

  if (/^(hi|hello|hey|help|what can you do|how do i use)/i.test(lower)) return help();

  // ---- A specific project -----------------------------------------------------
  const code = q.match(/\b(SD2|PRASHAD|CBDD|SASCI|ACA)-[A-Z]{2}-\d{4}\b/i)?.[0];
  const byDestination = repo.views().find((v) => {
    const d = v.destination.toLowerCase().replace(/\s*\(.*\)/, "");
    return lower.includes(d) || (d.split(/[\s–—-]+/)[0].length > 4 && lower.includes(d.split(/[\s–—-]+/)[0]));
  });
  const target = code ? repo.findProject(code) : byDestination;
  if (target && !/\b(compare|states|all projects|portfolio)\b/.test(lower)) return projectAnswer(repo, target, lower);

  // ---- Milestones --------------------------------------------------------------
  if (/milestone|deadline|due\b|upcoming/.test(lower)) {
    const days = num(lower, /next\s+(\d{1,3})\s*days?/) ?? (/(next|this)\s+month/.test(lower) ? 30 : 60);
    const p = repo.portfolio({ state: filters.state, scheme: filters.scheme, category: filters.category });
    if (/overdue|missed|late|slipped/.test(lower)) {
      const rows = p.overdueMilestones;
      return {
        text: rows.length
          ? `**${rows.length} milestones are overdue**${scope(labels)} (more than 14 days past plan and not complete). The longest-running:\n\n${rows.slice(0, 6).map((r) => `- **${r.name}** — ${r.project} (${r.code}), due ${r.plannedEnd}, **${r.daysOverdue} days overdue**`).join("\n")}`
          : `No milestones are overdue${scope(labels)}.`,
        artifacts: rows.length ? [{ type: "table", title: "Overdue milestones", columns: ["Code", "Project", "Milestone", "Planned end", "Days overdue"], rows: rows.map((r) => [r.code, r.project, r.name, r.plannedEnd, r.daysOverdue]) }] : [],
      };
    }
    const rows = p.upcomingMilestones.filter((r) => r.daysToGo <= days);
    const atRisk = rows.filter((r) => r.health === "Off track" || r.health === "At risk");
    return {
      text: rows.length
        ? `**${rows.length} milestones fall due in the next ${days} days**${scope(labels)}. ${atRisk.length ? `${atRisk.length} belong to projects already at risk or off track — watch these first:` : "All belong to projects currently on track."}\n\n${(atRisk.length ? atRisk : rows).slice(0, 6).map((r) => `- **${r.name}** — ${r.project}, due ${r.plannedEnd} (${r.daysToGo} days), ${r.progressPct}% done`).join("\n")}`
        : `No milestones fall due in the next ${days} days${scope(labels)}.`,
      artifacts: rows.length ? [{ type: "table", title: `Milestones due in the next ${days} days`, columns: ["Code", "Project", "Milestone", "Due", "Days to go", "Progress %", "Project health"], rows: rows.map((r) => [r.code, r.project, r.name, r.plannedEnd, r.daysToGo, r.progressPct, r.health]) }] : [],
    };
  }

  // ---- Stalled / on hold ------------------------------------------------------
  if (/stall|stuck|on hold|stopped|no progress|halt/.test(lower)) {
    const { views } = listProjects(repo, { ...filters, stalled: true, sort_by: "risk", limit: topN ?? 25 });
    return listAnswer(views, labels,
      (n) => `**${n} project${n === 1 ? " has" : "s have"} effectively stalled**${scope(labels)} — physical progress below 0.4 percentage points a month over the last quarter, or formally on hold.`,
      (v) => `${v.metrics.actualPct}% complete, moving ${v.metrics.velocity ?? 0} pp/month; ${v.metrics.flags.find((f) => f.code === "CRITICAL_ISSUE")?.detail ?? "no critical issue logged — the cause needs a site review"}`,
      `No stalled projects${scope(labels)}. Every active project moved at least 0.4 percentage points a month over the last quarter.`);
  }

  // ---- Stale reporting ---------------------------------------------------------
  if (/stale|not (been )?updated|no (recent )?update|reporting|overdue report|outdated/.test(lower)) {
    const { views } = listProjects(repo, { ...filters, stale: true, sort_by: "risk", limit: 60 });
    return listAnswer(views, labels,
      (n) => `**${n} project${n === 1 ? "'s" : "s'"} progress report${n === 1 ? " is" : "s are"} overdue**${scope(labels)} (no report in the last 45 days). Their figures may be out of date:`,
      (v) => `last report ${v.metrics.lastReportMonth ?? "never"}, ${v.metrics.daysSinceUpdate} days ago`,
      `Reporting is current${scope(labels)}: every active project filed a report within the last 45 days.`);
  }

  // ---- Cost --------------------------------------------------------------------
  if (/overrun|over budget|over-budget|cost|escalat|exceed|expensive|cpi/.test(lower) && !/spent|utili[sz]ation|released/.test(lower)) {
    const min = num(lower, /(?:more than|above|over|>\s*|at least)\s*(\d{1,3})\s*%/) ?? 5;
    const { views } = listProjects(repo, { ...filters, min_overrun_pct: min, sort_by: "overrun", limit: topN ?? 25 });
    const total = views.reduce((s, v) => s + Math.max(0, v.metrics.forecastOverrunCr), 0);
    const answer = listAnswer(views, labels,
      (n) => `**${n} project${n === 1 ? " is" : "s are"} forecast to overrun by more than ${min}%**${scope(labels)}, adding about **${cr(total)}** to the approved cost. Estimates use the cost performance index (CPI = value of work done ÷ money spent):`,
      (v) => `forecast +${v.metrics.overrunPct}% (EAC ${cr(v.metrics.eacCr)} vs ${cr(v.metrics.budgetCr)}), CPI ${v.metrics.cpi?.toFixed(2)}`,
      `No project${scope(labels)} is forecast to overrun by more than ${min}%. (Projects under 10% complete are excluded because their CPI isn't reliable yet.)`);
    if (views.length > 1) answer.artifacts.push({ type: "chart", spec: { kind: "bar", title: "Forecast cost overrun", unit: "%", categories: views.slice(0, 12).map((v) => v.destination), series: [{ name: "Forecast overrun %", values: views.slice(0, 12).map((v) => v.metrics.overrunPct) }] } });
    return answer;
  }

  // ---- Funds -------------------------------------------------------------------
  if (/spent|spend|expenditure|utili[sz]|fund|released|budget|money|financial/.test(lower)) {
    const p = repo.portfolio({ state: filters.state, scheme: filters.scheme, category: filters.category });
    if (!p.totals.projects) return { text: `No projects match${scope(labels)}.`, artifacts: [] };
    const t = p.totals;
    const groups = filters.state ? p.byScheme : p.byState;
    return {
      text: `**Financial position${scope(labels)}** across ${t.projects} projects:\n\n- Approved cost **${cr(t.budgetCr)}** (sanctioned ${cr(t.sanctionedCr)})\n- Funds released **${cr(t.releasedCr)}**, spent **${cr(t.spentCr)}** — utilisation **${t.utilisationPct}%** of approved cost\n- Unspent balance with agencies **${cr(Math.max(0, t.releasedCr - t.spentCr))}**\n- Physical progress **${t.physicalPct}%** (planned ${t.plannedPct}% by today)\n- Forecast cost at completion **${cr(t.eacCr)}**, i.e. **${cr(t.forecastOverrunCr)}** above approved cost`,
      artifacts: [
        { type: "chart", spec: { kind: "bar", title: `Approved cost vs spent by ${filters.state ? "scheme" : "state"}`, unit: "₹ cr", categories: groups.slice(0, 15).map((g) => g.key), series: [{ name: "Approved", values: groups.slice(0, 15).map((g) => g.budgetCr) }, { name: "Spent", values: groups.slice(0, 15).map((g) => g.spentCr) }] } },
        { type: "table", title: `By ${filters.state ? "scheme" : "state"}`, columns: [filters.state ? "Scheme" : "State", "Projects", "Approved ₹ cr", "Spent ₹ cr", "Physical %"], rows: groups.map((g) => [g.key, g.count, g.budgetCr, g.spentCr, g.physicalPct]) },
      ],
    };
  }

  // ---- Delays ------------------------------------------------------------------
  if (/delay|behind|late|slip|schedule|spi|lagg/.test(lower)) {
    const min = num(lower, /(?:more than|over|above|>\s*|at least)\s*(\d{1,4})\s*days?/) ?? 30;
    const { views } = listProjects(repo, { ...filters, min_delay_days: min, sort_by: "delay", limit: topN ?? 30 });
    const answer = listAnswer(views, labels,
      (n) => `**${n} project${n === 1 ? " is" : "s are"} forecast to finish more than ${min} days late**${scope(labels)}. Forecasts use the earned-schedule method (SPI below 1 means behind plan):`,
      (v) => `${fmtDelay(v.metrics.delayDays)} (forecast ${v.metrics.forecastEnd}, SPI ${v.metrics.spi?.toFixed(2) ?? "n/a"}); ${v.metrics.flags[0]?.title.toLowerCase() ?? ""}`,
      `No project${scope(labels)} is forecast to finish more than ${min} days late.`);
    if (views.length > 1) answer.artifacts.push({ type: "chart", spec: { kind: "bar", title: "Forecast delay", unit: "days", categories: views.slice(0, 12).map((v) => v.destination), series: [{ name: "Forecast delay (days)", values: views.slice(0, 12).map((v) => v.metrics.delayDays) }] } });
    return answer;
  }

  // ---- Comparisons ---------------------------------------------------------------
  if (/compare|by state|which state|state-wise|statewise|by scheme|which scheme|scheme-wise|by category/.test(lower)) {
    const p = repo.portfolio({ state: filters.state, scheme: filters.scheme, category: filters.category });
    const dim = /scheme/.test(lower) ? "scheme" : /category|type/.test(lower) ? "category" : "state";
    const groups = dim === "scheme" ? p.byScheme : dim === "category" ? p.byCategory : p.byState;
    const worst = [...groups].sort((a, z) => z.avgRisk - a.avgRisk);
    return {
      text: `**Comparison by ${dim}${scope(labels)}.** Highest average risk: ${worst.slice(0, 3).map((g) => `**${g.key}** (risk ${g.avgRisk}, ${g.offTrack} off track of ${g.count})`).join("; ")}. Lowest: ${worst.slice(-2).map((g) => `${g.key} (${g.avgRisk})`).join(", ")}.`,
      artifacts: [
        { type: "chart", spec: { kind: "bar", title: `Average risk score by ${dim}`, unit: "score", categories: worst.slice(0, 15).map((g) => g.key), series: [{ name: "Average risk", values: worst.slice(0, 15).map((g) => g.avgRisk) }] } },
        { type: "table", title: `By ${dim}`, columns: [dim[0].toUpperCase() + dim.slice(1), "Projects", "Approved ₹ cr", "Spent ₹ cr", "Physical %", "Delayed", "Off track", "Avg risk"], rows: groups.map((g) => [g.key, g.count, g.budgetCr, g.spentCr, g.physicalPct, g.delayed, g.offTrack, g.avgRisk]) },
      ],
    };
  }

  // ---- Corrective measures -------------------------------------------------------
  if (/recommend|corrective|what should|action|fix|remed|mitigat|suggest/.test(lower)) {
    const { views } = listProjects(repo, { ...filters, health: ["Off track", "At risk", "On hold"], sort_by: "risk", limit: topN ?? 5 });
    if (!views.length) return { text: `Nothing needs corrective action${scope(labels)} — no project is at risk or off track.`, artifacts: [] };
    const parts = views.map((v) => {
      const recs = v.metrics.recommendations.slice(0, 2).map((r) => `  - *${r.priority}* — ${r.action} (${r.owner})`).join("\n");
      return `**${v.name}** (${v.code}) — risk ${v.metrics.riskScore}, ${v.metrics.flags[0]?.title.toLowerCase() ?? v.metrics.health.toLowerCase()}\n${recs}`;
    });
    return { text: `**Priority corrective measures${scope(labels)}**, highest-risk projects first:\n\n${parts.join("\n\n")}`, artifacts: [projectsTable("Projects needing action", views)] };
  }

  // ---- Risk ----------------------------------------------------------------------
  if (/risk|critical|worst|problem|concern|attention|red flag|off track|at risk|trouble/.test(lower)) {
    const health = /off track/.test(lower) ? ["Off track"] : /at risk/.test(lower) ? ["At risk"] : undefined;
    const { views } = listProjects(repo, { ...filters, health, sort_by: "risk", limit: topN ?? 10 });
    const active = views.filter((v) => v.metrics.health !== "Completed" && v.metrics.riskScore > 0);
    return listAnswer(active, labels,
      (n) => `**${health ? `${n} project${n === 1 ? " is" : "s are"} ${health[0].toLowerCase()}` : `The ${n} highest-risk projects`}${scope(labels)}.** The risk score (0–100) adds up schedule, delay, cost, open issues, overdue milestones, stalled work and stale reporting:`,
      (v) => `risk **${v.metrics.riskScore}** (${v.metrics.riskLevel}) — ${v.metrics.flags.slice(0, 2).map((f) => f.title.toLowerCase()).join("; ") || "no flags"}`,
      `No high-risk projects${scope(labels)}.`);
  }

  // ---- Count / list / overview -------------------------------------------------------
  const p = repo.portfolio({ state: filters.state, scheme: filters.scheme, category: filters.category });
  if (!p.totals.projects) return { text: `I couldn't find any projects${scope(labels)}. Try another state or scheme.`, artifacts: [] };
  if (/how many|count|number of|list|show( me)? (all )?projects/.test(lower)) {
    const { views } = listProjects(repo, { ...filters, sort_by: "risk", limit: 60 });
    return {
      text: `There ${p.totals.projects === 1 ? "is **1 project**" : `are **${p.totals.projects} projects**`}${scope(labels)}: ${Object.entries(p.health).filter(([, n]) => n).map(([h, n]) => `${n} ${h.toLowerCase()}`).join(", ")}.`,
      artifacts: [projectsTable("Projects", views)],
    };
  }
  return overview(p, labels, q);
}

function listAnswer(views: ProjectView[], labels: string[], head: (n: number) => string, line: (v: ProjectView) => string, empty: string): Answer {
  if (!views.length) return { text: empty, artifacts: [] };
  const more = views.length > 6 ? `\n\n…and ${views.length - 6} more in the table below.` : "";
  return { text: `${head(views.length)}\n\n${bullets(views, line)}${more}`, artifacts: [projectsTable("Matching projects", views)] };
}

function projectAnswer(repo: Repo, v: ProjectView, lower: string): Answer {
  const d = repo.detail(v.id);
  const m = d.metrics;
  const lines = [
    `**${d.name}** (${d.code}) — ${d.scheme}, ${d.district}, ${d.state}. Executed by ${d.implementing_agency}; nodal officer ${d.nodal_officer}.`,
    "",
    `- **Health: ${m.health}** · risk ${m.riskScore}/100 (${m.riskLevel})`,
    `- **Progress:** ${m.actualPct}% complete vs ${m.plannedPctToday}% planned by today${m.spi !== null ? ` · SPI ${m.spi.toFixed(2)}` : ""}`,
    m.health === "Completed"
      ? `- **Completed** on ${d.actual_end_date ?? m.forecastEnd} (planned ${d.planned_end_date})`
      : `- **Finish:** planned ${d.planned_end_date}, forecast ${m.forecastEnd ?? "n/a"}${m.delayDays && m.delayDays > 0 ? ` — **${m.delayDays} days late**` : ""}`,
    `- **Cost:** approved ${cr(m.budgetCr)}${d.revised_cost_cr ? ` (revised from ${cr(d.sanctioned_cost_cr)})` : ""}, spent ${cr(m.spentCr)}${m.cpiReliable ? ` · CPI ${m.cpi?.toFixed(2)} · forecast ${cr(m.eacCr)} (${m.overrunPct >= 0 ? "+" : ""}${m.overrunPct}%)` : ""}`,
    `- **Last report:** ${m.lastReportMonth ?? "none"}${m.daysSinceUpdate !== null ? ` (${m.daysSinceUpdate} days ago)` : ""}`,
  ];
  if (m.flags.length) lines.push("", "**Concerns**", ...m.flags.slice(0, 4).map((f) => `- ${f.title}: ${f.detail}`));
  const open = d.issues.filter((i) => i.status !== "Resolved");
  if (open.length) lines.push("", "**Open issues**", ...open.map((i) => `- [${i.severity}] ${i.title} — owner: ${i.owner}`));
  if (m.recommendations.length && !/\bprogress\b|\bstatus\b/.test(lower) || /recommend|action|what should/.test(lower)) {
    lines.push("", "**Recommended corrective measures**", ...m.recommendations.slice(0, 4).map((r) => `- *${r.priority}* — ${r.action} (${r.owner})`));
  }
  const reps = d.reports.slice(-12);
  const artifacts: Artifact[] = [{ type: "projects", title: d.name, ids: [d.id] }];
  if (reps.length > 1) {
    const plan = new Map(d.plannedSeries.map((s) => [s.month, s.plannedPct]));
    artifacts.push({ type: "chart", spec: { kind: "line", title: "Physical progress — planned vs actual", unit: "%", categories: reps.map((r) => r.month), series: [{ name: "Planned", values: reps.map((r) => plan.get(r.month) ?? null) }, { name: "Actual", values: reps.map((r) => r.physical_pct) }] } });
  }
  return { text: lines.join("\n"), artifacts };
}

function overview(p: ReturnType<Repo["portfolio"]>, labels: string[], q: string): Answer {
  const t = p.totals;
  const understood = labels.length || /summary|overview|status|portfolio|how are|overall|brief/i.test(q);
  const intro = understood ? "" : `I wasn't sure what you meant by "${q.slice(0, 80)}", so here is the portfolio overview. Try asking about delays, cost overruns, stalled works, milestones, funds or a specific destination.\n\n`;
  return {
    text: `${intro}**Portfolio status${scope(labels)}** — ${t.projects} projects, approved cost ${cr(t.budgetCr)}:\n\n- **${p.health["On track"]} on track**, ${p.health["At risk"]} at risk, **${p.health["Off track"]} off track**, ${p.health["On hold"]} on hold, ${p.health.Completed} completed, ${p.health["Not started"]} not started\n- Physical progress **${t.physicalPct}%** against **${t.plannedPct}%** planned${t.weightedSpi !== null ? ` (budget-weighted SPI ${t.weightedSpi})` : ""}\n- **${t.delayed}** projects forecast to finish more than 30 days late; **${t.overBudget}** forecast to overrun cost by more than 5% (about ${cr(t.forecastOverrunCr)} in total)\n- **${t.openCriticalIssues}** critical issues open, **${t.overdueMilestones}** overdue milestones, **${t.stale}** projects with overdue progress reports\n\n**Needs attention first:** ${p.topRisks.slice(0, 3).map((r) => `${r.name} (risk ${r.riskScore})`).join("; ")}.`,
    artifacts: [{ type: "table", title: "Highest-risk projects", columns: ["Code", "Project", "State", "Health", "Risk", "Delay (days)", "Top concern"], rows: p.topRisks.map((r) => [r.code, r.name, r.state, r.health, r.riskScore, r.delayDays, r.topFlag]) }],
  };
}

function help(): Answer {
  return {
    text: `I can answer questions about the tourism project portfolio. Try:\n\n- *Which projects are delayed by more than 90 days?*\n- *Show cost overruns above 15% under PRASHAD*\n- *What is the status of the Konark project?*\n- *Which milestones are due in the next 30 days?*\n- *Which projects have stalled?*\n- *Compare states by risk*\n- *How much has been spent in Madhya Pradesh?*\n- *What corrective measures do the top 3 risky projects need?*`,
    artifacts: [],
  };
}
