import { useEffect, useState } from "react";
import { Link, match, useRouter } from "./lib/router";
import { useStore } from "./lib/store";
import { storageGet, storageSet } from "./lib/hooks";
import { api } from "./lib/api";
import { IconAlert, IconMenu, IconMoon, IconOverview, IconProjects, IconReport, IconSearch, IconSpark, IconSun } from "./components/Icons";
import { Overview } from "./pages/Overview";
import { Projects } from "./pages/Projects";
import { ProjectDetailPage } from "./pages/ProjectDetail";
import { Assistant } from "./pages/Assistant";
import { Reports } from "./pages/Reports";
import { ReportView } from "./pages/ReportView";
import { Alerts } from "./pages/Alerts";
import { Empty } from "./components/ui";

const NAV = [
  { to: "/", label: "Overview", icon: IconOverview, match: (p: string) => p === "/" },
  { to: "/assistant", label: "Ask Yatra", icon: IconSpark, match: (p: string) => p.startsWith("/assistant") },
  { to: "/projects", label: "Projects", icon: IconProjects, match: (p: string) => p.startsWith("/projects") },
  { to: "/alerts", label: "Risks & alerts", icon: IconAlert, match: (p: string) => p.startsWith("/alerts") },
  { to: "/reports", label: "Reports", icon: IconReport, match: (p: string) => p.startsWith("/reports") },
];

function useTheme() {
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    const saved = storageGet("yi-theme");
    if (saved === "light" || saved === "dark") return saved;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
  const toggle = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    storageSet("yi-theme", next);
  };
  return { theme, toggle };
}

export function App() {
  const { path, navigate } = useRouter();
  const { health, healthError, alertCount } = useStore();
  const [menuOpen, setMenuOpen] = useState(false);
  const { theme, toggle } = useTheme();

  useEffect(() => setMenuOpen(false), [path]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.closest("input, textarea, select, [contenteditable]");
      if ((e.key === "k" && (e.metaKey || e.ctrlKey)) || (e.key === "/" && !typing)) {
        e.preventDefault();
        if (!path.startsWith("/assistant")) navigate("/assistant");
        setTimeout(() => document.getElementById("composer")?.focus(), 50);
      }
      if (e.key === "Escape" && menuOpen) setMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [path, navigate, menuOpen]);

  let page: React.ReactNode;
  let title = "";
  let p: Record<string, string> | null;
  if (path === "/") { page = <Overview />; title = "Overview"; }
  else if (path === "/projects") { page = <Projects />; title = "Projects"; }
  else if ((p = match("/projects/:id", path))) { page = <ProjectDetailPage id={Number(p.id)} key={p.id} />; title = "Project"; }
  else if (path === "/assistant") { page = <Assistant convId={null} />; title = "Ask Yatra"; }
  else if ((p = match("/assistant/:id", path))) { page = <Assistant convId={p.id} />; title = "Ask Yatra"; }
  else if (path === "/reports") { page = <Reports />; title = "Reports"; }
  else if ((p = match("/reports/:id", path))) { page = <ReportView id={Number(p.id)} key={p.id} />; title = "Report"; }
  else if (path === "/alerts") { page = <Alerts />; title = "Risks & alerts"; }
  else {
    page = <div className="page"><Empty title="Page not found" action={<Link className="btn btn-primary" to="/">Open the overview</Link>}>There's nothing at {path}.</Empty></div>;
    title = "Not found";
  }
  const isAssistant = path.startsWith("/assistant");
  const resetDemo = async () => {
    if (!window.confirm("Restore the original demo data? Progress you've recorded, logged issues, saved reports and conversations will be removed.")) return;
    try {
      await api("/api/admin/reset-demo", { method: "POST" });
      window.location.assign("/");
    } catch (e) {
      window.alert((e as Error).message);
    }
  };
  const llm = health?.llm;

  return (
    <div className="app">
      <a className="skip-link" href="#main">Skip to content</a>
      {menuOpen && <button className="scrim" aria-label="Close menu" onClick={() => setMenuOpen(false)} />}
      <aside className="sidebar" data-open={menuOpen} aria-label="Primary">
        <Link to="/" className="brand" aria-label="Yatra Insight home">
          <span className="brand-mark" aria-hidden="true">Y</span>
          <span>
            <span className="brand-name">Yatra Insight</span>
            <span className="brand-sub">Tourism project monitoring</span>
          </span>
        </Link>
        <nav className="nav" aria-label="Main">
          {NAV.map((n) => (
            <Link key={n.to} to={n.to} className="nav-item" aria-current={n.match(path) ? "page" : undefined}>
              <n.icon size={18} />
              <span className="nav-word">{n.label}</span>
              {n.to === "/alerts" && alertCount > 0 && <span className="nav-count" aria-label={`${alertCount} projects with critical alerts`}>{alertCount}</span>}
            </Link>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="mode-chip" title={llm?.configured ? `Model ${llm.model}, effort ${llm.effort}` : "Set ANTHROPIC_API_KEY to enable Claude"}>
            <span className="mode-dot" style={{ background: healthError ? "var(--crit)" : llm?.configured ? "var(--good)" : "var(--warn)" }} aria-hidden="true" />
            <span>
              <strong style={{ display: "block", fontWeight: 600 }}>{healthError ? "Server unreachable" : !health ? "Connecting…" : llm?.configured ? "Claude connected" : "Offline analysis mode"}</strong>
              <span className="muted">{healthError ? "Start the API and reload." : llm?.configured ? llm.model : "Add an API key for full AI answers."}</span>
            </span>
          </div>
          <div className="row" style={{ justifyContent: "space-between", padding: "0 4px" }}>
            <span className="small muted">
              {health ? `Data as of ${health.asOf}` : ""}
              <button className="btn btn-ghost btn-sm" style={{ display: "block", padding: 0, height: 24, fontWeight: 500, color: "var(--muted)" }} onClick={resetDemo} title="Restore the original synthetic demo portfolio">Reset demo data</button>
            </span>
            <button className="btn btn-ghost btn-icon btn-sm" onClick={toggle} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`} title="Toggle theme">
              {theme === "dark" ? <IconSun size={16} /> : <IconMoon size={16} />}
            </button>
          </div>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <button className="btn btn-ghost btn-icon menu-btn" aria-label="Open menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}><IconMenu /></button>
          <span className="topbar-title">{title}</span>
          <span className="topbar-spacer" />
          {!isAssistant && (
            <button className="search-trigger" onClick={() => { navigate("/assistant"); setTimeout(() => document.getElementById("composer")?.focus(), 50); }} aria-label="Ask a question about projects">
              <IconSearch size={16} />
              <span>Ask about any project…</span>
              <span className="kbd" aria-hidden="true">⌘K</span>
            </button>
          )}
        </header>
        <main id="main" tabIndex={-1} style={{ outline: "none" }}>{page}</main>
      </div>
    </div>
  );
}
