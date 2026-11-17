import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { Health, RiskLevel, Severity } from "../../../server/types";
import { IconCheckCircle, IconClock, IconOctagon, IconPause, IconWarn, IconX, IconFlag, IconRefresh } from "./Icons";

// ---- Status --------------------------------------------------------------------

const HEALTH: Record<Health, { cls: string; icon: ReactNode; color: string }> = {
  "On track": { cls: "badge-good", icon: <IconCheckCircle size={14} />, color: "var(--good)" },
  "At risk": { cls: "badge-warn", icon: <IconWarn size={14} />, color: "var(--warn)" },
  "Off track": { cls: "badge-crit", icon: <IconOctagon size={14} />, color: "var(--crit)" },
  "On hold": { cls: "badge-serious", icon: <IconPause size={14} />, color: "var(--serious)" },
  "Not started": { cls: "badge-neutral", icon: <IconClock size={14} />, color: "var(--neutral)" },
  Completed: { cls: "badge-done", icon: <IconCheckCircle size={14} />, color: "var(--done)" },
};
export const healthColor = (h: Health) => HEALTH[h]?.color ?? "var(--neutral)";
export const HEALTH_ORDER: Health[] = ["On track", "At risk", "Off track", "On hold", "Not started", "Completed"];

export function HealthBadge({ health }: { health: Health }) {
  const h = HEALTH[health] ?? HEALTH["Not started"];
  return <span className={`badge ${h.cls}`}>{h.icon}{health}</span>;
}

const SEV: Record<Severity, { cls: string; label: string }> = {
  critical: { cls: "badge-crit", label: "Critical" },
  high: { cls: "badge-serious", label: "High" },
  medium: { cls: "badge-warn", label: "Medium" },
  low: { cls: "badge-neutral", label: "Low" },
};
export function SeverityBadge({ severity }: { severity: Severity | string }) {
  const s = SEV[(severity as string).toLowerCase() as Severity] ?? SEV.low;
  return <span className={`badge ${s.cls}`}><IconFlag size={12} />{s.label}</span>;
}

export const riskColor = (score: number) => (score >= 60 ? "var(--crit)" : score >= 40 ? "var(--serious)" : score >= 20 ? "var(--warn)" : "var(--good)");
export function RiskPill({ score, level }: { score: number; level?: RiskLevel }) {
  return (
    <span className="risk-pill" title={level ? `${level} risk` : undefined} aria-label={`Risk ${score} of 100${level ? `, ${level}` : ""}`}>
      <span className="risk-bar" aria-hidden="true"><i style={{ width: `${Math.max(3, score)}%`, background: riskColor(score) }} /></span>
      {score}
    </span>
  );
}

export function ProgressBar({ actual, planned, label }: { actual: number; planned?: number | null; label?: string }) {
  return (
    <div className="progress" role="img" aria-label={label ?? `${actual}% complete${planned != null ? `, ${planned}% planned` : ""}`}>
      <i style={{ width: `${Math.min(100, Math.max(0, actual))}%` }} />
      {planned != null && <b style={{ left: `calc(${Math.min(100, Math.max(0, planned))}% - 1px)` }} title={`Planned ${planned}%`} />}
    </div>
  );
}

// ---- Containers & states -------------------------------------------------------------

export function Card({ title, sub, actions, children, className = "", bodyClass = "card-body", id }: { title?: ReactNode; sub?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; bodyClass?: string; id?: string }) {
  return (
    <section className={`card ${className}`} aria-labelledby={title && id ? `${id}-h` : undefined} id={id}>
      {(title || actions) && (
        <div className="card-head">
          <div>
            {title && <h2 id={id ? `${id}-h` : undefined}>{title}</h2>}
            {sub && <p className="sub">{sub}</p>}
          </div>
          {actions && <div className="row">{actions}</div>}
        </div>
      )}
      <div className={bodyClass}>{children}</div>
    </section>
  );
}

export function Empty({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      {icon && <div className="icon-tile">{icon}</div>}
      <h3>{title}</h3>
      {children && <p style={{ maxWidth: "48ch" }}>{children}</p>}
      {action}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: { message: string } | null; onRetry?: () => void }) {
  if (!error) return null;
  return (
    <div className="error-box" role="alert">
      <IconWarn size={20} />
      <div style={{ flex: 1 }}>
        <strong>Couldn't load this.</strong>
        <p style={{ marginTop: 2 }}>{error.message}</p>
      </div>
      {onRetry && <button className="btn btn-secondary btn-sm" onClick={onRetry}><IconRefresh size={14} />Try again</button>}
    </div>
  );
}

export function Skeleton({ h = 16, w = "100%", style }: { h?: number | string; w?: number | string; style?: React.CSSProperties }) {
  return <div className="skeleton" style={{ height: h, width: w, ...style }} aria-hidden="true" />;
}

export function PageSkeleton() {
  return (
    <div className="stack" aria-busy="true" aria-label="Loading">
      <Skeleton h={36} w={280} />
      <div className="grid grid-kpi">{[0, 1, 2, 3].map((i) => <Skeleton key={i} h={118} />)}</div>
      <div className="grid grid-main"><Skeleton h={340} /><Skeleton h={340} /></div>
    </div>
  );
}

// ---- Modal ---------------------------------------------------------------------------

export function Modal({ open, onClose, title, children, footer, labelledBy = "modal-title" }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; labelledBy?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className="modal" aria-labelledby={labelledBy} onClose={onClose} onCancel={(e) => { e.preventDefault(); onClose(); }}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}>
      {open && (
        <>
          <div className="modal-head">
            <h2 id={labelledBy}>{title}</h2>
            <button className="btn btn-ghost btn-icon btn-sm" onClick={onClose} aria-label="Close"><IconX size={16} /></button>
          </div>
          <div className="modal-body">{children}</div>
          {footer && <div className="modal-foot">{footer}</div>}
        </>
      )}
    </dialog>
  );
}

// ---- Toasts --------------------------------------------------------------------------

interface Toast { id: number; text: string; kind: "ok" | "err" }
const ToastCtx = createContext<(text: string, kind?: "ok" | "err") => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, kind: "ok" | "err" = "ok") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-2), { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "err" ? 7000 : 4000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind === "err" ? "err" : ""}`}>
            {t.kind === "err" ? <IconWarn size={16} /> : <IconCheckCircle size={16} />}
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ---- Form field ----------------------------------------------------------------------

export function Field({ id, label, hint, error, children }: { id: string; label: string; hint?: string; error?: string; children: ReactNode }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
      {error ? <p className="field-error" id={`${id}-err`}><IconWarn size={14} />{error}</p> : hint ? <p className="hint" id={`${id}-hint`}>{hint}</p> : null}
    </div>
  );
}

export function Kpi({ label, value, unit, foot, icon }: { label: string; value: ReactNode; unit?: string; foot?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="card kpi">
      <span className="kpi-label">{icon}{label}</span>
      <span className="kpi-value">{value}{unit && <small>{unit}</small>}</span>
      {foot && <span className="kpi-foot">{foot}</span>}
    </div>
  );
}
