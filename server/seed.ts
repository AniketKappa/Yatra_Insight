// Deterministic synthetic portfolio of tourism infrastructure projects.
// Every number is generated from a fixed seed relative to the seeding date, so
// the demo always contains the same mix of healthy, slipping, stalled,
// over-budget, completed and not-yet-started projects. This is DEMO DATA: the
// destinations are real places, but the projects, costs and people are invented.

import type { DatabaseSync } from "node:sqlite";
import { addDays, daysBetween, monthEnd, monthOf, monthRange, todayISO, addMonths } from "./lib/dates.ts";
import { sCurve, inverseSCurve } from "./lib/curves.ts";
import { tx } from "./db.ts";

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Category = "Heritage" | "Pilgrimage" | "Eco-tourism" | "Coastal" | "Adventure" | "Rural" | "Buddhist" | "Wellness";
export type SchemeKey = "SD2" | "PRASHAD" | "CBDD" | "SASCI" | "ACA";

export const SCHEMES: Record<SchemeKey, { name: string; min: number; max: number }> = {
  SD2: { name: "Swadesh Darshan 2.0", min: 22, max: 95 },
  PRASHAD: { name: "PRASHAD", min: 18, max: 60 },
  CBDD: { name: "Challenge Based Destination Development", min: 9, max: 38 },
  SASCI: { name: "Special Assistance to States (SASCI)", min: 55, max: 148 },
  ACA: { name: "Assistance to Central Agencies", min: 6, max: 24 },
};

export const STATE_CODES: Record<string, string> = {
  Karnataka: "KA", Kerala: "KL", "Tamil Nadu": "TN", Puducherry: "PY", "Andhra Pradesh": "AP",
  Telangana: "TS", Maharashtra: "MH", Goa: "GA", Gujarat: "GJ", Rajasthan: "RJ",
  "Madhya Pradesh": "MP", Bihar: "BR", "Uttar Pradesh": "UP", Uttarakhand: "UK",
  "Himachal Pradesh": "HP", "Jammu & Kashmir": "JK", Ladakh: "LA", Punjab: "PB", Haryana: "HR",
  Odisha: "OD", "West Bengal": "WB", Assam: "AS", Sikkim: "SK", Meghalaya: "ML",
  "Arunachal Pradesh": "AR", Nagaland: "NL", "Andaman & Nicobar": "AN",
  // not used by the demo seed, available for new projects
  Chhattisgarh: "CG", Jharkhand: "JH", Manipur: "MN", Mizoram: "MZ", Tripura: "TR", Delhi: "DL",
  Chandigarh: "CH", Lakshadweep: "LD", "Dadra & Nagar Haveli and Daman & Diu": "DH",
};
export const CATEGORIES: Category[] = ["Heritage", "Pilgrimage", "Eco-tourism", "Coastal", "Adventure", "Rural", "Buddhist", "Wellness"];

// [destination, state, district, category, scheme, lat, lng]
const DESTINATIONS: [string, string, string, Category, SchemeKey, number, number][] = [
  ["Hampi", "Karnataka", "Vijayanagara", "Heritage", "SD2", 15.335, 76.46],
  ["Mysuru", "Karnataka", "Mysuru", "Heritage", "SASCI", 12.295, 76.639],
  ["Kumarakom", "Kerala", "Kottayam", "Rural", "SD2", 9.617, 76.43],
  ["Sabarimala", "Kerala", "Pathanamthitta", "Pilgrimage", "PRASHAD", 9.434, 77.081],
  ["Varkala", "Kerala", "Thiruvananthapuram", "Coastal", "CBDD", 8.737, 76.716],
  ["Mahabalipuram", "Tamil Nadu", "Chengalpattu", "Heritage", "SD2", 12.62, 80.192],
  ["Rameswaram", "Tamil Nadu", "Ramanathapuram", "Pilgrimage", "PRASHAD", 9.288, 79.313],
  ["Puducherry Heritage Town", "Puducherry", "Puducherry", "Heritage", "SD2", 11.934, 79.83],
  ["Araku Valley", "Andhra Pradesh", "Alluri Sitharama Raju", "Eco-tourism", "SD2", 18.327, 82.877],
  ["Srisailam", "Andhra Pradesh", "Nandyal", "Pilgrimage", "PRASHAD", 16.072, 78.868],
  ["Ramappa", "Telangana", "Mulugu", "Heritage", "CBDD", 18.259, 79.943],
  ["Ajanta–Ellora", "Maharashtra", "Chhatrapati Sambhajinagar", "Heritage", "SASCI", 20.026, 75.179],
  ["Sindhudurg", "Maharashtra", "Sindhudurg", "Coastal", "SD2", 16.043, 73.461],
  ["Old Goa", "Goa", "North Goa", "Heritage", "SD2", 15.501, 73.912],
  ["Dholavira", "Gujarat", "Kutch", "Heritage", "SD2", 23.887, 70.213],
  ["Dwarka", "Gujarat", "Devbhumi Dwarka", "Pilgrimage", "PRASHAD", 22.238, 68.968],
  ["Jaisalmer", "Rajasthan", "Jaisalmer", "Heritage", "SD2", 26.915, 70.908],
  ["Pushkar", "Rajasthan", "Ajmer", "Pilgrimage", "PRASHAD", 26.49, 74.551],
  ["Bundi", "Rajasthan", "Bundi", "Heritage", "CBDD", 25.441, 75.637],
  ["Orchha", "Madhya Pradesh", "Niwari", "Heritage", "SD2", 25.351, 78.64],
  ["Amarkantak", "Madhya Pradesh", "Anuppur", "Pilgrimage", "PRASHAD", 22.673, 81.758],
  ["Gwalior Fort", "Madhya Pradesh", "Gwalior", "Heritage", "SASCI", 26.23, 78.169],
  ["Khajuraho", "Madhya Pradesh", "Chhatarpur", "Heritage", "ACA", 24.852, 79.934],
  ["Bodh Gaya", "Bihar", "Gaya", "Buddhist", "SD2", 24.695, 84.991],
  ["Rajgir", "Bihar", "Nalanda", "Buddhist", "CBDD", 25.028, 85.42],
  ["Varanasi Ghats", "Uttar Pradesh", "Varanasi", "Pilgrimage", "PRASHAD", 25.31, 83.01],
  ["Kushinagar", "Uttar Pradesh", "Kushinagar", "Buddhist", "SD2", 26.741, 83.888],
  ["Prayagraj Sangam", "Uttar Pradesh", "Prayagraj", "Pilgrimage", "SASCI", 25.424, 81.885],
  ["Rishikesh", "Uttarakhand", "Dehradun", "Adventure", "SD2", 30.087, 78.268],
  ["Kedarnath", "Uttarakhand", "Rudraprayag", "Pilgrimage", "PRASHAD", 30.735, 79.067],
  ["Manali", "Himachal Pradesh", "Kullu", "Adventure", "SD2", 32.243, 77.189],
  ["Dharamshala", "Himachal Pradesh", "Kangra", "Wellness", "CBDD", 32.219, 76.323],
  ["Srinagar Dal Lake", "Jammu & Kashmir", "Srinagar", "Eco-tourism", "SD2", 34.117, 74.873],
  ["Leh", "Ladakh", "Leh", "Adventure", "SD2", 34.152, 77.577],
  ["Amritsar", "Punjab", "Amritsar", "Pilgrimage", "PRASHAD", 31.62, 74.877],
  ["Kurukshetra", "Haryana", "Kurukshetra", "Pilgrimage", "SD2", 29.969, 76.878],
  ["Konark", "Odisha", "Puri", "Heritage", "SD2", 19.888, 86.095],
  ["Chilika", "Odisha", "Khordha", "Eco-tourism", "CBDD", 19.718, 85.318],
  ["Sundarbans", "West Bengal", "South 24 Parganas", "Eco-tourism", "SD2", 21.949, 88.897],
  ["Bishnupur", "West Bengal", "Bankura", "Heritage", "CBDD", 23.075, 87.317],
  ["Kaziranga", "Assam", "Golaghat", "Eco-tourism", "SD2", 26.578, 93.171],
  ["Kamakhya", "Assam", "Kamrup Metropolitan", "Pilgrimage", "PRASHAD", 26.166, 91.705],
  ["Majuli", "Assam", "Majuli", "Rural", "CBDD", 26.95, 94.167],
  ["Gangtok", "Sikkim", "Gangtok", "Eco-tourism", "SD2", 27.339, 88.607],
  ["Sohra (Cherrapunji)", "Meghalaya", "East Khasi Hills", "Eco-tourism", "CBDD", 25.271, 91.732],
  ["Ziro Valley", "Arunachal Pradesh", "Lower Subansiri", "Rural", "SD2", 27.588, 93.828],
  ["Kisama Heritage Village", "Nagaland", "Kohima", "Rural", "SD2", 25.622, 94.105],
  ["Swaraj Dweep (Havelock)", "Andaman & Nicobar", "South Andaman", "Coastal", "SD2", 11.967, 92.987],
];

const COMPONENTS: Record<Category, string[]> = {
  Heritage: [
    "Heritage Precinct Interpretation Centre & Visitor Amenities",
    "Sound-and-Light Show and Monument Illumination",
    "Heritage Walk, Signage & Last-mile Connectivity",
  ],
  Pilgrimage: [
    "Pilgrim Facilitation Centre & Queue Complex",
    "Ghat Development & Riverfront Amenities",
    "Darshan Corridor & Crowd Management Infrastructure",
  ],
  "Eco-tourism": [
    "Nature Trails, Watchtowers & Interpretation Centre",
    "Lakefront Rejuvenation & Boating Infrastructure",
    "Eco-lodges & Solid Waste Management Facilities",
  ],
  Coastal: [
    "Beach Promenade, Lifeguard Posts & Amenities",
    "Water Sports Hub & Coastal Experience Zone",
    "Jetty Upgrade & Waterfront Development",
  ],
  Adventure: [
    "Adventure Base Camp & Mountain Rescue Centre",
    "Trekking Trail Network & Camping Grounds",
    "River Rafting Launch Points & Riverside Facilities",
  ],
  Rural: [
    "Craft Village, Haat & Homestay Cluster",
    "Living Heritage Village & Cultural Performance Arena",
  ],
  Buddhist: [
    "Meditation Park & Buddhist Convention Centre",
    "Monastic Heritage Trail & Visitor Plaza",
  ],
  Wellness: ["Wellness & Yoga Retreat Centre", "Ayurveda Wellness Hub & Healing Gardens"],
};

const OFFICERS = [
  "Ananya Rao", "Vikram Sethi", "Meera Pillai", "Rohit Bhandari", "Kavitha Narayanan",
  "Arjun Mehta", "Farah Qureshi", "Sandeep Kulkarni", "Priya Das", "Harpreet Gill",
  "Nikhil Joshi", "Lalremruati Sailo", "Suresh Iyer", "Deepa Hegde", "Imran Lone",
  "Tenzin Norbu", "Sneha Patnaik", "Gaurav Chauhan", "Rupali Bora", "Aditya Menon",
];

export const MILESTONES: { name: string; cum: number }[] = [
  { name: "DPR approval & technical sanction", cum: 4 },
  { name: "Tendering & work order", cum: 9 },
  { name: "Site mobilisation & enabling works", cum: 20 },
  { name: "Civil works – core structures", cum: 62 },
  { name: "Finishing, MEP & landscaping", cum: 90 },
  { name: "Commissioning & handover", cum: 100 },
];

type Archetype =
  | "on_track" | "minor_slip" | "severe_delay" | "overrun" | "stalled"
  | "completed" | "not_started" | "recovering" | "stale" | "on_hold";

// Fixed archetype order guarantees the demo mix regardless of PRNG drift.
const ARCHETYPES: Archetype[] = [
  "on_track", "minor_slip", "severe_delay", "on_track", "overrun", "completed", "stalled", "on_track",
  "minor_slip", "recovering", "on_track", "not_started", "severe_delay", "on_track", "overrun", "minor_slip",
  "completed", "on_track", "stale", "minor_slip", "on_track", "severe_delay", "on_track", "overrun",
  "stalled", "on_track", "minor_slip", "completed", "on_track", "recovering", "on_hold", "minor_slip",
  "on_track", "overrun", "not_started", "on_track", "severe_delay", "minor_slip", "on_track", "completed",
  "on_track", "stale", "minor_slip", "on_track", "overrun", "stalled", "on_track", "recovering",
];

const ISSUE_LIBRARY: Record<string, { category: string; title: string; description: string; owner: string }[]> = {
  severe: [
    { category: "Land acquisition", title: "Encumbrance on 2.4 acres of project land", description: "Private claim on part of the site under adjudication; work front for parking and plaza blocked.", owner: "District Collector" },
    { category: "Statutory clearance", title: "Forest / CRZ clearance pending", description: "Stage-II clearance awaited from the regional office; approach road and trail works on hold.", owner: "State Forest Department" },
    { category: "Litigation", title: "Writ petition challenging tender award", description: "High Court interim order restrains execution on the main structure pending next hearing.", owner: "Law Department" },
    { category: "Utility shifting", title: "HT line and water main shifting delayed", description: "Electricity board yet to approve the shifting estimate; foundation work at the plaza cannot proceed.", owner: "State Electricity Board" },
  ],
  cost: [
    { category: "Design change", title: "Scope addition after site inspection", description: "Additional retaining wall and drainage works required after geotechnical survey; revised estimate under preparation.", owner: "Implementing Agency" },
    { category: "Price escalation", title: "Steel and cement price variation claims", description: "Contractor has raised escalation claims under the price-variation clause; quantum under verification.", owner: "Executive Engineer" },
  ],
  stall: [
    { category: "Contractor performance", title: "Contractor has slowed down work", description: "Labour strength at site dropped below 20% of agreed deployment; show-cause notice issued.", owner: "Implementing Agency" },
    { category: "Funds release", title: "Second tranche release pending", description: "Utilisation certificate for the first tranche returned with observations; release held at Ministry.", owner: "State Tourism Department" },
  ],
  minor: [
    { category: "Weather", title: "Monsoon disruption to civil works", description: "Heavy rainfall halted concreting for several weeks; productivity loss being recovered with extra shifts.", owner: "Contractor" },
    { category: "Approvals", title: "Revised drawings awaiting approval", description: "Architectural drawings for the visitor centre façade sent back for heritage committee comments.", owner: "Heritage Committee" },
    { category: "Material supply", title: "Delay in supply of local stone", description: "Quarry permit renewal delayed supply of dressed stone for paving.", owner: "Contractor" },
  ],
};

const REMARKS: [number, string][] = [
  [0, "Site handed over; survey and setting-out in progress."],
  [8, "Mobilisation complete; site office, labour camp and enabling works in progress."],
  [20, "Foundation and substructure works in progress."],
  [40, "Superstructure works in progress; services sleeves laid."],
  [62, "Core structures complete; masonry, plastering and MEP works under way."],
  [80, "Finishing works, landscaping and signage installation in progress."],
  [95, "Snag rectification and trial runs of systems."],
  [100, "Works completed; handover to operating agency done."],
];

function remarkFor(pct: number, archetype: Archetype): string {
  let base = REMARKS[0][1];
  for (const [t, r] of REMARKS) if (pct >= t) base = r;
  if (archetype === "stalled" && pct < 100) return `${base} Progress negligible this month; labour deployment low.`;
  if (archetype === "severe_delay" && pct < 100) return `${base} Work front constrained by pending clearances.`;
  return base;
}

export interface SeedSummary {
  projects: number;
  progressReports: number;
  milestones: number;
  issues: number;
}

export function seedDatabase(db: DatabaseSync, opts: { asOf?: string; seed?: number } = {}): SeedSummary {
  const asOf = opts.asOf ?? todayISO();
  const rand = mulberry32(opts.seed ?? 20261116);
  const pick = <T,>(arr: T[]) => arr[Math.floor(rand() * arr.length)];
  const between = (a: number, b: number) => a + rand() * (b - a);
  const lastReportMonth = monthOf(addMonths(asOf.slice(0, 8) + "01", -1)); // last full month

  const insProject = db.prepare(`INSERT INTO projects
    (id, code, name, destination, scheme, state, district, category, implementing_agency, nodal_officer,
     description, sanctioned_cost_cr, revised_cost_cr, start_date, planned_end_date, actual_end_date, status, lat, lng)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insMilestone = db.prepare(`INSERT INTO milestones
    (project_id, seq, name, weight_pct, planned_start, planned_end, actual_start, actual_end, progress_pct)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  const insReport = db.prepare(`INSERT INTO progress_reports
    (project_id, month, physical_pct, expenditure_cr, funds_released_cr, remarks, reported_by, reported_at)
    VALUES (?,?,?,?,?,?,?,?)`);
  const insIssue = db.prepare(`INSERT INTO issues
    (project_id, category, severity, status, title, description, owner, raised_on, resolved_on)
    VALUES (?,?,?,?,?,?,?,?,?)`);

  const summary: SeedSummary = { projects: 0, progressReports: 0, milestones: 0, issues: 0 };

  tx(db, () => {
    db.exec("DELETE FROM project_metrics; DELETE FROM issues; DELETE FROM progress_reports; DELETE FROM milestones; DELETE FROM reports; DELETE FROM projects;");
    const serials: Record<string, number> = {};

    DESTINATIONS.forEach(([destination, state, district, category, schemeKey, lat, lng], i) => {
      const id = i + 1;
      const archetype = ARCHETYPES[i % ARCHETYPES.length];
      const scheme = SCHEMES[schemeKey];
      const sanctioned = Math.round(between(scheme.min, scheme.max) * 100) / 100;
      const component = pick(COMPONENTS[category]);
      const name = `${destination} — ${component}`;
      const sc = STATE_CODES[state] ?? "XX";
      serials[schemeKey] = (serials[schemeKey] ?? 100) + Math.floor(between(3, 17));
      const code = `${schemeKey}-${sc}-${String(serials[schemeKey]).padStart(4, "0")}`;
      const officer = OFFICERS[i % OFFICERS.length];
      const agency = pick([
        `${state} Tourism Development Corporation`,
        `${state} Public Works Department`,
        `${state} Tourism Infrastructure Ltd`,
        "India Tourism Development Corporation",
        "NBCC (India) Ltd",
      ]);

      // Timeline per archetype.
      const durationMonths = Math.round(between(20, 38));
      let startOffsetMonths: number; // months before as-of
      switch (archetype) {
        case "completed": startOffsetMonths = durationMonths + Math.round(between(2, 10)); break;
        case "not_started": startOffsetMonths = -Math.round(between(1, 4)); break;
        case "severe_delay": case "stalled": startOffsetMonths = Math.round(durationMonths * between(0.75, 1.25)); break;
        default: startOffsetMonths = Math.round(durationMonths * between(0.2, 0.9));
      }
      const start = addMonths(asOf.slice(0, 8) + "01", -startOffsetMonths);
      const plannedEnd = addDays(addMonths(start, durationMonths), -1);
      const totalDays = daysBetween(start, plannedEnd);

      // Execution behaviour.
      let eff = between(0.97, 1.04);
      let costFactor = between(0.99, 1.05);
      let revised: number | null = null;
      if (archetype === "minor_slip" || archetype === "stale") eff = between(0.82, 0.92);
      if (archetype === "severe_delay") { eff = between(0.52, 0.68); costFactor = between(1.07, 1.15); }
      if (archetype === "overrun") { eff = between(0.88, 0.98); costFactor = between(1.22, 1.42); }
      if (archetype === "stalled") { eff = between(0.75, 0.88); costFactor = between(1.04, 1.12); }
      if (archetype === "completed") eff = between(0.9, 1.0);
      if (archetype === "on_hold") eff = between(0.7, 0.8);
      if (archetype === "overrun" || (archetype === "severe_delay" && rand() < 0.6)) {
        revised = Math.round(sanctioned * between(1.08, 1.22) * 100) / 100;
      }
      const budget = revised ?? sanctioned;
      const stallAtFraction = between(0.45, 0.6); // fraction of the observed window after which a stall begins

      const actualAt = (date: string, observedSpanDays: number): number => {
        const elapsed = daysBetween(start, date);
        if (elapsed <= 0) return 0;
        let effective = elapsed * eff;
        if (archetype === "recovering") {
          const half = observedSpanDays * 0.55;
          effective = elapsed <= half ? elapsed * 0.62 : half * 0.62 + (elapsed - half) * 1.12;
        }
        if (archetype === "stalled" || archetype === "on_hold") {
          const stallDay = observedSpanDays * stallAtFraction;
          if (elapsed > stallDay) effective = stallDay * eff + (elapsed - stallDay) * 0.03;
        }
        return Math.min(100, 100 * sCurve(effective / totalDays));
      };

      // Monthly reports.
      let reportsUntil = lastReportMonth;
      if (archetype === "stale") reportsUntil = monthOf(addMonths(lastReportMonth + "-01", -4));
      if (archetype === "on_hold") reportsUntil = monthOf(addMonths(lastReportMonth + "-01", -2));
      const startMonth = monthOf(start);
      const months = archetype === "not_started" || startMonth > reportsUntil ? [] : monthRange(startMonth, reportsUntil);
      const observedSpanDays = Math.max(1, daysBetween(start, monthEnd(reportsUntil)));

      let prevPct = 0;
      let prevSpent = 0;
      let released = 0;
      let completedOn: string | null = null;
      const pending: [string, number, number, number, string, string][] = [];
      for (const month of months) {
        if (completedOn) break;
        const end = monthEnd(month);
        let pct = actualAt(end, observedSpanDays);
        pct += (rand() - 0.5) * 0.8;
        pct = Math.round(Math.min(100, Math.max(prevPct, pct)) * 10) / 10;
        if (archetype === "completed" && pct >= 99.3) pct = 100;
        if (archetype !== "completed" && pct >= 99.5) pct = 99.4; // only completed projects finish
        const earnedCost = (pct / 100) * budget;
        const advance = pct > 0 && pct < 15 ? budget * 0.04 * (1 - pct / 15) : 0; // mobilisation advance
        let spent = earnedCost * costFactor * between(0.98, 1.02) + advance;
        spent = Math.round(Math.max(prevSpent, spent) * 100) / 100;
        // Funds are released in tranches of 25% of budget, a step ahead of spending.
        while (released < budget && released - spent < budget * 0.08) released = Math.min(budget, released + budget * 0.25);
        if (archetype === "stalled" && pct > 30) released = Math.min(released, Math.max(spent, budget * 0.5));
        const reportedAt = addDays(end, Math.round(between(3, 12)));
        pending.push([month, pct, spent, Math.round(released * 100) / 100, remarkFor(pct, archetype), reportedAt]);
        prevPct = pct;
        prevSpent = spent;
        if (pct >= 100) completedOn = addDays(end, -Math.round(between(2, 20)));
      }

      const status =
        archetype === "not_started" ? "Not started"
        : archetype === "on_hold" ? "On hold"
        : completedOn ? "Completed"
        : "In progress";

      const description = `${component} at ${destination}, ${district} district, ${state}. Sanctioned under ${scheme.name} to improve visitor infrastructure, safety and experience; executed by ${agency}.`;
      insProject.run(id, code, name, destination, scheme.name, state, district, category, agency, officer,
        description, sanctioned, revised, start, plannedEnd, completedOn, status, lat, lng);
      summary.projects++;
      for (const [month, pct, spent, rel, remark, reportedAt] of pending) {
        insReport.run(id, month, pct, spent, rel, remark, officer, reportedAt);
        summary.progressReports++;
      }

      // Milestones: planned dates from the planned S-curve; actual dates from progress history.
      const reportRows = pending.map(([month, physical_pct]) => ({ month, physical_pct }));
      const latestPct = reportRows.length ? reportRows[reportRows.length - 1].physical_pct : 0;
      let prevCum = 0;
      let prevPlannedEnd = start;
      MILESTONES.forEach((m, k) => {
        const plannedEndM = addDays(start, Math.round(inverseSCurve(m.cum / 100) * totalDays));
        const firstAbove = (threshold: number) => reportRows.find((r) => r.physical_pct >= threshold)?.month;
        const startedMonth = firstAbove(prevCum + 0.01);
        const doneMonth = firstAbove(m.cum - 0.05);
        const span = m.cum - prevCum;
        const progress = Math.round(Math.min(100, Math.max(0, ((latestPct - prevCum) / span) * 100)));
        insMilestone.run(
          id, k + 1, m.name, span, prevPlannedEnd, plannedEndM,
          startedMonth ? monthEnd(startedMonth).slice(0, 8) + "05" : null,
          doneMonth ? addDays(monthEnd(doneMonth), -Math.round(between(0, 12))) : null,
          doneMonth ? 100 : progress,
        );
        summary.milestones++;
        prevCum = m.cum;
        prevPlannedEnd = plannedEndM;
      });

      // Issues.
      const addIssue = (lib: keyof typeof ISSUE_LIBRARY, severity: string, status: string, ageDays: number) => {
        const it = pick(ISSUE_LIBRARY[lib]);
        const raised = addDays(asOf, -Math.max(5, Math.round(ageDays)));
        const resolved = status === "Resolved" ? addDays(raised, Math.round(between(20, 90))) : null;
        insIssue.run(id, it.category, severity, status, it.title, it.description, it.owner, raised < start ? start : raised, resolved && resolved > asOf ? asOf : resolved);
        summary.issues++;
      };
      switch (archetype) {
        case "severe_delay":
          addIssue("severe", "Critical", "Open", between(120, 300));
          addIssue("severe", "High", rand() < 0.5 ? "Open" : "Mitigating", between(60, 200));
          addIssue("minor", "Medium", "Resolved", between(200, 400));
          break;
        case "stalled":
          addIssue("stall", "Critical", "Open", between(60, 160));
          addIssue("stall", "High", "Open", between(40, 120));
          break;
        case "overrun":
          addIssue("cost", "High", "Open", between(40, 150));
          addIssue("cost", "Medium", "Mitigating", between(30, 120));
          break;
        case "minor_slip": case "stale":
          addIssue("minor", "Medium", rand() < 0.5 ? "Open" : "Mitigating", between(20, 120));
          break;
        case "recovering":
          addIssue("severe", "High", "Resolved", between(150, 260));
          addIssue("minor", "Low", "Mitigating", between(15, 60));
          break;
        case "on_hold":
          addIssue("severe", "Critical", "Open", between(60, 120));
          break;
        case "completed":
          addIssue("minor", "Low", "Resolved", between(300, 500));
          break;
        case "not_started":
          if (rand() < 0.6) addIssue("minor", "Low", "Open", between(10, 40));
          break;
        default:
          if (rand() < 0.35) addIssue("minor", "Low", "Resolved", between(60, 200));
      }
    });
  });

  return summary;
}
