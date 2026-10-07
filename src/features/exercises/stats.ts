import type { ExerciseType, PRKind, SetEntry, Side, Workout } from '../../types';
import { estimate1RM, isRecordSet, prKindsFor, prMetricSide, type ExerciseSession } from '../../lib/calc';

/*
 * Pure statistics for the exercises feature (no DB / React imports, unit-tested in stats.test.ts).
 */

// ---------------------------------------------------------------- usage (times performed + recents)

export interface ExerciseUsageEntry {
  /** Number of workouts containing the exercise. */
  count: number;
  /** Start time of the most recent workout containing it. */
  lastAt: number;
  lastWorkoutId: string;
  /** All sets of the exercise in that most recent workout. */
  lastSets: SetEntry[];
}

export interface ExerciseUsage {
  byId: Map<string, ExerciseUsageEntry>;
  /** Distinct exercise ids, most recently performed first. */
  recentIds: string[];
}

export const EMPTY_USAGE: ExerciseUsage = { byId: new Map(), recentIds: [] };

/** `workouts` must be sorted newest first. */
export function computeUsage(workouts: Workout[]): ExerciseUsage {
  const byId = new Map<string, ExerciseUsageEntry>();
  const recentIds: string[] = [];
  for (const w of workouts) {
    const counted = new Set<string>();
    for (const we of w.exercises) {
      let entry = byId.get(we.exerciseId);
      if (!entry) {
        entry = { count: 0, lastAt: w.startedAt, lastWorkoutId: w.id, lastSets: [] };
        byId.set(we.exerciseId, entry);
        recentIds.push(we.exerciseId);
      }
      if (entry.lastWorkoutId === w.id) entry.lastSets.push(...we.sets);
      if (!counted.has(we.exerciseId)) {
        counted.add(we.exerciseId);
        entry.count += 1;
      }
    }
  }
  return { byId, recentIds };
}

// ---------------------------------------------------------------- best set of a session

type Tuple = number[];

function score(s: SetEntry, type: ExerciseType): Tuple {
  const w = s.weightKg ?? 0;
  const r = s.reps ?? 0;
  const d = s.durationSec ?? 0;
  const m = s.distanceM ?? 0;
  switch (type) {
    case 'weight_reps':
      return [estimate1RM(w, r), w, r];
    case 'weighted_bodyweight':
      return [w, r];
    case 'assisted_bodyweight':
      return [r, -w];
    case 'bodyweight_reps':
      return [r];
    case 'duration':
      return [d];
    case 'duration_weight':
      return [w, d];
    case 'distance_duration':
      return [m, d];
    case 'weight_distance':
      return [w, m];
  }
}

function greater(a: Tuple, b: Tuple): boolean {
  for (let i = 0; i < a.length; i++) {
    if (a[i] > b[i] + 1e-9) return true;
    if (a[i] < b[i] - 1e-9) return false;
  }
  return false;
}

/** The headline set of a session (heaviest 1RM / most reps / longest...). Warm-ups only count if nothing else. */
export function bestSet(sets: SetEntry[], type: ExerciseType): SetEntry | null {
  const done = sets.filter((s) => s.done !== false);
  const work = done.filter((s) => s.type !== 'warmup');
  const pool = work.length ? work : done;
  let best: SetEntry | null = null;
  let bestScore: Tuple | null = null;
  for (const s of pool) {
    const sc = score(s, type);
    if (!bestScore || greater(sc, bestScore)) {
      best = s;
      bestScore = sc;
    }
  }
  return best;
}

// ---------------------------------------------------------------- personal records

export interface RecordEntry {
  kind: PRKind;
  /** kg, reps, seconds or meters depending on kind. */
  value: number;
  set: SetEntry;
  /** The side that set it, when the set was per-side (records count the better side). */
  side?: Side;
  workoutId: string;
  workoutName: string;
  date: number;
}

/** All-time best per PR kind for one exercise (earliest workout wins ties — that's when it was set). */
export function personalRecords(workouts: Workout[], exerciseId: string, type: ExerciseType): RecordEntry[] {
  const sorted = [...workouts].sort((a, b) => a.startedAt - b.startedAt);
  const out: RecordEntry[] = [];
  for (const kind of prKindsFor(type)) {
    let best: RecordEntry | null = null;
    for (const w of sorted) {
      for (const we of w.exercises) {
        if (we.exerciseId !== exerciseId) continue;
        for (const s of we.sets) {
          if (!isRecordSet(s)) continue;
          const { value: v, side } = prMetricSide(kind, s, type);
          if (v > 0 && (!best || v > best.value + 1e-9)) {
            best = { kind, value: v, set: s, ...(side ? { side } : {}), workoutId: w.id, workoutName: w.name, date: w.startedAt };
          }
        }
      }
    }
    if (best) out.push(best);
  }
  return out;
}

// ---------------------------------------------------------------- lifetime totals

export interface LifetimeTotals {
  sessions: number;
  sets: number;
  reps: number;
  volumeKg: number;
  durationSec: number;
  distanceM: number;
}

export function lifetimeTotals(sessions: ExerciseSession[]): LifetimeTotals {
  const t: LifetimeTotals = { sessions: sessions.length, sets: 0, reps: 0, volumeKg: 0, durationSec: 0, distanceM: 0 };
  for (const s of sessions) {
    t.sets += s.sets.length;
    t.reps += s.totalReps;
    t.volumeKg += s.sessionVolume;
    t.durationSec += s.totalDuration;
    t.distanceM += s.totalDistance;
  }
  return t;
}

// ---------------------------------------------------------------- chart metrics

export type MetricKey =
  | 'heaviest'
  | 'e1rm'
  | 'bestSetVolume'
  | 'sessionVolume'
  | 'totalReps'
  | 'maxReps'
  | 'maxDuration'
  | 'totalDuration'
  | 'maxDistance'
  | 'totalDistance';

/** How a metric's value is displayed (weight/volume are kg, duration seconds, distance meters). */
export type MetricFormat = 'weight' | 'volume' | 'reps' | 'duration' | 'distance';

export const METRICS: Record<MetricKey, { label: string; format: MetricFormat; get: (s: ExerciseSession) => number }> = {
  heaviest: { label: 'Heaviest Weight', format: 'weight', get: (s) => s.heaviestKg },
  e1rm: { label: 'One Rep Max', format: 'weight', get: (s) => s.best1RM },
  bestSetVolume: { label: 'Best Set Volume', format: 'volume', get: (s) => s.bestSetVolume },
  sessionVolume: { label: 'Session Volume', format: 'volume', get: (s) => s.sessionVolume },
  totalReps: { label: 'Total Reps', format: 'reps', get: (s) => s.totalReps },
  maxReps: { label: 'Most Reps', format: 'reps', get: (s) => s.maxReps },
  maxDuration: { label: 'Longest', format: 'duration', get: (s) => s.maxDuration },
  totalDuration: { label: 'Total Time', format: 'duration', get: (s) => s.totalDuration },
  maxDistance: { label: 'Longest Distance', format: 'distance', get: (s) => s.maxDistance },
  totalDistance: { label: 'Total Distance', format: 'distance', get: (s) => s.totalDistance },
};

/** Chart metrics offered for an exercise type (first = default). */
export function metricsFor(type: ExerciseType): MetricKey[] {
  switch (type) {
    case 'weight_reps':
    case 'weighted_bodyweight':
      return ['heaviest', 'e1rm', 'bestSetVolume', 'sessionVolume', 'totalReps'];
    case 'bodyweight_reps':
    case 'assisted_bodyweight':
      return ['maxReps', 'totalReps'];
    case 'duration':
      return ['maxDuration', 'totalDuration'];
    case 'duration_weight':
      return ['heaviest', 'maxDuration', 'totalDuration'];
    case 'distance_duration':
      return ['maxDistance', 'totalDistance', 'maxDuration', 'totalDuration'];
    case 'weight_distance':
      return ['heaviest', 'maxDistance', 'totalDistance'];
  }
}
