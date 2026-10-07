import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import type { ExerciseType, Routine, RoutineExercise, Workout, WorkoutExercise } from '../types';
import { computeAllPRs, countDoneSets, isSideSet, workoutVolumeKg } from './calc';
import { CATALOG_BY_ID } from './exercises';
import { uid } from './ids';
import { copySides } from './sides';

/** Exercise type lookup straight from the DB/catalog (for code running outside React). */
export async function loadTypeLookup(): Promise<(id: string) => ExerciseType> {
  const custom = await db.customExercises.toArray();
  const map = new Map<string, ExerciseType>(custom.map((c) => [c.id, c.type]));
  return (id: string) => map.get(id) ?? CATALOG_BY_ID.get(id)?.type ?? 'weight_reps';
}

/** Fill the derived/denormalized fields of a workout (call before every save). */
export function deriveWorkout(w: Workout, typeOf: (id: string) => ExerciseType): Workout {
  return {
    ...w,
    exerciseIds: [...new Set(w.exercises.map((e) => e.exerciseId))],
    volumeKg: workoutVolumeKg(w.exercises, typeOf),
    setCount: countDoneSets(w.exercises),
    updatedAt: Date.now(),
  };
}

/** Re-walk the whole history and rewrite PR badges wherever they changed. */
export async function recomputeAllPRs(): Promise<void> {
  const typeOf = await loadTypeLookup();
  await db.transaction('rw', db.workouts, async () => {
    const all = await db.workouts.toArray();
    const prs = computeAllPRs(all, typeOf);
    const changed: Workout[] = [];
    for (const w of all) {
      const next = prs.get(w.id) ?? [];
      if (JSON.stringify(next) !== JSON.stringify(w.prs ?? [])) changed.push({ ...w, prs: next });
    }
    if (changed.length) await db.workouts.bulkPut(changed);
  });
}

/** Save a new or edited workout (derives totals, then refreshes PRs across history). */
export async function saveWorkout(w: Workout): Promise<void> {
  const typeOf = await loadTypeLookup();
  await db.workouts.put(deriveWorkout(w, typeOf));
  await recomputeAllPRs();
}

export async function deleteWorkout(id: string): Promise<void> {
  const w = await db.workouts.get(id);
  await db.workouts.delete(id);
  if (w?.photoIds?.length) await db.media.bulkDelete(w.photoIds);
  await recomputeAllPRs();
}

/** All workouts, newest first. */
export function useWorkouts(): Workout[] | undefined {
  return useLiveQuery(() => db.workouts.orderBy('startedAt').reverse().toArray(), []);
}

export function useWorkout(id: string | null | undefined): Workout | undefined | null {
  return useLiveQuery(async () => (id ? (await db.workouts.get(id)) ?? null : null), [id]);
}

/** Workouts containing an exercise, oldest first. */
export function useExerciseWorkouts(exerciseId: string | null | undefined): Workout[] | undefined {
  return useLiveQuery(
    async () =>
      exerciseId ? (await db.workouts.where('exerciseIds').equals(exerciseId).sortBy('startedAt')) : [],
    [exerciseId],
  );
}

/** Convert a finished workout's exercises into routine exercises (used by "Save as routine"). */
export function workoutToRoutineExercises(exercises: WorkoutExercise[]): RoutineExercise[] {
  return exercises.map((we) => ({
    id: uid(),
    exerciseId: we.exerciseId,
    notes: we.notes,
    restSec: we.restSec ?? null,
    supersetId: we.supersetId ?? null,
    sets: we.sets.map((s) => ({
      id: uid(),
      type: s.type,
      weightKg: s.weightKg ?? null,
      reps: s.reps ?? null,
      durationSec: s.durationSec ?? null,
      distanceM: s.distanceM ?? null,
      ...(isSideSet(s) ? { sides: copySides(s) } : {}),
    })),
  }));
}

export async function createRoutineFromWorkout(w: Workout, name?: string): Promise<string> {
  const count = await db.routines.count();
  const r: Routine = {
    id: uid(),
    name: name?.trim() || w.name,
    folderId: null,
    order: count,
    exercises: workoutToRoutineExercises(w.exercises),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastPerformedAt: null,
  };
  await db.routines.add(r);
  return r.id;
}

/** Default workout title by time of day ("Morning Workout"...). */
export function defaultWorkoutName(at = new Date()): string {
  const h = at.getHours();
  if (h < 5) return 'Night Workout';
  if (h < 12) return 'Morning Workout';
  if (h < 17) return 'Afternoon Workout';
  if (h < 21) return 'Evening Workout';
  return 'Night Workout';
}
