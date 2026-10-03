import { format } from 'date-fns';
import type { Meal, MealItem, Per100g, Totals } from './types';

/*
 * Pure nutrition math. No I/O, no clock reads (pass `now` where a time is needed), so it is trivially testable.
 *
 * DISPLAY-ONLY BURN RULE: nothing in this file (or targets.ts) takes workout calories. The daily budget is
 * target − eaten, full stop. The TDEE activity factor already assumes the user's training, so adding a
 * workout's burn back to the budget would count it twice. lib/nutrition/guard.test.ts enforces that these
 * modules never import the burn / calories code.
 */

export const MAX_SERVES = 20;

export function emptyTotals(): Totals {
  return { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0, fiberG: 0, sugarG: 0, sodiumMg: 0 };
}

const n0 = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Nutrients of `grams` of a food given per 100 g (unknowns count as 0). */
export function scalePer100g(per100g: Per100g, grams: number): Totals {
  const f = Math.max(0, grams) / 100;
  return {
    kcal: n0(per100g.kcal) * f,
    proteinG: n0(per100g.proteinG) * f,
    carbsG: n0(per100g.carbsG) * f,
    fatG: n0(per100g.fatG) * f,
    fiberG: n0(per100g.fiberG) * f,
    sugarG: n0(per100g.sugarG) * f,
    sodiumMg: n0(per100g.sodiumMg) * f,
  };
}

export function addTotals(a: Totals, b: Totals): Totals {
  return {
    kcal: a.kcal + b.kcal,
    proteinG: a.proteinG + b.proteinG,
    carbsG: a.carbsG + b.carbsG,
    fatG: a.fatG + b.fatG,
    fiberG: a.fiberG + b.fiberG,
    sugarG: a.sugarG + b.sugarG,
    sodiumMg: a.sodiumMg + b.sodiumMg,
  };
}

export function multiplyTotals(t: Totals, k: number): Totals {
  return {
    kcal: t.kcal * k,
    proteinG: t.proteinG * k,
    carbsG: t.carbsG * k,
    fatG: t.fatG * k,
    fiberG: t.fiberG * k,
    sugarG: t.sugarG * k,
    sodiumMg: t.sodiumMg * k,
  };
}

/** Clamp serves to 1..20 (integers). */
export function clampServes(serves: number | null | undefined): number {
  const s = Math.round(n0(serves) || 1);
  return Math.min(MAX_SERVES, Math.max(1, s));
}

/** Nutrients for ONE serving of an item (fixed items ignore grams). */
export function itemServing(item: MealItem): Totals {
  if (item.fixed) return { ...emptyTotals(), ...item.fixed };
  if (!item.per100g || item.grams == null) return emptyTotals();
  return scalePer100g(item.per100g, item.grams);
}

/** Nutrients an item contributes to the meal (one serving × serves). */
export function itemNutrients(item: MealItem, serves: number): Totals {
  return multiplyTotals(itemServing(item), clampServes(serves));
}

/** Sum of all items × serves. */
export function mealTotals(items: MealItem[], serves: number): Totals {
  return items.reduce((acc, it) => addTotals(acc, itemNutrients(it, serves)), emptyTotals());
}

/** Local calendar day key, e.g. "2026-10-03". */
export function dayKey(ms: number): string {
  return format(ms, 'yyyy-MM-dd');
}

/** Parse a day key to local midnight epoch ms (NaN for junk). */
export function dayStart(day: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return NaN;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
}

/** Shift a day key by whole days (DST-safe: works in calendar days, not 24 h steps). */
export function shiftDay(day: string, deltaDays: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return day;
  return dayKey(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + deltaDays).getTime());
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Re-derive everything cached on a meal (serves clamp, totals, and `day` when needed). Pure.
 *
 * `day` is derived from `at` only when it is missing/invalid or `rederiveDay` is set (the eaten time changed).
 * Otherwise the stored day is kept: deriving it again in the CURRENT time zone would silently move a meal to
 * another day after travel the next time any unrelated field (grams, serves) is edited.
 */
export function recomputeMeal(meal: Meal, opts: { rederiveDay?: boolean } = {}): Meal {
  const serves = clampServes(meal.serves);
  const day = opts.rederiveDay || !DAY_RE.test(meal.day ?? '') ? dayKey(meal.at) : meal.day;
  return { ...meal, serves, day, totals: mealTotals(meal.items, serves) };
}

/** Only finished meals count toward the day (drafts, pending, analyzing and failed meals don't). */
export function countsTowardDay(meal: Pick<Meal, 'status'>): boolean {
  return meal.status === 'done';
}

/** Day totals of the meals that count. */
export function sumMeals(meals: Meal[]): Totals {
  return meals.filter(countsTowardDay).reduce((acc, m) => addTotals(acc, m.totals), emptyTotals());
}

/**
 * Calories left today. Exactly two inputs on purpose — the budget is target minus eaten; workout burn is
 * shown next to it but NEVER added (see the file header). Negative means over target.
 */
export function remaining(targetKcal: number, eatenKcal: number): number {
  return Math.round(targetKcal) - Math.round(eatenKcal);
}

/**
 * Turn Claude's whole-item fallback estimate (numbers for `grams`) into per-100 g values, so the item stays
 * scalable when the user edits its weight. With no usable weight, the estimate is treated as 100 g.
 */
export function per100gFromEstimate(
  est: { kcal: number; proteinG: number; carbsG: number; fatG: number; fiberG?: number | null; sugarG?: number | null; sodiumMg?: number | null },
  grams: number | null | undefined,
): Per100g {
  const g = n0(grams) > 0 ? n0(grams) : 100;
  const k = 100 / g;
  const opt = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? null : Math.max(0, v) * k);
  return {
    kcal: Math.max(0, n0(est.kcal)) * k,
    proteinG: Math.max(0, n0(est.proteinG)) * k,
    carbsG: Math.max(0, n0(est.carbsG)) * k,
    fatG: Math.max(0, n0(est.fatG)) * k,
    fiberG: opt(est.fiberG),
    sugarG: opt(est.sugarG),
    sodiumMg: opt(est.sodiumMg),
  };
}

/** Whole kcal for display. */
export const kcal = (v: number) => Math.round(n0(v));
/** Grams of a macro for display: 1 decimal under 10 g, whole above. */
export function macroG(v: number): string {
  const x = n0(v);
  return x < 10 ? String(Math.round(x * 10) / 10) : String(Math.round(x));
}

/**
 * When to stamp a meal logged while viewing `day`: now for today; otherwise that day at the current time of
 * day (so a forgotten lunch logged tonight for yesterday lands on yesterday). Pure: `now` injected.
 */
export function atForDay(day: string | null | undefined, now: number): number {
  if (!day || day === dayKey(now)) return now;
  const m = DAY_RE.test(day) ? day.split('-').map(Number) : null;
  if (!m) return now;
  // Build from calendar fields (not midnight + elapsed ms) so DST days keep the wall-clock time and the day.
  const t = new Date(now);
  return new Date(m[0], m[1] - 1, m[2], t.getHours(), t.getMinutes(), t.getSeconds()).getTime();
}
