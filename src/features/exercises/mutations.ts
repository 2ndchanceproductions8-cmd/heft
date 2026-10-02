import { db } from '../../db';
import { deriveWorkout, loadTypeLookup, recomputeAllPRs } from '../../lib/workouts';

/**
 * After a logged custom exercise's type changed: the stored totals of every workout containing it (volume,
 * set count) depend on the type, so re-derive them, then re-walk the PR history.
 */
export async function refreshHistoryAfterTypeChange(exerciseId: string): Promise<void> {
  const typeOf = await loadTypeLookup();
  await db.transaction('rw', db.workouts, async () => {
    const logged = await db.workouts.where('exerciseIds').equals(exerciseId).toArray();
    if (logged.length) await db.workouts.bulkPut(logged.map((w) => deriveWorkout(w, typeOf)));
  });
  await recomputeAllPRs();
}
