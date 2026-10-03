import { dayKey, dayStart } from '../../../lib/nutrition/math';

/*
 * Paths for the Food tab's full-screen flows. Query values are only ids and day keys (never personal data).
 */

/** A real 'yyyy-MM-dd' day key from a ?d= param, or null (junk, impossible dates like 2026-02-31). */
export function validDay(d: string | null | undefined): string | null {
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  const start = dayStart(d);
  return Number.isFinite(start) && dayKey(start) === d ? d : null;
}

function withQuery(path: string, q: Record<string, string | null | undefined>): string {
  const parts = Object.entries(q)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${encodeURIComponent(v!)}`);
  return parts.length ? `${path}?${parts.join('&')}` : path;
}

export const SETTINGS_PATH = '/nutrition/settings';

/** The Diary, on `day` when given. */
export const diaryPath = (day?: string | null) => withQuery('/nutrition', { d: day });

export const mealPath = (id: string) => `/nutrition/meal/${encodeURIComponent(id)}`;

/** Capture screen; `meal` resumes a draft, `d` logs on another day. */
export const logPath = (o: { meal?: string | null; d?: string | null } = {}) => withQuery('/nutrition/log', { meal: o.meal, d: o.d });

/** Barcode screen; `meal` adds the product to that meal, `d` logs a new meal on another day. */
export const scanPath = (o: { meal?: string | null; d?: string | null } = {}) => withQuery('/nutrition/scan', { meal: o.meal, d: o.d });

/** Position of the current entry in this tab's history (React Router keeps it in history.state). */
export const historyIdx = () => {
  try {
    return (window.history.state as { idx?: number } | null)?.idx ?? 0;
  } catch {
    return 0;
  }
};
