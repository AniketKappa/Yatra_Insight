// Date helpers. All dates are ISO calendar strings (YYYY-MM-DD) handled in UTC
// so results never shift with the server's timezone.

const DAY_MS = 86_400_000;

export function parseDate(iso: string): Date {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, (m || 1) - 1, d || 1));
}

export function toISO(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function todayISO(): string {
  const override = process.env.AS_OF_DATE;
  if (override && /^\d{4}-\d{2}-\d{2}$/.test(override)) return override;
  return toISO(new Date());
}

export function addDays(iso: string, days: number): string {
  return toISO(new Date(parseDate(iso).getTime() + Math.round(days) * DAY_MS));
}

export function daysBetween(a: string, b: string): number {
  return Math.round((parseDate(b).getTime() - parseDate(a).getTime()) / DAY_MS);
}

export function addMonths(iso: string, months: number): string {
  const d = parseDate(iso);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d.getUTCDate(), lastDay));
  return toISO(target);
}

/** "2026-10" -> "2026-10-31" */
export function monthEnd(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return toISO(new Date(Date.UTC(y, m, 0)));
}

export function monthOf(iso: string): string {
  return iso.slice(0, 7);
}

/** Inclusive list of YYYY-MM months from a to b. */
export function monthRange(fromMonth: string, toMonth: string): string[] {
  const out: string[] = [];
  let [y, m] = fromMonth.split("-").map(Number);
  const [ty, tm] = toMonth.split("-").map(Number);
  let guard = 0;
  while ((y < ty || (y === ty && m <= tm)) && guard++ < 600) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

export function isValidISODate(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = parseDate(s);
  return toISO(d) === s;
}

export function isValidMonth(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
}
