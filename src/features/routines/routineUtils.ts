import type { Routine, RoutineExercise, RoutineSet, SetEntry, SetType, Settings, SideValues, Workout } from '../../types';
import { isSideSet, previousInstanceSets } from '../../lib/calc';
import { setNumberLabels, type TypeFields } from '../../lib/exerciseMeta';
import { uid } from '../../lib/ids';
import { copySides } from '../../lib/sides';
import type { PickedExercise } from '../../lib/workoutStore';

/*
 * Pure helpers for the routines feature (no React, no Dexie) so they are cheap to unit test.
 */

// ---------------------------------------------------------------- reps / rep ranges

/**
 * Parse what the user typed into a REPS cell: a single number ("8") or a range ("8-12").
 * Any run of non-digits counts as the range separator, because phone keypads differ: iOS's numeric pad
 * has no "-", so "8.12", "8,12" and "8 12" are accepted too. A reversed range is swapped ("12-8" = 8-12);
 * equal bounds collapse to a single number. A trailing separator ("8-" while typing) is just 8.
 */
export function parseRepsInput(text: string): { reps: number | null; repsMax: number | null } {
  const nums = (text.match(/\d+/g) ?? []).slice(0, 2).map((n) => Math.min(9999, parseInt(n, 10)));
  if (!nums.length) return { reps: null, repsMax: null };
  if (nums.length === 1) return { reps: nums[0], repsMax: null };
  const lo = Math.min(nums[0], nums[1]);
  const hi = Math.max(nums[0], nums[1]);
  return { reps: lo, repsMax: hi > lo ? hi : null };
}

/**
 * Clean what is being typed into a REPS cell: digits plus at most ONE "-" separator. The keys a phone keypad
 * offers instead of "-" (".", ",", space, en/em dash) are shown as "-" right away, so "8.12" on the iPhone
 * decimal pad reads "8-12" while typing.
 */
export function normalizeRepsText(raw: string): string {
  let t = raw.replace(/[^\d\-–—.,\s]/g, '').replace(/[\-–—.,\s]+/g, '-').replace(/^-+/, '');
  // A range has two numbers: a second separator (and anything after it) is ignored.
  const second = t.indexOf('-', t.indexOf('-') + 1);
  if (t.includes('-') && second > 0) t = t.slice(0, second);
  return t.slice(0, 9);
}

/** "8", "8-12" or "" (no target). */
export function formatReps(reps: number | null | undefined, repsMax: number | null | undefined): string {
  if (reps == null) return repsMax != null ? String(repsMax) : '';
  return repsMax != null && repsMax > reps ? `${reps}-${repsMax}` : String(reps);
}

// ---------------------------------------------------------------- set badges

/**
 * Badge text for each set - the app-wide numbering rule (lib/exerciseMeta setNumberLabels), so "set 3" in a
 * routine is "set 3" when you run it: warm-ups show "W" and are not counted; failure / drop sets show "F" /
 * "D" in place of their number.
 */
export function setBadges(sets: readonly { type: SetType }[]): string[] {
  return setNumberLabels(sets);
}

/** Tailwind classes for a set badge (semantic colors only). */
export const SET_BADGE_CLASS: Record<SetType, string> = {
  normal: 'bg-surface-2 text-fg',
  warmup: 'bg-warn-soft text-warn',
  failure: 'bg-danger-soft text-danger',
  drop: 'bg-drop-soft text-drop',
};

// ---------------------------------------------------------------- previews / labels

/** "Bench Press, Squat, Row & 2 more" */
export function exercisePreview(names: string[], max = 3): string {
  if (!names.length) return 'No exercises yet';
  if (names.length <= max + 1) {
    // Never write "& 1 more" — just show the last name instead.
    return names.join(', ');
  }
  return `${names.slice(0, max).join(', ')} & ${names.length - max} more`;
}

// ---------------------------------------------------------------- supersets

/** Superset id → letter index (A = 0) in order of first appearance. */
export function supersetIndex(exercises: { supersetId?: string | null }[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const e of exercises) if (e.supersetId && !map.has(e.supersetId)) map.set(e.supersetId, map.size);
  return map;
}

/** A superset needs 2+ members; drop dangling single-member superset ids. */
export function cleanupSupersets<T extends { supersetId?: string | null }>(list: T[]): T[] {
  const counts = new Map<string, number>();
  for (const e of list) if (e.supersetId) counts.set(e.supersetId, (counts.get(e.supersetId) ?? 0) + 1);
  return list.map((e) => (e.supersetId && (counts.get(e.supersetId) ?? 0) < 2 ? { ...e, supersetId: null } : e));
}

/** Put `aId` and `bId` in the same superset (joining an existing one if either already has one). */
export function joinSuperset(list: RoutineExercise[], aId: string, bId: string): RoutineExercise[] {
  const a = list.find((e) => e.id === aId);
  const b = list.find((e) => e.id === bId);
  if (!a || !b || a.id === b.id) return list;
  const sid = b.supersetId ?? a.supersetId ?? uid();
  return cleanupSupersets(list.map((e) => (e.id === aId || e.id === bId ? { ...e, supersetId: sid } : e)));
}

export function leaveSuperset(list: RoutineExercise[], id: string): RoutineExercise[] {
  return cleanupSupersets(list.map((e) => (e.id === id ? { ...e, supersetId: null } : e)));
}

/** Semantic color pairs for superset markers (complete class strings so Tailwind sees them). */
export const SUPERSET_STYLES = [
  { bar: 'bg-drop', text: 'text-drop', soft: 'bg-drop-soft' },
  { bar: 'bg-warn', text: 'text-warn', soft: 'bg-warn-soft' },
  { bar: 'bg-success', text: 'text-success', soft: 'bg-success-soft' },
  { bar: 'bg-gold', text: 'text-gold', soft: 'bg-gold-soft' },
  { bar: 'bg-accent', text: 'text-accent', soft: 'bg-accent-soft' },
  { bar: 'bg-danger', text: 'text-danger', soft: 'bg-danger-soft' },
] as const;

export function supersetStyle(index: number) {
  return SUPERSET_STYLES[index % SUPERSET_STYLES.length];
}

export const supersetLetter = (index: number) => String.fromCharCode(65 + (index % 26));

// ---------------------------------------------------------------- set builders

export function blankRoutineSet(partial: Partial<RoutineSet> = {}): RoutineSet {
  return {
    id: uid(),
    type: 'normal',
    weightKg: null,
    reps: null,
    repsMax: null,
    durationSec: null,
    distanceM: null,
    ...partial,
  };
}

/** A new set copying the last one's values (warm-ups stay warm-ups; failure/drop become normal). */
export function nextSet(sets: RoutineSet[]): RoutineSet {
  const last = sets[sets.length - 1];
  if (!last) return blankRoutineSet();
  return blankRoutineSet({
    type: last.type === 'warmup' ? 'warmup' : 'normal',
    weightKg: last.weightKg ?? null,
    reps: last.reps ?? null,
    repsMax: last.repsMax ?? null,
    durationSec: last.durationSec ?? null,
    distanceM: last.distanceM ?? null,
    ...(last.sides ? { sides: copySides(last) } : {}),
  });
}

/**
 * Clear the values an exercise type has no column for (e.g. reps after replacing a lifting exercise with a
 * timed one), so hidden leftovers never turn into targets when the routine is started.
 */
export function fitSetsToFields(
  sets: RoutineSet[],
  f: { weight: boolean; reps: boolean; duration: boolean; distance: boolean },
): RoutineSet[] {
  const fit = <T extends SideValues>(v: T): T => ({
    ...v,
    weightKg: f.weight ? v.weightKg ?? null : null,
    reps: f.reps ? v.reps ?? null : null,
    repsMax: f.reps ? v.repsMax ?? null : null,
    durationSec: f.duration ? v.durationSec ?? null : null,
    distanceM: f.distance ? v.distanceM ?? null : null,
  });
  return sets.map((s) => ({ ...fit(s), ...(s.sides ? { sides: { left: fit(s.sides.left), right: fit(s.sides.right) } } : {}) }));
}

/** Routine sets mirroring a previous workout session (types and values). */
export function routineSetsFromPrevious(prev: SetEntry[]): RoutineSet[] {
  return prev.map((s) =>
    blankRoutineSet({
      type: s.type,
      weightKg: s.weightKg ?? null,
      reps: s.reps ?? null,
      durationSec: s.durationSec ?? null,
      distanceM: s.distanceM ?? null,
      ...(isSideSet(s) ? { sides: copySides(s) } : {}),
    }),
  );
}

/** Deep copy of a routine exercise with fresh ids (used when picking "from a routine"). */
export function copyRoutineExercise(re: RoutineExercise): RoutineExercise {
  return {
    id: uid(),
    exerciseId: re.exerciseId,
    notes: re.notes,
    restSec: re.restSec ?? null,
    supersetId: null,
    sets: re.sets.map((s) => ({ ...s, id: uid(), ...(s.sides ? { sides: copySides(s) } : {}) })),
  };
}

/**
 * A routine exercise picked "from a routine" as `exerciseId`: a fresh copy of the source (set count, types,
 * reps, ranges, time, distance, rest, notes). When the picked exercise is not the source's - the user created
 * or switched to a gym/brand variant in the picker - the planned weights are cleared (they belong to the other
 * machine), and with `fields` values the picked exercise's type has no column for are dropped.
 */
export function routineExerciseFromSource(src: RoutineExercise, exerciseId: string, fields?: TypeFields): RoutineExercise {
  const copy = { ...copyRoutineExercise(src), exerciseId, notes: src.notes ?? '' };
  if (exerciseId === src.exerciseId) return copy;
  const sets = copy.sets.map((s) => ({
    ...s,
    weightKg: null,
    ...(s.sides ? { sides: { left: { ...s.sides.left, weightKg: null }, right: { ...s.sides.right, weightKg: null } } } : {}),
  }));
  return { ...copy, sets: fields ? fitSetsToFields(sets, fields) : sets };
}

/**
 * The routine exercises an "Add Exercises" pick in the routine editor appends:
 * - routine picks copy their source exercise (routineExerciseFromSource) and keep that routine's supersets
 *   under fresh ids for this batch (a group with only one member picked is dropped);
 * - plain picks get the previous session of that exercise INSTANCE (the n-th Bench in this routine mirrors
 *   last time's n-th Bench block, like the logger), else 3 empty sets;
 * - "Add as Superset" (`superset`, 2+ picks) puts the whole batch in one new superset instead.
 */
export function routineExercisesFromPicks(
  picked: PickedExercise[],
  opts: {
    /** Source routines of "from routine" picks, by id. */
    sources: Map<string, Routine>;
    /** Exercises already in the routine being edited (for the instance count). */
    existing: { exerciseId: string }[];
    /** Workout history, newest first. */
    history: Workout[];
    previousMode: Settings['previousValues'];
    /** The routine being edited (for "same routine" previous values). */
    routineId: string | null;
    superset: boolean;
    fieldsOf?: (exerciseId: string) => TypeFields | undefined;
  },
): RoutineExercise[] {
  const counts = new Map<string, number>();
  for (const e of opts.existing) counts.set(e.exerciseId, (counts.get(e.exerciseId) ?? 0) + 1);
  const ssMap = new Map<string, string>();
  const added = picked.map((p): RoutineExercise => {
    const occurrence = counts.get(p.exerciseId) ?? 0;
    counts.set(p.exerciseId, occurrence + 1);
    const rid = p.fromRoutine?.routineId;
    const src = rid ? opts.sources.get(rid)?.exercises.find((e) => e.id === p.fromRoutine!.routineExerciseId) : undefined;
    if (rid && src) {
      const re = routineExerciseFromSource(src, p.exerciseId, opts.fieldsOf?.(p.exerciseId));
      if (!src.supersetId) return re;
      const k = `${rid}:${src.supersetId}`; // keyed by routine too: duplicated routines may share ids
      if (!ssMap.has(k)) ssMap.set(k, uid());
      return { ...re, supersetId: ssMap.get(k)! };
    }
    const prev = previousInstanceSets(opts.history, p.exerciseId, {
      mode: opts.previousMode,
      routineId: opts.routineId,
      occurrence,
    });
    return newEditorExercise(p.exerciseId, prev?.length ? routineSetsFromPrevious(prev) : Array.from({ length: 3 }, () => blankRoutineSet()));
  });
  if (opts.superset && added.length > 1) {
    const sid = uid();
    return added.map((e) => ({ ...e, supersetId: sid }));
  }
  return cleanupSupersets(added);
}

export function newEditorExercise(exerciseId: string, sets: RoutineSet[]): RoutineExercise {
  return { id: uid(), exerciseId, notes: '', restSec: null, supersetId: null, sets };
}

/** Total planned sets in a routine. */
export function routineSetCount(r: { exercises: { sets: unknown[] }[] }): number {
  return r.exercises.reduce((n, e) => n + e.sets.length, 0);
}

// ---------------------------------------------------------------- ordering

/**
 * Global routine order after reordering ONE folder group. `groups` are the routine ids per folder in display
 * order; the group `key` gets `orderedIds`. Returns the flat list whose index becomes each routine's `order`.
 */
export function flattenGroupOrder(
  groups: { key: string; ids: string[] }[],
  key: string,
  orderedIds: string[],
): string[] {
  return groups.flatMap((g) => (g.key === key ? orderedIds : g.ids));
}

/** Move an item inside an array (returns a new array). */
export function moveItem<T>(arr: T[], from: number, to: number): T[] {
  const next = arr.slice();
  if (from < 0 || from >= next.length || to < 0 || to >= next.length) return next;
  const [it] = next.splice(from, 1);
  next.splice(to, 0, it);
  return next;
}
