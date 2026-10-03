import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../db';
import { activeCalories } from '../appleHealth';
import type { Workout } from '../../types';
import { dayStart, shiftDay } from './math';

/*
 * Workout calories for the Diary — DISPLAY ONLY.
 *
 * Shown as "Workouts today: N kcal active · already counted in your target". Never fed into targets or
 * remaining(): the TDEE activity factor already assumes the training, so eating it back double-counts.
 * Only UI files import this module; guard.test.ts fails if targets.ts / math.ts ever do.
 *
 * Uses Heft's ACTIVE calories (total estimate minus the 1 MET you'd burn at rest anyway), the same number
 * the Apple Health bridge sends to the Move ring.
 */

export interface DayBurn {
  activeKcal: number;
  workouts: number;
}

/** Sum active kcal of workouts that STARTED on `day`. */
export function sumActiveKcal(workouts: Pick<Workout, 'calories' | 'caloriesManual' | 'durationSec' | 'bodyweightKg'>[]): number {
  return workouts.reduce((acc, w) => acc + activeCalories(w), 0);
}

export async function loadDayBurn(day: string): Promise<DayBurn> {
  const from = dayStart(day);
  const to = dayStart(shiftDay(day, 1));
  if (!Number.isFinite(from) || !Number.isFinite(to)) return { activeKcal: 0, workouts: 0 };
  const ws = await db.workouts.where('startedAt').between(from, to, true, false).toArray();
  return { activeKcal: sumActiveKcal(ws), workouts: ws.length };
}

/** undefined while loading. */
export function useDayBurn(day: string): DayBurn | undefined {
  return useLiveQuery(() => loadDayBurn(day), [day]);
}
