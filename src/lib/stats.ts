import { addWeeks, startOfWeek } from 'date-fns';
import type { Exercise, ExerciseType, Muscle, PRRecord, Workout } from '../types';
import { countDoneSets, exerciseSessions, totalReps, type ExerciseSession } from './calc';

/*
 * Aggregations for the Progress tab. Pure functions over saved workouts (weights in kg, durations in
 * seconds, timestamps in epoch ms) so they are easy to test and memoize.
 */

export interface WeekBucket {
  /** Local midnight at the start of the week (epoch ms). */
  weekStart: number;
  workouts: number;
  durationSec: number;
  volumeKg: number;
  sets: number;
  reps: number;
  calories: number;
}

export function weekStartOf(ms: number, weekStartsOn: 0 | 1): number {
  return startOfWeek(ms, { weekStartsOn }).getTime();
}

/** Totals per calendar week for the last `weeks` weeks (oldest → newest, current week last, empty weeks included). */
export function weeklyBuckets(
  workouts: Workout[],
  weeks: number,
  weekStartsOn: 0 | 1 = 0,
  now: number = Date.now(),
): WeekBucket[] {
  const count = Math.max(0, Math.floor(weeks));
  const current = startOfWeek(now, { weekStartsOn });
  const buckets: WeekBucket[] = [];
  const byStart = new Map<number, WeekBucket>();
  for (let i = count - 1; i >= 0; i--) {
    const weekStart = addWeeks(current, -i).getTime();
    const b: WeekBucket = { weekStart, workouts: 0, durationSec: 0, volumeKg: 0, sets: 0, reps: 0, calories: 0 };
    buckets.push(b);
    byStart.set(weekStart, b);
  }
  for (const w of workouts) {
    const b = byStart.get(weekStartOf(w.startedAt, weekStartsOn));
    if (!b) continue;
    b.workouts += 1;
    b.durationSec += Math.max(0, w.durationSec || 0);
    b.volumeKg += Math.max(0, w.volumeKg || 0);
    b.sets += w.setCount ?? countDoneSets(w.exercises);
    b.reps += totalReps(w.exercises);
    b.calories += Math.max(0, w.calories ?? 0);
  }
  return buckets;
}

const workingSetCount = (sets: Workout['exercises'][number]['sets']) =>
  sets.reduce((n, s) => n + (s.done && s.type !== 'warmup' ? 1 : 0), 0);

/**
 * Sets per muscle for workouts started at or after `fromMs`: every completed, non-warm-up set counts +1
 * for the exercise's primary muscle and +0.5 for each secondary muscle.
 */
export function muscleSetCounts(
  workouts: Workout[],
  fromMs: number,
  getExercise: (id: string) => Exercise,
  toMs: number = Number.POSITIVE_INFINITY,
): Partial<Record<Muscle, number>> {
  const out: Partial<Record<Muscle, number>> = {};
  for (const w of workouts) {
    if (w.startedAt < fromMs || w.startedAt > toMs) continue;
    for (const we of w.exercises) {
      const n = workingSetCount(we.sets);
      if (!n) continue;
      const ex = getExercise(we.exerciseId);
      out[ex.primary] = (out[ex.primary] ?? 0) + n;
      for (const m of new Set(ex.secondary)) {
        if (m === ex.primary) continue;
        out[m] = (out[m] ?? 0) + n * 0.5;
      }
    }
  }
  return out;
}

export interface MuscleExerciseRow {
  exerciseId: string;
  /** Weighted sets credited to the muscle (secondary = 0.5 per set). */
  sets: number;
  role: 'primary' | 'secondary';
  lastDate: number;
}

/** Exercises that trained `muscle` since `fromMs`, most sets first (for the expandable muscle list). */
export function exercisesForMuscle(
  workouts: Workout[],
  fromMs: number,
  muscle: Muscle,
  getExercise: (id: string) => Exercise,
): MuscleExerciseRow[] {
  const rows = new Map<string, MuscleExerciseRow>();
  for (const w of workouts) {
    if (w.startedAt < fromMs) continue;
    for (const we of w.exercises) {
      const n = workingSetCount(we.sets);
      if (!n) continue;
      const ex = getExercise(we.exerciseId);
      const role = ex.primary === muscle ? 'primary' : ex.secondary.includes(muscle) ? 'secondary' : null;
      if (!role) continue;
      const row = rows.get(we.exerciseId) ?? { exerciseId: we.exerciseId, sets: 0, role, lastDate: 0 };
      row.sets += role === 'primary' ? n : n * 0.5;
      row.lastDate = Math.max(row.lastDate, w.startedAt);
      rows.set(we.exerciseId, row);
    }
  }
  return [...rows.values()].sort((a, b) => b.sets - a.sets || b.lastDate - a.lastDate);
}

/**
 * Consecutive weeks with at least one workout, ending with the current week if it already has one
 * (otherwise ending last week, so the streak isn't "lost" until the current week is over).
 */
export function weekStreak(workouts: Workout[], weekStartsOn: 0 | 1 = 0, now: number = Date.now()): number {
  const weeks = new Set(workouts.map((w) => weekStartOf(w.startedAt, weekStartsOn)));
  let cursor = startOfWeek(now, { weekStartsOn });
  if (!weeks.has(cursor.getTime())) cursor = addWeeks(cursor, -1);
  let n = 0;
  while (weeks.has(cursor.getTime())) {
    n++;
    cursor = addWeeks(cursor, -1);
  }
  return n;
}

export interface RecentPR {
  workout: Workout;
  pr: PRRecord;
}

/** The `n` most recent personal records, newest workout first (in the order they were recorded within a workout). */
export function recentPRs(workouts: Workout[], n: number): RecentPR[] {
  const out: RecentPR[] = [];
  if (n <= 0) return out;
  const sorted = [...workouts].sort((a, b) => b.startedAt - a.startedAt);
  for (const workout of sorted) {
    for (const pr of workout.prs ?? []) {
      out.push({ workout, pr });
      if (out.length >= n) return out;
    }
  }
  return out;
}

export interface TopExercise {
  exerciseId: string;
  /** Number of workouts the exercise appears in (with at least one completed set). */
  sessions: number;
  lastDate: number;
}

/** Most frequently performed exercises (ties broken by most recent). */
export function topExercises(workouts: Workout[], n: number): TopExercise[] {
  const map = new Map<string, TopExercise>();
  for (const w of workouts) {
    const ids = new Set(w.exercises.filter((we) => we.sets.some((s) => s.done)).map((we) => we.exerciseId));
    for (const id of ids) {
      const row = map.get(id) ?? { exerciseId: id, sessions: 0, lastDate: 0 };
      row.sessions += 1;
      row.lastDate = Math.max(row.lastDate, w.startedAt);
      map.set(id, row);
    }
  }
  return [...map.values()].sort((a, b) => b.sessions - a.sessions || b.lastDate - a.lastDate).slice(0, Math.max(0, n));
}

/** Which per-session number best describes progress for an exercise type (for sparklines / "best" labels). */
export type ProgressMetric = 'best1RM' | 'heaviestKg' | 'maxReps' | 'maxDuration' | 'maxDistance';

export function progressMetricFor(type: ExerciseType): ProgressMetric {
  switch (type) {
    case 'weight_reps':
      return 'best1RM';
    case 'weighted_bodyweight':
    case 'duration_weight':
    case 'weight_distance':
      return 'heaviestKg';
    case 'bodyweight_reps':
    case 'assisted_bodyweight':
      return 'maxReps';
    case 'duration':
      return 'maxDuration';
    case 'distance_duration':
      return 'maxDistance';
  }
}

/** Per-session values of the type's progress metric, oldest first, plus the all-time best. */
export function exerciseTrend(
  workouts: Workout[],
  exerciseId: string,
  type: ExerciseType,
): { metric: ProgressMetric; points: { date: number; value: number }[]; best: number; sessions: ExerciseSession[] } {
  const metric = progressMetricFor(type);
  const sessions = exerciseSessions(workouts, exerciseId, type);
  const points = sessions.map((s) => ({ date: s.date, value: s[metric] }));
  const best = points.reduce((m, p) => Math.max(m, p.value), 0);
  return { metric, points, best, sessions };
}
