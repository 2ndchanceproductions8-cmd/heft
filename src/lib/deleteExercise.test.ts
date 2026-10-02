import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db';
import { buildExerciseIndex, createCustomExercise, createVariant, deleteCustomExercise, exerciseInUse, exerciseUsage, variantFamily } from './exercises';

async function index() {
  return buildExerciseIndex(await db.customExercises.toArray(), await db.overrides.toArray());
}

describe('deleteCustomExercise', () => {
  beforeEach(async () => {
    await Promise.all([db.workouts.clear(), db.routines.clear(), db.active.clear(), db.customExercises.clear(), db.media.clear()]);
  });

  it('hard-deletes an unused custom exercise and its photos', async () => {
    await db.media.put({ id: 'p1', blob: new Blob(['x']), type: 'image/jpeg', createdAt: 0 });
    const id = await createCustomExercise({ name: 'Belt Squat', equipment: 'machine', primary: 'quadriceps', type: 'weight_reps', photoIds: ['p1'] });
    expect(await exerciseUsage(id)).toEqual({ workouts: 0, routines: 0, activeWorkout: false, variants: 0 });
    expect(await deleteCustomExercise(id)).toBe('deleted');
    expect(await db.customExercises.get(id)).toBeUndefined();
    expect(await db.media.get('p1')).toBeUndefined();
  });

  it('archives an exercise that is in the workout in progress', async () => {
    const id = await createCustomExercise({ name: 'Plank Hold', equipment: 'bodyweight', primary: 'abdominals', type: 'duration' });
    await db.active.put({
      id: 'current',
      workout: {
        id: 'w1',
        name: 'Morning',
        startedAt: Date.now(),
        exercises: [{ id: 'we1', exerciseId: id, sets: [{ id: 's1', type: 'normal', durationSec: 60, done: true }] }],
      },
    });
    const usage = await exerciseUsage(id);
    expect(usage).toMatchObject({ activeWorkout: true, workouts: 0 });
    expect(exerciseInUse(usage)).toBe(true);
    expect(await deleteCustomExercise(id)).toBe('archived');
    const rec = await db.customExercises.get(id);
    expect(rec?.archived).toBe(true);
    // Still resolves (name, type) for the logger card and the saved workout.
    const ex = (await index()).get(id);
    expect(ex.missing).toBeFalsy();
    expect(ex.type).toBe('duration');
  });

  it('archives a base exercise that has variants, keeping the family and inherited pictures together', async () => {
    await db.media.put({ id: 'p1', blob: new Blob(['x']), type: 'image/jpeg', createdAt: 0 });
    const baseId = await createCustomExercise({
      name: 'Hack Squat',
      equipment: 'machine',
      primary: 'quadriceps',
      type: 'weight_reps',
      photoIds: ['p1'],
      instructions: ['Sit back into the pad.'],
    });
    const base = (await index()).get(baseId);
    const a = await createVariant(base, 'Gym A');
    const b = await createVariant(base, 'Gym B');

    expect((await exerciseUsage(baseId)).variants).toBe(2);
    expect(await deleteCustomExercise(baseId)).toBe('archived');
    expect(await db.media.get('p1')).toBeDefined();

    const idx = await index();
    expect(idx.list.some((e) => e.id === baseId)).toBe(false); // hidden from the library
    const va = idx.get(a);
    expect(va.photoIds).toEqual(['p1']);
    expect(va.instructions).toEqual(['Sit back into the pad.']);
    expect(va.aliases).toContain('Hack Squat');
    const fam = variantFamily(idx, a);
    expect(fam[0].id).toBe(baseId);
    expect(fam.map((e) => e.id).sort()).toEqual([baseId, a, b].sort());
  });

  it('still archives when only an archived variant points at it', async () => {
    const baseId = await createCustomExercise({ name: 'Row', equipment: 'machine', primary: 'lats', type: 'weight_reps' });
    const v = await createVariant((await index()).get(baseId), 'Old Gym');
    await db.customExercises.update(v, { archived: true });
    expect(await deleteCustomExercise(baseId)).toBe('archived');
  });
});
