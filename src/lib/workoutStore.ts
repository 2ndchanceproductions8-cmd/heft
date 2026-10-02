import { create } from 'zustand';
import { db } from '../db';
import type {
  ActiveWorkout,
  Routine,
  RoutineExercise,
  SetEntry,
  SetTarget,
  Workout,
  WorkoutExercise,
} from '../types';
import { toast } from '../components/ui/dialogs';
import { typeFields, type TypeFields } from './exerciseMeta';
import { uid } from './ids';
import { deleteMedia } from './media';
import { saveWorkout, defaultWorkoutName, loadTypeLookup } from './workouts';

/**
 * The in-progress workout. Every change is persisted to IndexedDB (db.active, id "current") so closing
 * the app, locking the phone or a crash never loses a workout. Timers are timestamp-based (startedAt,
 * rest.endsAt) so they stay correct while the app is in the background.
 *
 * The exercise/set mutations are implemented as pure functions over a `WorkoutExercise[]`
 * (`exerciseListOps`) so the "Edit saved workout" screen reuses exactly the same behaviour on a local copy.
 */

export interface PickedExercise {
  exerciseId: string;
  /** Set when the user picked the exercise from one of their routines — its planned sets come along. */
  fromRoutine?: { routineId: string; routineExerciseId: string } | null;
}

export interface NewExerciseItem {
  /** Optional instance id (lets the caller find/scroll to the new card). Generated when omitted. */
  id?: string;
  exerciseId: string;
  sets?: SetEntry[];
  notes?: string;
  restSec?: number | null;
  /**
   * Superset group within this add batch (routine picks keep their routine's pairings). Ignored when the
   * batch is added with `{ superset: true }`; a group left with one member is dropped.
   */
  supersetId?: string | null;
  /** The routine slot a routine pick came from (WorkoutExercise.routineExerciseId). */
  routineExerciseId?: string | null;
}

/** Inputs of the "Save Workout" screen that the workout itself has no field for. */
export interface FinishDraft {
  /** Photos already stored in db.media, attached to the workout on save. */
  photoIds: string[];
  /** null = automatic (time since start). */
  durationSec: number | null;
  /** null = the workout's real start time. */
  startedAt: number | null;
  /** null = use the estimate. */
  manualCalories: number | null;
}

export const EMPTY_FINISH_DRAFT: FinishDraft = { photoIds: [], durationSec: null, startedAt: null, manualCalories: null };

/** The active workout as the store keeps (and persists) it. */
export type LiveWorkout = ActiveWorkout & {
  /**
   * The "Save Workout" screen's draft. Persisted with the workout so a reload (or iOS killing the app while
   * the camera is open) keeps the edits, and discarding the workout can delete its photos.
   */
  finishDraft?: FinishDraft | null;
  /**
   * Instances created by a "keep completed sets" variant switch -> the instance they split from. A split-off
   * card keeps its routine link (routineExerciseId), so this map is what tells it apart from a second
   * instance of the slot: "Update routine?" (lib/routines.ts planRoutineUpdate) keeps the slot on the
   * original machine with its full plan instead of shrinking it and appending the other machine.
   */
  variantSplits?: Record<string, string>;
};

export interface FinishMeta {
  name: string;
  notes?: string;
  startedAt: number;
  durationSec: number;
  photoIds: string[];
  calories: number | null;
  caloriesManual: boolean;
  bodyweightKg: number | null;
}

interface WorkoutStore {
  active: LiveWorkout | null;
  hydrated: boolean;
  hydrate(): Promise<void>;

  /** Replace any current workout with `w` (callers confirm with the user first if one is running). */
  start(w: ActiveWorkout): void;
  startEmpty(): ActiveWorkout;
  startFromRoutine(r: Routine): ActiveWorkout;
  /** "Repeat workout" from history. */
  startFromWorkout(w: Workout): ActiveWorkout;
  discard(): void;

  setName(name: string): void;
  setNotes(notes: string): void;
  setStartedAt(ms: number): void;

  addExercises(items: NewExerciseItem[], opts?: { superset?: boolean }): void;
  removeExercise(weId: string): void;
  replaceExercise(weId: string, exerciseId: string): void;
  /** Same movement on another machine/brand - see exerciseListOps.switchVariant. */
  switchVariant(weId: string, exerciseId: string, moveDone: boolean, newId?: string): void;
  reorderExercises(orderedWeIds: string[]): void;
  updateExercise(weId: string, patch: Partial<Omit<WorkoutExercise, 'id' | 'sets'>>): void;
  /** Put the given exercises in one superset (or pass a single id to remove it from its superset). */
  setSuperset(weIds: string[]): void;
  removeFromSuperset(weId: string): void;

  addSet(weId: string, partial?: Partial<SetEntry>): void;
  removeSet(weId: string, setId: string): void;
  updateSet(weId: string, setId: string, patch: Partial<SetEntry>): void;

  startRest(weId: string, setId: string, seconds: number): void;
  adjustRest(deltaSec: number): void;
  stopRest(): void;

  /**
   * Update the "Save Workout" draft of workout `workoutId`. Returns false (and changes nothing) when that
   * workout is no longer the active one - e.g. a photo that finished saving after the workout was discarded.
   */
  setFinishDraft(workoutId: string, fn: (d: FinishDraft) => Partial<FinishDraft>): boolean;

  /**
   * Save as a Workout and clear the active workout. Only completed sets are kept (empty cells take their
   * planned value; a set still missing a required value is dropped - see finalizeDoneSets). Throws when
   * nothing is left to save.
   */
  finish(meta: FinishMeta): Promise<Workout>;
}

// ------------------------------------------------------------------ builders

export function newSet(partial: Partial<SetEntry> = {}): SetEntry {
  return { id: uid(), type: 'normal', weightKg: null, reps: null, done: false, ...partial };
}

export function targetFromValues(s: {
  weightKg?: number | null;
  reps?: number | null;
  repsMax?: number | null;
  durationSec?: number | null;
  distanceM?: number | null;
}): SetTarget {
  return {
    weightKg: s.weightKg ?? null,
    reps: s.reps ?? null,
    repsMax: s.repsMax ?? null,
    durationSec: s.durationSec ?? null,
    distanceM: s.distanceM ?? null,
  };
}

/** Sets for an exercise taken from a routine: same set types, routine values become placeholders. */
export function setsFromRoutineExercise(re: RoutineExercise): SetEntry[] {
  return re.sets.map((s) => newSet({ type: s.type, target: targetFromValues(s) }));
}

/** Sets that mirror a previous session (values as placeholders). */
export function setsFromPrevious(prev: SetEntry[]): SetEntry[] {
  return prev.map((s) => newSet({ type: s.type, target: targetFromValues(s) }));
}

function exerciseFromItem(item: NewExerciseItem): WorkoutExercise {
  return {
    id: item.id ?? uid(),
    exerciseId: item.exerciseId,
    notes: item.notes,
    restSec: item.restSec ?? null,
    supersetId: item.supersetId ?? null,
    ...(item.routineExerciseId ? { routineExerciseId: item.routineExerciseId } : {}),
    sets: item.sets?.length ? item.sets : [newSet()],
  };
}

function blank(name: string, extra: Partial<ActiveWorkout> = {}): ActiveWorkout {
  return { id: uid(), name, startedAt: Date.now(), exercises: [], rest: null, routineId: null, ...extra };
}

/** A superset needs 2+ members; drop dangling single-member superset ids. */
export function cleanupSupersets(exercises: WorkoutExercise[]): WorkoutExercise[] {
  const counts = new Map<string, number>();
  for (const we of exercises) if (we.supersetId) counts.set(we.supersetId, (counts.get(we.supersetId) ?? 0) + 1);
  return exercises.map((we) => (we.supersetId && (counts.get(we.supersetId) ?? 0) < 2 ? { ...we, supersetId: null } : we));
}

// ------------------------------------------------------------------ set values

export type SetValues = Pick<SetEntry, 'weightKg' | 'reps' | 'durationSec' | 'distanceM'>;

/**
 * The values a set gets when it is ticked: what was typed, else the placeholder (target), else the
 * previous session's matching set. Only the fields the exercise type uses are filled.
 */
export function filledValues(set: SetEntry, prev: SetEntry | null | undefined, fields: TypeFields): SetValues {
  const t: SetTarget = set.target ?? {};
  const pick = <K extends keyof SetValues>(k: K, used: boolean): SetValues[K] => {
    if (set[k] != null) return set[k];
    if (!used) return set[k] ?? null;
    return (t[k as keyof SetTarget] as SetValues[K]) ?? prev?.[k] ?? null;
  };
  return {
    weightKg: pick('weightKg', fields.weight),
    reps: pick('reps', fields.reps),
    durationSec: pick('durationSec', fields.duration),
    distanceM: pick('distanceM', fields.distance),
  };
}

/** Error shown when a set can't be completed yet (null = fine). */
export function missingValueMessage(fields: TypeFields, v: Partial<SetValues>): string | null {
  if (fields.reps) return v.reps == null ? 'Enter reps first' : null;
  if (fields.distance && fields.duration) {
    return v.distanceM == null && v.durationSec == null ? 'Enter distance or time first' : null;
  }
  if (fields.duration) return v.durationSec == null ? 'Enter time first' : null;
  if (fields.distance) return v.distanceM == null ? 'Enter distance first' : null;
  return null;
}

/**
 * The save-time rule for ticked sets, shared by Finish and the saved-workout editor. Set cells stay editable
 * after a set is ticked, so a completed set can lose its value again: an empty cell takes its planned target
 * (what the faint placeholder shows), and a completed set still missing a required value is dropped
 * (`dropped` counts them). Undone sets are passed through untouched - completedExercises drops them.
 */
export function finalizeDoneSets(
  exercises: WorkoutExercise[],
  fieldsOf: (exerciseId: string) => TypeFields,
): { exercises: WorkoutExercise[]; dropped: number } {
  let dropped = 0;
  const out = exercises.map((we) => {
    const fields = fieldsOf(we.exerciseId);
    const sets = we.sets.flatMap((s) => {
      if (!s.done) return [s];
      const v = { ...s, ...filledValues(s, null, fields) };
      if (missingValueMessage(fields, v)) {
        dropped++;
        return [];
      }
      return [v];
    });
    return { ...we, sets };
  });
  return { exercises: out, dropped };
}

/**
 * What gets saved from a list of logged exercises: only completed sets (targets stripped), exercises
 * without completed sets dropped, single-member supersets cleaned up.
 */
export function completedExercises(exercises: WorkoutExercise[]): WorkoutExercise[] {
  const kept = exercises
    .map((we) => ({
      ...we,
      sets: we.sets.filter((s) => s.done).map(({ target: _t, ...s }) => ({ ...s, done: true })),
    }))
    .filter((we) => we.sets.length > 0);
  return cleanupSupersets(kept);
}

// ------------------------------------------------------------------ pure list operations

const mapEx = (list: WorkoutExercise[], weId: string, fn: (we: WorkoutExercise) => WorkoutExercise) =>
  list.map((we) => (we.id === weId ? fn(we) : we));

/** A planned weight belongs to one machine; reps, rep ranges, time and distance still apply on another. */
export const dropWeightTarget = (s: SetEntry): SetEntry => ({ ...s, target: s.target ? { ...s.target, weightKg: null } : null });

/** Immutable exercise/set operations shared by the live logger (store) and the saved-workout editor. */
export const exerciseListOps = {
  addExercises(list: WorkoutExercise[], items: NewExerciseItem[], opts?: { superset?: boolean }): WorkoutExercise[] {
    if (!items.length) return list;
    // "Add as Superset" puts every picked exercise in one new superset; otherwise routine picks keep their
    // routine's pairings (a group with only one member picked is dropped by cleanupSupersets).
    const forced = opts?.superset && items.length > 1 ? uid() : null;
    const added = items.map((it) => ({ ...exerciseFromItem(it), supersetId: forced ?? it.supersetId ?? null }));
    return cleanupSupersets([...list, ...added]);
  },
  removeExercise(list: WorkoutExercise[], weId: string): WorkoutExercise[] {
    return cleanupSupersets(list.filter((we) => we.id !== weId));
  },
  replaceExercise(list: WorkoutExercise[], weId: string, exerciseId: string): WorkoutExercise[] {
    return mapEx(list, weId, (we) => ({
      ...we, // keeps the routine slot link: Update routine puts the replacement in that slot
      exerciseId,
      // Planned values belonged to the old exercise; keep set count/types and anything already typed.
      sets: we.sets.map((s) => ({ ...s, target: null })),
    }));
  },
  /**
   * "Switch Machine / Brand Variant". With `moveDone` (or nothing done yet) the instance is re-pointed in
   * place. Otherwise it is split: the completed sets stay on the original machine (their history must not
   * move to the variant) and the remaining sets move to a new instance `newId` right after it, in the same
   * superset and routine slot (routineExerciseId). Either way the plan's reps/ranges/time/distance are kept
   * and only the weight target is dropped.
   * (Replace Exercise - a different movement - uses replaceExercise, which drops the whole plan.)
   */
  switchVariant(
    list: WorkoutExercise[],
    weId: string,
    exerciseId: string,
    moveDone: boolean,
    newId: string = uid(),
  ): WorkoutExercise[] {
    const idx = list.findIndex((we) => we.id === weId);
    const we = list[idx];
    if (!we || we.exerciseId === exerciseId) return list;
    const done = we.sets.filter((s) => s.done);
    if (moveDone || !done.length) {
      return mapEx(list, weId, (x) => ({ ...x, exerciseId, sets: x.sets.map(dropWeightTarget) }));
    }
    const todo = we.sets.filter((s) => !s.done);
    const last = done[done.length - 1];
    const moved: WorkoutExercise = {
      id: newId,
      exerciseId,
      restSec: we.restSec ?? null,
      supersetId: we.supersetId ?? null,
      ...(we.routineExerciseId ? { routineExerciseId: we.routineExerciseId } : {}),
      sets: (todo.length ? todo : [newSet({ type: 'normal', target: last.target ?? null })]).map(dropWeightTarget),
    };
    return [...list.slice(0, idx), { ...we, sets: done }, moved, ...list.slice(idx + 1)];
  },
  reorderExercises(list: WorkoutExercise[], ids: string[]): WorkoutExercise[] {
    const byId = new Map(list.map((we) => [we.id, we]));
    const ordered = ids.map((id) => byId.get(id)).filter(Boolean) as WorkoutExercise[];
    const rest = list.filter((we) => !ids.includes(we.id));
    return [...ordered, ...rest];
  },
  updateExercise(
    list: WorkoutExercise[],
    weId: string,
    patch: Partial<Omit<WorkoutExercise, 'id' | 'sets'>>,
  ): WorkoutExercise[] {
    return mapEx(list, weId, (we) => ({ ...we, ...patch }));
  },
  setSuperset(list: WorkoutExercise[], weIds: string[]): WorkoutExercise[] {
    if (weIds.length < 2) return list;
    // Join an existing superset if one of them already has one.
    const existing = list.find((we) => weIds.includes(we.id) && we.supersetId)?.supersetId;
    const sid = existing ?? uid();
    return cleanupSupersets(list.map((we) => (weIds.includes(we.id) ? { ...we, supersetId: sid } : we)));
  },
  removeFromSuperset(list: WorkoutExercise[], weId: string): WorkoutExercise[] {
    return cleanupSupersets(list.map((we) => (we.id === weId ? { ...we, supersetId: null } : we)));
  },
  addSet(list: WorkoutExercise[], weId: string, partial?: Partial<SetEntry>): WorkoutExercise[] {
    return mapEx(list, weId, (we) => {
      const last = we.sets[we.sets.length - 1];
      // New sets inherit the previous set's type (except failure/drop) and its placeholder.
      const type = partial?.type ?? (last && last.type === 'warmup' ? 'warmup' : 'normal');
      return { ...we, sets: [...we.sets, newSet({ type, target: last?.target ?? null, ...partial })] };
    });
  },
  removeSet(list: WorkoutExercise[], weId: string, setId: string): WorkoutExercise[] {
    return mapEx(list, weId, (we) => ({ ...we, sets: we.sets.filter((s) => s.id !== setId) }));
  },
  updateSet(list: WorkoutExercise[], weId: string, setId: string, patch: Partial<SetEntry>): WorkoutExercise[] {
    return mapEx(list, weId, (we) => ({ ...we, sets: we.sets.map((s) => (s.id === setId ? { ...s, ...patch } : s)) }));
  },
};

// ------------------------------------------------------------------ persistence

let writeChain: Promise<unknown> = Promise.resolve();
let lastPersistWarning = 0;
function persist(active: LiveWorkout | null) {
  writeChain = writeChain
    .then(async () => {
      if (active) await db.active.put({ id: 'current', workout: active });
      else await db.active.delete('current');
    })
    .catch((e) => {
      console.error('persist active workout failed', e);
      // Storage full / blocked: the workout still lives in memory, but would not survive closing the app.
      if (Date.now() - lastPersistWarning > 30_000) {
        lastPersistWarning = Date.now();
        toast("Couldn't save progress to this device. Keep the app open and finish the workout.", 'error', 5000);
      }
    });
}

/** Resolves once every queued write of the active workout has reached IndexedDB. */
export function flushActiveWorkout(): Promise<unknown> {
  return writeChain;
}

// ------------------------------------------------------------------ store

export const useWorkoutStore = create<WorkoutStore>((set, get) => {
  /** Apply an immutable update to the active workout and persist it. */
  const mutate = (fn: (w: LiveWorkout) => LiveWorkout) => {
    const cur = get().active;
    if (!cur) return;
    const next = fn(cur);
    if (next === cur) return;
    set({ active: next });
    persist(next);
  };
  /** Apply a list operation to the exercises. */
  const mutateList = (fn: (list: WorkoutExercise[]) => WorkoutExercise[]) =>
    mutate((w) => {
      const exercises = fn(w.exercises);
      return exercises === w.exercises ? w : { ...w, exercises };
    });
  const L = exerciseListOps;
  /** Photos added on the Save Workout screen of a workout that is being thrown away. */
  const dropDraftPhotos = (w: LiveWorkout | null) => {
    const ids = w?.finishDraft?.photoIds ?? [];
    if (ids.length) void deleteMedia(ids).catch(() => undefined);
  };

  return {
    active: null,
    hydrated: false,

    async hydrate() {
      if (get().hydrated) return;
      const rec = await db.active.get('current');
      // A workout started in this session before hydration finished wins over the stored one.
      set({ active: get().active ?? rec?.workout ?? null, hydrated: true });
    },

    start(w) {
      const prev = get().active;
      set({ active: w });
      persist(w);
      if (prev && prev.id !== w.id) dropDraftPhotos(prev);
    },
    startEmpty() {
      const w = blank(defaultWorkoutName());
      get().start(w);
      return w;
    },
    startFromRoutine(r) {
      const w = blank(r.name, {
        routineId: r.id,
        notes: r.notes,
        exercises: r.exercises.map((re) => ({
          id: uid(),
          exerciseId: re.exerciseId,
          notes: re.notes,
          restSec: re.restSec ?? null,
          supersetId: re.supersetId ?? null,
          routineExerciseId: re.id, // lets "Update routine?" find the slot even after a variant swap
          sets: re.sets.length ? setsFromRoutineExercise(re) : [newSet()],
        })),
      });
      get().start(w);
      return w;
    },
    startFromWorkout(src) {
      const w = blank(src.name, {
        routineId: src.routineId ?? null,
        exercises: src.exercises.map((we) => ({
          id: uid(),
          exerciseId: we.exerciseId,
          notes: we.notes,
          restSec: we.restSec ?? null,
          supersetId: we.supersetId ?? null,
          // Repeating a routine workout keeps its slot links (routineId is kept too).
          ...(we.routineExerciseId ? { routineExerciseId: we.routineExerciseId } : {}),
          sets: we.sets.length ? setsFromPrevious(we.sets) : [newSet()],
        })),
      });
      get().start(w);
      return w;
    },
    discard() {
      const prev = get().active;
      set({ active: null });
      persist(null);
      dropDraftPhotos(prev);
    },

    setName: (name) => mutate((w) => ({ ...w, name })),
    setNotes: (notes) => mutate((w) => ({ ...w, notes })),
    setStartedAt: (ms) => mutate((w) => ({ ...w, startedAt: ms })),

    addExercises: (items, opts) => mutateList((list) => L.addExercises(list, items, opts)),
    removeExercise: (weId) =>
      mutate((w) => ({
        ...w,
        exercises: L.removeExercise(w.exercises, weId),
        rest: w.rest?.workoutExerciseId === weId ? null : w.rest,
      })),
    replaceExercise: (weId, exerciseId) => mutateList((list) => L.replaceExercise(list, weId, exerciseId)),
    switchVariant: (weId, exerciseId, moveDone, newId = uid()) =>
      mutate((w) => {
        const exercises = L.switchVariant(w.exercises, weId, exerciseId, moveDone, newId);
        if (exercises === w.exercises) return w;
        const split = exercises.length > w.exercises.length;
        return split ? { ...w, exercises, variantSplits: { ...w.variantSplits, [newId]: weId } } : { ...w, exercises };
      }),
    reorderExercises: (ids) => mutateList((list) => L.reorderExercises(list, ids)),
    updateExercise: (weId, patch) => mutateList((list) => L.updateExercise(list, weId, patch)),
    setSuperset: (weIds) => mutateList((list) => L.setSuperset(list, weIds)),
    removeFromSuperset: (weId) => mutateList((list) => L.removeFromSuperset(list, weId)),

    addSet: (weId, partial) => mutateList((list) => L.addSet(list, weId, partial)),
    removeSet: (weId, setId) =>
      mutate((w) => ({
        ...w,
        exercises: L.removeSet(w.exercises, weId, setId),
        rest: w.rest?.setId === setId ? null : w.rest,
      })),
    updateSet: (weId, setId, patch) => mutateList((list) => L.updateSet(list, weId, setId, patch)),

    startRest: (weId, setId, seconds) =>
      mutate((w) =>
        seconds > 0
          ? { ...w, rest: { endsAt: Date.now() + seconds * 1000, totalSec: seconds, workoutExerciseId: weId, setId } }
          : { ...w, rest: null },
      ),
    adjustRest: (delta) =>
      mutate((w) => {
        if (!w.rest) return w;
        const endsAt = Math.max(Date.now(), w.rest.endsAt + delta * 1000);
        return { ...w, rest: { ...w.rest, endsAt, totalSec: Math.max(1, w.rest.totalSec + delta) } };
      }),
    stopRest: () => mutate((w) => (w.rest ? { ...w, rest: null } : w)),

    setFinishDraft(workoutId, fn) {
      if (get().active?.id !== workoutId) return false;
      mutate((w) => {
        const d: FinishDraft = { ...EMPTY_FINISH_DRAFT, ...w.finishDraft };
        return { ...w, finishDraft: { ...d, ...fn(d) } };
      });
      return true;
    },

    async finish(meta) {
      const typeOf = await loadTypeLookup();
      const a = get().active;
      if (!a) throw new Error('No active workout');
      // Same rule as the saved-workout editor: a ticked set whose value was cleared again is not saved.
      const exercises = completedExercises(finalizeDoneSets(a.exercises, (id) => typeFields(typeOf(id))).exercises);
      if (!exercises.length) throw new Error('No completed sets to save');
      const now = Date.now();
      const workout: Workout = {
        id: a.id,
        name: meta.name.trim() || a.name || defaultWorkoutName(new Date(meta.startedAt)),
        startedAt: meta.startedAt,
        endedAt: meta.startedAt + meta.durationSec * 1000,
        durationSec: meta.durationSec,
        notes: meta.notes?.trim() || undefined,
        routineId: a.routineId ?? null,
        exercises,
        exerciseIds: [],
        photoIds: meta.photoIds,
        bodyweightKg: meta.bodyweightKg,
        calories: meta.calories,
        caloriesManual: meta.caloriesManual,
        volumeKg: 0,
        setCount: 0,
        prs: [],
        createdAt: now,
        updatedAt: now,
      };
      await saveWorkout(workout);
      if (a.routineId) await db.routines.update(a.routineId, { lastPerformedAt: workout.startedAt });
      set({ active: null });
      persist(null);
      await writeChain;
      return (await db.workouts.get(workout.id)) ?? workout;
    },
  };
});

/** Convenience hook for the active workout. */
export const useActiveWorkout = () => useWorkoutStore((s) => s.active);
