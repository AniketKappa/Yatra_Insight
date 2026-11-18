import { useEffect, useState, type FormEvent } from "react";
import type { ProjectDetail } from "../../../server/types";
import { api, ApiError } from "../lib/api";
import { Field, Modal } from "./ui";
import { useForm } from "../pages/ProjectDetail";

interface Catalog { states: string[]; schemes: string[]; categories: string[] }

const EMPTY = {
  destination: "", title: "", state: "", district: "", scheme: "", category: "",
  implementing_agency: "", nodal_officer: "", sanctioned_cost_cr: "", start_date: "", planned_end_date: "", description: "",
};

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
    case "start_date": return val ? "" : "Choose the planned start date.";
    case "planned_end_date": {
      if (!val) return "Choose the planned completion date.";
      if (v.start_date && (Date.parse(val) - Date.parse(v.start_date)) / 86400000 < 90) return "Completion must be at least 3 months after the start.";
      return "";
    }
    default: return "";
  }
}

export function AddProjectForm({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: (p: ProjectDetail) => void }) {
  const f = useForm({ ...EMPTY });
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
      const created = await api<ProjectDetail>("/api/projects", { method: "POST", json: { ...f.values, sanctioned_cost_cr: Number(f.values.sanctioned_cost_cr) } });
      f.setValues({ ...EMPTY });
      onSaved(created);
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
    <Modal open={open} onClose={onClose} title="Add a project" labelledBy="add-project-title"
      footer={<><button className="btn btn-ghost" type="button" onClick={onClose}>Cancel</button><button className="btn btn-primary" form="add-project-form" type="submit" disabled={f.busy}>{f.busy && <span className="spinner" />}Add project</button></>}>
      <form id="add-project-form" className="form-grid" onSubmit={submit} noValidate>
        <p className="muted small">The project code and six standard milestones are created from these details. Record monthly progress from the project page once work starts.</p>
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
        <Field id="f-sanctioned_cost_cr" label="Sanctioned cost (₹ crore)" error={f.errors.sanctioned_cost_cr} hint="e.g. 42.5 for ₹42.5 crore">
          <input className="input" type="number" inputMode="decimal" step="0.01" min={0} {...f.bind("sanctioned_cost_cr")} onBlur={blur("sanctioned_cost_cr")} />
        </Field>
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
