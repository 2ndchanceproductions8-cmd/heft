import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../db';
import type { Media, Routine, WorkoutExercise } from '../../types';
import { planRoutineUpdate, updateRoutineFromWorkout } from '../../lib/routines';
import {
  EMPTY_FINISH_DRAFT,
  completedExercises,
  exerciseListOps as L,
  flushActiveWorkout,
  newSet,
  useWorkoutStore,
  type FinishMeta,
} from '../../lib/workoutStore';
import { sweepOrphanMedia } from './mediaSweep';

/* Store-level fixes of the workout logger (the pure helpers are covered in logic.test.ts). */

const BENCH = 'Barbell_Bench_Press_-_Medium_Grip'; // weight_reps
const PULLDOWN = 'Wide-Grip_Lat_Pulldown'; // weight_reps
const HAMMER = 'c_hammer'; // stands in for a gym/brand variant of the pulldown

const store = () => useWorkoutStore.getState();

const meta = (partial: Partial<FinishMeta> = {}): FinishMeta => ({
  name: 'Test',
  startedAt: Date.now() - 3600_000,
  durationSec: 3600,
  photoIds: [],
  calories: 300,
  caloriesManual: false,
  bodyweightKg: 80,
  ...partial,
});

const media = (id: string, createdAt: number): Media => ({ id, blob: 'jpeg' as unknown as Blob, type: 'image/jpeg', createdAt });

beforeEach(async () => {
  useWorkoutStore.setState({ active: null, hydrated: true });
  await flushActiveWorkout();
  await Promise.all(db.tables.map((t) => t.clear()));
});

describe('switching machine/brand variant mid-exercise', () => {
  /** Back Day: Lat Pulldown 3 x 8-12 @ 60 kg, two sets done, in a superset with bench. */
  const backDay = (): WorkoutExercise[] => [
    {
      id: 'pull',
      exerciseId: PULLDOWN,
      restSec: 90,
      supersetId: 'ss',
      notes: 'seat 4',
      sets: [
        newSet({ weightKg: 60, reps: 10, done: true, target: { weightKg: 60, reps: 8, repsMax: 12 } }),
        newSet({ weightKg: 60, reps: 9, done: true, target: { weightKg: 60, reps: 8, repsMax: 12 } }),
        newSet({ target: { weightKg: 60, reps: 8, repsMax: 12 } }),
      ],
    },
    { id: 'bench', exerciseId: BENCH, supersetId: 'ss', sets: [newSet()] },
  ];

  it('keeps completed sets on the original machine and moves the rest to a new card right after it', () => {
    const list = backDay();
    const out = L.switchVariant(list, 'pull', HAMMER, false, 'new');
    expect(out.map((e) => e.id)).toEqual(['pull', 'new', 'bench']);
    const [orig, moved] = out;
    expect(orig.exerciseId).toBe(PULLDOWN);
    expect(orig.sets).toEqual(list[0].sets.slice(0, 2));
    expect(moved).toMatchObject({ exerciseId: HAMMER, supersetId: 'ss', restSec: 90 });
    expect(moved.notes).toBeUndefined();
    expect(moved.sets.map((s) => s.id)).toEqual([list[0].sets[2].id]);
    // The rep range still applies on the other machine; the planned weight does not.
    expect(moved.sets[0].target).toMatchObject({ reps: 8, repsMax: 12, weightKg: null });

    // Saved as two exercises: the history of each machine stays its own.
    const saved = completedExercises(
      out.map((e) => (e.id === 'new' ? { ...e, sets: e.sets.map((s) => ({ ...s, weightKg: 45, reps: 10, done: true })) } : e)),
    );
    expect(saved.map((e) => [e.exerciseId, e.sets.length])).toEqual([
      [PULLDOWN, 2],
      [HAMMER, 1],
    ]);
  });

  it('with every set done, the new card gets one fresh set with the last plan (minus weight)', () => {
    const list = backDay();
    list[0].sets = list[0].sets.slice(0, 2);
    const out = L.switchVariant(list, 'pull', HAMMER, false, 'new');
    expect(out[1].sets).toHaveLength(1);
    expect(out[1].sets[0]).toMatchObject({ done: false, weightKg: null, reps: null });
    expect(out[1].sets[0].target).toMatchObject({ reps: 8, repsMax: 12, weightKg: null });
  });

  it('"move all sets" (or nothing done yet) re-points the card in place and keeps the rep ranges', () => {
    const moved = L.switchVariant(backDay(), 'pull', HAMMER, true, 'new');
    expect(moved.map((e) => e.id)).toEqual(['pull', 'bench']);
    expect(moved[0].exerciseId).toBe(HAMMER);
    expect(moved[0].sets).toHaveLength(3);
    for (const s of moved[0].sets) expect(s.target).toMatchObject({ reps: 8, repsMax: 12, weightKg: null });

    const fresh = backDay();
    fresh[0].sets = fresh[0].sets.map((s) => ({ ...s, done: false }));
    const out = L.switchVariant(fresh, 'pull', HAMMER, false, 'new');
    expect(out).toHaveLength(2);
    expect(out[0].exerciseId).toBe(HAMMER);
    // Switching to the same exercise is a no-op.
    expect(L.switchVariant(fresh, 'pull', PULLDOWN, false)).toBe(fresh);
  });

  it('the store remembers which card was split off (for "Update routine?")', () => {
    store().start({ id: 'w', name: 'Back', startedAt: Date.now(), exercises: backDay(), rest: null });
    store().switchVariant('pull', HAMMER, false, 'new');
    expect(store().active?.variantSplits).toEqual({ new: 'pull' });
    store().switchVariant('new', PULLDOWN, true, 'other');
    expect(store().active?.variantSplits).toEqual({ new: 'pull' });
  });
});

describe('finish()', () => {
  it('drops a ticked set whose reps were cleared afterwards and fills empty cells from the plan', async () => {
    store().startEmpty();
    store().addExercises([{ exerciseId: BENCH, sets: [newSet(), newSet(), newSet({ target: { weightKg: 80, reps: 8 } })] }]);
    const we = store().active!.exercises[0];
    const [a, b, c] = we.sets;
    store().updateSet(we.id, a.id, { weightKg: 60, reps: 5, done: true });
    store().updateSet(we.id, b.id, { weightKg: 60, reps: 5, done: true });
    store().updateSet(we.id, b.id, { reps: null }); // cleared after ticking
    store().updateSet(we.id, c.id, { done: true }); // ticked, then both cells emptied: takes the plan

    const saved = await store().finish(meta());
    expect(saved.exercises[0].sets.map((s) => s.id)).toEqual([a.id, c.id]);
    expect(saved.exercises[0].sets[1]).toMatchObject({ weightKg: 80, reps: 8 });
    expect(saved.setCount).toBe(2);
    expect(saved.volumeKg).toBe(60 * 5 + 80 * 8);
  });

  it('refuses to save a workout left without a valid set (the workout stays active)', async () => {
    store().startEmpty();
    store().addExercises([{ exerciseId: BENCH }]);
    const we = store().active!.exercises[0];
    store().updateSet(we.id, we.sets[0].id, { weightKg: 60, reps: null, done: true });
    await expect(store().finish(meta())).rejects.toThrow();
    expect(store().active).not.toBeNull();
    expect(await db.workouts.count()).toBe(0);
  });
});

describe('Save Workout draft', () => {
  it('is persisted with the active workout and survives a reload', async () => {
    const w = store().startEmpty();
    expect(store().setFinishDraft(w.id, () => ({ manualCalories: 512, durationSec: 2700 }))).toBe(true);
    expect(store().setFinishDraft(w.id, (d) => ({ photoIds: [...d.photoIds, 'p1'] }))).toBe(true);
    await flushActiveWorkout();

    useWorkoutStore.setState({ active: null, hydrated: false });
    await store().hydrate();
    expect(store().active?.finishDraft).toEqual({ ...EMPTY_FINISH_DRAFT, photoIds: ['p1'], manualCalories: 512, durationSec: 2700 });
  });

  it('does not attach to another (or no) workout', () => {
    store().startEmpty();
    expect(store().setFinishDraft('someone-else', () => ({ photoIds: ['p1'] }))).toBe(false);
    expect(store().active?.finishDraft ?? null).toBeNull();
  });

  it('discarding the workout (or starting another) deletes its draft photos', async () => {
    await db.media.bulkPut([media('p1', Date.now()), media('p2', Date.now()), media('keep', Date.now())]);
    const w1 = store().startEmpty();
    store().setFinishDraft(w1.id, () => ({ photoIds: ['p1'] }));
    store().startEmpty(); // replaces w1
    await vi.waitFor(async () => expect(await db.media.get('p1')).toBeUndefined());

    const w2 = store().active!;
    store().setFinishDraft(w2.id, () => ({ photoIds: ['p2'] }));
    store().discard();
    await vi.waitFor(async () => expect(await db.media.get('p2')).toBeUndefined());
    expect(await db.media.get('keep')).toBeDefined();
  });

  it('finish() moves the photos to the saved workout instead of deleting them', async () => {
    await db.media.put(media('p1', Date.now()));
    const w = store().startEmpty();
    store().addExercises([{ exerciseId: BENCH }]);
    const we = store().active!.exercises[0];
    store().updateSet(we.id, we.sets[0].id, { weightKg: 60, reps: 5, done: true });
    store().setFinishDraft(w.id, () => ({ photoIds: ['p1'] }));
    const saved = await store().finish(meta({ photoIds: ['p1'] }));
    expect(saved.photoIds).toEqual(['p1']);
    expect('finishDraft' in saved).toBe(false);
    expect(await db.media.get('p1')).toBeDefined();
  });
});

describe('orphaned photo sweep', () => {
  it('deletes only old photos that nothing refers to', async () => {
    const now = Date.now();
    const day = 86400_000;
    await db.media.bulkPut([
      media('old-orphan', now - 3 * day),
      media('old-workout', now - 3 * day),
      media('old-measurement', now - 3 * day),
      media('old-draft', now - 3 * day),
      media('new-orphan', now),
    ]);
    await db.workouts.put({
      id: 'w',
      name: 'W',
      startedAt: 1,
      endedAt: 2,
      durationSec: 1,
      exercises: [],
      exerciseIds: [],
      photoIds: ['old-workout'],
      volumeKg: 0,
      setCount: 0,
      prs: [],
      createdAt: 1,
      updatedAt: 1,
    });
    await db.measurements.put({ id: 'm', date: 1, photoIds: ['old-measurement'] });
    store().start({ id: 'a', name: 'A', startedAt: now, exercises: [], rest: null });
    store().setFinishDraft('a', () => ({ photoIds: ['old-draft'] }));
    await flushActiveWorkout();

    const removed = await sweepOrphanMedia({ before: now - day });
    expect(removed).toBe(1);
    const left = (await db.media.toCollection().primaryKeys()).sort();
    expect(left).toEqual(['new-orphan', 'old-draft', 'old-measurement', 'old-workout']);
  });
});

describe('routine supersets through the store', () => {
  it('addExercises keeps per-item superset groups and cleans up single members', () => {
    store().startEmpty();
    store().addExercises([
      { exerciseId: BENCH, supersetId: 'g1' },
      { exerciseId: PULLDOWN, supersetId: 'g1' },
      { exerciseId: HAMMER, supersetId: 'g2' },
    ]);
    expect(store().active!.exercises.map((e) => e.supersetId ?? null)).toEqual(['g1', 'g1', null]);
  });
});

describe('routine slot link (routineExerciseId)', () => {
  const routine: Routine = {
    id: 'r',
    name: 'Back Day',
    folderId: null,
    order: 0,
    createdAt: 1,
    updatedAt: 1,
    exercises: [
      {
        id: 'slot-pull',
        exerciseId: PULLDOWN,
        sets: [
          { id: 'p1', type: 'normal', weightKg: 60, reps: 8, repsMax: 12 },
          { id: 'p2', type: 'normal', weightKg: 60, reps: 8, repsMax: 12 },
          { id: 'p3', type: 'normal', weightKg: 60, reps: 8, repsMax: 12 },
        ],
      },
      { id: 'slot-bench', exerciseId: BENCH, sets: [{ id: 'b1', type: 'normal', weightKg: 80, reps: 5 }] },
    ],
  };
  const tickAll = (weId: string, weightKg: number, reps: number) => {
    const we = store().active!.exercises.find((e) => e.id === weId)!;
    for (const s of we.sets) store().updateSet(weId, s.id, { weightKg, reps, done: true });
  };

  it('is set from the routine and kept through Replace, a variant switch and a split', () => {
    const w = store().startFromRoutine(routine);
    expect(w.exercises.map((e) => e.routineExerciseId)).toEqual(['slot-pull', 'slot-bench']);
    const [pull, bench] = w.exercises;

    store().replaceExercise(bench.id, 'Dumbbell_Bench_Press');
    expect(store().active!.exercises[1].routineExerciseId).toBe('slot-bench');

    store().switchVariant(pull.id, HAMMER, true); // in place
    expect(store().active!.exercises[0]).toMatchObject({ exerciseId: HAMMER, routineExerciseId: 'slot-pull' });

    store().updateSet(pull.id, store().active!.exercises[0].sets[0].id, { weightKg: 45, reps: 10, done: true });
    store().switchVariant(pull.id, PULLDOWN, false, 'split'); // keep the done set on the Hammer machine
    const split = store().active!.exercises.find((e) => e.id === 'split')!;
    expect(split).toMatchObject({ exerciseId: PULLDOWN, routineExerciseId: 'slot-pull' });
    expect(store().active!.variantSplits).toEqual({ split: pull.id });
  });

  it('is saved with the workout, so "Update routine" swaps the slot to the variant instead of appending it', async () => {
    await db.routines.put(routine);
    const w = store().startFromRoutine(routine);
    const [pull, bench] = w.exercises;
    store().switchVariant(pull.id, HAMMER, true);
    tickAll(pull.id, 45, 10);
    tickAll(bench.id, 80, 5);
    const saved = await store().finish(meta());
    expect(saved.exercises.map((e) => e.routineExerciseId)).toEqual(['slot-pull', 'slot-bench']);
    expect((await db.workouts.get(saved.id))!.exercises[0].routineExerciseId).toBe('slot-pull');

    const plan = planRoutineUpdate(routine, saved);
    expect(plan.changed).toBe(true);
    expect(plan.swaps).toEqual([{ routineExerciseId: 'slot-pull', from: PULLDOWN, to: HAMMER }]);
    expect(plan.added).toEqual([]);
    await updateRoutineFromWorkout('r', saved);
    const updated = (await db.routines.get('r'))!;
    expect(updated.exercises.map((e) => [e.id, e.exerciseId])).toEqual([
      ['slot-pull', HAMMER],
      ['slot-bench', BENCH],
    ]);
    expect(updated.exercises[0].sets.map((s) => [s.weightKg, s.reps, s.repsMax])).toEqual([
      [45, 8, 12],
      [45, 8, 12],
      [45, 8, 12],
    ]);
  });

  it('after a split the routine keeps the original machine and its full plan', async () => {
    await db.routines.put(routine);
    const w = store().startFromRoutine(routine);
    const pull = w.exercises[0];
    const [s1, s2] = pull.sets;
    store().updateSet(pull.id, s1.id, { weightKg: 65, reps: 10, done: true });
    store().updateSet(pull.id, s2.id, { weightKg: 65, reps: 9, done: true });
    store().switchVariant(pull.id, HAMMER, false, 'split');
    tickAll('split', 45, 10);
    const splits = store().active!.variantSplits;
    const saved = await store().finish(meta());
    const plan = planRoutineUpdate(routine, saved, splits);
    expect(plan.swaps).toEqual([]);
    expect(plan.added).toEqual([]);
    expect(plan.exercises[0]).toMatchObject({ id: 'slot-pull', exerciseId: PULLDOWN });
    expect(plan.exercises[0].sets.map((s) => s.weightKg)).toEqual([65, 65, 60]);
  });

  it('"Repeat workout" keeps the links of a routine workout', () => {
    const src = store().startFromRoutine(routine);
    const repeated = store().startFromWorkout({
      id: 'old',
      name: 'Back Day',
      startedAt: 1,
      endedAt: 2,
      durationSec: 1,
      routineId: 'r',
      exercises: src.exercises.map((e) => ({ ...e, sets: e.sets.map((s) => ({ ...s, weightKg: 50, reps: 8, done: true })) })),
      exerciseIds: [PULLDOWN, BENCH],
      photoIds: [],
      volumeKg: 0,
      setCount: 0,
      prs: [],
      createdAt: 1,
      updatedAt: 1,
    });
    expect(repeated.exercises.map((e) => e.routineExerciseId)).toEqual(['slot-pull', 'slot-bench']);
  });
});
