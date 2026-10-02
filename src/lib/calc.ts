import type { ExerciseType, PRKind, PRRecord, SetEntry, Workout, WorkoutExercise } from '../types';

/** Estimated one-rep max (Epley). reps=1 returns the weight itself. */
export function estimate1RM(weightKg: number | null | undefined, reps: number | null | undefined): number {
  if (!weightKg || !reps || reps < 1 || weightKg <= 0) return 0;
  if (reps === 1) return weightKg;
  return weightKg * (1 + reps / 30);
}

/** Volume (kg) of a single set. Only load-bearing rep sets count (weight × reps), like Hevy. */
export function setVolumeKg(set: Pick<SetEntry, 'weightKg' | 'reps'>, type: ExerciseType): number {
  if (type !== 'weight_reps' && type !== 'weighted_bodyweight') return 0;
  return Math.max(0, set.weightKg ?? 0) * Math.max(0, set.reps ?? 0);
}

export function workoutVolumeKg(exercises: WorkoutExercise[], typeOf: (exerciseId: string) => ExerciseType): number {
  let v = 0;
  for (const we of exercises) {
    const t = typeOf(we.exerciseId);
    for (const s of we.sets) if (s.done) v += setVolumeKg(s, t);
  }
  return v;
}

export function countDoneSets(exercises: WorkoutExercise[]): number {
  return exercises.reduce((n, we) => n + we.sets.filter((s) => s.done).length, 0);
}

export function totalReps(exercises: WorkoutExercise[]): number {
  return exercises.reduce((n, we) => n + we.sets.reduce((m, s) => m + (s.done ? s.reps ?? 0 : 0), 0), 0);
}

// ---------------------------------------------------------------- personal records

/** Which PR categories apply to an exercise type. */
export function prKindsFor(type: ExerciseType): PRKind[] {
  switch (type) {
    case 'weight_reps':
      return ['heaviest_weight', 'best_1rm', 'best_set_volume'];
    case 'weighted_bodyweight':
      return ['heaviest_weight', 'most_reps'];
    case 'assisted_bodyweight':
    case 'bodyweight_reps':
      return ['most_reps'];
    case 'duration':
      return ['longest_duration'];
    case 'duration_weight':
      return ['heaviest_weight', 'longest_duration'];
    case 'distance_duration':
      return ['longest_distance', 'longest_duration'];
    case 'weight_distance':
      return ['heaviest_weight', 'longest_distance'];
  }
}

export const PR_LABEL: Record<PRKind, string> = {
  heaviest_weight: 'Heaviest Weight',
  best_1rm: 'Best 1RM',
  best_set_volume: 'Best Set Volume',
  most_reps: 'Most Reps',
  longest_duration: 'Longest Duration',
  longest_distance: 'Longest Distance',
};

export function prMetric(kind: PRKind, set: SetEntry, type: ExerciseType): number {
  switch (kind) {
    case 'heaviest_weight':
      return set.weightKg ?? 0;
    case 'best_1rm':
      return estimate1RM(set.weightKg, set.reps);
    case 'best_set_volume':
      return setVolumeKg(set, type);
    case 'most_reps':
      return set.reps ?? 0;
    case 'longest_duration':
      return set.durationSec ?? 0;
    case 'longest_distance':
      return set.distanceM ?? 0;
  }
}

export type Bests = Partial<Record<PRKind, number>>;

/** Sets that can set records: completed and not warm-ups. */
export const isRecordSet = (s: SetEntry) => s.done && s.type !== 'warmup';

/**
 * Personal records achieved by one workout's exercises, compared against `bests` (best values BEFORE this
 * workout). A PR requires previous history (bests > 0) and is credited to the single best set per kind.
 * Mutates nothing; returns the records plus the updated bests per exercise.
 */
export function detectPRs(
  exercises: WorkoutExercise[],
  bestsByExercise: Map<string, Bests>,
  typeOf: (exerciseId: string) => ExerciseType,
): { prs: PRRecord[]; updated: Map<string, Bests> } {
  const prs: PRRecord[] = [];
  const updated = new Map<string, Bests>();
  // Group instances of the same exercise (an exercise can appear twice in a workout).
  const byExercise = new Map<string, WorkoutExercise[]>();
  for (const we of exercises) {
    const arr = byExercise.get(we.exerciseId) ?? [];
    arr.push(we);
    byExercise.set(we.exerciseId, arr);
  }
  for (const [exerciseId, instances] of byExercise) {
    const type = typeOf(exerciseId);
    const prev = bestsByExercise.get(exerciseId) ?? {};
    const next: Bests = { ...prev };
    for (const kind of prKindsFor(type)) {
      let top = 0;
      let topSet: { we: WorkoutExercise; set: SetEntry } | null = null;
      for (const we of instances) {
        for (const set of we.sets) {
          if (!isRecordSet(set)) continue;
          const v = prMetric(kind, set, type);
          if (v > top) {
            top = v;
            topSet = { we, set };
          }
        }
      }
      const before = prev[kind] ?? 0;
      if (topSet && before > 0 && top > before + 1e-9) {
        prs.push({ exerciseId, workoutExerciseId: topSet.we.id, setId: topSet.set.id, kind, value: top });
      }
      if (top > before) next[kind] = top;
    }
    updated.set(exerciseId, next);
  }
  return { prs, updated };
}

/**
 * Walks all workouts oldest → newest and returns the PRs each one set. Use after any history change
 * (finish, edit, delete, import) so records stay correct.
 */
export function computeAllPRs(
  workouts: Workout[],
  typeOf: (exerciseId: string) => ExerciseType,
): Map<string, PRRecord[]> {
  const sorted = [...workouts].sort((a, b) => a.startedAt - b.startedAt);
  const bests = new Map<string, Bests>();
  const out = new Map<string, PRRecord[]>();
  for (const w of sorted) {
    const { prs, updated } = detectPRs(w.exercises, bests, typeOf);
    for (const [id, b] of updated) bests.set(id, b);
    out.set(w.id, prs);
  }
  return out;
}

/** All-time bests per exercise across the given workouts. */
export function bestsByExercise(
  workouts: Workout[],
  typeOf: (exerciseId: string) => ExerciseType,
): Map<string, Bests> {
  const bests = new Map<string, Bests>();
  for (const w of workouts) {
    for (const we of w.exercises) {
      const type = typeOf(we.exerciseId);
      const b = bests.get(we.exerciseId) ?? {};
      for (const kind of prKindsFor(type)) {
        for (const s of we.sets) {
          if (!isRecordSet(s)) continue;
          const v = prMetric(kind, s, type);
          if (v > (b[kind] ?? 0)) b[kind] = v;
        }
      }
      bests.set(we.exerciseId, b);
    }
  }
  return bests;
}

// ---------------------------------------------------------------- history helpers

/**
 * The previous session's sets for one INSTANCE of an exercise (the PREVIOUS column, and the placeholders a
 * plain pick gets in the logger and the routine editor): the `occurrence`-th instance (0-based, in list order)
 * of `exerciseId` in the most recent workout that had that many. Instances are never merged, so a back-off
 * Bench block doesn't show the heavy block's sets. `workoutsNewestFirst` must be sorted by startedAt
 * descending. With mode 'same_routine' and a routineId, prefers the last time it was done in that routine.
 */
export function previousInstanceSets(
  workoutsNewestFirst: Workout[],
  exerciseId: string,
  opts: { mode?: 'any' | 'same_routine'; routineId?: string | null; occurrence?: number } = {},
): SetEntry[] | null {
  const k = opts.occurrence ?? 0;
  const pick = (w: Workout) => {
    const sets = w.exercises.filter((e) => e.exerciseId === exerciseId)[k]?.sets;
    return sets?.length ? sets : null;
  };
  if (opts.mode === 'same_routine' && opts.routineId) {
    for (const w of workoutsNewestFirst) {
      if (w.routineId !== opts.routineId) continue;
      const s = pick(w);
      if (s) return s;
    }
  }
  for (const w of workoutsNewestFirst) {
    const s = pick(w);
    if (s) return s;
  }
  return null;
}

export interface ExerciseSession {
  workoutId: string;
  workoutName: string;
  date: number;
  sets: SetEntry[];
  heaviestKg: number;
  best1RM: number;
  bestSetVolume: number;
  sessionVolume: number;
  totalReps: number;
  maxReps: number;
  maxDuration: number;
  totalDuration: number;
  maxDistance: number;
  totalDistance: number;
}

/** One row per workout containing the exercise, oldest first — feeds charts and the History tab. */
export function exerciseSessions(workouts: Workout[], exerciseId: string, type: ExerciseType): ExerciseSession[] {
  const rows: ExerciseSession[] = [];
  for (const w of workouts) {
    const sets = w.exercises.filter((e) => e.exerciseId === exerciseId).flatMap((e) => e.sets.filter((s) => s.done));
    if (!sets.length) continue;
    const work = sets.filter((s) => s.type !== 'warmup');
    const base = work.length ? work : sets;
    rows.push({
      workoutId: w.id,
      workoutName: w.name,
      date: w.startedAt,
      sets,
      heaviestKg: Math.max(0, ...base.map((s) => s.weightKg ?? 0)),
      best1RM: Math.max(0, ...base.map((s) => estimate1RM(s.weightKg, s.reps))),
      bestSetVolume: Math.max(0, ...base.map((s) => setVolumeKg(s, type))),
      sessionVolume: sets.reduce((v, s) => v + setVolumeKg(s, type), 0),
      totalReps: sets.reduce((v, s) => v + (s.reps ?? 0), 0),
      maxReps: Math.max(0, ...base.map((s) => s.reps ?? 0)),
      maxDuration: Math.max(0, ...base.map((s) => s.durationSec ?? 0)),
      totalDuration: sets.reduce((v, s) => v + (s.durationSec ?? 0), 0),
      maxDistance: Math.max(0, ...base.map((s) => s.distanceM ?? 0)),
      totalDistance: sets.reduce((v, s) => v + (s.distanceM ?? 0), 0),
    });
  }
  rows.sort((a, b) => a.date - b.date);
  return rows;
}

/** Best weight lifted for each rep count (1..maxReps) — Hevy's "Set Records" table. */
export function repRecords(
  workouts: Workout[],
  exerciseId: string,
  maxReps = 15,
): { reps: number; weightKg: number; date: number; workoutId: string }[] {
  const best = new Map<number, { weightKg: number; date: number; workoutId: string }>();
  for (const w of workouts) {
    for (const we of w.exercises) {
      if (we.exerciseId !== exerciseId) continue;
      for (const s of we.sets) {
        if (!isRecordSet(s) || !s.reps || !s.weightKg) continue;
        const r = Math.min(s.reps, maxReps);
        const cur = best.get(r);
        if (!cur || s.weightKg > cur.weightKg) best.set(r, { weightKg: s.weightKg, date: w.startedAt, workoutId: w.id });
      }
    }
  }
  return [...best.entries()].sort((a, b) => a[0] - b[0]).map(([reps, v]) => ({ reps, ...v }));
}
