import 'fake-indexeddb/auto';
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { Routine, RoutineSet, SetEntry, Workout } from '../../types';
import { buildExerciseIndex } from '../../lib/exercises';
import { typeFields } from '../../lib/exerciseMeta';
import { ExerciseProvider } from '../../lib/ExerciseProvider';
import { planRoutineUpdate } from '../../lib/routines';
import { joinSet, patchSide, splitSet, syncSideSet } from '../../lib/sides';
import { dropWeightTarget, setsFromRoutineExercise, targetFromValues } from '../../lib/workoutStore';
import { workoutToRoutineExercises } from '../../lib/workouts';
import { routineSetsSummary } from '../exercises/format';
import { RoutineExerciseCard } from './RoutineExerciseCard';
import { blankRoutineSet, fitSetsToFields, nextSet, routineExerciseFromSource, routineSetsFromPrevious } from './routineUtils';

const EX = 'Dumbbell_One-Arm_Triceps_Extension'; // Single Arm Overhead Triceps Extension (Dumbbell): per-side by default
const LB = 0.45359237;

/** A planned set with its own left and right. */
const planned = (l: [number, number, number?], r: [number, number, number?], p: Partial<RoutineSet> = {}): RoutineSet =>
  syncSideSet(
    blankRoutineSet({
      sides: {
        left: { weightKg: l[0], reps: l[1], ...(l[2] != null ? { repsMax: l[2] } : {}) },
        right: { weightKg: r[0], reps: r[1], ...(r[2] != null ? { repsMax: r[2] } : {}) },
      },
      ...p,
    }),
  );

const logged = (l: [number, number], r: [number, number], id = 's'): SetEntry =>
  syncSideSet({ id, type: 'normal', done: true, sides: { left: { weightKg: l[0], reps: l[1] }, right: { weightKg: r[0], reps: r[1] } } });

describe('routine sets: left and right', () => {
  it('a plain planned set splits with its rep range on both sides; editing one side keeps the other', () => {
    const plain = blankRoutineSet({ weightKg: 22.5, reps: 8, repsMax: 12 });
    const split = splitSet(plain);
    expect(split.sides).toEqual({
      left: { weightKg: 22.5, reps: 8, repsMax: 12, durationSec: null, distanceM: null },
      right: { weightKg: 22.5, reps: 8, repsMax: 12, durationSec: null, distanceM: null },
    });
    const p = patchSide(plain, 'right', { weightKg: 20 });
    expect(p.sides?.left).toMatchObject({ weightKg: 22.5, reps: 8, repsMax: 12 });
    expect(p.sides?.right).toMatchObject({ weightKg: 20, reps: 8, repsMax: 12 });
    // Mirror = the stronger (left) side, range included.
    expect([p.weightKg, p.reps, p.repsMax]).toEqual([22.5, 8, 12]);
  });

  it('a logged set never grows a repsMax field from the mirror', () => {
    expect('repsMax' in logged([20, 10], [20, 9])).toBe(false);
  });

  it('joining keeps the better side', () => {
    const j = joinSet(planned([22.5, 10], [20, 10]));
    expect(j.sides).toBeUndefined();
    expect([j.weightKg, j.reps]).toEqual([22.5, 10]);
  });

  it("starting the routine: each side's plan becomes that side's placeholder (range kept)", () => {
    const re = { id: 're', exerciseId: EX, sets: [planned([22.5, 8, 12], [20, 10])] };
    const [s] = setsFromRoutineExercise(re);
    expect(s.target?.sides?.left).toMatchObject({ weightKg: 22.5, reps: 8, repsMax: 12 });
    expect(s.target?.sides?.right).toMatchObject({ weightKg: 20, reps: 10 });
    expect(s.target?.sides?.right.repsMax ?? null).toBeNull();
    expect(targetFromValues(blankRoutineSet({ weightKg: 20, reps: 10 })).sides).toBeUndefined();
    // Another machine: no planned weights on either side.
    const moved = dropWeightTarget(s);
    expect(moved.target?.weightKg).toBeNull();
    expect(moved.target?.sides?.left.weightKg).toBeNull();
    expect(moved.target?.sides?.right.weightKg).toBeNull();
    expect(moved.target?.sides?.left.reps).toBe(8);
  });

  it('Add Set, fitting to a type, copies and "from previous" keep both sides', () => {
    const last = planned([22.5, 10], [20, 10]);
    expect(nextSet([last]).sides?.left).toMatchObject({ weightKg: 22.5, reps: 10 });
    expect(nextSet([last]).sides?.right).toMatchObject({ weightKg: 20, reps: 10 });
    expect(nextSet([last]).sides).not.toBe(last.sides);
    const [fit] = fitSetsToFields([last], typeFields('bodyweight_reps'));
    expect(fit.sides?.left).toMatchObject({ weightKg: null, reps: 10 });
    expect(fit.sides?.right).toMatchObject({ weightKg: null, reps: 10 });
    expect(routineSetsFromPrevious([logged([22.5, 10], [20, 9])])[0].sides?.right).toMatchObject({ weightKg: 20, reps: 9 });
    const other = routineExerciseFromSource({ id: 'x', exerciseId: EX, sets: [last] }, 'c_variant');
    expect(other.sets[0].sides?.left.weightKg).toBeNull();
    expect(other.sets[0].sides?.right.reps).toBe(10);
  });

  it('"Save as routine" keeps the left and right a workout logged', () => {
    const [re] = workoutToRoutineExercises([{ id: 'we', exerciseId: EX, sets: [logged([22.5, 10], [20, 9])] }]);
    expect(re.sets[0].sides?.left).toMatchObject({ weightKg: 22.5, reps: 10 });
    expect(re.sets[0].sides?.right).toMatchObject({ weightKg: 20, reps: 9 });
  });

  it('the routine summary covers both sides', () => {
    const line = routineSetsSummary([planned([50 * LB, 10], [45 * LB, 10]), planned([50 * LB, 10], [45 * LB, 10])], 'weight_reps', 'lb', 'mi');
    expect(line).toBe('2 sets · 10 reps · 45–50 lb');
  });
});

describe('"Update routine?" with left and right', () => {
  const routine = (sets: RoutineSet[]): Routine => ({
    id: 'r',
    name: 'Arms',
    folderId: null,
    order: 0,
    exercises: [{ id: 're', exerciseId: EX, sets }],
    createdAt: 0,
    updatedAt: 0,
  });
  const workout = (sets: SetEntry[]): Workout => ({
    id: 'w',
    name: 'Arms',
    startedAt: 1,
    endedAt: 2,
    durationSec: 1,
    routineId: 'r',
    exercises: [{ id: 'we', exerciseId: EX, routineExerciseId: 're', sets }],
    exerciseIds: [EX],
    photoIds: [],
    volumeKg: 0,
    setCount: 1,
    prs: [],
    createdAt: 0,
    updatedAt: 0,
  });

  it('a plain plan matched on both sides is not a change; a weaker side is, and it is planned per side', () => {
    const r = routine([blankRoutineSet({ id: 'rs', weightKg: 22.5, reps: 10 })]);
    expect(planRoutineUpdate(r, workout([logged([22.5, 10], [22.5, 10])])).changed).toBe(false);
    const plan = planRoutineUpdate(r, workout([logged([22.5, 10], [20, 10])]));
    expect(plan.changed).toBe(true);
    const s = plan.exercises[0].sets[0];
    expect(s.id).toBe('rs');
    expect(s.sides?.left).toMatchObject({ weightKg: 22.5, reps: 10 });
    expect(s.sides?.right).toMatchObject({ weightKg: 20, reps: 10 });
  });

  it("each side keeps its own rep range while the reps land in it", () => {
    const r = routine([planned([22.5, 8, 12], [20, 8, 12], { id: 'rs' })]);
    expect(planRoutineUpdate(r, workout([logged([22.5, 11], [20, 9])])).changed).toBe(false);
    const plan = planRoutineUpdate(r, workout([logged([25, 10], [20, 9])]));
    expect(plan.changed).toBe(true);
    expect(plan.exercises[0].sets[0].sides?.left).toMatchObject({ weightKg: 25, reps: 8, repsMax: 12 });
    expect(plan.exercises[0].sets[0].sides?.right).toMatchObject({ weightKg: 20, reps: 8, repsMax: 12 });
  });
});

describe('routine editor card', () => {
  const index = buildExerciseIndex([], []);
  const card = (exerciseId: string, sets: RoutineSet[]) =>
    renderToString(
      h(
        ExerciseProvider,
        null,
        h(
          MemoryRouter,
          null,
          h(RoutineExerciseCard, {
            re: { id: 're', exerciseId, restSec: null, supersetId: null, sets },
            exercise: index.get(exerciseId),
            unit: 'lb',
            distanceUnit: 'mi',
            defaultRest: 90,
            exerciseCount: 1,
            onUpdate: () => {},
            onAction: () => {},
          }),
        ),
      ),
    );

  it('a per-side exercise plans each set as an L and an R line, each with its own weight and reps', () => {
    const html = card(EX, [planned([50 * LB, 10], [45 * LB, 10]), blankRoutineSet({ weightKg: 50 * LB, reps: 10 })]);
    for (const label of ['Set 1 left weight (lb)', 'Set 1 right weight (lb)', 'Set 1 left reps', 'Set 1 right reps', 'Set 2 left weight (lb)', 'Set 2 right weight (lb)'])
      expect(html).toContain(`aria-label="${label}"`);
    expect(html).toMatch(/aria-label="Set 1 right weight \(lb\)"[^>]*value="45"|value="45"[^>]*aria-label="Set 1 right weight \(lb\)"/);
    expect(html).toContain('>L</span>');
    expect(html).toContain('>R</span>');
  });

  it('a two-arm exercise keeps one line per set', () => {
    const html = card('Machine_Triceps_Extension', [blankRoutineSet({ weightKg: 50 * LB, reps: 10 })]);
    expect(html).toContain('aria-label="Set 1 weight (lb)"');
    expect(html).not.toContain('left weight');
  });
});
