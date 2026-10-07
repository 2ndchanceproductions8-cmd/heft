import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../db';
import type { Routine, SetEntry, Workout, WorkoutExercise } from '../../types';
import { typeFields } from '../../lib/exerciseMeta';
import { anyToMeters, distanceUnitForType, metersToAny, round } from '../../lib/units';
import { exerciseListOps, newSet } from '../../lib/workoutStore';
import {
  adaptSetsToType,
  alignPreviousSets,
  buildExerciseItems,
  distanceText,
  effectiveRestSec,
  filledValues,
  finalizeDoneSets,
  formatPRValue,
  formatSetSummary,
  fromLocalInput,
  missingValueMessage,
  pendingSetCount,
  previousInstanceSets,
  restOptionLabel,
  routineUpdateMessage,
  sameFields,
  setBadges,
  supersetColors,
  supersetContinues,
  toLocalInput,
} from './logic';
import { workoutForRoutineUpdate } from '../../lib/routines';
import { DEFAULT_SETTINGS } from '../../lib/settings';
import type { Exercise } from '../../types';

const BENCH = 'Barbell_Bench_Press_-_Medium_Grip';

const ex = (patch: Partial<Exercise> = {}): Exercise => ({
  id: BENCH,
  name: 'Bench',
  originalName: 'Bench',
  perSide: false,
  equipment: 'barbell',
  primary: 'chest',
  secondary: [],
  type: 'weight_reps',
  images: [],
  photoIds: [],
  instructions: [],
  source: 'catalog',
  aliases: [],
  ...patch,
});

const we = (patch: Partial<WorkoutExercise> = {}): WorkoutExercise => ({
  id: 'we',
  exerciseId: BENCH,
  sets: [newSet()],
  ...patch,
});

describe('set badges', () => {
  it('numbers working sets and letters the special types', () => {
    const sets = [
      newSet({ type: 'warmup' }),
      newSet({ type: 'warmup' }),
      newSet(),
      newSet(),
      newSet({ type: 'failure' }),
      newSet({ type: 'drop' }),
    ];
    expect(setBadges(sets).map((b) => b.label)).toEqual(['W', 'W', '1', '2', 'F', 'D']);
    // F and D take a number, so the set after them keeps its place (same rule as routines and history).
    expect(setBadges([newSet(), newSet({ type: 'failure' }), newSet()]).map((b) => b.label)).toEqual(['1', 'F', '3']);
    expect(setBadges(sets)[0].className).toBe('text-warn');
    expect(setBadges(sets)[4].className).toBe('text-danger');
    expect(setBadges(sets)[5].className).toBe('text-drop');
  });
});

describe('PREVIOUS formatting', () => {
  const lb = 0.45359237;
  it('formats each exercise type', () => {
    expect(formatSetSummary({ weightKg: 135 * lb, reps: 8 }, 'weight_reps', 'lb', 'mi')).toBe('135 lb x 8');
    expect(formatSetSummary({ reps: 12 }, 'bodyweight_reps', 'lb', 'mi')).toBe('12 reps');
    expect(formatSetSummary({ weightKg: 25 * lb, reps: 8 }, 'weighted_bodyweight', 'lb', 'mi')).toBe('+25 lb x 8');
    expect(formatSetSummary({ weightKg: 40 * lb, reps: 6 }, 'assisted_bodyweight', 'lb', 'mi')).toBe('-40 lb x 6');
    expect(formatSetSummary({ durationSec: 60 }, 'duration', 'lb', 'mi')).toBe('1:00');
    expect(formatSetSummary({ distanceM: 1.2 * 1609.344, durationSec: 600 }, 'distance_duration', 'lb', 'mi')).toBe(
      '1.2 mi | 10:00',
    );
    expect(formatSetSummary({}, 'weight_reps', 'kg', 'km')).toBe('-');
  });
});

describe('ticking a set', () => {
  const fields = typeFields('weight_reps');
  it('fills empty inputs from the target, then the previous session', () => {
    const set: SetEntry = newSet({ target: { weightKg: 80, reps: null } });
    const prev: SetEntry = newSet({ weightKg: 75, reps: 9, done: true });
    expect(filledValues(set, prev, fields)).toEqual({ weightKg: 80, reps: 9, durationSec: null, distanceM: null });
  });
  it('keeps what was typed', () => {
    const set: SetEntry = newSet({ weightKg: 90, reps: 5, target: { weightKg: 80, reps: 8 } });
    expect(filledValues(set, null, fields)).toMatchObject({ weightKg: 90, reps: 5 });
  });
  it('requires reps for rep exercises and a value for timed/distance ones', () => {
    expect(missingValueMessage(fields, { weightKg: 80, reps: null })).toBe('Enter reps first');
    expect(missingValueMessage(fields, { weightKg: null, reps: 8 })).toBeNull();
    expect(missingValueMessage(typeFields('duration'), { durationSec: null })).toBe('Enter time first');
    expect(missingValueMessage(typeFields('distance_duration'), { durationSec: 600 })).toBeNull();
    expect(missingValueMessage(typeFields('weight_distance'), { weightKg: 40 })).toBe('Enter distance first');
  });
  it('counts typed-but-unticked sets', () => {
    const list = [we({ sets: [newSet({ reps: 5 }), newSet({ reps: 5, done: true }), newSet()] })];
    expect(pendingSetCount(list)).toBe(1);
  });
});

describe('rest timer', () => {
  it('resolves workout → exercise → settings default', () => {
    const s = { ...DEFAULT_SETTINGS, defaultRestSec: 90 };
    expect(effectiveRestSec(we(), ex(), s)).toBe(90);
    expect(effectiveRestSec(we(), ex({ restSec: 120 }), s)).toBe(120);
    expect(effectiveRestSec(we({ restSec: 0 }), ex({ restSec: 120 }), s)).toBe(0);
  });
  it('labels (the card and the picker use the same app-wide labels)', () => {
    expect(restOptionLabel(90)).toBe('1:30');
    expect(restOptionLabel(0)).toBe('Off');
    expect(restOptionLabel(45)).toBe('45s');
    expect(restOptionLabel(75)).toBe('1:15');
    expect(restOptionLabel(300)).toBe('5:00');
  });
});

describe('supersets', () => {
  it('gives each superset its own color, the same for every member', () => {
    const list = [
      we({ id: 'a', supersetId: 's1' }),
      we({ id: 'b', supersetId: 's1' }),
      we({ id: 'c', supersetId: 's2' }),
      we({ id: 'd', supersetId: 's2' }),
      we({ id: 'e' }),
    ];
    const colors = supersetColors(list);
    expect(colors.size).toBe(2);
    expect(colors.get('s1')).not.toEqual(colors.get('s2'));
  });
  it('defers the rest timer until the last exercise of the round', () => {
    const list = [we({ id: 'a', supersetId: 's' }), we({ id: 'b', supersetId: 's' }), we({ id: 'c' })];
    expect(supersetContinues(list, 'a')).toBe(true);
    expect(supersetContinues(list, 'b')).toBe(false);
    expect(supersetContinues(list, 'c')).toBe(false);
  });
});

describe('adding exercises', () => {
  beforeEach(async () => {
    await Promise.all(db.tables.map((t) => t.clear()));
  });

  it('routine picks bring planned sets; others mirror the last session or start empty', async () => {
    await db.routines.put({
      id: 'r',
      name: 'Pull',
      folderId: null,
      order: 0,
      exercises: [{ id: 're', exerciseId: 'Plank', restSec: 45, notes: 'tight core', sets: [{ id: 'x', type: 'normal', durationSec: 60 }] }],
      createdAt: 1,
      updatedAt: 1,
    });
    const history: Workout[] = [
      {
        id: 'w',
        name: 'Old',
        startedAt: 1,
        endedAt: 2,
        durationSec: 1,
        exercises: [{ id: 'o', exerciseId: BENCH, sets: [newSet({ weightKg: 60, reps: 5, done: true }), newSet({ weightKg: 60, reps: 5, done: true })] }],
        exerciseIds: [BENCH],
        photoIds: [],
        volumeKg: 0,
        setCount: 2,
        prs: [],
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    const items = await buildExerciseItems(
      [
        { exerciseId: 'Plank', fromRoutine: { routineId: 'r', routineExerciseId: 're' } },
        { exerciseId: BENCH },
        { exerciseId: 'Wide-Grip_Lat_Pulldown' },
      ],
      { history, previousMode: 'any' },
    );
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ exerciseId: 'Plank', restSec: 45, notes: 'tight core' });
    expect(items[0].sets?.[0].target).toMatchObject({ durationSec: 60 });
    expect(items[1].sets).toHaveLength(2);
    expect(items[1].sets?.[0].target).toMatchObject({ weightKg: 60, reps: 5 });
    expect(items[1].sets?.[0].weightKg).toBeNull();
    expect(items[2].sets).toHaveLength(1);
    expect(new Set(items.map((i) => i.id)).size).toBe(3);

    const edit = await buildExerciseItems([{ exerciseId: BENCH }], { history, previousMode: 'any', done: true });
    expect(edit[0].sets?.every((s) => s.done)).toBe(true);
  });
});

describe('datetime-local helpers', () => {
  it('round-trips local time to the minute', () => {
    const ms = new Date(2026, 9, 1, 7, 45).getTime();
    expect(toLocalInput(ms)).toBe('2026-10-01T07:45');
    expect(fromLocalInput('2026-10-01T07:45')).toBe(ms);
    expect(fromLocalInput('')).toBeNull();
  });
});

describe('replacing with a different exercise type', () => {
  it('clears columns the new type does not log and un-ticks sets missing a required value', () => {
    const sets = [
      newSet({ weightKg: 100, reps: 5, done: true }),
      newSet({ weightKg: 100, reps: null }),
      newSet(),
    ];
    // Bench (weight & reps) → Plank (duration): weight/reps would otherwise be saved invisibly.
    const patches = adaptSetsToType(sets, typeFields('duration'));
    expect(patches).toEqual([
      { setId: sets[0].id, patch: { weightKg: null, reps: null, done: false } },
      { setId: sets[1].id, patch: { weightKg: null } },
    ]);
  });
  it('keeps compatible values (bench → bodyweight push-up keeps the reps)', () => {
    const sets = [newSet({ weightKg: 60, reps: 10, done: true })];
    expect(adaptSetsToType(sets, typeFields('bodyweight_reps'))).toEqual([
      { setId: sets[0].id, patch: { weightKg: null } },
    ]);
  });
  it('compares the logged columns of two types', () => {
    expect(sameFields(typeFields('weight_reps'), typeFields('weighted_bodyweight'))).toBe(true);
    expect(sameFields(typeFields('weight_reps'), typeFields('duration'))).toBe(false);
  });
});

// ------------------------------------------------------------------ fixes

const workout = (id: string, exercises: WorkoutExercise[], patch: Partial<Workout> = {}): Workout => ({
  id,
  name: id,
  startedAt: 1,
  endedAt: 2,
  durationSec: 1,
  exercises,
  exerciseIds: [...new Set(exercises.map((e) => e.exerciseId))],
  photoIds: [],
  volumeKg: 0,
  setCount: 0,
  prs: [],
  createdAt: 1,
  updatedAt: 1,
  ...patch,
});
const done = (weightKg: number | null, reps: number | null, type: SetEntry['type'] = 'normal'): SetEntry =>
  newSet({ type, weightKg, reps, done: true });

describe('saving ticked sets (finalizeDoneSets)', () => {
  const fieldsOf = () => typeFields('weight_reps');
  it('drops a ticked set whose reps were cleared, and fills empty cells from the plan', () => {
    const cleared = newSet({ weightKg: 60, reps: null, done: true });
    const planned = newSet({ weightKg: null, reps: null, done: true, target: { weightKg: 80, reps: 8 } });
    const ok = done(70, 5);
    const undone = newSet({ weightKg: 70, reps: 5 });
    const { exercises, dropped } = finalizeDoneSets([we({ sets: [cleared, planned, ok, undone] })], fieldsOf);
    expect(dropped).toBe(1);
    expect(exercises[0].sets.map((s) => s.id)).toEqual([planned.id, ok.id, undone.id]);
    expect(exercises[0].sets[0]).toMatchObject({ weightKg: 80, reps: 8, done: true });
  });
  it('requires distance or time for cardio', () => {
    const run = newSet({ done: true });
    const { dropped } = finalizeDoneSets([we({ sets: [run] })], () => typeFields('distance_duration'));
    expect(dropped).toBe(1);
  });
});

describe('PREVIOUS alignment by set type', () => {
  const W = (reps: number) => done(20, reps, 'warmup');
  const N = (reps: number) => done(60, reps);
  it('a working set never takes last session\'s warm-up', () => {
    const prev = [W(10), N(8), N(7), N(6)];
    const cur = [newSet(), newSet(), newSet()];
    expect(alignPreviousSets(cur, prev)).toEqual([prev[1], prev[2], prev[3]]);
  });
  it('a new warm-up gets no previous set; working sets still line up', () => {
    const prev = [N(8), N(7), N(6)];
    const cur = [newSet({ type: 'warmup' }), newSet(), newSet(), newSet()];
    expect(alignPreviousSets(cur, prev)).toEqual([null, prev[0], prev[1], prev[2]]);
  });
  it('a set turned into a failure set keeps its working-set match', () => {
    const prev = [W(10), N(8), N(7)];
    const cur = [newSet({ type: 'warmup' }), newSet(), newSet({ type: 'failure' })];
    expect(alignPreviousSets(cur, prev)).toEqual([prev[0], prev[1], prev[2]]);
  });
  it('extra warm-ups (or sets) beyond last time get null', () => {
    const prev = [W(10), N(8)];
    const cur = [newSet({ type: 'warmup' }), newSet({ type: 'warmup' }), newSet(), newSet()];
    expect(alignPreviousSets(cur, prev)).toEqual([prev[0], null, prev[1], null]);
    expect(alignPreviousSets(cur, null)).toEqual([null, null, null, null]);
  });
});

describe('PREVIOUS per exercise instance', () => {
  const bench = (sets: SetEntry[]) => ({ id: Math.random().toString(36), exerciseId: BENCH, sets });
  const older = workout('older', [bench([done(90, 5)]), bench([done(60, 12)]), bench([done(40, 20)])]);
  const recent = workout('recent', [bench([done(100, 5)]), bench([done(70, 10)])]);
  const history = [recent, older]; // newest first
  it('the Nth instance maps to the Nth instance last time, never merged', () => {
    expect(previousInstanceSets(history, BENCH, { occurrence: 0 })?.map((s) => s.weightKg)).toEqual([100]);
    expect(previousInstanceSets(history, BENCH, { occurrence: 1 })?.map((s) => s.weightKg)).toEqual([70]);
    // Only the older workout had a third block.
    expect(previousInstanceSets(history, BENCH, { occurrence: 2 })?.map((s) => s.weightKg)).toEqual([40]);
    expect(previousInstanceSets(history, BENCH, { occurrence: 3 })).toBeNull();
  });
  it('prefers the same routine when asked', () => {
    const fromRoutine = workout('r', [bench([done(80, 8)])], { routineId: 'r1' });
    const h = [recent, fromRoutine];
    expect(previousInstanceSets(h, BENCH, { mode: 'same_routine', routineId: 'r1' })?.[0].weightKg).toBe(80);
    expect(previousInstanceSets(h, BENCH, { mode: 'any', routineId: 'r1' })?.[0].weightKg).toBe(100);
  });
});

describe('Weight & Distance units (carries)', () => {
  const lb = 0.45359237;
  it('PREVIOUS reads yd for mi users and m for km users; runs stay in mi/km', () => {
    expect(formatSetSummary({ weightKg: 60 * lb, distanceM: 40 * 0.9144 }, 'weight_distance', 'lb', 'mi')).toBe('60 lb | 40 yd');
    expect(formatSetSummary({ weightKg: 40, distanceM: 30 }, 'weight_distance', 'kg', 'km')).toBe('40 kg | 30 m');
    expect(formatSetSummary({ distanceM: 1.2 * 1609.344, durationSec: 600 }, 'distance_duration', 'lb', 'mi')).toBe('1.2 mi | 10:00');
  });
  it('the logger cell, placeholder and header use yd/m', () => {
    const m = 36.576; // 40 yd
    const du = distanceUnitForType('weight_distance', 'mi');
    expect(du.toUpperCase()).toBe('YD');
    expect(round(metersToAny(m, du), 2)).toBe(40);
    expect(distanceText(m, 'weight_distance', 'mi')).toBe('40');
    expect(anyToMeters(40, du)).toBeCloseTo(m, 6);
    expect(distanceText(1609.344 * 1.25, 'distance_duration', 'mi')).toBe('1.25');
  });
  it('carries keep one decimal of yd / m', () => {
    const m = anyToMeters(40.5, 'yd');
    expect(distanceText(m, 'weight_distance', 'mi')).toBe('40.5');
    expect(formatSetSummary({ weightKg: 60 * lb, distanceM: m }, 'weight_distance', 'lb', 'mi')).toBe('60 lb | 40.5 yd');
    expect(formatPRValue('longest_distance', 36.576, 'weight_distance', { unit: 'kg', distanceUnit: 'km' })).toBe('36.6 m');
  });
  it('PR toast values use the exercise type', () => {
    const settings = { unit: 'lb' as const, distanceUnit: 'mi' as const };
    expect(formatPRValue('longest_distance', anyToMeters(40, 'yd'), 'weight_distance', settings)).toBe('40 yd');
    expect(formatPRValue('longest_distance', 30, 'weight_distance', { unit: 'kg', distanceUnit: 'km' })).toBe('30 m');
    expect(formatPRValue('heaviest_weight', 45 * lb, 'weighted_bodyweight', settings)).toBe('+45 lb');
    expect(formatPRValue('heaviest_weight', 225 * lb, 'weight_reps', settings)).toBe('225 lb');
  });
});

describe('adding routine exercises keeps their supersets', () => {
  beforeEach(async () => {
    await Promise.all(db.tables.map((t) => t.clear()));
    await db.routines.put({
      id: 'r',
      name: 'Upper',
      folderId: null,
      order: 0,
      exercises: [
        { id: 'a1', exerciseId: BENCH, supersetId: 's1', sets: [{ id: 'x1', type: 'normal', reps: 8 }] },
        { id: 'a2', exerciseId: 'Wide-Grip_Lat_Pulldown', supersetId: 's1', sets: [{ id: 'x2', type: 'normal', reps: 10 }] },
        { id: 'solo', exerciseId: 'Plank', sets: [{ id: 'x3', type: 'normal', durationSec: 60 }] },
      ],
      createdAt: 1,
      updatedAt: 1,
    });
  });
  const pick = (reId: string, exerciseId: string) => ({ exerciseId, fromRoutine: { routineId: 'r', routineExerciseId: reId } });
  const all = () => [pick('a1', BENCH), pick('a2', 'Wide-Grip_Lat_Pulldown'), pick('solo', 'Plank')];

  it('a routine superset stays paired under a fresh id; the solo exercise stays solo', async () => {
    const items = await buildExerciseItems(all(), { history: [], previousMode: 'any' });
    const list = exerciseListOps.addExercises([], items, { superset: false });
    expect(list[0].supersetId).toBeTruthy();
    expect(list[0].supersetId).not.toBe('s1');
    expect(list[1].supersetId).toBe(list[0].supersetId);
    expect(list[2].supersetId ?? null).toBeNull();
    // Adding the same routine again makes a new group, not a 4-member one.
    const again = exerciseListOps.addExercises(list, await buildExerciseItems(all(), { history: [], previousMode: 'any' }));
    expect(again[3].supersetId).toBeTruthy();
    expect(again[3].supersetId).not.toBe(list[0].supersetId);
  });
  it('picking only one member of a routine superset adds it solo', async () => {
    const items = await buildExerciseItems([pick('a1', BENCH)], { history: [], previousMode: 'any' });
    expect(exerciseListOps.addExercises([], items)[0].supersetId ?? null).toBeNull();
  });
  it('routine picks carry their routine slot link into the workout', async () => {
    const items = await buildExerciseItems(all(), { history: [], previousMode: 'any' });
    expect(items.map((i) => i.routineExerciseId)).toEqual(['a1', 'a2', 'solo']);
    const list = exerciseListOps.addExercises([], items);
    expect(list.map((e) => e.routineExerciseId)).toEqual(['a1', 'a2', 'solo']);
    const [plain] = await buildExerciseItems([{ exerciseId: BENCH }], { history: [], previousMode: 'any' });
    expect(exerciseListOps.addExercises([], [plain])[0].routineExerciseId ?? null).toBeNull();
  });
  it('a variant picked for a routine exercise keeps the plan but drops the planned weights', async () => {
    await db.routines.update('r', {
      exercises: [
        {
          id: 'a2',
          exerciseId: 'Wide-Grip_Lat_Pulldown',
          notes: 'seat 4',
          restSec: 90,
          sets: [
            { id: 'x1', type: 'warmup', weightKg: 30, reps: 12 },
            { id: 'x2', type: 'normal', weightKg: 60, reps: 8, repsMax: 12 },
          ],
        },
      ],
    });
    const [same] = await buildExerciseItems([pick('a2', 'Wide-Grip_Lat_Pulldown')], { history: [], previousMode: 'any' });
    expect(same.sets?.map((s) => s.target?.weightKg)).toEqual([30, 60]);
    const [variant] = await buildExerciseItems([pick('a2', 'c_hammer_pulldown')], { history: [], previousMode: 'any' });
    expect(variant).toMatchObject({ exerciseId: 'c_hammer_pulldown', notes: 'seat 4', restSec: 90, routineExerciseId: 'a2' });
    expect(variant.sets?.map((s) => [s.type, s.target?.weightKg, s.target?.reps, s.target?.repsMax])).toEqual([
      ['warmup', null, 12, null],
      ['normal', null, 8, 12],
    ]);
  });
  it('"Add as Superset" puts every picked exercise in one superset', async () => {
    const items = await buildExerciseItems(all(), { history: [], previousMode: 'any' });
    const list = exerciseListOps.addExercises([], items, { superset: true });
    expect(new Set(list.map((e) => e.supersetId)).size).toBe(1);
    expect(list[0].supersetId).toBeTruthy();
  });
  it('a second instance of an exercise mirrors last time\'s second block', async () => {
    const history = [
      workout('w', [
        { id: 'h1', exerciseId: BENCH, sets: [done(100, 5), done(100, 5)] },
        { id: 'h2', exerciseId: BENCH, sets: [done(70, 10)] },
      ]),
    ];
    const existing = [we({ id: 'cur', exerciseId: BENCH })];
    const [item] = await buildExerciseItems([{ exerciseId: BENCH }], { history, previousMode: 'any', existing });
    expect(item.sets?.map((s) => s.target?.weightKg)).toEqual([70]);
    const [first] = await buildExerciseItems([{ exerciseId: BENCH }], { history, previousMode: 'any' });
    expect(first.sets?.map((s) => s.target?.weightKg)).toEqual([100, 100]);
  });
});

describe('Update routine after a variant split', () => {
  const PULL = 'Wide-Grip_Lat_Pulldown';
  const HAMMER = 'c_hammer_pulldown';
  const routine: Routine = {
    id: 'r',
    name: 'Back',
    folderId: null,
    order: 0,
    exercises: [
      {
        id: 'slot',
        exerciseId: PULL,
        sets: [
          { id: 'p1', type: 'normal', weightKg: 60, reps: 8, repsMax: 12 },
          { id: 'p2', type: 'normal', weightKg: 60, reps: 8, repsMax: 12 },
          { id: 'p3', type: 'normal', weightKg: 60, reps: 8, repsMax: 12 },
        ],
      },
    ],
    createdAt: 1,
    updatedAt: 1,
  };
  it('the slot keeps its 3 sets: 2 done on its machine, the plan for the one done on the other', () => {
    const w = workout('w', [
      { id: 'base', exerciseId: PULL, sets: [done(65, 10), done(65, 9)] },
      { id: 'split', exerciseId: HAMMER, sets: [done(45, 10)] },
    ]);
    const view = workoutForRoutineUpdate(w, routine, { split: 'base' });
    expect(view.exercises.map((e) => e.id)).toEqual(['base']);
    expect(view.exercises[0].sets.map((s) => [s.weightKg, s.reps])).toEqual([
      [65, 10],
      [65, 9],
      [60, 8],
    ]);
  });
  it('leaves workouts without splits, and splits of non-routine exercises, alone', () => {
    const w = workout('w', [
      { id: 'base', exerciseId: PULL, sets: [done(65, 10)] },
      { id: 'extra', exerciseId: BENCH, sets: [done(80, 5)] },
      { id: 'extra2', exerciseId: 'c_bench_variant', sets: [done(70, 5)] },
    ]);
    expect(workoutForRoutineUpdate(w, routine, undefined)).toBe(w);
    expect(workoutForRoutineUpdate(w, routine, { extra2: 'extra' }).exercises.map((e) => e.id)).toEqual([
      'base',
      'extra',
      'extra2',
    ]);
  });
});

describe('"Update routine?" message', () => {
  const names: Record<string, string> = {
    lat: 'Lat Pulldown (Cable)',
    hammer: 'Lat Pulldown (Cable) - Hammer Strength',
    curl: 'Bicep Curl (Dumbbell)',
    a: 'A',
    b: 'B',
    c: 'C',
    d: 'D',
  };
  const nameOf = (id: string) => names[id] ?? id;
  it('says what is saved and what stays', () => {
    expect(routineUpdateMessage('Back Day', { swaps: [], added: [] }, nameOf)).toBe(
      "Save today's sets and weights to 'Back Day' for next time? Exercises you skipped stay in the routine.",
    );
  });
  it('names a slot whose exercise will change, and added exercises', () => {
    const msg = routineUpdateMessage(
      'Back Day',
      { swaps: [{ routineExerciseId: 's', from: 'lat', to: 'hammer' }], added: ['curl'] },
      nameOf,
    );
    expect(msg).toContain('Lat Pulldown (Cable) will become Lat Pulldown (Cable) - Hammer Strength.');
    expect(msg).toContain('Bicep Curl (Dumbbell) will be added.');
    expect(routineUpdateMessage('X', { swaps: [], added: ['a', 'b'] }, nameOf)).toContain('A and B will be added.');
    expect(routineUpdateMessage('X', { swaps: [], added: ['a', 'b', 'c', 'd'] }, nameOf)).toContain('A, B and 2 more will be added.');
  });
});
