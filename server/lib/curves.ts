// The planned progress curve. Construction projects follow an S-curve: slow
// mobilisation, fast middle, slow finishing. We use the smoothstep polynomial
// S(t) = 3t^2 - 2t^3 on normalised time t in [0, 1]. The same function is used to
// seed data and to compute planned value, so both always agree.

import { daysBetween, parseDate } from "./dates.ts";

export function sCurve(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

/** Inverse of sCurve via bisection: the t at which planned progress = fraction. */
export function inverseSCurve(fraction: number): number {
  const f = Math.min(1, Math.max(0, fraction));
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (sCurve(mid) < f) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Planned cumulative physical progress (0-100) on a given date. */
export function plannedPctAt(start: string, plannedEnd: string, date: string): number {
  const total = daysBetween(start, plannedEnd);
  if (total <= 0) return parseDate(date) >= parseDate(plannedEnd) ? 100 : 0;
  return 100 * sCurve(daysBetween(start, date) / total);
}

/** Planned cumulative financial progress. Money leads physical work slightly
 * (mobilisation advances), so we shift the curve ~4% earlier. */
export function plannedFinancialFraction(start: string, plannedEnd: string, date: string): number {
  const total = daysBetween(start, plannedEnd);
  if (total <= 0) return 1;
  return sCurve(daysBetween(start, date) / total + 0.04);
}
