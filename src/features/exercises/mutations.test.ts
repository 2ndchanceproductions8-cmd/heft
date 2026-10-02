import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../db';
import type { Workout } from '../../types';
import { createCustomExercise, updateCustomExercise } from '../../lib/exercises';
import { refreshHistoryAfterTypeChange } from './mutations';

const workout = (id: string, startedAt: number, exerciseId: string, weightKg: number, reps: number): Workout => ({
  id,
  name: id,
  startedAt,
  endedAt: startedAt + 1,
  durationSec: 60,
  exercises: [{ id: `we-${id}`, exerciseId, sets: [{ id: `s-${id}`, type: 'normal', weightKg, reps, done: true }] }],
  exerciseIds: [exerciseId],
  photoIds: [],
  volumeKg: 0,
  setCount: 1,
  prs: [],
  createdAt: startedAt,
  updatedAt: startedAt,
});

describe('refreshHistoryAfterTypeChange', () => {
  beforeEach(async () => {
    await db.workouts.clear();
    await db.customExercises.clear();
  });

  it('re-derives volume and PRs of every workout that logged the exercise', async () => {
    const id = await createCustomExercise({ name: 'Belt Squat', equipment: 'machine', primary: 'quadriceps', type: 'bodyweight_reps' });
    await db.workouts.bulkPut([workout('w1', 1000, id, 40, 10), workout('w2', 2000, id, 50, 10)]);

    await updateCustomExercise(id, { type: 'weight_reps' });
    await refreshHistoryAfterTypeChange(id);

    const w1 = await db.workouts.get('w1');
    const w2 = await db.workouts.get('w2');
    expect(w1?.volumeKg).toBe(400);
    expect(w2?.volumeKg).toBe(500);
    // 50 kg beats 40 kg → w2 now holds the heaviest-weight PR for the re-typed exercise
    expect(w2?.prs.some((p) => p.kind === 'heaviest_weight' && p.value === 50)).toBe(true);
  });
});
