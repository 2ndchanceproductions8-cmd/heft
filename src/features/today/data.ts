import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../db';
import type { Measurement } from '../../types';
import type { Meal } from '../../lib/nutrition/types';

/*
 * Live reads for the Today dashboard (foundation-owned). Every hook returns undefined while IndexedDB answers.
 * Workouts come from lib/workouts useWorkouts(), targets from lib/nutrition/store useTargets(), settings from
 * lib/settings useSettings(); the math is lib/today.ts.
 */

/** Every measurement row, oldest first (a personal log: a few hundred rows at most). */
export function useMeasurements(): Measurement[] | undefined {
  return useLiveQuery(() => db.measurements.orderBy('date').toArray(), []);
}

/** Meals whose day key is in [first, last] (inclusive), any status, oldest first. */
export function useMealsInDays(first: string, last: string): Meal[] | undefined {
  return useLiveQuery(() => db.meals.where('day').between(first, last, true, true).sortBy('at'), [first, last]);
}
