import { useEffect, useState, type FormEvent } from "react";
import type { ProjectDetail } from "../../../server/types";
import { api, ApiError } from "../lib/api";
import { Field, Modal } from "./ui";
import { useForm } from "../pages/ProjectDetail";

interface Catalog { states: string[]; schemes: string[]; categories: string[] }

const EMPTY = {
  destination: "", title: "", state: "", district: "", scheme: "", category: "",
  implementing_agency: "", nodal_officer: "", sanctioned_cost_cr: "", revised_cost_cr: "", start_date: "", planned_end_date: "", description: "",
};

/** The form's values for an existing project (its name is "<destination> — <work>"). */
function valuesFrom(p: ProjectDetail): typeof EMPTY {
  const prefix = `${p.destination} — `;
  return {
    destination: p.destination, title: p.name.startsWith(prefix) ? p.name.slice(prefix.length) : p.name,
    state: p.state, district: p.district, scheme: p.scheme, category: p.category,
    implementing_agency: p.implementing_agency, nodal_officer: p.nodal_officer,
    sanctioned_cost_cr: String(p.sanctioned_cost_cr), revised_cost_cr: p.revised_cost_cr == null ? "" : String(p.revised_cost_cr),
    start_date: p.start_date, planned_end_date: p.planned_end_date, description: p.description,
  };
}

/** Client-side checks mirror the server's; the server stays the authority and its field errors are shown too. */
function check(k: string, v: typeof EMPTY): string {
  const val = v[k as keyof typeof EMPTY].trim();
  switch (k) {
    case "destination": return val.length < 2 ? "Enter the destination, e.g. Hampi." : "";
    case "title": return val.length < 3 ? "Describe the work, e.g. Visitor centre and parking." : "";
    case "state": return val ? "" : "Choose a state or union territory.";
    case "district": return val.length < 2 ? "Enter the district." : "";
    case "scheme": return val ? "" : "Choose a scheme.";
    case "category": return val ? "" : "Choose a category.";
    case "implementing_agency": return val.length < 2 ? "Enter the implementing agency." : "";
    case "nodal_officer": return val.length < 2 ? "Enter the nodal officer's name." : "";
    case "sanctioned_cost_cr": {
      const n = Number(val);
      if (!val || !Number.isFinite(n) || n <= 0) return "Enter the sanctioned cost in ₹ crore (more than 0).";
      return n > 5000 ? "That's more than ₹5,000 cr. Check the unit: figures are in crore." : "";
    }
    case "revised_cost_cr": {
      if (!val) return "";
      const n = Number(val);
      return !Number.isFinite(n) || n <= 0 ? "Enter the revised cost in ₹ crore, or leave it blank." : "";
    }
    case "start_date": return val ? "" : "Choose the planned start date.";
    case "planned_end_date": {
      if (!val) return "Choose the planned completion date.";
      if (v.start_date && (Date.parse(val) - Date.parse(v.start_date)) / 86400000 < 90) return "Completion must be at least 3 months after the start.";
      return "";
    }
    default: return "";
  }
}

/** Add a project, or edit one when `project` is given. */
export function ProjectForm({ open, onClose, onSaved, project }: { open: boolean; onClose: () => void; onSaved: (p: ProjectDetail) => void; project?: ProjectDetail }) {
  const editing = Boolean(project);
  const f = useForm(project ? valuesFrom(project) : { ...EMPTY });
  // Re-fill from the latest saved project each time the edit form opens.
  useEffect(() => {
    if (open && project) { f.setValues(valuesFrom(project)); f.setErrors({}); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, project]);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  useEffect(() => {
    if (open && !catalog) api<Catalog>("/api/catalog").then(setCatalog).catch(() => {});
  }, [open, catalog]);

  const blur = (k: string) => () => {
    const msg = check(k, f.values);
    f.setErrors((e) => { const n = { ...e }; if (msg) n[k] = msg; else delete n[k]; return n; });
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    for (const k of Object.keys(EMPTY)) { const m = check(k, f.values); if (m) errs[k] = m; }
    f.setErrors(errs);
    if (Object.keys(errs).length) {
      document.getElementById(`f-${Object.keys(errs)[0]}`)?.focus();
      return;
    }
    f.setBusy(true);
    try {
      const json = { ...f.values, sanctioned_cost_cr: Number(f.values.sanctioned_cost_cr), revised_cost_cr: f.values.revised_cost_cr === "" ? null : Number(f.values.revised_cost_cr) };
      const saved = project
        ? await api<ProjectDetail>(`/api/projects/${project.id}`, { method: "PUT", json })
        : await api<ProjectDetail>("/api/projects", { method: "POST", json });
      if (!project) f.setValues({ ...EMPTY });
      onSaved(saved);
    } catch (err) {
      if (err instanceof ApiError && err.fields) f.setErrors(err.fields);
      else f.setErrors({ form: (err as Error).message });
    } finally {
      f.setBusy(false);
    }
  };

  const sel = (k: keyof typeof EMPTY, label: string, options: string[] | undefined, placeholder: string) => (
    <Field id={`f-${k}`} label={label} error={f.errors[k]}>
      <select className="select" {...f.bind(k)} onBlur={blur(k)}>
        <option value="">{options ? placeholder : "Loading…"}</option>
        {options?.map((o) => <option key={o}>{o}</option>)}
      </select>
    </Field>
  );

  return (
    <Modal open={open} onClose={onClose} title={editing ? `Edit ${project!.code}` : "Add a project"} labelledBy="project-form-title"
      footer={<><button className="btn btn-ghost" type="button" onClick={onClose}>Cancel</button><button className="btn btn-primary" form="project-form" type="submit" disabled={f.busy}>{f.busy && <span className="spinner" />}{editing ? "Save changes" : "Add project"}</button></>}>
      <form id="project-form" className="form-grid" onSubmit={submit} noValidate>
        <p className="muted small">{editing
          ? "The project code stays the same. Changing the dates replans the milestones' planned dates; recorded progress is kept."
          : "The project code and six standard milestones are created from these details. Record monthly progress from the project page once work starts."}</p>
        {f.errors.form && <div className="error-box" role="alert">{f.errors.form}</div>}
        <div className="form-grid two">
          <Field id="f-destination" label="Destination" error={f.errors.destination} hint="The place, e.g. Hampi">
            <input className="input" maxLength={80} autoComplete="off" {...f.bind("destination")} onBlur={blur("destination")} />
          </Field>
          <Field id="f-title" label="Work" error={f.errors.title} hint="What is being built">
            <input className="input" maxLength={120} autoComplete="off" {...f.bind("title")} onBlur={blur("title")} />
          </Field>
        </div>
        <div className="form-grid two">
          {sel("state", "State or UT", catalog?.states, "Choose…")}
          <Field id="f-district" label="District" error={f.errors.district}>
            <input className="input" maxLength={60} autoComplete="off" {...f.bind("district")} onBlur={blur("district")} />
          </Field>
        </div>
        <div className="form-grid two">
          {sel("scheme", "Scheme", catalog?.schemes, "Choose…")}
          {sel("category", "Category", catalog?.categories, "Choose…")}
        </div>
        <div className="form-grid two">
          <Field id="f-implementing_agency" label="Implementing agency" error={f.errors.implementing_agency}>
            <input className="input" maxLength={120} autoComplete="organization" {...f.bind("implementing_agency")} onBlur={blur("implementing_agency")} />
          </Field>
          <Field id="f-nodal_officer" label="Nodal officer" error={f.errors.nodal_officer}>
            <input className="input" maxLength={80} autoComplete="name" {...f.bind("nodal_officer")} onBlur={blur("nodal_officer")} />
          </Field>
        </div>
        <div className={editing ? "form-grid two" : "form-grid"}>
          <Field id="f-sanctioned_cost_cr" label="Sanctioned cost (₹ crore)" error={f.errors.sanctioned_cost_cr} hint="e.g. 42.5 for ₹42.5 crore">
            <input className="input" type="number" inputMode="decimal" step="0.01" min={0} {...f.bind("sanctioned_cost_cr")} onBlur={blur("sanctioned_cost_cr")} />
          </Field>
          {editing && (
            <Field id="f-revised_cost_cr" label="Revised cost (₹ crore) — optional" error={f.errors.revised_cost_cr} hint="Only if a cost revision was approved">
              <input className="input" type="number" inputMode="decimal" step="0.01" min={0} {...f.bind("revised_cost_cr")} onBlur={blur("revised_cost_cr")} />
            </Field>
          )}
        </div>
        <div className="form-grid two">
          <Field id="f-start_date" label="Planned start" error={f.errors.start_date}>
            <input className="input" type="date" {...f.bind("start_date")} onBlur={blur("start_date")} />
          </Field>
          <Field id="f-planned_end_date" label="Planned completion" error={f.errors.planned_end_date}>
            <input className="input" type="date" min={f.values.start_date || undefined} {...f.bind("planned_end_date")} onBlur={blur("planned_end_date")} />
          </Field>
        </div>
        <Field id="f-description" label="Description — optional" error={f.errors.description}>
          <textarea className="textarea" maxLength={1000} {...f.bind("description")} />
        </Field>
      </form>
    </Modal>
  );
}
