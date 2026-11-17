// App-wide data: server health (LLM mode) and a project index for linking.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { ProjectView } from "../../../server/types";
import { api } from "./api";

export interface Health {
  ok: boolean;
  asOf: string;
  llm: { configured: boolean; provider?: string; model: string; effort: string | null };
  data: { projects: number; reports: number };
}

interface Store {
  health: Health | null;
  healthError: string | null;
  projects: ProjectView[] | null;
  index: Map<number, ProjectView> | null;
  refreshProjects: () => void;
  meta: { states: string[]; schemes: string[]; categories: string[] } | null;
  alertCount: number;
}

const Ctx = createContext<Store | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectView[] | null>(null);
  const [meta, setMeta] = useState<Store["meta"]>(null);

  const refreshProjects = useCallback(() => {
    api<ProjectView[]>("/api/projects").then(setProjects).catch(() => {});
    api<Store["meta"]>("/api/meta").then(setMeta).catch(() => {});
  }, []);

  useEffect(() => {
    api<Health>("/api/health").then(setHealth).catch((e) => setHealthError(e.message));
    refreshProjects();
  }, [refreshProjects]);

  const index = useMemo(() => (projects ? new Map(projects.map((p) => [p.id, p])) : null), [projects]);
  const alertCount = useMemo(() => (projects ?? []).filter((p) => p.metrics.flags.some((f) => f.severity === "critical")).length, [projects]);

  return <Ctx.Provider value={{ health, healthError, projects, index, refreshProjects, meta, alertCount }}>{children}</Ctx.Provider>;
}

export function useStore() {
  const c = useContext(Ctx);
  if (!c) throw new Error("useStore outside provider");
  return c;
}
