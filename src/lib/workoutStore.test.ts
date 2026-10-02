import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db';
import type { Routine, Workout } from '../types';
import {
  cleanupSupersets,
  exerciseListOps,
  flushActiveWorkout,
  newSet,
  useWorkoutStore,
  type FinishMeta,
} from './workoutStore';
import { saveWorkout } from './workouts';

const BENCH = 'Barbell_Bench_Press_-_Medium_Grip'; // weight_reps
const PULLDOWN = 'Wide-Grip_Lat_Pulldown'; // weight_reps
const PLANK = 'Plank'; // duration

const store = () => useWorkoutStore.getState();

function meta(partial: Partial<FinishMeta> = {}): FinishMeta {
  return {
    name: 'Test Workout',
    startedAt: Date.now() - 3600_000,
    durationSec: 3600,
    photoIds: [],
    calories: 300,
    caloriesManual: false,
    bodyweightKg: 80,
    ...partial,
  };
}

function routine(): Routine {
  return {
    id: 'r1',
    name: 'Push Day',
    folderId: null,
    order: 0,
    notes: 'Go heavy',
    exercises: [
      {
        id: 're1',
        exerciseId: BENCH,
        restSec: 120,
        notes: 'Pause at the chest',
        sets: [
          { id: 'rs1', type: 'warmup', weightKg: 40, reps: 10 },
          { id: 'rs2', type: 'normal', weightKg: 80, reps: 8, repsMax: 12 },
          { id: 'rs3', type: 'normal', weightKg: 80, reps: 8, repsMax: 12 },
        ],
      },
      { id: 're2', exerciseId: PLANK, sets: [] },
    ],
    createdAt: 1,
    updatedAt: 1,
    lastPerformedAt: null,
  };
}

beforeEach(async () => {
  useWorkoutStore.setState({ active: null, hydrated: true });
  await Promise.all(db.tables.map((t) => t.clear()));
});

describe('startFromRoutine', () => {
  it('creates sets with the routine values as target placeholders', () => {
    const w = store().startFromRoutine(routine());
    expect(store().active?.id).toBe(w.id);
    expect(w.routineId).toBe('r1');
    expect(w.name).toBe('Push Day');
    expect(w.notes).toBe('Go heavy');
    expect(w.exercises).toHaveLength(2);

    const bench = w.exercises[0];
    expect(bench.exerciseId).toBe(BENCH);
    expect(bench.restSec).toBe(120);
    expect(bench.notes).toBe('Pause at the chest');
    expect(bench.sets.map((s) => s.type)).toEqual(['warmup', 'normal', 'normal']);
    for (const s of bench.sets) {
      // Values are empty — the plan is only a placeholder.
      expect(s.done).toBe(false);
      expect(s.weightKg).toBeNull();
      expect(s.reps).toBeNull();
    }
    expect(bench.sets[0].target).toMatchObject({ weightKg: 40, reps: 10 });
    expect(bench.sets[1].target).toMatchObject({ weightKg: 80, reps: 8, repsMax: 12 });
    // New ids, not the routine's.
    expect(bench.sets[1].id).not.toBe('rs2');

    // A routine exercise without sets still gets one empty set to fill in.
    expect(w.exercises[1].sets).toHaveLength(1);
    expect(w.exercises[1].sets[0].target ?? null).toBeNull();
  });
});

describe('finish()', () => {
  it('keeps only done sets, strips targets, drops empty exercises and derives totals', async () => {
    await db.routines.put(routine());
    store().startFromRoutine(routine());
    const [bench, plank] = store().active!.exercises;
    store().updateSet(bench.id, bench.sets[0].id, { weightKg: 40, reps: 10, done: true });
    store().updateSet(bench.id, bench.sets[1].id, { weightKg: 80, reps: 8, done: true });
    // Third set typed but never ticked → not saved.
    store().updateSet(bench.id, bench.sets[2].id, { weightKg: 80, reps: 6 });
    expect(plank.sets.every((s) => !s.done)).toBe(true);

    const saved = await store().finish(meta());

    expect(store().active).toBeNull();
    expect(await db.active.get('current')).toBeUndefined();
    expect(saved.exercises).toHaveLength(1); // plank dropped (no completed sets)
    expect(saved.exercises[0].exerciseId).toBe(BENCH);
    expect(saved.exercises[0].sets).toHaveLength(2);
    for (const s of saved.exercises[0].sets) {
      expect(s.done).toBe(true);
      expect('target' in s).toBe(false);
    }
    expect(saved.setCount).toBe(2);
    expect(saved.volumeKg).toBe(40 * 10 + 80 * 8);
    expect(saved.exerciseIds).toEqual([BENCH]);
    expect(saved.name).toBe('Test Workout');
    expect(saved.endedAt).toBe(saved.startedAt + 3600_000);
    expect(saved.prs).toEqual([]); // first time doing it → no records yet

    // Saved with its routine, which remembers when it was last performed.
    expect((await db.workouts.get(saved.id))?.routineId).toBe('r1');
    expect((await db.routines.get('r1'))?.lastPerformedAt).toBe(saved.startedAt);
  });

  it('sets PRs against earlier workouts', async () => {
    const earlier: Workout = {
      id: 'w_old',
      name: 'Old',
      startedAt: Date.now() - 7 * 86400_000,
      endedAt: Date.now() - 7 * 86400_000 + 3600_000,
      durationSec: 3600,
      exercises: [
        {
          id: 'we_old',
          exerciseId: BENCH,
          sets: [{ id: 's_old', type: 'normal', weightKg: 100, reps: 5, done: true }],
        },
      ],
      exerciseIds: [],
      photoIds: [],
      volumeKg: 0,
      setCount: 0,
      prs: [],
      createdAt: 1,
      updatedAt: 1,
    };
    await saveWorkout(earlier);

    store().startEmpty();
    store().addExercises([{ exerciseId: BENCH, sets: [newSet(), newSet()] }]);
    const we = store().active!.exercises[0];
    // Warm-up heavier than the record must not count; working set beats it.
    store().updateSet(we.id, we.sets[0].id, { type: 'warmup', weightKg: 120, reps: 1, done: true });
    store().updateSet(we.id, we.sets[1].id, { weightKg: 110, reps: 5, done: true });

    const saved = await store().finish(meta({ startedAt: Date.now() - 600_000, durationSec: 600 }));
    const kinds = saved.prs.map((p) => p.kind).sort();
    expect(kinds).toEqual(['best_1rm', 'best_set_volume', 'heaviest_weight']);
    for (const p of saved.prs) expect(p.setId).toBe(we.sets[1].id);
    expect(saved.prs.find((p) => p.kind === 'heaviest_weight')?.value).toBe(110);
  });

  it('falls back to the workout name when the title is blank', async () => {
    store().startEmpty();
    const name = store().active!.name;
    store().addExercises([{ exerciseId: PULLDOWN }]);
    const we = store().active!.exercises[0];
    store().updateSet(we.id, we.sets[0].id, { weightKg: 50, reps: 10, done: true });
    const saved = await store().finish(meta({ name: '   ' }));
    expect(saved.name).toBe(name);
  });
});

describe('rest timer', () => {
  it('removeSet clears the rest timer that belongs to that set', () => {
    store().startEmpty();
    store().addExercises([{ exerciseId: BENCH, sets: [newSet(), newSet()] }]);
    const we = store().active!.exercises[0];
    const [a, b] = we.sets;

    store().startRest(we.id, a.id, 90);
    expect(store().active?.rest).toMatchObject({ setId: a.id, totalSec: 90 });

    // Removing a different set keeps the timer.
    store().removeSet(we.id, b.id);
    expect(store().active?.rest?.setId).toBe(a.id);

    store().removeSet(we.id, a.id);
    expect(store().active?.rest).toBeNull();
    expect(store().active?.exercises[0].sets).toHaveLength(0);
  });

  it('adjustRest never goes below now and stopRest clears it', () => {
    store().startEmpty();
    store().addExercises([{ exerciseId: BENCH }]);
    const we = store().active!.exercises[0];
    store().startRest(we.id, we.sets[0].id, 10);
    store().adjustRest(-60);
    expect(store().active!.rest!.endsAt).toBeLessThanOrEqual(Date.now());
    store().stopRest();
    expect(store().active?.rest).toBeNull();
  });
});

describe('supersets', () => {
  it('cleans up a superset left with a single member', () => {
    store().startEmpty();
    store().addExercises([{ exerciseId: BENCH }, { exerciseId: PULLDOWN }, { exerciseId: PLANK }], { superset: true });
    let list = store().active!.exercises;
    const sid = list[0].supersetId;
    expect(sid).toBeTruthy();
    expect(list.every((e) => e.supersetId === sid)).toBe(true);

    // 3 → 2 members: still a superset.
    store().removeExercise(list[2].id);
    list = store().active!.exercises;
    expect(list.map((e) => e.supersetId)).toEqual([sid, sid]);

    // 2 → 1 member: the leftover is no longer in a superset.
    store().removeFromSuperset(list[1].id);
    list = store().active!.exercises;
    expect(list.map((e) => e.supersetId ?? null)).toEqual([null, null]);
  });

  it('removing an exercise dissolves its two-member superset', () => {
    store().startEmpty();
    store().addExercises([{ exerciseId: BENCH }, { exerciseId: PULLDOWN }]);
    const [a, b] = store().active!.exercises;
    store().setSuperset([a.id, b.id]);
    expect(store().active!.exercises[0].supersetId).toBeTruthy();
    store().removeExercise(b.id);
    expect(store().active!.exercises).toHaveLength(1);
    expect(store().active!.exercises[0].supersetId ?? null).toBeNull();
  });

  it('cleanupSupersets is a no-op for valid supersets', () => {
    const list = exerciseListOps.addExercises([], [{ exerciseId: BENCH }, { exerciseId: PULLDOWN }], { superset: true });
    expect(cleanupSupersets(list)).toEqual(list);
  });
});

describe('exerciseListOps', () => {
  it('addExercises honours provided instance ids and reorder keeps unknown ids at the end', () => {
    let list = exerciseListOps.addExercises([], [
      { id: 'x1', exerciseId: BENCH },
      { id: 'x2', exerciseId: PULLDOWN },
      { id: 'x3', exerciseId: PLANK },
    ]);
    expect(list.map((e) => e.id)).toEqual(['x1', 'x2', 'x3']);
    list = exerciseListOps.reorderExercises(list, ['x3', 'x1']);
    expect(list.map((e) => e.id)).toEqual(['x3', 'x1', 'x2']);
  });

  it('replaceExercise keeps typed values but drops the old plan', () => {
    store().startFromRoutine(routine());
    const we = store().active!.exercises[0];
    store().updateSet(we.id, we.sets[1].id, { weightKg: 70, reps: 9 });
    store().replaceExercise(we.id, PULLDOWN);
    const after = store().active!.exercises[0];
    expect(after.exerciseId).toBe(PULLDOWN);
    expect(after.sets).toHaveLength(3);
    expect(after.sets[1]).toMatchObject({ weightKg: 70, reps: 9, target: null });
  });

  it('addSet inherits the warm-up type and the last placeholder', () => {
    store().startFromRoutine(routine());
    const we = store().active!.exercises[0];
    store().addSet(we.id);
    const sets = store().active!.exercises[0].sets;
    expect(sets).toHaveLength(4);
    expect(sets[3].type).toBe('normal');
    expect(sets[3].target).toMatchObject({ weightKg: 80, reps: 8 });
  });
});

describe('persistence', () => {
  it('writes every change to IndexedDB and hydrates it back after a restart', async () => {
    store().startEmpty();
    store().addExercises([{ exerciseId: BENCH }]);
    const we = store().active!.exercises[0];
    store().updateSet(we.id, we.sets[0].id, { weightKg: 60, reps: 8, done: true });
    await flushActiveWorkout();
    expect((await db.active.get('current'))?.workout.exercises[0].sets[0]).toMatchObject({ weightKg: 60, done: true });

    // "Restart": memory cleared, hydrate from the DB.
    useWorkoutStore.setState({ active: null, hydrated: false });
    await store().hydrate();
    expect(store().hydrated).toBe(true);
    expect(store().active?.exercises[0].sets[0]).toMatchObject({ weightKg: 60, reps: 8, done: true });

    store().discard();
    await flushActiveWorkout();
    expect(await db.active.get('current')).toBeUndefined();
  });

  it('hydrate never overwrites a workout started while it was loading', async () => {
    await db.active.put({ id: 'current', workout: { id: 'stale', name: 'Stale', startedAt: 1, exercises: [], rest: null } });
    useWorkoutStore.setState({ active: null, hydrated: false });
    const loading = store().hydrate();
    const fresh = store().startEmpty();
    await loading;
    expect(store().active?.id).toBe(fresh.id);
    await flushActiveWorkout();
    expect((await db.active.get('current'))?.workout.id).toBe(fresh.id);
  });
});
