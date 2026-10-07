import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import type { Routine, RoutineExercise, RoutineFolder, RoutineSet, SetEntry, Side, SideValues, Workout, WorkoutExercise } from '../types';
import { isSideSet } from './calc';
import { uid } from './ids';
import { copySides, SIDES, sideOf, syncSideSet } from './sides';

/** All routines ordered by `order` (then name). */
export function useRoutines(): Routine[] | undefined {
  return useLiveQuery(async () => {
    const all = await db.routines.toArray();
    return all.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  }, []);
}

export function useRoutine(id: string | null | undefined): Routine | undefined | null {
  return useLiveQuery(async () => (id ? (await db.routines.get(id)) ?? null : null), [id]);
}

export function useFolders(): RoutineFolder[] | undefined {
  return useLiveQuery(async () => (await db.folders.toArray()).sort((a, b) => a.order - b.order), []);
}

export function newRoutineSet(partial: Partial<RoutineSet> = {}): RoutineSet {
  return { id: uid(), type: 'normal', weightKg: null, reps: null, ...partial };
}

export function newRoutineExercise(exerciseId: string, sets = 3): RoutineExercise {
  return {
    id: uid(),
    exerciseId,
    restSec: null,
    supersetId: null,
    sets: Array.from({ length: sets }, () => newRoutineSet()),
  };
}

export async function createRoutine(partial: Partial<Routine> = {}): Promise<string> {
  const order = await db.routines.count();
  const r: Routine = {
    id: uid(),
    name: 'New Routine',
    folderId: null,
    order,
    exercises: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastPerformedAt: null,
    ...partial,
  };
  await db.routines.add(r);
  return r.id;
}

export async function saveRoutine(r: Routine): Promise<void> {
  await db.routines.put({ ...r, updatedAt: Date.now() });
}

export async function deleteRoutine(id: string): Promise<void> {
  await db.routines.delete(id);
}

export async function duplicateRoutine(id: string): Promise<string | null> {
  const r = await db.routines.get(id);
  if (!r) return null;
  return createRoutine({
    ...r,
    id: uid(),
    name: `${r.name} (Copy)`,
    order: (await db.routines.count()),
    exercises: r.exercises.map((e) => ({ ...e, id: uid(), sets: e.sets.map((s) => ({ ...s, id: uid() })) })),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastPerformedAt: null,
  });
}

export async function createFolder(name: string): Promise<string> {
  const id = uid();
  await db.folders.add({ id, name: name.trim() || 'New Folder', order: await db.folders.count() });
  return id;
}

export async function renameFolder(id: string, name: string): Promise<void> {
  await db.folders.update(id, { name: name.trim() || 'Folder' });
}

/** Deletes a folder; its routines move to "My Routines" (no folder). */
export async function deleteFolder(id: string): Promise<void> {
  await db.transaction('rw', db.folders, db.routines, async () => {
    await db.routines.where('folderId').equals(id).modify({ folderId: null });
    await db.folders.delete(id);
  });
}

const hasRange = (s: SideValues) => s.reps != null && s.repsMax != null && s.repsMax > s.reps;

/** One side (or a plain set) matches its plan; reps anywhere inside a planned rep range count as matching. */
const sameLimb = (a: SideValues, b: SideValues) =>
  (a.weightKg ?? null) === (b.weightKg ?? null) &&
  (hasRange(a) ? b.reps != null && b.reps >= a.reps! && b.reps <= a.repsMax! : (a.reps ?? null) === (b.reps ?? null)) &&
  (a.durationSec ?? null) === (b.durationSec ?? null) &&
  (a.distanceM ?? null) === (b.distanceM ?? null);

/**
 * A logged set "matches" its planned set. Per-side on either end is compared side by side (a plain plan or a plain
 * logged set stands for both sides), so new left/right numbers offer to update the routine.
 */
const sameSet = (a: RoutineSet, b: SetEntry) =>
  a.type === b.type &&
  (isSideSet(a) || isSideSet(b)
    ? SIDES.every((side) => sameLimb(sideOf(a, side)!, sideOf(b, side)!))
    : sameLimb(a, b));

/** A planned side (or plain set) from a logged one: the range is kept while the logged side still has reps. */
function plannedLimb(s: SideValues, old: SideValues | null | undefined): SideValues {
  const keepRange = !!old && hasRange(old) && s.reps != null;
  return {
    weightKg: s.weightKg ?? null,
    reps: keepRange ? old!.reps : s.reps ?? null,
    repsMax: keepRange ? old!.repsMax : null,
    durationSec: s.durationSec ?? null,
    distanceM: s.distanceM ?? null,
  };
}

/**
 * Planned set updated from a logged one. Rep ranges are kept (only the load changes), but only while the
 * logged set still has reps: after a Replace with a timed or distance exercise the old range must not stick.
 * A per-side logged set plans each side (keeping that side's range, or the plain plan's).
 */
function plannedFromLogged(s: SetEntry, old: RoutineSet | undefined): RoutineSet {
  const base: RoutineSet = { id: old?.id ?? uid(), type: s.type, ...plannedLimb(s, old) };
  if (!isSideSet(s)) return base;
  const side = (k: Side) => plannedLimb(s.sides[k], old ? sideOf(old, k) : null);
  return syncSideSet({ ...base, sides: { left: side('left'), right: side('right') } });
}

/*
 * "Update routine?" after finishing a routine workout. ONE path: FinishWorkoutPage calls planRoutineUpdate
 * (what would change, for the prompt) and updateRoutineFromWorkout (apply it). Both go through the same steps:
 *   1. workoutForRoutineUpdate - fold "keep completed sets on this machine" variant splits back into their
 *      slot (the active workout's `variantSplits` map says which card was split off which);
 *   2. pairWorkoutWithRoutine - pair routine slots with logged exercises by routineExerciseId, then exerciseId;
 *   3. merge - the routine after the update (a swapped variant takes its slot in place).
 * The exported building blocks take the same optional `splits`, so every caller sees the same result.
 */

/** Instance split off by a variant switch -> the instance it came from (LiveWorkout.variantSplits). */
export type VariantSplits = Record<string, string> | null | undefined;

/**
 * Pairs each routine slot (by `RoutineExercise.id`) with the workout exercise performed for it.
 * Pass 1 follows the recorded link (`WorkoutExercise.routineExerciseId`), so a slot whose exercise was swapped
 * for a gym/brand variant or replaced mid-workout still finds it. Pass 2 falls back to the same exerciseId for
 * slots still open (older workouts without links, exercises added from the library). Pass 1 runs to completion
 * first so the fallback cannot steal an exercise that belongs to another slot (e.g. A and B swapped with each
 * other).
 */
export function pairWorkoutWithRoutine(r: Routine, w: Workout): Map<string, WorkoutExercise> {
  const pairs = new Map<string, WorkoutExercise>();
  const used = new Set<string>();
  const take = (reId: string, we: WorkoutExercise | undefined) => {
    if (!we) return;
    pairs.set(reId, we);
    used.add(we.id);
  };
  for (const re of r.exercises) {
    take(re.id, w.exercises.find((x) => !used.has(x.id) && x.routineExerciseId === re.id));
  }
  for (const re of r.exercises) {
    if (pairs.has(re.id)) continue;
    take(re.id, w.exercises.find((x) => !used.has(x.id) && x.exerciseId === re.exerciseId));
  }
  return pairs;
}

/**
 * The workout as "Update routine" should see it after variant splits ("keep my completed sets on this
 * machine, log the rest on the other one"). A split-off instance of a routine slot is left out, and the slot's
 * own instance is padded with the slot's remaining planned sets - so the routine keeps its set count and the
 * plan for the sets that were done on another machine, instead of shrinking to the sets done on its machine
 * and gaining the other machine as an extra exercise. (When the slot's own instance is gone - removed, or
 * nothing on it was saved - the split-off one simply takes the slot through its routine link.) Splits of
 * exercises that are not in the routine are left alone (they are appended as usual).
 */
export function workoutForRoutineUpdate(w: Workout, routine: Routine, splits: VariantSplits): Workout {
  if (!splits || !Object.keys(splits).length) return w;
  const present = new Set(w.exercises.map((e) => e.id));
  // The kept instance a split-off one belongs to (follows a split of a split); null = not a split-off.
  const memo = new Map<string, string | null>();
  const originOf = (id: string, depth = 0): string | null => {
    if (memo.has(id)) return memo.get(id)!;
    let res: string | null = null;
    let cur: string | undefined = splits[id];
    for (let hops = 0; cur && hops < 50 && depth < 50; hops++) {
      if (present.has(cur)) {
        res = originOf(cur, depth + 1) ?? cur;
        break;
      }
      cur = splits[cur];
    }
    memo.set(id, res);
    return res;
  };
  const kept = w.exercises.filter((e) => originOf(e.id) == null);
  if (kept.length === w.exercises.length) return w;

  const pairs = pairWorkoutWithRoutine(routine, { ...w, exercises: kept });
  const slotOf = new Map<string, RoutineExercise>();
  for (const re of routine.exercises) {
    const we = pairs.get(re.id);
    if (we) slotOf.set(we.id, re);
  }
  const exercises: WorkoutExercise[] = [];
  for (const we of w.exercises) {
    const origin = originOf(we.id);
    if (origin != null) {
      if (!slotOf.has(origin)) exercises.push(we);
      continue;
    }
    const re = slotOf.get(we.id);
    const splitHere = w.exercises.some((x) => originOf(x.id) === we.id);
    if (!re || !splitHere || re.sets.length <= we.sets.length) {
      exercises.push(we);
      continue;
    }
    // The sets done on the other machine leave this slot's plan for them unchanged (minus the planned weight
    // when the slot itself now holds a different machine: that weight belonged to the old one).
    const sameMachine = we.exerciseId === re.exerciseId;
    const planned: SetEntry[] = re.sets.slice(we.sets.length).map((rs) => {
      const sides = copySides(rs);
      return {
        id: rs.id,
        type: rs.type,
        weightKg: sameMachine ? rs.weightKg ?? null : null,
        reps: rs.reps ?? null,
        durationSec: rs.durationSec ?? null,
        distanceM: rs.distanceM ?? null,
        ...(sides
          ? {
              sides: sameMachine
                ? sides
                : { left: { ...sides.left, weightKg: null }, right: { ...sides.right, weightKg: null } },
            }
          : {}),
        done: true,
      };
    });
    exercises.push({ ...we, sets: [...we.sets, ...planned] });
  }
  return { ...w, exercises };
}

/** The merge step, on a workout already folded by workoutForRoutineUpdate. */
function merge(r: Routine, w: Workout): RoutineExercise[] {
  const pairs = pairWorkoutWithRoutine(r, w);
  const used = new Set([...pairs.values()].map((we) => we.id));
  const merged: RoutineExercise[] = r.exercises.map((re) => {
    const we = pairs.get(re.id);
    if (!we) return re;
    return {
      ...re, // keeps the slot's id, position and supersetId
      exerciseId: we.exerciseId, // a variant/replacement takes the slot
      notes: we.notes ?? re.notes,
      restSec: we.restSec ?? re.restSec ?? null,
      sets: we.sets.map((s, i) => plannedFromLogged(s, re.sets[i])),
    };
  });
  for (const we of w.exercises) {
    if (used.has(we.id)) continue;
    merged.push({
      id: uid(),
      exerciseId: we.exerciseId,
      notes: we.notes,
      restSec: we.restSec ?? null,
      supersetId: null,
      sets: we.sets.map((s) => plannedFromLogged(s, undefined)),
    });
  }
  return merged;
}

/**
 * What the routine would look like after "Update routine": exercises you performed get the sets and
 * weights you actually did (rep ranges kept), exercises you skipped today stay untouched, and exercises
 * you added are appended. A slot whose exercise you swapped (variant / Replace) takes the new exercise in
 * place, keeping its position and superset. Nothing is ever deleted by a partial workout.
 */
export function mergeWorkoutIntoRoutine(r: Routine, w: Workout, splits?: VariantSplits): RoutineExercise[] {
  return merge(r, workoutForRoutineUpdate(w, r, splits));
}

export interface RoutineExerciseSwap {
  routineExerciseId: string;
  from: string;
  to: string;
}

function slotSwaps(r: Routine, w: Workout): RoutineExerciseSwap[] {
  const pairs = pairWorkoutWithRoutine(r, w);
  const out: RoutineExerciseSwap[] = [];
  for (const re of r.exercises) {
    const we = pairs.get(re.id);
    if (we && we.exerciseId !== re.exerciseId) out.push({ routineExerciseId: re.id, from: re.exerciseId, to: we.exerciseId });
  }
  return out;
}

/**
 * Routine slots whose exercise "Update routine" would swap (variant switch or Replace mid-workout), in
 * routine order. Lets the prompt say "Lat Pulldown (Cable) will become Lat Pulldown (Cable) - Hammer Strength".
 */
export function routineExerciseSwaps(r: Routine, w: Workout, splits?: VariantSplits): RoutineExerciseSwap[] {
  return slotSwaps(r, workoutForRoutineUpdate(w, r, splits));
}

const comparable = (list: RoutineExercise[]) =>
  JSON.stringify(
    list.map((e) => [
      e.exerciseId,
      e.sets.map((s) => [s.type, s.weightKg ?? null, s.reps ?? null, s.repsMax ?? null, s.durationSec ?? null, s.distanceM ?? null, copySides(s)]),
    ]),
  );

/** The "anything to update?" step, on a folded workout and its merge result. */
function differs(r: Routine, w: Workout, merged: RoutineExercise[]): boolean {
  if (!w.exercises.length) return false;
  // Quick path: every performed exercise is the one its slot plans and matches it set-for-set.
  const slotOf = new Map<string, RoutineExercise>();
  const pairs = pairWorkoutWithRoutine(r, w);
  for (const re of r.exercises) {
    const we = pairs.get(re.id);
    if (we) slotOf.set(we.id, re);
  }
  const allMatch = w.exercises.every((we) => {
    const re = slotOf.get(we.id);
    return (
      !!re &&
      re.exerciseId === we.exerciseId &&
      re.sets.length === we.sets.length &&
      re.sets.every((s, j) => sameSet(s, we.sets[j]))
    );
  });
  if (allMatch) return false;
  return comparable(merged) !== comparable(r.exercises);
}

/** True when "Update routine" would change anything (new loads, different set counts, swapped or added exercises). */
export function workoutDiffersFromRoutine(r: Routine, w: Workout, splits?: VariantSplits): boolean {
  const view = workoutForRoutineUpdate(w, r, splits);
  return differs(r, view, merge(r, view));
}

export interface RoutineUpdatePlan {
  /** The routine's exercises after the update. */
  exercises: RoutineExercise[];
  /** False when updating would change nothing (then don't ask). */
  changed: boolean;
  /** Slots whose exercise changes (variant switch / Replace), in routine order. */
  swaps: RoutineExerciseSwap[];
  /** exerciseIds of performed exercises that are not in the routine and would be appended, in workout order. */
  added: string[];
}

/** Everything "Update routine?" needs, computed once from the same folded workout. */
export function planRoutineUpdate(r: Routine, w: Workout, splits?: VariantSplits): RoutineUpdatePlan {
  const view = workoutForRoutineUpdate(w, r, splits);
  const exercises = merge(r, view);
  const paired = new Set([...pairWorkoutWithRoutine(r, view).values()].map((we) => we.id));
  return {
    exercises,
    changed: differs(r, view, exercises),
    swaps: slotSwaps(r, view),
    added: view.exercises.filter((we) => !paired.has(we.id)).map((we) => we.exerciseId),
  };
}

/** Apply "Update routine" (see planRoutineUpdate). Re-reads the routine so an edit made meanwhile isn't lost. */
export async function updateRoutineFromWorkout(routineId: string, w: Workout, splits?: VariantSplits): Promise<void> {
  const r = await db.routines.get(routineId);
  if (!r) return;
  await db.routines.put({ ...r, exercises: mergeWorkoutIntoRoutine(r, w, splits), updatedAt: Date.now() });
}

// ---------------------------------------------------------------- ordering & folders (routines feature)

/** The `order` value that puts a routine after every existing one. */
export async function nextRoutineOrder(): Promise<number> {
  const last = await db.routines.orderBy('order').last();
  return last ? last.order + 1 : 0;
}

/** Persist a new global routine order: each id's index becomes its `order`. Unknown ids are skipped. */
export async function reorderRoutines(orderedIds: string[]): Promise<void> {
  await db.transaction('rw', db.routines, async () => {
    const existing = new Set((await db.routines.toCollection().primaryKeys()) as string[]);
    const updates = orderedIds
      .filter((id) => existing.has(id))
      .map((id, i) => ({ key: id, changes: { order: i } }));
    if (updates.length) await db.routines.bulkUpdate(updates);
  });
}

/** Move a routine into a folder (null = "My Routines"); it goes to the end of the list. */
export async function moveRoutineToFolder(id: string, folderId: string | null): Promise<void> {
  const order = await nextRoutineOrder();
  await db.routines.update(id, { folderId, order, updatedAt: Date.now() });
}

/** Persist a folder's collapsed state on the Workout page. */
export async function setFolderCollapsed(id: string, collapsed: boolean): Promise<void> {
  await db.folders.update(id, { collapsed });
}

/** Most recent workout start time per routine id (derived from history, so deleted workouts drop out). */
export function useRoutineLastPerformed(): Map<string, number> | undefined {
  return useLiveQuery(async () => {
    const map = new Map<string, number>();
    await db.workouts
      .orderBy('startedAt')
      .reverse()
      .each((w) => {
        if (w.routineId && !map.has(w.routineId)) map.set(w.routineId, w.startedAt);
      });
    return map;
  }, []);
}

/**
 * Create a folder AFTER every existing one. (createFolder uses the folder count as `order`, which collides
 * with an existing folder once one has been deleted, so a new folder could sort above older ones.)
 */
export async function createFolderLast(name: string): Promise<string> {
  return db.transaction('rw', db.folders, async () => {
    const last = await db.folders.orderBy('order').last();
    const id = await createFolder(name);
    await db.folders.update(id, { order: last ? last.order + 1 : 0 });
    return id;
  });
}

/** Duplicate a routine and put the copy at the end of the list (duplicateRoutine's count-based order can collide). */
export async function duplicateRoutineLast(id: string): Promise<string | null> {
  const order = await nextRoutineOrder();
  const newId = await duplicateRoutine(id);
  if (newId) await db.routines.update(newId, { order });
  return newId;
}
