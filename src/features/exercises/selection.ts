import type { PickedExercise } from '../../lib/workoutStore';

/** One selected row in the Add-Exercise picker. `key` distinguishes a library pick from a routine pick. */
export interface PickerSelection {
  key: string;
  pick: PickedExercise;
}

export const exKey = (id: string) => `ex:${id}`;
export const rtKey = (routineId: string, routineExerciseId: string) => `rt:${routineId}:${routineExerciseId}`;

/**
 * Select a just-created exercise. When it is a machine/brand variant of `replacesId`, it takes the place of
 * the first selected row of that base exercise (library or routine pick) and any other rows of the base are
 * dropped, so the order the user built is kept. If the base was picked from a routine, the variant keeps
 * that routine link (sets, reps, rest, notes) under its own `ex:` key, so it shows as checked in the library
 * search and can't be added twice. Otherwise it is appended.
 */
export function selectCreated(cur: PickerSelection[], id: string, replacesId?: string): PickerSelection[] {
  const key = exKey(id);
  const rest = cur.filter((s) => s.key !== key);
  const at = replacesId ? rest.findIndex((s) => s.pick.exerciseId === replacesId) : -1;
  if (at < 0) return [...rest, { key, pick: { exerciseId: id } }];
  const fromRoutine = rest.find((s) => s.pick.exerciseId === replacesId && s.pick.fromRoutine)?.pick.fromRoutine ?? null;
  const item: PickerSelection = { key, pick: fromRoutine ? { exerciseId: id, fromRoutine } : { exerciseId: id } };
  return [...rest.slice(0, at), item, ...rest.slice(at + 1).filter((s) => s.pick.exerciseId !== replacesId)];
}

/**
 * The routine the picker's Routines tab shows while browsing (no search): the one the user tapped, else the first
 * routine that isn't the one this workout came from (adding biceps to a triceps day means looking at another
 * routine), else the first. null when there are none.
 */
export function browseRoutineId(
  routineIds: readonly string[],
  picked: string | null | undefined,
  current: string | null | undefined,
): string | null {
  if (picked && routineIds.includes(picked)) return picked;
  return routineIds.find((id) => id !== current) ?? routineIds[0] ?? null;
}
