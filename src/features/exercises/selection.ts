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
