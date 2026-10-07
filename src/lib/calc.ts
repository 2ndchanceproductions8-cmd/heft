import type {
  ExerciseType,
  PRKind,
  PRRecord,
  SetEntry,
  SetSides,
  Side,
  SideValues,
  Workout,
  WorkoutExercise,
} from '../types';

/** Estimated one-rep max (Epley). reps=1 returns the weight itself. */
export function estimate1RM(weightKg: number | null | undefined, reps: number | null | undefined): number {
  if (!weightKg || !reps || reps < 1 || weightKg <= 0) return 0;
  if (reps === 1) return weightKg;
  return weightKg * (1 + reps / 30);
}

// ---------------------------------------------------------------- per-side sets

/** Anything carrying set values: a set, a target, or one side of a per-side set. */
type LimbSource = SideValues & { sides?: SetSides | null };

/** True for a per-side (left/right) set. */
export function isSideSet<T extends { sides?: SetSides | null }>(s: T | null | undefined): s is T & { sides: SetSides } {
  return !!s?.sides?.left && !!s.sides.right;
}

export interface Limb {
  /** null = a plain set (both sides together). */
  side: Side | null;
  values: SideValues;
}

/**
 * What each limb did in a set: the two sides of a per-side set, else the set itself. THE way to read a set's
 * values for totals and records: totals add every limb (a per-side set's volume is left + right), records take
 * the best limb (so a single-arm row's records compare arm to arm, like the "50 lb x 10" each-arm sets logged
 * before per-side logging existed).
 */
export function setLimbs(s: LimbSource): Limb[] {
  if (isSideSet(s)) return [
    { side: 'left', values: s.sides.left },
    { side: 'right', values: s.sides.right },
  ];
  return [{ side: null, values: s }];
}

const limbVolume = (v: SideValues) => Math.max(0, v.weightKg ?? 0) * Math.max(0, v.reps ?? 0);

/** Volume (kg) of a single set. Only load-bearing rep sets count (weight × reps), like Hevy. Both sides of a per-side set count. */
export function setVolumeKg(set: LimbSource, type: ExerciseType): number {
  if (type !== 'weight_reps' && type !== 'weighted_bodyweight') return 0;
  return setLimbs(set).reduce((v, l) => v + limbVolume(l.values), 0);
}

/** Reps of a set (both sides of a per-side set). */
export function setReps(set: LimbSource): number {
  return setLimbs(set).reduce((n, l) => n + Math.max(0, l.values.reps ?? 0), 0);
}

/** Total time (s) of a set (both sides of a per-side set). */
export function setDurationSec(set: LimbSource): number {
  return setLimbs(set).reduce((n, l) => n + Math.max(0, l.values.durationSec ?? 0), 0);
}

/** Total distance (m) of a set (both sides of a per-side set). */
export function setDistanceM(set: LimbSource): number {
  return setLimbs(set).reduce((n, l) => n + Math.max(0, l.values.distanceM ?? 0), 0);
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
  return exercises.reduce((n, we) => n + we.sets.reduce((m, s) => m + (s.done ? setReps(s) : 0), 0), 0);
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

/** A record metric of one limb's values (a plain set, or one side of a per-side set). */
export function limbMetric(kind: PRKind, v: SideValues, type: ExerciseType): number {
  switch (kind) {
    case 'heaviest_weight':
      return v.weightKg ?? 0;
    case 'best_1rm':
      return estimate1RM(v.weightKg, v.reps);
    case 'best_set_volume':
      return type === 'weight_reps' || type === 'weighted_bodyweight' ? limbVolume(v) : 0;
    case 'most_reps':
      return v.reps ?? 0;
    case 'longest_duration':
      return v.durationSec ?? 0;
    case 'longest_distance':
      return v.distanceM ?? 0;
  }
}

/** A set's record metric and the limb that achieved it: a per-side set counts its better side. */
export function prMetricSide(kind: PRKind, set: LimbSource, type: ExerciseType): { value: number; side: Side | null } {
  let best = { value: 0, side: null as Side | null };
  for (const l of setLimbs(set)) {
    const value = limbMetric(kind, l.values, type);
    if (value > best.value) best = { value, side: l.side };
  }
  return best;
}

export function prMetric(kind: PRKind, set: LimbSource, type: ExerciseType): number {
  return prMetricSide(kind, set, type).value;
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
      let topSet: { we: WorkoutExercise; set: SetEntry; side: Side | null } | null = null;
      for (const we of instances) {
        for (const set of we.sets) {
          if (!isRecordSet(set)) continue;
          const m = prMetricSide(kind, set, type);
          if (m.value > top) {
            top = m.value;
            topSet = { we, set, side: m.side };
          }
        }
      }
      const before = prev[kind] ?? 0;
      if (topSet && before > 0 && top > before + 1e-9) {
        prs.push({
          exerciseId,
          workoutExerciseId: topSet.we.id,
          setId: topSet.set.id,
          kind,
          value: top,
          ...(topSet.side ? { side: topSet.side } : {}),
        });
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

/** One side's (or one plain limb's) bests in a session. */
export interface LimbBests {
  heaviestKg: number;
  best1RM: number;
  bestSetVolume: number;
  maxReps: number;
  maxDuration: number;
  maxDistance: number;
}

function limbBests(values: SideValues[], type: ExerciseType): LimbBests {
  const max = (f: (v: SideValues) => number) => Math.max(0, ...values.map(f));
  return {
    heaviestKg: max((v) => v.weightKg ?? 0),
    best1RM: max((v) => estimate1RM(v.weightKg, v.reps)),
    bestSetVolume: max((v) => limbMetric('best_set_volume', v, type)),
    maxReps: max((v) => v.reps ?? 0),
    maxDuration: max((v) => v.durationSec ?? 0),
    maxDistance: max((v) => v.distanceM ?? 0),
  };
}

export interface ExerciseSession extends LimbBests {
  workoutId: string;
  workoutName: string;
  date: number;
  sets: SetEntry[];
  sessionVolume: number;
  totalReps: number;
  totalDuration: number;
  totalDistance: number;
  /** Left vs right bests, when the session has per-side sets (from those sets only). */
  sides?: Record<Side, LimbBests>;
}

/**
 * One row per workout containing the exercise, oldest first — feeds charts and the History tab. Bests are per
 * limb (a per-side set counts its better side), totals add both sides.
 */
export function exerciseSessions(workouts: Workout[], exerciseId: string, type: ExerciseType): ExerciseSession[] {
  const rows: ExerciseSession[] = [];
  for (const w of workouts) {
    const sets = w.exercises.filter((e) => e.exerciseId === exerciseId).flatMap((e) => e.sets.filter((s) => s.done));
    if (!sets.length) continue;
    const work = sets.filter((s) => s.type !== 'warmup');
    const base = work.length ? work : sets;
    const sideSets = base.filter((s) => isSideSet(s));
    rows.push({
      workoutId: w.id,
      workoutName: w.name,
      date: w.startedAt,
      sets,
      ...limbBests(
        base.flatMap((s) => setLimbs(s).map((l) => l.values)),
        type,
      ),
      sessionVolume: sets.reduce((v, s) => v + setVolumeKg(s, type), 0),
      totalReps: sets.reduce((v, s) => v + setReps(s), 0),
      totalDuration: sets.reduce((v, s) => v + setDurationSec(s), 0),
      totalDistance: sets.reduce((v, s) => v + setDistanceM(s), 0),
      ...(sideSets.length
        ? {
            sides: {
              left: limbBests(sideSets.map((s) => s.sides!.left), type),
              right: limbBests(sideSets.map((s) => s.sides!.right), type),
            },
          }
        : {}),
    });
  }
  rows.sort((a, b) => a.date - b.date);
  return rows;
}

/** The left-vs-right comparison metric for an exercise type (what "stronger side" means for it). */
export type SideMetric = 'best1RM' | 'heaviestKg' | 'maxReps' | 'maxDuration' | 'maxDistance';

export function sideMetricFor(type: ExerciseType): SideMetric {
  switch (type) {
    case 'weight_reps':
    case 'weighted_bodyweight':
      return 'best1RM';
    case 'bodyweight_reps':
    case 'assisted_bodyweight':
      return 'maxReps';
    case 'duration':
    case 'duration_weight':
      return 'maxDuration';
    case 'distance_duration':
    case 'weight_distance':
      return 'maxDistance';
  }
}

/** One session's left vs right, on the type's metric. */
export interface SideBalancePoint {
  workoutId: string;
  date: number;
  left: number;
  right: number;
}

export interface SideBalance {
  metric: SideMetric;
  /** Sessions with per-side sets, oldest first. */
  points: SideBalancePoint[];
  /** The latest session's gap: how much weaker the weaker side is, % of the stronger side (0 = even). */
  gapPct: number | null;
  /** The latest session's weaker side (null when even or no data). */
  weaker: Side | null;
  /** Best ever per side on the metric. */
  bestLeft: number;
  bestRight: number;
}

/**
 * Left-vs-right strength of a per-side exercise from its sessions (exerciseSessions rows). The gap compares the
 * latest session's two sides on the type's metric (estimated 1RM for weighted reps, reps, time or distance).
 */
export function sideBalance(sessions: ExerciseSession[], type: ExerciseType): SideBalance {
  const metric = sideMetricFor(type);
  const pick = (b: LimbBests) => (metric === 'best1RM' && b.best1RM === 0 ? b.heaviestKg : b[metric]);
  const points: SideBalancePoint[] = [];
  for (const s of sessions) {
    if (!s.sides) continue;
    const left = pick(s.sides.left);
    const right = pick(s.sides.right);
    if (left <= 0 && right <= 0) continue;
    points.push({ workoutId: s.workoutId, date: s.date, left, right });
  }
  const last = points[points.length - 1];
  let gapPct: number | null = null;
  let weaker: Side | null = null;
  const strong = last ? Math.max(last.left, last.right) : 0;
  if (last && strong > 0) {
    gapPct = (Math.abs(last.left - last.right) / strong) * 100;
    if (gapPct < 0.05) gapPct = 0;
    else weaker = last.left < last.right ? 'left' : 'right';
  }
  return {
    metric,
    points,
    gapPct,
    weaker,
    bestLeft: Math.max(0, ...points.map((p) => p.left)),
    bestRight: Math.max(0, ...points.map((p) => p.right)),
  };
}

/** Best weight lifted for each rep count (1..maxReps) — Hevy's "Set Records" table. Per limb for per-side sets. */
export function repRecords(
  workouts: Workout[],
  exerciseId: string,
  maxReps = 15,
): { reps: number; weightKg: number; date: number; workoutId: string; side?: Side }[] {
  const best = new Map<number, { weightKg: number; date: number; workoutId: string; side?: Side }>();
  for (const w of workouts) {
    for (const we of w.exercises) {
      if (we.exerciseId !== exerciseId) continue;
      for (const s of we.sets) {
        if (!isRecordSet(s)) continue;
        for (const { side, values: v } of setLimbs(s)) {
          if (!v.reps || !v.weightKg) continue;
          const r = Math.min(v.reps, maxReps);
          const cur = best.get(r);
          if (!cur || v.weightKg > cur.weightKg)
            best.set(r, { weightKg: v.weightKg, date: w.startedAt, workoutId: w.id, ...(side ? { side } : {}) });
        }
      }
    }
  }
  return [...best.entries()].sort((a, b) => a[0] - b[0]).map(([reps, v]) => ({ reps, ...v }));
}
