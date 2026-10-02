import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Routine, RoutineExercise, RoutineSet, SetEntry, Workout, WorkoutExercise } from '../../types';
import { db } from '../../db';
import { buildExerciseIndex } from '../../lib/exercises';
import {
  createFolder,
  createFolderLast,
  createRoutine,
  deleteFolder,
  duplicateRoutineLast,
  mergeWorkoutIntoRoutine,
  moveRoutineToFolder,
  nextRoutineOrder,
  planRoutineUpdate,
  reorderRoutines,
  routineExerciseSwaps,
  workoutDiffersFromRoutine,
} from '../../lib/routines';
import { setNumberLabels, typeFields } from '../../lib/exerciseMeta';
import { REST_OPTIONS, restOptionLabel, restOptionsWith, restSettingLabel } from '../../lib/rest';
import { REST_OPTIONS as LOGGER_REST_OPTIONS, setBadges as loggerSetBadges } from '../workout/logic';
import {
  blankRoutineSet,
  cleanupSupersets,
  copyRoutineExercise,
  exercisePreview,
  fitSetsToFields,
  flattenGroupOrder,
  formatReps,
  joinSuperset,
  leaveSuperset,
  moveItem,
  nextSet,
  normalizeRepsText,
  parseRepsInput,
  routineExerciseFromSource,
  routineExercisesFromPicks,
  routineSetsFromPrevious,
  setBadges,
  supersetIndex,
} from './routineUtils';
import { addStarterRoutines, buildStarterRoutines } from './starterRoutines';

const re = (id: string, supersetId: string | null = null, sets: RoutineSet[] = [blankRoutineSet()]): RoutineExercise => ({
  id,
  exerciseId: 'ex_' + id,
  supersetId,
  restSec: null,
  sets,
});

describe('parseRepsInput', () => {
  it('parses single numbers and ranges', () => {
    expect(parseRepsInput('')).toEqual({ reps: null, repsMax: null });
    expect(parseRepsInput('10')).toEqual({ reps: 10, repsMax: null });
    expect(parseRepsInput('8-12')).toEqual({ reps: 8, repsMax: 12 });
    expect(parseRepsInput('8 – 12')).toEqual({ reps: 8, repsMax: 12 });
  });
  it('accepts iOS-keypad separators, swaps reversed ranges, collapses equal bounds', () => {
    expect(parseRepsInput('8.12')).toEqual({ reps: 8, repsMax: 12 });
    expect(parseRepsInput('8,12')).toEqual({ reps: 8, repsMax: 12 });
    expect(parseRepsInput('12-8')).toEqual({ reps: 8, repsMax: 12 });
    expect(parseRepsInput('10-10')).toEqual({ reps: 10, repsMax: null });
    expect(parseRepsInput('8-')).toEqual({ reps: 8, repsMax: null });
  });
  it('normalizes what is typed: phone-pad separators become one "-"', () => {
    expect(normalizeRepsText('8.12')).toBe('8-12');
    expect(normalizeRepsText('8,12')).toBe('8-12');
    expect(normalizeRepsText('8 12')).toBe('8-12');
    expect(normalizeRepsText('8--12')).toBe('8-12');
    expect(normalizeRepsText('8-12-15')).toBe('8-12');
    expect(normalizeRepsText('8-12.')).toBe('8-12');
    expect(normalizeRepsText('-8')).toBe('8');
    expect(normalizeRepsText('8.')).toBe('8-');
    expect(normalizeRepsText('abc10')).toBe('10');
    expect(parseRepsInput(normalizeRepsText('8.12'))).toEqual({ reps: 8, repsMax: 12 });
  });
  it('round-trips with formatReps', () => {
    expect(formatReps(8, 12)).toBe('8-12');
    expect(formatReps(8, null)).toBe('8');
    expect(formatReps(null, null)).toBe('');
    for (const t of ['5', '6-10', '12-15']) {
      const p = parseRepsInput(t);
      expect(formatReps(p.reps, p.repsMax)).toBe(t);
    }
  });
});

describe('set badges', () => {
  it('numbers working sets like the logger (warm-ups excluded, F/D replace their number)', () => {
    const types = ['warmup', 'warmup', 'normal', 'normal', 'failure', 'drop', 'normal'] as const;
    expect(setBadges(types.map((type) => ({ type })))).toEqual(['W', 'W', '1', '2', 'F', 'D', '5']);
  });
  it('matches the workout logger exactly (both use lib/exerciseMeta setNumberLabels)', () => {
    const types = ['warmup', 'normal', 'failure', 'normal', 'drop', 'drop', 'normal', 'warmup', 'normal'] as const;
    const sets = types.map((type, i) => ({ id: String(i), type, done: false }));
    expect(setBadges(sets)).toEqual(loggerSetBadges(sets).map((b) => b.label));
    expect(setBadges(sets)).toEqual(setNumberLabels(sets));
    expect(setBadges(sets)).toEqual(['W', '1', 'F', '3', 'D', 'D', '6', 'W', '7']);
  });
});

describe('exercisePreview', () => {
  it('shows up to 4 names, else 3 + "& N more"', () => {
    expect(exercisePreview([])).toBe('No exercises yet');
    expect(exercisePreview(['A', 'B', 'C', 'D'])).toBe('A, B, C, D');
    expect(exercisePreview(['A', 'B', 'C', 'D', 'E', 'F'])).toBe('A, B, C & 3 more');
  });
});

describe('rest options (lib/rest.ts, one vocabulary app-wide)', () => {
  it("offers exactly the workout logger's choices: Off, 5s … 5:00", () => {
    expect(LOGGER_REST_OPTIONS).toBe(REST_OPTIONS); // the logger re-exports the shared list
    expect([...REST_OPTIONS]).toEqual([0, 5, 10, 15, 20, 30, 45, 60, 75, 90, 105, 120, 150, 180, 210, 240, 300]);
    expect(new Set(REST_OPTIONS).size).toBe(REST_OPTIONS.length);
  });
  it('labels every option "Off" / "45s" / "1:30"', () => {
    expect(REST_OPTIONS.map(restOptionLabel)).toEqual([
      'Off', '5s', '10s', '15s', '20s', '30s', '45s', '1:00', '1:15', '1:30', '1:45', '2:00', '2:30', '3:00', '3:30', '4:00', '5:00',
    ]);
  });
  it('labels the default with the settings value', () => {
    expect(restSettingLabel(null, 90)).toBe('Default (1:30)');
    expect(restSettingLabel(undefined, 45)).toBe('Default (45s)');
    expect(restSettingLabel(null, 0)).toBe('Default (Off)');
    expect(restSettingLabel(0, 90)).toBe('Off');
    expect(restSettingLabel(150, 90)).toBe('2:30');
  });
  it('adds an off-list current value so it can show as chosen', () => {
    expect(restOptionsWith(90)).toEqual([...REST_OPTIONS]);
    expect(restOptionsWith(100)).toContain(100);
    expect(restOptionsWith(100).indexOf(100)).toBe(REST_OPTIONS.indexOf(90) + 1);
    expect(restOptionsWith(null)).toEqual([...REST_OPTIONS]);
  });
});

describe('supersets', () => {
  it('joins, extends and leaves supersets; drops single-member ids', () => {
    let list = [re('a'), re('b'), re('c')];
    list = joinSuperset(list, 'a', 'b');
    const sid = list[0].supersetId;
    expect(sid).toBeTruthy();
    expect(list[1].supersetId).toBe(sid);
    list = joinSuperset(list, 'c', 'a'); // joins the existing one
    expect(list.every((e) => e.supersetId === sid)).toBe(true);
    list = leaveSuperset(list, 'a');
    expect(list[0].supersetId).toBeNull();
    expect(list[1].supersetId).toBe(sid);
    list = leaveSuperset(list, 'b');
    expect(list.every((e) => !e.supersetId)).toBe(true); // c alone is no superset
  });
  it('indexes supersets by first appearance', () => {
    const idx = supersetIndex([re('a', 'x'), re('b', 'y'), re('c', 'x')]);
    expect(idx.get('x')).toBe(0);
    expect(idx.get('y')).toBe(1);
    expect(cleanupSupersets([re('a', 'x'), re('b', 'y'), re('c', 'x')]).map((e) => e.supersetId)).toEqual(['x', null, 'x']);
  });
});

describe('set builders', () => {
  it('nextSet copies the last values (warm-up stays warm-up, failure becomes normal)', () => {
    const s = nextSet([blankRoutineSet({ type: 'failure', weightKg: 50, reps: 8, repsMax: 12 })]);
    expect(s).toMatchObject({ type: 'normal', weightKg: 50, reps: 8, repsMax: 12 });
    expect(nextSet([blankRoutineSet({ type: 'warmup', weightKg: 20 })]).type).toBe('warmup');
    expect(nextSet([]).type).toBe('normal');
  });
  it('mirrors a previous session and deep-copies routine exercises with new ids', () => {
    const prev: SetEntry[] = [
      { id: '1', type: 'warmup', weightKg: 20, reps: 10, done: true },
      { id: '2', type: 'normal', weightKg: 60, reps: 8, done: true },
    ];
    const sets = routineSetsFromPrevious(prev);
    expect(sets.map((s) => [s.type, s.weightKg, s.reps])).toEqual([
      ['warmup', 20, 10],
      ['normal', 60, 8],
    ]);
    const src = re('a', 'x', sets);
    const copy = copyRoutineExercise(src);
    expect(copy.id).not.toBe(src.id);
    expect(copy.supersetId).toBeNull();
    expect(copy.sets.map((s) => s.id)).not.toEqual(src.sets.map((s) => s.id));
    expect(copy.sets.map((s) => s.weightKg)).toEqual([20, 60]);
  });
});

describe('fitSetsToFields', () => {
  it('clears values the new exercise type has no column for', () => {
    const sets = [blankRoutineSet({ weightKg: 40, reps: 8, repsMax: 12, durationSec: 30, distanceM: 100 })];
    expect(fitSetsToFields(sets, typeFields('duration'))[0]).toMatchObject({
      weightKg: null,
      reps: null,
      repsMax: null,
      durationSec: 30,
      distanceM: null,
    });
    expect(fitSetsToFields(sets, typeFields('weight_reps'))[0]).toMatchObject({ weightKg: 40, reps: 8, repsMax: 12, durationSec: null });
  });
});

describe('ordering helpers', () => {
  it('moves items and flattens the per-folder order', () => {
    expect(moveItem(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
    expect(moveItem(['a', 'b', 'c'], 5, 0)).toEqual(['a', 'b', 'c']);
    const groups = [
      { key: 'mine', ids: ['a', 'b'] },
      { key: 'f1', ids: ['c', 'd', 'e'] },
    ];
    expect(flattenGroupOrder(groups, 'f1', ['e', 'c', 'd'])).toEqual(['a', 'b', 'e', 'c', 'd']);
  });
});

describe('starter routines', () => {
  const index = buildExerciseIndex([], []);

  it('builds Push / Pull / Legs from the catalog with 3 sets and rep ranges', () => {
    const built = buildStarterRoutines(index.list);
    expect(built.map((r) => r.name)).toEqual(['Push', 'Pull', 'Legs']);
    for (const r of built) {
      expect(r.exercises.length).toBeGreaterThanOrEqual(5);
      expect(r.exercises.length).toBeLessThanOrEqual(6);
      expect(new Set(r.exercises.map((e) => e.exerciseId)).size).toBe(r.exercises.length);
      for (const e of r.exercises) {
        expect(index.byId.has(e.exerciseId)).toBe(true);
        expect(e.sets).toHaveLength(3);
        for (const s of e.sets) {
          expect(s.weightKg).toBeNull();
          expect(s.reps).toBeGreaterThan(0);
          expect(s.repsMax!).toBeGreaterThan(s.reps!);
        }
      }
    }
  });

  it('never crashes when exercises are missing (skips them)', () => {
    expect(buildStarterRoutines([])).toEqual([]);
    const partial = index.list.filter((e) => /squat|press/i.test(e.name));
    const built = buildStarterRoutines(partial);
    for (const r of built) expect(r.exercises.length).toBeGreaterThan(0);
  });

  it('matches renamed exercises by their original name', () => {
    const renamed = buildExerciseIndex([], [{ id: 'Barbell_Squat', name: 'Back Squat (Rogue rack)' }]);
    const legs = buildStarterRoutines(renamed.list).find((r) => r.name === 'Legs')!;
    expect(legs.exercises[0].exerciseId).toBe('Barbell_Squat');
  });
});

describe('routine DB helpers', () => {
  beforeEach(async () => {
    await db.routines.clear();
    await db.folders.clear();
  });

  it('reorders, moves to folders and adds starters in a Starter folder', async () => {
    const a = await createRoutine({ name: 'A', order: 0 });
    const b = await createRoutine({ name: 'B', order: 1 });
    const c = await createRoutine({ name: 'C', order: 2 });
    expect(await nextRoutineOrder()).toBe(3);

    await reorderRoutines([c, a, b, 'missing']);
    const sorted = (await db.routines.toArray()).sort((x, y) => x.order - y.order).map((r) => r.name);
    expect(sorted).toEqual(['C', 'A', 'B']);

    const f = await createFolder('Upper');
    await moveRoutineToFolder(a, f);
    const moved = await db.routines.get(a);
    expect(moved?.folderId).toBe(f);
    expect(moved?.order).toBe(3);

    const n = await addStarterRoutines(buildExerciseIndex([], []).list);
    expect(n).toBe(3);
    const starter = (await db.folders.toArray()).find((x) => x.name === 'Starter');
    expect(starter).toBeTruthy();
    const inStarter = await db.routines.where('folderId').equals(starter!.id).toArray();
    expect(inStarter.map((r) => r.name).sort()).toEqual(['Legs', 'Pull', 'Push']);
  });

  it('puts new folders and duplicates after everything else, even after deletions', async () => {
    const f1 = await createFolderLast('One');
    const f2 = await createFolderLast('Two');
    const f3 = await createFolderLast('Three');
    await deleteFolder(f2);
    const f4 = await createFolderLast('Four');
    const folders = (await db.folders.toArray()).sort((a, b) => a.order - b.order).map((f) => f.id);
    expect(folders).toEqual([f1, f3, f4]);

    const a = await createRoutine({ name: 'A', order: 0 });
    await createRoutine({ name: 'B', order: 5 });
    const copy = await duplicateRoutineLast(a);
    const row = await db.routines.get(copy!);
    expect(row?.name).toBe('A (Copy)');
    expect(row?.order).toBe(6);
  });
});

describe('Update routine after a variant swap / Replace', () => {
  // routineExerciseId = the routine slot the workout exercise was started from (absent on legacy workouts).
  const done = (weightKg: number | null, reps: number | null, extra: Partial<SetEntry> = {}): SetEntry => ({
    id: Math.random().toString(36).slice(2),
    type: 'normal',
    weightKg,
    reps,
    done: true,
    ...extra,
  });
  const plan = (weightKg: number | null, reps: number | null, extra: Partial<RoutineSet> = {}) => blankRoutineSet({ weightKg, reps, ...extra });
  const slot = (id: string, exerciseId: string, sets: RoutineSet[], supersetId: string | null = null): RoutineExercise => ({
    id,
    exerciseId,
    restSec: null,
    supersetId,
    sets,
  });
  const routineOf = (exercises: RoutineExercise[]): Routine => ({
    id: 'r',
    name: 'Back Day',
    folderId: null,
    order: 0,
    exercises,
    createdAt: 0,
    updatedAt: 0,
    lastPerformedAt: null,
  });
  const did = (id: string, exerciseId: string, sets: SetEntry[], routineExerciseId?: string): WorkoutExercise => ({
    id,
    exerciseId,
    sets,
    ...(routineExerciseId ? { routineExerciseId } : {}),
  });
  const workoutOf = (exercises: WorkoutExercise[]): Workout => ({
    id: 'w',
    name: 'w',
    startedAt: 0,
    endedAt: 3_600_000,
    durationSec: 3600,
    routineId: 'r',
    exercises,
    exerciseIds: exercises.map((e) => e.exerciseId),
    photoIds: [],
    volumeKg: 0,
    setCount: 0,
    prs: [],
    createdAt: 0,
    updatedAt: 0,
  });

  it('a swapped variant takes its slot in place (same index, id and superset), nothing appended', () => {
    const r = routineOf([slot('re1', 'lat_cable', [plan(50, 10)], 'ss1'), slot('re2', 'row', [plan(40, 10)], 'ss1')]);
    const w = workoutOf([did('w1', 'lat_hammer', [done(60, 10)], 're1')]);
    const merged = mergeWorkoutIntoRoutine(r, w);
    expect(merged.map((e) => e.exerciseId)).toEqual(['lat_hammer', 'row']);
    expect(merged[0]).toMatchObject({ id: 're1', supersetId: 'ss1' });
    expect(merged[0].sets).toEqual([expect.objectContaining({ id: r.exercises[0].sets[0].id, weightKg: 60, reps: 10 })]);
    expect(merged[1]).toBe(r.exercises[1]);
    expect(workoutDiffersFromRoutine(r, w)).toBe(true);
    expect(routineExerciseSwaps(r, w)).toEqual([{ routineExerciseId: 're1', from: 'lat_cable', to: 'lat_hammer' }]);
  });

  it('legacy workouts without a link still merge by exerciseId', () => {
    const r = routineOf([slot('re1', 'bench', [plan(60, 6, { repsMax: 10 })]), slot('re2', 'fly', [plan(20, 12)])]);
    const w = workoutOf([did('w1', 'bench', [done(65, 8)]), did('w2', 'curl', [done(15, 10)])]);
    const merged = mergeWorkoutIntoRoutine(r, w);
    expect(merged.map((e) => e.exerciseId)).toEqual(['bench', 'fly', 'curl']);
    expect(merged[0]).toMatchObject({ id: 're1' });
    expect(merged[0].sets[0]).toMatchObject({ weightKg: 65, reps: 6, repsMax: 10 });
    expect(merged[2].supersetId).toBeNull();
    expect(routineExerciseSwaps(r, w)).toEqual([]);
  });

  it('A and B swapped with each other land in the right slots (the fallback cannot steal a linked one)', () => {
    const r = routineOf([slot('re1', 'A', [plan(10, 10)]), slot('re2', 'B', [plan(20, 10)])]);
    // Logged in workout order B (from slot re1) then A (from slot re2).
    const w = workoutOf([did('w1', 'B', [done(30, 8)], 're1'), did('w2', 'A', [done(40, 8)], 're2')]);
    const merged = mergeWorkoutIntoRoutine(r, w);
    expect(merged.map((e) => [e.id, e.exerciseId, e.sets[0].weightKg])).toEqual([
      ['re1', 'B', 30],
      ['re2', 'A', 40],
    ]);
    // re1 was skipped; re2 was swapped to A. A by exerciseId must not be pulled into re1.
    const w2 = workoutOf([did('w1', 'A', [done(40, 8)], 're2')]);
    const merged2 = mergeWorkoutIntoRoutine(r, w2);
    expect(merged2[0]).toBe(r.exercises[0]);
    expect(merged2[1]).toMatchObject({ id: 're2', exerciseId: 'A' });
    expect(merged2).toHaveLength(2);
  });

  it('two instances linked to the same slot: the first merges, the second is appended', () => {
    const r = routineOf([slot('re1', 'lat_cable', [plan(50, 10)])]);
    const w = workoutOf([did('w1', 'lat_hammer', [done(60, 10)], 're1'), did('w2', 'lat_cable', [done(55, 10)], 're1')]);
    const merged = mergeWorkoutIntoRoutine(r, w);
    expect(merged.map((e) => [e.exerciseId, e.sets[0].weightKg])).toEqual([
      ['lat_hammer', 60],
      ['lat_cable', 55],
    ]);
    expect(merged[0].id).toBe('re1');
    expect(merged[1].id).not.toBe('re1');
  });

  it('a swap whose sets equal another slot plan still prompts (no false "unchanged")', () => {
    const r = routineOf([slot('re1', 'A', [plan(20, 10)]), slot('re2', 'B', [plan(20, 10)])]);
    const swapped = workoutOf([did('w1', 'B', [done(20, 10)], 're1'), did('w2', 'B', [done(20, 10)], 're2')]);
    expect(workoutDiffersFromRoutine(r, swapped)).toBe(true);
    const same = workoutOf([did('w1', 'A', [done(20, 10)], 're1'), did('w2', 'B', [done(20, 10)], 're2')]);
    expect(workoutDiffersFromRoutine(r, same)).toBe(false);
    // Legacy (no links), unchanged: no prompt either.
    expect(workoutDiffersFromRoutine(r, workoutOf([did('w1', 'A', [done(20, 10)]), did('w2', 'B', [done(20, 10)])]))).toBe(false);
  });

  it('Replace with a timed exercise does not carry the old rep range over', () => {
    const r = routineOf([slot('re1', 'crunch', [plan(null, 10, { repsMax: 15 })])]);
    const w = workoutOf([did('w1', 'plank', [done(null, null, { durationSec: 60 })], 're1')]);
    const [m] = mergeWorkoutIntoRoutine(r, w);
    expect(m).toMatchObject({ id: 're1', exerciseId: 'plank' });
    expect(m.sets[0]).toMatchObject({ reps: null, repsMax: null, durationSec: 60 });
  });
});

// ------------------------------------------------------------------ routine editor: adding picks

describe('routine editor: adding exercises from the picker', () => {
  const rs = (weightKg: number | null, reps: number | null, extra: Partial<RoutineSet> = {}) => blankRoutineSet({ weightKg, reps, ...extra });
  const source: Routine = {
    id: 'src',
    name: 'Upper',
    folderId: null,
    order: 0,
    createdAt: 0,
    updatedAt: 0,
    exercises: [
      { id: 'a1', exerciseId: 'bench', supersetId: 's1', notes: 'pause', restSec: 120, sets: [rs(80, 5), rs(80, 5)] },
      { id: 'a2', exerciseId: 'lat_cable', supersetId: 's1', restSec: 90, sets: [rs(null, 10, { type: 'warmup' }), rs(60, 8, { repsMax: 12 })] },
      { id: 'solo', exerciseId: 'plank', sets: [rs(null, null, { durationSec: 60 })] },
    ],
  };
  const pick = (reId: string, exerciseId: string) => ({ exerciseId, fromRoutine: { routineId: 'src', routineExerciseId: reId } });
  const base = { sources: new Map([['src', source]]), existing: [], history: [], previousMode: 'any' as const, routineId: 'edited', superset: false };

  it("keeps the source routine's supersets under a fresh id; the solo pick stays solo", () => {
    const out = routineExercisesFromPicks([pick('a1', 'bench'), pick('a2', 'lat_cable'), pick('solo', 'plank')], base);
    expect(out.map((e) => e.exerciseId)).toEqual(['bench', 'lat_cable', 'plank']);
    expect(out[0].supersetId).toBeTruthy();
    expect(out[0].supersetId).not.toBe('s1');
    expect(out[1].supersetId).toBe(out[0].supersetId);
    expect(out[2].supersetId).toBeNull();
    expect(out[0]).toMatchObject({ notes: 'pause', restSec: 120 });
    expect(out[0].id).not.toBe('a1');
    expect(out[0].sets[0].id).not.toBe(source.exercises[0].sets[0].id);
    // A second batch from the same routine gets its own group.
    const again = routineExercisesFromPicks([pick('a1', 'bench'), pick('a2', 'lat_cable')], base);
    expect(again[0].supersetId).toBe(again[1].supersetId);
    expect(again[0].supersetId).not.toBe(out[0].supersetId);
  });

  it('picking only one member of a source superset adds it solo; "Add as Superset" groups the whole batch', () => {
    expect(routineExercisesFromPicks([pick('a1', 'bench')], base)[0].supersetId).toBeNull();
    const grouped = routineExercisesFromPicks([pick('a1', 'bench'), pick('solo', 'plank')], { ...base, superset: true });
    expect(grouped[0].supersetId).toBeTruthy();
    expect(grouped[1].supersetId).toBe(grouped[0].supersetId);
  });

  it('a variant picked in place of the routine exercise keeps the plan but not the planned weights', () => {
    const [v] = routineExercisesFromPicks([pick('a2', 'lat_hammer')], base);
    expect(v).toMatchObject({ exerciseId: 'lat_hammer', restSec: 90 });
    expect(v.sets.map((s) => [s.type, s.weightKg, s.reps, s.repsMax ?? null])).toEqual([
      ['warmup', null, 10, null],
      ['normal', null, 8, 12],
    ]);
    // Same exercise: weights stay.
    expect(routineExerciseFromSource(source.exercises[1], 'lat_cable').sets[1].weightKg).toBe(60);
    // A different type drops the columns it has no use for.
    const timed = routineExerciseFromSource(source.exercises[1], 'plank', typeFields('duration'));
    expect(timed.sets.every((s) => s.reps == null && s.repsMax == null && s.weightKg == null)).toBe(true);
  });

  it('plain picks mirror the previous session of that instance, like the logger (never merged)', () => {
    const w = (id: string, startedAt: number, routineId: string | null, blocks: number[][]): Workout => ({
      id,
      name: id,
      startedAt,
      endedAt: startedAt + 1,
      durationSec: 1,
      routineId,
      exercises: blocks.map((weights, i) => ({
        id: `${id}-${i}`,
        exerciseId: 'bench',
        sets: weights.map((kg, j) => ({ id: `${id}-${i}-${j}`, type: 'normal' as const, weightKg: kg, reps: 5, done: true })),
      })),
      exerciseIds: ['bench'],
      photoIds: [],
      volumeKg: 0,
      setCount: 0,
      prs: [],
      createdAt: startedAt,
      updatedAt: startedAt,
    });
    const history = [w('new', 3, null, [[100, 100], [70]]), w('old', 2, 'edited', [[90]])];
    const opts = { ...base, history };
    // First Bench in the routine: last time's first block (2 sets, not 3 merged).
    expect(routineExercisesFromPicks([{ exerciseId: 'bench' }], opts)[0].sets.map((s) => s.weightKg)).toEqual([100, 100]);
    // Already one Bench in the routine: the new one mirrors last time's second block.
    const second = routineExercisesFromPicks([{ exerciseId: 'bench' }], { ...opts, existing: [{ exerciseId: 'bench' }] });
    expect(second[0].sets.map((s) => s.weightKg)).toEqual([70]);
    // Two Benches in one batch: first and second block.
    const both = routineExercisesFromPicks([{ exerciseId: 'bench' }, { exerciseId: 'bench' }], opts);
    expect(both.map((e) => e.sets.map((s) => s.weightKg))).toEqual([[100, 100], [70]]);
    // "Same routine" previous values prefer this routine's last session.
    const same = routineExercisesFromPicks([{ exerciseId: 'bench' }], { ...opts, previousMode: 'same_routine' });
    expect(same[0].sets.map((s) => s.weightKg)).toEqual([90]);
    // Never done: 3 empty sets.
    expect(routineExercisesFromPicks([{ exerciseId: 'squat' }], opts)[0].sets).toHaveLength(3);
  });
});

// ------------------------------------------------------------------ Update routine: one path (links + splits)

describe('planRoutineUpdate', () => {
  const plan = (weightKg: number | null, reps: number | null) => blankRoutineSet({ weightKg, reps });
  const done = (weightKg: number, reps: number): SetEntry => ({ id: Math.random().toString(36).slice(2), type: 'normal', weightKg, reps, done: true });
  const routine: Routine = {
    id: 'r',
    name: 'Back Day',
    folderId: null,
    order: 0,
    createdAt: 0,
    updatedAt: 0,
    exercises: [
      { id: 'slot', exerciseId: 'lat_cable', supersetId: null, sets: [plan(60, 8), plan(60, 8), plan(60, 8)] },
      { id: 'row', exerciseId: 'row', supersetId: null, sets: [plan(50, 10)] },
    ],
  };
  const workoutOf = (exercises: WorkoutExercise[]): Workout => ({
    id: 'w',
    name: 'w',
    startedAt: 0,
    endedAt: 1,
    durationSec: 1,
    routineId: 'r',
    exercises,
    exerciseIds: exercises.map((e) => e.exerciseId),
    photoIds: [],
    volumeKg: 0,
    setCount: 0,
    prs: [],
    createdAt: 0,
    updatedAt: 0,
  });

  it('a variant swap replaces the slot exercise and loads, and the plan names the swap', () => {
    const w = workoutOf([{ id: 'w1', exerciseId: 'lat_hammer', routineExerciseId: 'slot', sets: [done(45, 10), done(45, 10), done(45, 9)] }]);
    const p = planRoutineUpdate(routine, w);
    expect(p.changed).toBe(true);
    expect(p.swaps).toEqual([{ routineExerciseId: 'slot', from: 'lat_cable', to: 'lat_hammer' }]);
    expect(p.added).toEqual([]);
    expect(p.exercises.map((e) => [e.id, e.exerciseId, e.sets.map((s) => s.weightKg)])).toEqual([
      ['slot', 'lat_hammer', [45, 45, 45]],
      ['row', 'row', [50]],
    ]);
  });

  it('an unlinked exercise is appended and reported as added', () => {
    const w = workoutOf([
      { id: 'w1', exerciseId: 'lat_cable', routineExerciseId: 'slot', sets: [done(60, 8), done(60, 8), done(60, 8)] },
      { id: 'w2', exerciseId: 'curl', sets: [done(15, 12)] },
    ]);
    const p = planRoutineUpdate(routine, w);
    expect(p).toMatchObject({ changed: true, swaps: [], added: ['curl'] });
    expect(p.exercises.map((e) => e.exerciseId)).toEqual(['lat_cable', 'row', 'curl']);
  });

  it('a "keep completed sets" split keeps the slot on its machine with its full plan; the split-off card is not appended', () => {
    const w = workoutOf([
      { id: 'base', exerciseId: 'lat_cable', routineExerciseId: 'slot', sets: [done(65, 8), done(65, 8)] },
      { id: 'split', exerciseId: 'lat_hammer', routineExerciseId: 'slot', sets: [done(45, 10)] },
    ]);
    const p = planRoutineUpdate(routine, w, { split: 'base' });
    expect(p.swaps).toEqual([]);
    expect(p.added).toEqual([]);
    expect(p.exercises[0]).toMatchObject({ id: 'slot', exerciseId: 'lat_cable' });
    expect(p.exercises[0].sets.map((s) => s.weightKg)).toEqual([65, 65, 60]);
    expect(p.exercises).toHaveLength(2);
    // The building blocks give the same answer for the same splits.
    expect(mergeWorkoutIntoRoutine(routine, w, { split: 'base' }).map((e) => [e.exerciseId, e.sets.map((s) => s.weightKg)])).toEqual(
      p.exercises.map((e) => [e.exerciseId, e.sets.map((s) => s.weightKg)]),
    );
    expect(workoutDiffersFromRoutine(routine, w, { split: 'base' })).toBe(p.changed);
    expect(routineExerciseSwaps(routine, w, { split: 'base' })).toEqual(p.swaps);
    // Without the split info the second linked card is just another instance: appended.
    expect(planRoutineUpdate(routine, w).added).toEqual(['lat_hammer']);
  });

  it('a split-off card whose original card is gone takes the slot through its link', () => {
    const w = workoutOf([{ id: 'split', exerciseId: 'lat_hammer', routineExerciseId: 'slot', sets: [done(45, 10)] }]);
    const p = planRoutineUpdate(routine, w, { split: 'base' });
    expect(p.swaps).toEqual([{ routineExerciseId: 'slot', from: 'lat_cable', to: 'lat_hammer' }]);
    expect(p.exercises[0]).toMatchObject({ id: 'slot', exerciseId: 'lat_hammer' });
  });

  it('nothing to update when the workout matches the plan', () => {
    const w = workoutOf([{ id: 'w1', exerciseId: 'lat_cable', routineExerciseId: 'slot', sets: [done(60, 8), done(60, 8), done(60, 8)] }]);
    expect(planRoutineUpdate(routine, w).changed).toBe(false);
  });

  it('two slots of the same exercise: switching the SECOND one to a variant swaps that slot only', () => {
    const twice: Routine = {
      ...routine,
      exercises: [
        { id: 's1', exerciseId: 'lat_cable', supersetId: null, sets: [plan(60, 8)] },
        { id: 's2', exerciseId: 'lat_cable', supersetId: null, sets: [plan(40, 15)] },
      ],
    };
    const w = workoutOf([
      { id: 'w1', exerciseId: 'lat_cable', routineExerciseId: 's1', sets: [done(60, 8)] },
      { id: 'w2', exerciseId: 'lat_hammer', routineExerciseId: 's2', sets: [done(35, 15)] },
    ]);
    const p = planRoutineUpdate(twice, w);
    expect(p.swaps).toEqual([{ routineExerciseId: 's2', from: 'lat_cable', to: 'lat_hammer' }]);
    expect(p.added).toEqual([]);
    expect(p.exercises.map((e) => [e.id, e.exerciseId, e.sets[0].weightKg])).toEqual([
      ['s1', 'lat_cable', 60],
      ['s2', 'lat_hammer', 35],
    ]);
  });

  it('a variant done for a slot plus the base exercise added from the library: slot swapped, base appended', () => {
    const w = workoutOf([
      { id: 'w1', exerciseId: 'lat_hammer', routineExerciseId: 'slot', sets: [done(45, 10)] },
      { id: 'w2', exerciseId: 'lat_cable', sets: [done(60, 8)] },
    ]);
    const p = planRoutineUpdate(routine, w);
    expect(p.swaps).toEqual([{ routineExerciseId: 'slot', from: 'lat_cable', to: 'lat_hammer' }]);
    expect(p.added).toEqual(['lat_cable']);
    expect(p.exercises.map((e) => e.exerciseId)).toEqual(['lat_hammer', 'row', 'lat_cable']);
  });
});
