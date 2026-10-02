import { describe, expect, it } from 'vitest';
import type { RoutineSet, SetEntry, Workout, WorkoutExercise } from '../../types';
import { exerciseSessions } from '../../lib/calc';
import { KG_PER_LB, anyToMeters } from '../../lib/units';
import { deleteExerciseCopy, formatSetValue, relativeDay, routineSetsSummary, setLabels } from './format';
import { bestSet, computeUsage, lifetimeTotals, metricsFor, personalRecords } from './stats';
import { exKey, rtKey, selectCreated } from './selection';
import { formatAxis, formatValue, toDisplay } from './ExerciseChart';

const lb = (n: number) => n * KG_PER_LB;
let sid = 0;
const set = (p: Partial<SetEntry>): SetEntry => ({ id: `s${++sid}`, type: 'normal', done: true, ...p });
const we = (exerciseId: string, sets: SetEntry[]): WorkoutExercise => ({ id: `we${++sid}`, exerciseId, sets });
const workout = (id: string, startedAt: number, exercises: WorkoutExercise[]): Workout => ({
  id,
  name: `W ${id}`,
  startedAt,
  endedAt: startedAt + 3600_000,
  durationSec: 3600,
  exercises,
  exerciseIds: [...new Set(exercises.map((e) => e.exerciseId))],
  photoIds: [],
  volumeKg: 0,
  setCount: 0,
  prs: [],
  createdAt: startedAt,
  updatedAt: startedAt,
});

describe('formatSetValue', () => {
  it('formats weight × reps in the user unit', () => {
    expect(formatSetValue({ weightKg: lb(185), reps: 8 }, 'weight_reps', 'lb', 'mi')).toBe('185 lb × 8');
    expect(formatSetValue({ weightKg: 60, reps: 5 }, 'weight_reps', 'kg', 'km')).toBe('60 kg × 5');
  });
  it('handles bodyweight, weighted and assisted', () => {
    expect(formatSetValue({ reps: 12 }, 'bodyweight_reps', 'lb', 'mi')).toBe('12 reps');
    expect(formatSetValue({ weightKg: lb(25), reps: 6 }, 'weighted_bodyweight', 'lb', 'mi')).toBe('+25 lb × 6');
    expect(formatSetValue({ weightKg: lb(40), reps: 8 }, 'assisted_bodyweight', 'lb', 'mi')).toBe('-40 lb × 8');
    expect(formatSetValue({ weightKg: null, reps: 8 }, 'weighted_bodyweight', 'lb', 'mi')).toBe('8 reps');
  });
  it('handles duration and distance types', () => {
    expect(formatSetValue({ durationSec: 60 }, 'duration', 'lb', 'mi')).toBe('1:00');
    expect(formatSetValue({ distanceM: 5000, durationSec: 1500 }, 'distance_duration', 'kg', 'km')).toBe('5 km in 25:00');
    expect(formatSetValue({ weightKg: 20, durationSec: 45 }, 'duration_weight', 'kg', 'km')).toBe('20 kg × 0:45');
  });
  it('shows carries / sleds in yd or m, not mi or km', () => {
    expect(formatSetValue({ weightKg: lb(60), distanceM: anyToMeters(40, 'yd') }, 'weight_distance', 'lb', 'mi')).toBe('60 lb × 40 yd');
    expect(formatSetValue({ weightKg: 25, distanceM: 20 }, 'weight_distance', 'kg', 'km')).toBe('25 kg × 20 m');
    expect(formatSetValue({ distanceM: 1609.344, durationSec: 480 }, 'distance_duration', 'lb', 'mi')).toBe('1 mi in 8:00');
  });
});

describe('setLabels', () => {
  it('numbers sets like the logger: warm-ups uncounted, F / D take their number', () => {
    expect(setLabels([{ type: 'normal' }, { type: 'failure' }, { type: 'normal' }])).toEqual(['1', 'F', '3']);
    expect(setLabels([{ type: 'warmup' }, { type: 'normal' }, { type: 'drop' }, { type: 'drop' }, { type: 'normal' }])).toEqual([
      'W',
      '1',
      'D',
      'D',
      '4',
    ]);
  });
  it('numbers normal sets and letters typed sets', () => {
    expect(setLabels([{ type: 'warmup' }, { type: 'normal' }, { type: 'normal' }, { type: 'drop' }, { type: 'failure' }])).toEqual([
      'W',
      '1',
      '2',
      'D',
      'F',
    ]);
  });
});

describe('routineSetsSummary', () => {
  const rs = (p: Partial<RoutineSet>): RoutineSet => ({ id: `r${++sid}`, type: 'normal', ...p });
  it('summarises a rep range and a single weight', () => {
    const sets = [1, 2, 3].map(() => rs({ reps: 8, repsMax: 12, weightKg: lb(135) }));
    expect(routineSetsSummary(sets, 'weight_reps', 'lb', 'mi')).toBe('3 sets · 8–12 reps · 135 lb');
  });
  it('shows weight ranges and ignores warm-ups', () => {
    const sets = [rs({ type: 'warmup', reps: 15, weightKg: lb(45) }), rs({ reps: 8, weightKg: lb(135) }), rs({ reps: 6, weightKg: lb(155) })];
    expect(routineSetsSummary(sets, 'weight_reps', 'lb', 'mi')).toBe('3 sets · 6–8 reps · 135–155 lb');
  });
  it('omits missing values', () => {
    expect(routineSetsSummary([rs({}), rs({})], 'weight_reps', 'lb', 'mi')).toBe('2 sets');
    expect(routineSetsSummary([rs({ durationSec: 60 })], 'duration', 'lb', 'mi')).toBe('1 set · 1:00');
  });
  it('shows carry distances in yd / m', () => {
    expect(routineSetsSummary([rs({ weightKg: lb(60), distanceM: anyToMeters(40, 'yd') })], 'weight_distance', 'lb', 'mi')).toBe('1 set · 60 lb · 40 yd');
    expect(routineSetsSummary([rs({ distanceM: 20 }), rs({ distanceM: 40 })], 'weight_distance', 'kg', 'km')).toBe('2 sets · 20–40 m');
  });
});

describe('relativeDay', () => {
  const now = new Date(2026, 9, 1, 12).getTime();
  it('uses friendly day names', () => {
    expect(relativeDay(now - 3600_000, now)).toBe('Today');
    expect(relativeDay(now - 86400_000, now)).toBe('Yesterday');
    expect(relativeDay(now - 3 * 86400_000, now)).toBe('3 days ago');
    expect(relativeDay(now - 60 * 86400_000, now)).toBe('2 months ago');
  });
});

describe('bestSet', () => {
  it('picks the highest estimated 1RM, ignoring warm-ups', () => {
    const sets = [set({ type: 'warmup', weightKg: 200, reps: 1 }), set({ weightKg: 100, reps: 5 }), set({ weightKg: 90, reps: 10 })];
    expect(bestSet(sets, 'weight_reps')?.weightKg).toBe(90); // 90×(1+10/30)=120 > 100×(1+5/30)=116.7
  });
  it('uses most reps for bodyweight and longest for duration', () => {
    expect(bestSet([set({ reps: 10 }), set({ reps: 14 })], 'bodyweight_reps')?.reps).toBe(14);
    expect(bestSet([set({ durationSec: 30 }), set({ durationSec: 75 })], 'duration')?.durationSec).toBe(75);
  });
  it('returns null for no sets', () => {
    expect(bestSet([], 'weight_reps')).toBeNull();
  });
});

describe('computeUsage', () => {
  it('counts workouts per exercise and orders recents newest first', () => {
    const w1 = workout('w1', 1000, [we('bench', [set({ weightKg: 60, reps: 5 })]), we('row', [set({ weightKg: 50, reps: 8 })])]);
    const w2 = workout('w2', 2000, [we('squat', [set({ weightKg: 100, reps: 5 })]), we('bench', [set({ weightKg: 62.5, reps: 5 })])]);
    const w3 = workout('w3', 3000, [we('bench', [set({ weightKg: 65, reps: 3 })]), we('bench', [set({ weightKg: 40, reps: 10 })])]);
    const u = computeUsage([w3, w2, w1]);
    expect(u.recentIds).toEqual(['bench', 'squat', 'row']);
    expect(u.byId.get('bench')?.count).toBe(3);
    expect(u.byId.get('bench')?.lastWorkoutId).toBe('w3');
    expect(u.byId.get('bench')?.lastSets.map((s) => s.weightKg)).toEqual([65, 40]);
    expect(u.byId.get('row')?.count).toBe(1);
  });
});

describe('personalRecords + lifetimeTotals', () => {
  it('finds the best value per PR kind with the workout that set it', () => {
    const w1 = workout('w1', 1000, [we('bench', [set({ weightKg: 100, reps: 5 }), set({ weightKg: 80, reps: 12 })])]);
    const w2 = workout('w2', 2000, [we('bench', [set({ weightKg: 105, reps: 3 }), set({ type: 'warmup', weightKg: 200, reps: 1 })])]);
    const recs = personalRecords([w2, w1], 'bench', 'weight_reps');
    const byKind = Object.fromEntries(recs.map((r) => [r.kind, r]));
    expect(byKind.heaviest_weight.value).toBe(105);
    expect(byKind.heaviest_weight.workoutId).toBe('w2');
    expect(byKind.best_set_volume.value).toBe(960);
    expect(byKind.best_set_volume.workoutId).toBe('w1');
    // 100×5 → 116.7 beats 105×3 → 115.5 and 80×12 → 112; the 200 kg warm-up never counts.
    expect(byKind.best_1rm.workoutId).toBe('w1');
    expect(byKind.best_1rm.value).toBeCloseTo(116.67, 1);
    expect(byKind.best_1rm.set.weightKg).toBe(100);
  });

  it('totals sessions, sets, reps and volume', () => {
    const w1 = workout('w1', 1000, [we('bench', [set({ weightKg: 100, reps: 5 }), set({ weightKg: 100, reps: 5 })])]);
    const w2 = workout('w2', 2000, [we('bench', [set({ weightKg: 50, reps: 10 })])]);
    const t = lifetimeTotals(exerciseSessions([w1, w2], 'bench', 'weight_reps'));
    expect(t).toMatchObject({ sessions: 2, sets: 3, reps: 20, volumeKg: 1500 });
  });
});

describe('metricsFor', () => {
  it('offers type-appropriate chart metrics', () => {
    expect(metricsFor('weight_reps')[0]).toBe('heaviest');
    expect(metricsFor('bodyweight_reps')).toEqual(['maxReps', 'totalReps']);
    expect(metricsFor('duration')).toEqual(['maxDuration', 'totalDuration']);
    expect(metricsFor('distance_duration')).toContain('totalDistance');
  });
});

describe('selectCreated (picker selection after creating an exercise / variant)', () => {
  const lib = (id: string) => ({ key: exKey(id), pick: { exerciseId: id } });
  const rt = (id: string, reId: string) => ({
    key: rtKey('r1', reId),
    pick: { exerciseId: id, fromRoutine: { routineId: 'r1', routineExerciseId: reId } },
  });
  it('appends a brand-new exercise', () => {
    expect(selectCreated([lib('a')], 'c_new').map((s) => s.key)).toEqual(['ex:a', 'ex:c_new']);
  });
  it('puts a variant in its base exercise’s place (library pick)', () => {
    expect(selectCreated([lib('a'), lib('lat'), lib('b')], 'c_v', 'lat').map((s) => s.key)).toEqual(['ex:a', 'ex:c_v', 'ex:b']);
  });
  it('also replaces a routine pick of the base, keeps its routine plan and drops duplicates of it', () => {
    const out = selectCreated([rt('row', 're1'), rt('lat', 're2'), lib('lat'), rt('curl', 're3')], 'c_v', 'lat');
    expect(out.map((s) => s.pick.exerciseId)).toEqual(['row', 'c_v', 'curl']);
    expect(out[1].key).toBe('ex:c_v');
    expect(out[1].pick.fromRoutine).toEqual({ routineId: 'r1', routineExerciseId: 're2' });
  });
  it('takes the routine plan even when a library pick of the base comes first', () => {
    const out = selectCreated([lib('lat'), rt('lat', 're2')], 'c_v', 'lat');
    expect(out).toEqual([{ key: 'ex:c_v', pick: { exerciseId: 'c_v', fromRoutine: { routineId: 'r1', routineExerciseId: 're2' } } }]);
  });
  it('a library pick of the base becomes a plain pick of the variant', () => {
    expect(selectCreated([lib('lat')], 'c_v', 'lat')).toEqual([{ key: 'ex:c_v', pick: { exerciseId: 'c_v' } }]);
  });
  it('appends the variant when its base was not selected, and never duplicates it', () => {
    expect(selectCreated([lib('a')], 'c_v', 'lat').map((s) => s.key)).toEqual(['ex:a', 'ex:c_v']);
    expect(selectCreated([lib('c_v')], 'c_v').map((s) => s.key)).toEqual(['ex:c_v']);
  });
});

describe('chart value formatting (ExerciseChart)', () => {
  it('plots carries in yd / m instead of flattening them to 0.0x mi', () => {
    expect(toDisplay(36.576, 'distance', 'lb', 'yd')).toBe(40);
    expect(formatValue(toDisplay(36.576, 'distance', 'lb', 'yd'), 'distance', 'lb', 'yd')).toBe('40 yd');
    // A 5 m carry no longer rounds to 0 (which the chart filters out).
    expect(toDisplay(5, 'distance', 'kg', 'm')).toBe(5);
    expect(formatAxis(35, 'distance', 'm')).toBe('35');
    // Same 0.1 rounding as the rest of the app.
    expect(toDisplay(anyToMeters(40.5, 'yd'), 'distance', 'lb', 'yd')).toBe(40.5);
    expect(formatValue(40.5, 'distance', 'lb', 'yd')).toBe('40.5 yd');
  });
  it('keeps km / mi with decimals for runs', () => {
    expect(toDisplay(5000, 'distance', 'kg', 'km')).toBe(5);
    expect(formatValue(5.25, 'distance', 'kg', 'km')).toBe('5.25 km');
    expect(formatAxis(2.5, 'distance', 'mi')).toBe('2.5');
  });
});

describe('delete confirmation copy', () => {
  const none = { workouts: 0, routines: 0, activeWorkout: false, variants: 0 };
  it('an unused exercise is deleted', () => {
    expect(deleteExerciseCopy(none)).toMatchObject({ archive: false, confirmLabel: 'Delete' });
  });
  it('says it will be archived (kept for history) and why', () => {
    const inHistory = deleteExerciseCopy({ ...none, workouts: 3, routines: 1 });
    expect(inHistory).toMatchObject({ archive: true, confirmLabel: 'Archive' });
    expect(inHistory.message).toBe(
      "It's used in 3 workouts in your history and a routine, so it will be archived instead of deleted: hidden from your library, but kept for your history.",
    );
    expect(deleteExerciseCopy({ ...none, activeWorkout: true }).message).toMatch(/^It's used in your current workout, so it will be archived/);
    expect(deleteExerciseCopy({ ...none, routines: 2 }).message).toMatch(/^It's used in 2 routines, so it will be archived/);
    const base = deleteExerciseCopy({ ...none, variants: 2 });
    expect(base.archive).toBe(true);
    expect(base.message).toMatch(/^It has 2 machine\/brand variants, so it will be archived/);
    expect(base.message).toContain('Its variants keep their own history.');
    expect(deleteExerciseCopy({ ...none, workouts: 1, variants: 1 }).message).toMatch(
      /^It's used in a workout in your history and it has a machine\/brand variant, so .* Its variant keeps its own history\.$/,
    );
  });
});

