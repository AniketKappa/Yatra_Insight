// Shared types (imported by the web app with `import type`).

export type Health = "On track" | "At risk" | "Off track" | "Completed" | "Not started" | "On hold";
export type RiskLevel = "Low" | "Moderate" | "High" | "Critical";
export type Severity = "critical" | "high" | "medium" | "low";

export interface Project {
  id: number;
  code: string;
  name: string;
  destination: string;
  scheme: string;
  state: string;
  district: string;
  category: string;
  implementing_agency: string;
  nodal_officer: string;
  description: string;
  sanctioned_cost_cr: number;
  revised_cost_cr: number | null;
  start_date: string;
  planned_end_date: string;
  actual_end_date: string | null;
  status: "Not started" | "In progress" | "On hold" | "Completed";
  lat: number | null;
  lng: number | null;
}

export interface Milestone {
  id: number;
  project_id: number;
  seq: number;
  name: string;
  weight_pct: number;
  planned_start: string;
  planned_end: string;
  actual_start: string | null;
  actual_end: string | null;
  progress_pct: number;
}

export interface ProgressReport {
  id: number;
  project_id: number;
  month: string;
  physical_pct: number;
  expenditure_cr: number;
  funds_released_cr: number;
  remarks: string;
  reported_by: string;
  reported_at: string;
}

export interface Issue {
  id: number;
  project_id: number;
  category: string;
  severity: "Low" | "Medium" | "High" | "Critical";
  status: "Open" | "Mitigating" | "Resolved";
  title: string;
  description: string;
  owner: string;
  raised_on: string;
  resolved_on: string | null;
}

export interface Flag {
  code: string;
  severity: Severity;
  title: string;
  detail: string;
}

export interface Recommendation {
  action: string;
  rationale: string;
  owner: string;
  priority: "Immediate" | "Within 30 days" | "Next review";
  flag: string;
}

export interface RiskComponent {
  factor: string;
  points: number;
  max: number;
  note: string;
}

export interface Metrics {
  asOf: string;
  health: Health;
  riskScore: number;
  riskLevel: RiskLevel;
  riskBreakdown: RiskComponent[];
  plannedPctAtReport: number | null;
  plannedPctToday: number;
  actualPct: number;
  spi: number | null;
  cpi: number | null;
  cpiReliable: boolean;
  budgetCr: number;
  spentCr: number;
  releasedCr: number;
  utilisationPct: number;
  eacCr: number;
  forecastOverrunCr: number;
  overrunPct: number;
  escalationPct: number;
  forecastEnd: string | null;
  forecastBasis: "actual" | "earned-schedule" | "resume-at-plan" | "plan" | "none";
  delayDays: number | null;
  velocity: number | null;
  stalled: boolean;
  overdueMilestones: { id: number; name: string; plannedEnd: string; daysOverdue: number }[];
  upcomingMilestones: { id: number; name: string; plannedEnd: string; daysToGo: number; progressPct: number }[];
  openIssues: number;
  criticalIssues: number;
  lastReportMonth: string | null;
  lastReportedAt: string | null;
  daysSinceUpdate: number | null;
  flags: Flag[];
  recommendations: Recommendation[];
}

export interface ProjectView extends Project {
  metrics: Metrics;
}

export interface ProjectDetail extends ProjectView {
  milestones: Milestone[];
  reports: ProgressReport[];
  issues: Issue[];
  plannedSeries: { month: string; plannedPct: number; plannedSpendCr: number }[];
}

export interface PortfolioFilters {
  state?: string;
  scheme?: string;
  category?: string;
  health?: string;
  q?: string;
}

export interface GroupStat {
  key: string;
  count: number;
  budgetCr: number;
  spentCr: number;
  physicalPct: number;
  delayed: number;
  offTrack: number;
  avgRisk: number;
  forecastOverrunCr: number;
}

export interface Portfolio {
  asOf: string;
  filters: PortfolioFilters;
  totals: {
    projects: number;
    sanctionedCr: number;
    budgetCr: number;
    spentCr: number;
    releasedCr: number;
    eacCr: number;
    forecastOverrunCr: number;
    physicalPct: number;
    plannedPct: number;
    utilisationPct: number;
    weightedSpi: number | null;
    delayed: number;
    overBudget: number;
    stale: number;
    openCriticalIssues: number;
    overdueMilestones: number;
  };
  health: Record<Health, number>;
  riskLevels: Record<RiskLevel, number>;
  byState: GroupStat[];
  byScheme: GroupStat[];
  byCategory: GroupStat[];
  topRisks: { id: number; code: string; name: string; state: string; health: Health; riskScore: number; riskLevel: RiskLevel; delayDays: number | null; overrunPct: number; topFlag: string | null }[];
  upcomingMilestones: { projectId: number; code: string; project: string; name: string; plannedEnd: string; daysToGo: number; progressPct: number; health: Health }[];
  overdueMilestones: { projectId: number; code: string; project: string; name: string; plannedEnd: string; daysOverdue: number }[];
  sCurve: { month: string; plannedPct: number; actualPct: number | null }[];
  alerts: { projectId: number; code: string; project: string; flag: Flag }[];
}

export interface ChartSpec {
  kind: "bar" | "line";
  title: string;
  unit?: string;
  categories: string[];
  series: { name: string; values: (number | null)[] }[];
}

export type Artifact =
  | { type: "table"; title: string; columns: string[]; rows: (string | number | null)[][]; sql?: string; truncated?: boolean }
  | { type: "chart"; spec: ChartSpec }
  | { type: "projects"; title: string; ids: number[] };

export interface Turn {
  id: number;
  role: "user" | "assistant";
  text: string;
  artifacts: Artifact[];
  meta: { mode?: "claude" | "offline"; model?: string; error?: string; tools?: string[]; notice?: string };
  created_at: string;
}
