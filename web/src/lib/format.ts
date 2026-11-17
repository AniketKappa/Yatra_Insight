// Formatting helpers (Indian conventions: ₹ crore, en-IN grouping).

export const fmtCr = (n: number | null | undefined, dp = 2) =>
  n === null || n === undefined || !Number.isFinite(n) ? "—" : `₹${n.toLocaleString("en-IN", { minimumFractionDigits: dp, maximumFractionDigits: dp })} cr`;

export const fmtCrCompact = (n: number | null | undefined) => {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1000) return `₹${(n / 1000).toLocaleString("en-IN", { maximumFractionDigits: 2 })}k cr`;
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: n >= 100 ? 0 : 1 })} cr`;
};

export const fmtPct = (n: number | null | undefined, dp = 1) =>
  n === null || n === undefined || !Number.isFinite(n) ? "—" : `${n.toLocaleString("en-IN", { maximumFractionDigits: dp })}%`;

export const fmtNum = (n: number | null | undefined, dp = 2) =>
  n === null || n === undefined || !Number.isFinite(n) ? "—" : n.toLocaleString("en-IN", { maximumFractionDigits: dp });

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const fmtDate = (iso: string | null | undefined) => {
  if (!iso) return "—";
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  if (!y || !m) return iso;
  return d ? `${d} ${MONTHS[m - 1]} ${y}` : `${MONTHS[m - 1]} ${y}`;
};

export const fmtMonth = (ym: string | null | undefined) => {
  if (!ym) return "—";
  const [y, m] = ym.split("-").map(Number);
  return `${MONTHS[m - 1]} ${String(y).slice(2)}`;
};

export const fmtDays = (d: number | null | undefined) => {
  if (d === null || d === undefined) return "—";
  if (d <= 0) return d === 0 ? "On time" : `${-d}d early`;
  if (d >= 365) return `${(d / 365).toFixed(1)} yrs late`;
  if (d >= 60) return `${Math.round(d / 30)} mo late`;
  return `${d}d late`;
};

export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-IN")} ${n === 1 ? one : many}`;

export const relTime = (iso: string) => {
  const t = new Date(iso.includes("T") || iso.includes(" ") ? iso.replace(" ", "T") + (iso.endsWith("Z") ? "" : "Z") : iso).getTime();
  const s = Math.round((Date.now() - t) / 1000);
  if (!Number.isFinite(s)) return iso;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
  return fmtDate(iso.slice(0, 10));
};
