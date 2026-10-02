import { describe, expect, it } from 'vitest';
import type { SetEntry, Workout, WorkoutExercise } from '../../types';
import { anyToMeters, unitToKg, unitToMeters } from '../../lib/units';
import { setBadges as loggerSetBadges } from '../workout/logic';
import { setBadges as routineSetBadges } from '../routines/routineUtils';
import { setLabels as exerciseSetLabels } from '../exercises/format';
import { setNumberLabels } from '../../lib/exerciseMeta';
import {
  bestSet,
  formatE1RM,
  formatPRValue,
  formatSetValue,
  formatTimeRange,
  formatTotalTime,
  formatWorkoutDateRange,
  formatWorkoutWhen,
  groupByMonth,
  muscleSplit,
  ordinal,
  setLabels,
  supersetLetters,
  totals,
  weeklyStreak,
  workoutsByDay,
} from './historyUtils';

const at = (y: number, mo: number, d: number, h = 12, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
let n = 0;
const set = (p: Partial<SetEntry>): SetEntry => ({ id: `s${++n}`, type: 'normal', done: true, ...p });
const workout = (startedAt: number, p: Partial<Workout> = {}): Workout => ({
  id: `w${++n}`,
  name: 'W',
  startedAt,
  endedAt: startedAt + 3600_000,
  durationSec: 3600,
  exercises: [],
  exerciseIds: [],
  photoIds: [],
  volumeKg: 0,
  setCount: 0,
  prs: [],
  createdAt: startedAt,
  updatedAt: startedAt,
  ...p,
});

describe('dates', () => {
  const now = at(2026, 10, 1, 9);
  it('formats card dates relative to now', () => {
    expect(formatWorkoutWhen(at(2026, 10, 1, 6, 12), now)).toBe('Today, 6:12 AM');
    expect(formatWorkoutWhen(at(2026, 9, 30, 18, 12), now)).toBe('Yesterday, 6:12 PM');
    expect(formatWorkoutWhen(at(2026, 9, 28, 18, 12), now)).toBe('Mon, Sep 28 | 6:12 PM');
    expect(formatWorkoutWhen(at(2025, 9, 29, 18, 12), now)).toBe('Mon, Sep 29, 2025 | 6:12 PM');
  });
  it('formats time ranges', () => {
    expect(formatTimeRange(at(2026, 9, 28, 18, 12), at(2026, 9, 28, 19, 20))).toBe('6:12 – 7:20 PM');
    expect(formatTimeRange(at(2026, 9, 28, 11, 40), at(2026, 9, 28, 12, 30))).toBe('11:40 AM – 12:30 PM');
    expect(formatTimeRange(at(2026, 9, 28, 23, 40), at(2026, 9, 29, 0, 30))).toBe('11:40 PM – 12:30 AM (+1 day)');
    expect(formatWorkoutDateRange(at(2026, 9, 28, 18, 12), at(2026, 9, 28, 19, 20))).toBe(
      'Mon, Sep 28, 2026 | 6:12 – 7:20 PM',
    );
  });
  it('ordinals', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 101, 111].map(ordinal)).toEqual([
      '1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '101st', '111th',
    ]);
  });
  it('total time', () => {
    expect(formatTotalTime(45 * 60)).toBe('45m');
    expect(formatTotalTime(12 * 3600 + 5 * 60)).toBe('12h 5m');
    expect(formatTotalTime(3 * 3600)).toBe('3h');
    expect(formatTotalTime(152 * 3600 + 20 * 60)).toBe('152h');
  });
});

describe('weeklyStreak', () => {
  // Thu Oct 1 2026; Sunday-start weeks begin Sep 27, Sep 20, Sep 13...
  const now = at(2026, 10, 1, 9);
  it('is 0 without workouts', () => expect(weeklyStreak([], 0, now)).toBe(0));
  it('counts consecutive weeks including the current one', () => {
    expect(weeklyStreak([at(2026, 9, 28), at(2026, 9, 21), at(2026, 9, 22), at(2026, 9, 14)], 0, now)).toBe(3);
  });
  it('keeps the streak alive when this week has no workout yet', () => {
    expect(weeklyStreak([at(2026, 9, 21), at(2026, 9, 14)], 0, now)).toBe(2);
  });
  it('breaks after a full empty week', () => {
    expect(weeklyStreak([at(2026, 9, 14), at(2026, 9, 7)], 0, now)).toBe(0);
  });
  it('respects weekStartsOn', () => {
    // Sunday Sep 27: Monday-start weeks put it in the week of Sep 21 alongside Sep 21.
    const ts = [at(2026, 9, 27), at(2026, 9, 29)];
    expect(weeklyStreak(ts, 0, now)).toBe(1);
    expect(weeklyStreak(ts, 1, now)).toBe(2);
  });
});

describe('grouping', () => {
  const ws = [workout(at(2026, 10, 1)), workout(at(2026, 9, 28, 18)), workout(at(2026, 9, 28, 7)), workout(at(2026, 8, 2))];
  it('groups by month in order', () => {
    const g = groupByMonth(ws);
    expect(g.map((x) => [x.label, x.workouts.length])).toEqual([
      ['October 2026', 1],
      ['September 2026', 2],
      ['August 2026', 1],
    ]);
  });
  it('groups by day', () => {
    expect(workoutsByDay(ws).get('2026-09-28')?.length).toBe(2);
  });
  it('totals', () => {
    expect(totals([workout(0, { durationSec: 60, volumeKg: 10 }), workout(0, { durationSec: 30, volumeKg: 5 })])).toEqual({
      count: 2,
      durationSec: 90,
      volumeKg: 15,
    });
  });
});

describe('set formatting', () => {
  const lb = (v: number) => unitToKg(v, 'lb');
  it('weight & reps', () => {
    expect(formatSetValue(set({ weightKg: lb(135), reps: 8 }), 'weight_reps', 'lb', 'mi')).toBe('135 lb x 8');
    expect(formatSetValue(set({ weightKg: 60, reps: 5 }), 'weight_reps', 'kg', 'km')).toBe('60 kg x 5');
    expect(formatSetValue(set({ weightKg: lb(25), reps: 6 }), 'weighted_bodyweight', 'lb', 'mi')).toBe('+25 lb x 6');
    expect(formatSetValue(set({ weightKg: 0, reps: 12 }), 'weighted_bodyweight', 'lb', 'mi')).toBe('12 reps');
    expect(formatSetValue(set({ weightKg: lb(40), reps: 8 }), 'assisted_bodyweight', 'lb', 'mi')).toBe('-40 lb x 8');
    expect(formatSetValue(set({ reps: 1 }), 'bodyweight_reps', 'lb', 'mi')).toBe('1 rep');
  });
  it('time and distance', () => {
    expect(formatSetValue(set({ durationSec: 90 }), 'duration', 'lb', 'mi')).toBe('1:30');
    expect(formatSetValue(set({ distanceM: unitToMeters(2.1, 'mi'), durationSec: 1080 }), 'distance_duration', 'lb', 'mi')).toBe(
      '2.1 mi in 18:00',
    );
    expect(formatSetValue(set({ distanceM: 400, durationSec: 95 }), 'distance_duration', 'kg', 'km')).toBe('0.4 km in 1:35');
    expect(formatSetValue(set({ weightKg: lb(60), distanceM: anyToMeters(40, 'yd') }), 'weight_distance', 'lb', 'mi')).toBe(
      '60 lb | 40 yd',
    );
    expect(formatSetValue(set({ weightKg: 30, distanceM: 40 }), 'weight_distance', 'kg', 'km')).toBe('30 kg | 40 m');
    expect(formatSetValue(set({ weightKg: 20, durationSec: 45 }), 'duration_weight', 'kg', 'km')).toBe('20 kg | 0:45');
    expect(formatSetValue(set({ weightKg: 0, durationSec: 45 }), 'duration_weight', 'kg', 'km')).toBe('0:45');
    expect(formatSetValue(set({ weightKg: 0, distanceM: 40 }), 'weight_distance', 'kg', 'km')).toBe('40 m');
    expect(formatSetValue(set({ weightKg: 0, distanceM: anyToMeters(40, 'yd') }), 'weight_distance', 'lb', 'mi')).toBe('40 yd');
    // Long sled sessions stay in the logger's unit instead of flipping to "0.68 mi" / "1.1 km".
    expect(formatSetValue(set({ distanceM: 1100 }), 'weight_distance', 'lb', 'mi')).toBe(`${(1203).toLocaleString()} yd`);
    expect(formatSetValue(set({ distanceM: 1100 }), 'weight_distance', 'kg', 'km')).toBe(`${(1100).toLocaleString()} m`);
    // ...to 0.1 yd / m, not whole numbers.
    expect(formatSetValue(set({ weightKg: lb(60), distanceM: anyToMeters(40.5, 'yd') }), 'weight_distance', 'lb', 'mi')).toBe('60 lb | 40.5 yd');
    expect(formatSetValue(set({ distanceM: 36.576 }), 'weight_distance', 'kg', 'km')).toBe('36.6 m');
    // Runs keep the user's unit, with tiny distances falling back to meters.
    expect(formatSetValue(set({ distanceM: 100, durationSec: 20 }), 'distance_duration', 'lb', 'mi')).toBe('100 m in 0:20');
    expect(formatSetValue(set({}), 'duration', 'kg', 'km')).toBe('-');
  });
  it('e1RM only for weight & reps with 2+ reps', () => {
    expect(formatE1RM(set({ weightKg: 100, reps: 5 }), 'weight_reps', 'kg')).toBe('117 kg');
    expect(formatE1RM(set({ weightKg: 100, reps: 1 }), 'weight_reps', 'kg')).toBeNull();
    expect(formatE1RM(set({ weightKg: 100, reps: 5 }), 'weighted_bodyweight', 'kg')).toBeNull();
  });
  it('PR values', () => {
    expect(formatPRValue('heaviest_weight', lb(225), 'weight_reps', 'lb', 'mi')).toBe('225 lb');
    expect(formatPRValue('heaviest_weight', lb(45), 'weighted_bodyweight', 'lb', 'mi')).toBe('+45 lb');
    expect(formatPRValue('most_reps', 15, 'bodyweight_reps', 'lb', 'mi')).toBe('15 reps');
    expect(formatPRValue('longest_duration', 125, 'duration', 'lb', 'mi')).toBe('2:05');
    expect(formatPRValue('longest_distance', anyToMeters(40, 'yd'), 'weight_distance', 'lb', 'mi')).toBe('40 yd');
    expect(formatPRValue('longest_distance', 30, 'weight_distance', 'kg', 'km')).toBe('30 m');
    expect(formatPRValue('longest_distance', unitToMeters(3.1, 'mi'), 'distance_duration', 'lb', 'mi')).toBe('3.1 mi');
  });
  it('set labels match the logger: warm-ups excluded, F/D still count', () => {
    const sets = [set({ type: 'warmup' }), set({}), set({}), set({ type: 'failure' }), set({ type: 'drop' }), set({})];
    expect(setLabels(sets)).toEqual(['W', '1', '2', 'F', 'D', '5']);
    expect(setLabels([set({}), set({}), set({ type: 'failure' }), set({})])).toEqual(['1', '2', 'F', '4']);
  });
  it('set labels are identical to the workout logger, the routine editor and exercise history', () => {
    const types = ['warmup', 'normal', 'failure', 'normal', 'drop', 'drop', 'normal', 'warmup', 'normal'] as const;
    const sets = types.map((type) => set({ type, done: false }));
    const labels = setLabels(sets);
    expect(labels).toEqual(loggerSetBadges(sets).map((b) => b.label));
    expect(labels).toEqual(routineSetBadges(sets));
    expect(labels).toEqual(exerciseSetLabels(sets));
    expect(labels).toEqual(setNumberLabels(sets));
  });
});

describe('bestSet', () => {
  it('picks the highest estimated 1RM and ignores warm-ups', () => {
    const a = set({ weightKg: 100, reps: 5 }); // e1RM 116.7
    const b = set({ weightKg: 110, reps: 1 }); // 110
    const w = set({ type: 'warmup', weightKg: 140, reps: 5 });
    expect(bestSet([a, b, w], 'weight_reps')).toBe(a);
  });
  it('falls back to warm-ups when that is all there is', () => {
    const w = set({ type: 'warmup', weightKg: 40, reps: 10 });
    expect(bestSet([w], 'weight_reps')).toBe(w);
  });
  it('per type rules', () => {
    const r1 = set({ reps: 10 });
    const r2 = set({ reps: 12 });
    expect(bestSet([r1, r2], 'bodyweight_reps')).toBe(r2);
    const as1 = set({ weightKg: 40, reps: 8 });
    const as2 = set({ weightKg: 30, reps: 8 });
    expect(bestSet([as1, as2], 'assisted_bodyweight')).toBe(as2);
    const run1 = set({ distanceM: 5000, durationSec: 1500 });
    const run2 = set({ distanceM: 5000, durationSec: 1400 });
    expect(bestSet([run1, run2], 'distance_duration')).toBe(run2);
    expect(bestSet([], 'weight_reps')).toBeNull();
  });
});

describe('muscles & supersets', () => {
  const we = (exerciseId: string, sets: SetEntry[], supersetId?: string): WorkoutExercise => ({
    id: `we${++n}`,
    exerciseId,
    sets,
    supersetId,
  });
  it('counts primary 1 and secondary 0.5 per working set', () => {
    const get = (id: string) =>
      id === 'bench'
        ? { primary: 'chest' as const, secondary: ['triceps' as const, 'shoulders' as const] }
        : { primary: 'triceps' as const, secondary: [] };
    const out = muscleSplit(
      [we('bench', [set({ type: 'warmup' }), set({}), set({}), set({ done: false })]), we('push', [set({})])],
      get,
    );
    expect(out).toEqual({ chest: 2, triceps: 2, shoulders: 1 });
  });
  it('letters supersets with 2+ members', () => {
    const m = supersetLetters([{ supersetId: 'x' }, { supersetId: 'x' }, { supersetId: null }, { supersetId: 'y' }, { supersetId: 'z' }, { supersetId: 'z' }]);
    expect([...m.entries()]).toEqual([
      ['x', 'A'],
      ['z', 'B'],
    ]);
  });
});
