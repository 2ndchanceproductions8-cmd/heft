import type { Meal } from '../../../lib/nutrition/types';

/*
 * Pure wording for the Today Food card: the meal count in the header and the "not counted yet" lines for
 * today's unfinished meals (drafts, waiting, analyzing, failed). Only `done` meals count toward the day, so these
 * lines are what explains a total that looks too low.
 */

/** Why one of today's meals isn't in the totals yet, most urgent first. */
export type UnfinishedKind = 'failed' | 'draft' | 'pending' | 'analyzing';

export const UNFINISHED_ORDER: readonly UnfinishedKind[] = ['failed', 'draft', 'pending', 'analyzing'];

export interface UnfinishedLine {
  kind: UnfinishedKind;
  count: number;
  label: string;
}

/** "1 meal", "3 meals". */
export function mealCountLabel(n: number): string {
  return n === 1 ? '1 meal' : `${n} meals`;
}

/**
 * The line's kind for one meal (null for a finished meal). An 'analyzing' meal whose run is no longer alive in
 * this app session (iOS killed the app mid-call) needs a retry, like a failed one: see `interrupted`.
 */
export function unfinishedKind(meal: Pick<Meal, 'id' | 'status'>, interrupted: ReadonlySet<string>): UnfinishedKind | null {
  if (meal.status === 'done') return null;
  if (meal.status === 'analyzing') return interrupted.has(meal.id) ? 'failed' : 'analyzing';
  return meal.status;
}

/** "1 meal needs a retry", "2 photo meals not finished", "1 meal waiting to analyze", "3 meals still analyzing". */
export function unfinishedLabel(kind: UnfinishedKind, n: number): string {
  const meals = mealCountLabel(n);
  switch (kind) {
    case 'failed':
      return `${meals} ${n === 1 ? 'needs' : 'need'} a retry`;
    case 'draft':
      return `${n} photo ${n === 1 ? 'meal' : 'meals'} not finished`;
    case 'pending':
      return `${meals} waiting to analyze`;
    case 'analyzing':
      return `${meals} still analyzing`;
  }
}

const NONE: ReadonlySet<string> = new Set();

/** Ids of today's 'analyzing' meals whose run is not alive in this app session (iOS killed the app mid-call). */
export function interruptedIds(meals: readonly Pick<Meal, 'id' | 'status'>[], isRunning: (id: string) => boolean): ReadonlySet<string> {
  const dead = meals.filter((m) => m.status === 'analyzing' && !isRunning(m.id)).map((m) => m.id);
  return dead.length ? new Set(dead) : NONE;
}

/** One line per kind present among `meals` (finished meals ignored), most urgent first. */
export function unfinishedLines(meals: readonly Pick<Meal, 'id' | 'status'>[], interrupted: ReadonlySet<string> = NONE): UnfinishedLine[] {
  const counts = new Map<UnfinishedKind, number>();
  for (const m of meals) {
    const kind = unfinishedKind(m, interrupted);
    if (kind) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return UNFINISHED_ORDER.filter((k) => counts.has(k)).map((kind) => {
    const count = counts.get(kind) ?? 0;
    return { kind, count, label: unfinishedLabel(kind, count) };
  });
}
