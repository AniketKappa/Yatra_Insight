import { useState, type FormEvent } from "react";
import { api } from "../lib/api";
import { useApi, useDocumentTitle } from "../lib/hooks";
import { Link, useRouter } from "../lib/router";
import { useStore } from "../lib/store";
import { fmtDate, relTime } from "../lib/format";
import { Card, Empty, ErrorState, Field, Skeleton, useToast } from "../components/ui";
import { IconChevronRight, IconReport, IconSpark } from "../components/Icons";

interface ReportRow { id: number; scope: "portfolio" | "project"; project_id: number | null; title: string; as_of: string; generated_by: string; created_at: string }

export function Reports() {
  useDocumentTitle("Reports");
  const { data, error, loading, reload } = useApi<ReportRow[]>("/api/reports");
  const { meta, projects, health } = useStore();
  const { navigate } = useRouter();
  const toast = useToast();
  const [scope, setScope] = useState<"portfolio" | "project">("portfolio");
  const [filters, setFilters] = useState({ state: "", scheme: "", category: "" });
  const [projectId, setProjectId] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (scope === "project" && !projectId) return setErr("Choose a project.");
    setBusy(true);
    try {
      const r = await api<{ id: number }>("/api/reports", { method: "POST", json: scope === "project" ? { scope, projectId: Number(projectId) } : { scope, filters: Object.fromEntries(Object.entries(filters).filter(([, v]) => v)) } });
      toast("Report generated.");
      navigate(`/reports/${r.id}`);
    } catch (e2) {
      setErr((e2 as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <p className="eyebrow">Reporting</p>
          <h1><span className="rise">Progress reports</span></h1>
          <p className="lede">Monthly progress reports, ready to print, built from the latest data. The figures come straight from the analytics; {health?.llm.configured ? "Claude writes the narrative and recommendations." : "the narrative is written by the offline template (add an API key to have Claude write it)."}</p>
        </div>
      </div>
      <div className="grid grid-main">
        <div className="stack">
          <Card title="Saved reports" sub={data ? `${data.length} report${data.length === 1 ? "" : "s"}` : undefined}>
            {error && <ErrorState error={error} onRetry={reload} />}
            {loading && <div className="stack">{[0, 1, 2].map((i) => <Skeleton key={i} h={52} />)}</div>}
            {data && data.length === 0 && <Empty icon={<IconReport />} title="No reports yet">Generate your first report with the form. It takes a few seconds.</Empty>}
            {data && data.length > 0 && (
              <div className="list">
                {data.map((r) => (
                  <Link key={r.id} to={`/reports/${r.id}`} className="list-item list-link" style={{ alignItems: "center" }}>
                    <div className="icon-tile"><IconReport size={16} /></div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <span className="cell-title">{r.title}</span>
                      <span className="cell-sub">As of {fmtDate(r.as_of)} · {r.generated_by.startsWith("claude") ? "Claude narrative" : "Template narrative"} · {relTime(r.created_at)}</span>
                    </div>
                    <IconChevronRight size={16} />
                  </Link>
                ))}
              </div>
            )}
          </Card>
        </div>
        <Card title="Generate a report">
          <form className="form-grid" onSubmit={submit} noValidate>
            <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
              <legend className="label" style={{ marginBottom: 8 }}>Scope</legend>
              <div className="view-toggle" role="radiogroup" style={{ display: "flex" }}>
                {(["portfolio", "project"] as const).map((s) => (
                  <button type="button" key={s} role="radio" aria-checked={scope === s} aria-pressed={scope === s} onClick={() => setScope(s)} style={{ flex: 1, textAlign: "center", padding: "8px 12px" }}>{s === "portfolio" ? "Portfolio" : "Single project"}</button>
                ))}
              </div>
            </fieldset>
            {scope === "portfolio" ? (
              <>
                <Field id="r-state" label="State (optional)"><select id="r-state" className="select" value={filters.state} onChange={(e) => setFilters({ ...filters, state: e.target.value })}><option value="">All states</option>{meta?.states.map((s) => <option key={s}>{s}</option>)}</select></Field>
                <Field id="r-scheme" label="Scheme (optional)"><select id="r-scheme" className="select" value={filters.scheme} onChange={(e) => setFilters({ ...filters, scheme: e.target.value })}><option value="">All schemes</option>{meta?.schemes.map((s) => <option key={s}>{s}</option>)}</select></Field>
                <Field id="r-category" label="Category (optional)"><select id="r-category" className="select" value={filters.category} onChange={(e) => setFilters({ ...filters, category: e.target.value })}><option value="">All categories</option>{meta?.categories.map((s) => <option key={s}>{s}</option>)}</select></Field>
              </>
            ) : (
              <Field id="r-project" label="Project" error={err && !projectId ? err : undefined}>
                <select id="r-project" className="select" value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-invalid={Boolean(err && !projectId)}>
                  <option value="">Choose a project…</option>
                  {[...(projects ?? [])].sort((a, b) => a.name.localeCompare(b.name)).map((p) => <option key={p.id} value={p.id}>{p.name} ({p.code})</option>)}
                </select>
              </Field>
            )}
            {err && (scope === "portfolio" || projectId) && <div className="error-box" role="alert">{err}</div>}
            <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? <><span className="spinner" />Generating{health?.llm.configured ? " with Claude" : ""}…</> : <><IconSpark size={16} />Generate report</>}</button>
            {busy && health?.llm.configured && <p className="hint">Claude is writing the narrative — this can take up to a minute.</p>}
          </form>
        </Card>
      </div>
    </div>
  );
}
