import { describe, expect, it } from 'vitest';
import type { Exercise, SetEntry, Workout, WorkoutExercise } from '../types';
import { formatClock, formatDuration, formatWeight, parseClock, parseDecimal, unitToKg, displayWeight, KG_PER_LB } from './units';
import { computeAllPRs, detectPRs, estimate1RM, exerciseSessions, previousInstanceSets, repRecords, setVolumeKg, workoutVolumeKg } from './calc';
import { estimateCalories, strengthMetForDensity } from './calories';

const set = (weightKg: number, reps: number, extra: Partial<SetEntry> = {}): SetEntry => ({
  id: Math.random().toString(36).slice(2),
  type: 'normal',
  weightKg,
  reps,
  done: true,
  ...extra,
});
const we = (exerciseId: string, sets: SetEntry[], id = exerciseId + '-we'): WorkoutExercise => ({ id, exerciseId, sets });
const workout = (id: string, startedAt: number, exercises: WorkoutExercise[], routineId: string | null = null): Workout => ({
  id,
  name: id,
  startedAt,
  endedAt: startedAt + 3600_000,
  durationSec: 3600,
  routineId,
  exercises,
  exerciseIds: exercises.map((e) => e.exerciseId),
  photoIds: [],
  volumeKg: 0,
  setCount: 0,
  prs: [],
  createdAt: startedAt,
  updatedAt: startedAt,
});
const typeOf = () => 'weight_reps' as const;

describe('units', () => {
  it('round-trips lb without drift', () => {
    expect(displayWeight(unitToKg(225, 'lb'), 'lb')).toBe(225);
    expect(displayWeight(unitToKg(132.5, 'lb'), 'lb')).toBe(132.5);
    expect(unitToKg(100, 'lb')).toBeCloseTo(100 * KG_PER_LB, 9);
  });
  it('formats weights, clocks and durations', () => {
    expect(formatWeight(100, 'kg')).toBe('100 kg');
    expect(formatWeight(null, 'kg')).toBe('-');
    expect(formatClock(65)).toBe('1:05');
    expect(formatClock(3725)).toBe('1:02:05');
    expect(formatDuration(3725)).toBe('1h 2min');
    expect(formatDuration(40)).toBe('40s');
  });
  it('parses user input', () => {
    expect(parseClock('1:30')).toBe(90);
    expect(parseClock('90')).toBe(90);
    expect(parseClock('1:02:03')).toBe(3723);
    expect(parseClock('abc')).toBeNull();
    expect(parseDecimal('62,5')).toBe(62.5);
    expect(parseDecimal('')).toBeNull();
  });
});

describe('calc', () => {
  it('estimates 1RM with Epley', () => {
    expect(estimate1RM(100, 1)).toBe(100);
    expect(estimate1RM(100, 10)).toBeCloseTo(133.33, 1);
    expect(estimate1RM(0, 5)).toBe(0);
  });
  it('only counts weight x reps volume for load-bearing types', () => {
    expect(setVolumeKg({ weightKg: 50, reps: 10 }, 'weight_reps')).toBe(500);
    expect(setVolumeKg({ weightKg: 50, reps: 10 }, 'assisted_bodyweight')).toBe(0);
    expect(workoutVolumeKg([we('a', [set(50, 10), set(60, 5, { done: false })])], typeOf)).toBe(500);
  });
  it('awards PRs only against previous history and only once per kind', () => {
    const w1 = workout('w1', 1, [we('bench', [set(100, 5)])]);
    const w2 = workout('w2', 2, [we('bench', [set(105, 5), set(110, 3)])]);
    const prs = computeAllPRs([w2, w1], typeOf);
    expect(prs.get('w1')).toEqual([]); // first time: no PR
    const kinds = prs.get('w2')!.map((p) => p.kind).sort();
    expect(kinds).toEqual(['best_1rm', 'best_set_volume', 'heaviest_weight']);
    expect(prs.get('w2')!.find((p) => p.kind === 'heaviest_weight')!.value).toBe(110);
  });
  it('ignores warm-up and unfinished sets for PRs', () => {
    const bests = new Map([['bench', { heaviest_weight: 100 }]]);
    const { prs } = detectPRs([we('bench', [set(200, 1, { type: 'warmup' }), set(150, 1, { done: false })])], bests, typeOf);
    expect(prs).toEqual([]);
  });
  it('finds previous sets, preferring the same routine when asked', () => {
    const a = workout('a', 3, [we('squat', [set(100, 5)])], null);
    const b = workout('b', 2, [we('squat', [set(90, 5)])], 'r1');
    const newest = [a, b];
    expect(previousInstanceSets(newest, 'squat')![0].weightKg).toBe(100);
    expect(previousInstanceSets(newest, 'squat', { mode: 'same_routine', routineId: 'r1' })![0].weightKg).toBe(90);
    expect(previousInstanceSets(newest, 'deadlift')).toBeNull();
    // Per instance, never merged: a second squat block maps to last time's second block.
    const two = workout('c', 4, [we('squat', [set(120, 3)]), we('squat', [set(80, 10)])], null);
    expect(previousInstanceSets([two, a], 'squat')!.map((s) => s.weightKg)).toEqual([120]);
    expect(previousInstanceSets([two, a], 'squat', { occurrence: 1 })!.map((s) => s.weightKg)).toEqual([80]);
  });
  it('builds per-session rows and rep records', () => {
    const w1 = workout('w1', 1, [we('row', [set(60, 10), set(70, 8)])]);
    const w2 = workout('w2', 2, [we('row', [set(80, 8)])]);
    const rows = exerciseSessions([w2, w1], 'row', 'weight_reps');
    expect(rows.map((r) => r.workoutId)).toEqual(['w1', 'w2']);
    expect(rows[0].heaviestKg).toBe(70);
    expect(rows[0].sessionVolume).toBe(60 * 10 + 70 * 8);
    const rr = repRecords([w1, w2], 'row');
    expect(rr.find((r) => r.reps === 8)!.weightKg).toBe(80);
  });
});

describe('calories', () => {
  const ex = (over: Partial<Exercise> = {}): Exercise => ({
    id: 'x',
    name: 'x',
    originalName: 'x',
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
    ...over,
  });
  it('scales strength MET with work density and clamps it', () => {
    expect(strengthMetForDensity(0, 3600)).toBe(2);
    expect(strengthMetForDensity(15, 3600)).toBe(3.5);
    expect(strengthMetForDensity(40, 3600)).toBe(6);
    expect(strengthMetForDensity(200, 3600)).toBe(6);
  });
  it('uses MET x kg x hours', () => {
    // 20 working sets in 1h -> MET 4.0; 80 kg -> 320 kcal
    const sets = Array.from({ length: 20 }, () => set(60, 8));
    const r = estimateCalories({ durationSec: 3600, bodyweightKg: 80, exercises: [we('bench', sets)], getExercise: () => ex() });
    expect(r.strengthMet).toBeCloseTo(4.0, 5);
    expect(r.total).toBe(320);
    expect(r.assumedBodyweight).toBe(false);
  });
  it('separates cardio time and assumes 75 kg when body weight is unknown', () => {
    const cardio = ex({ id: 'tread', type: 'distance_duration', equipment: 'cardio', met: 9.8 });
    const r = estimateCalories({
      durationSec: 3600,
      bodyweightKg: null,
      exercises: [we('tread', [{ id: 's', type: 'normal', durationSec: 1800, distanceM: 5000, done: true }])],
      getExercise: () => cardio,
    });
    expect(r.assumedBodyweight).toBe(true);
    expect(r.cardioSec).toBe(1800);
    expect(r.cardio).toBe(Math.round(9.8 * 75 * 0.5));
    expect(r.strength).toBe(Math.round(2.0 * 75 * 0.5));
  });
  it('times distance-only cardio sets from a typical pace', () => {
    const run = ex({ id: 'Running_Treadmill', type: 'distance_duration', equipment: 'cardio', met: 9.8 });
    const r = estimateCalories({
      durationSec: 1800,
      bodyweightKg: 75,
      exercises: [we('Running_Treadmill', [{ id: 's', type: 'normal', distanceM: 5000, done: true }])],
      getExercise: () => run,
    });
    expect(r.cardioSec).toBeCloseTo(5000 / 2.8, 3); // ~1786 s at 2.8 m/s
    expect(r.total).toBe(365); // not ~75 (the whole session at MET 2.0)
    // A stored time of 0 also falls back to the pace estimate.
    const zero = estimateCalories({
      durationSec: 1800,
      bodyweightKg: 75,
      exercises: [we('Running_Treadmill', [{ id: 's', type: 'normal', distanceM: 5000, durationSec: 0, done: true }])],
      getExercise: () => run,
    });
    expect(zero.total).toBe(365);
  });
  it("uses the session's own pace for distance-only sets, and the base exercise's speed for variants", () => {
    const row = ex({ id: 'c_row_gym_b', variantOf: 'Rowing_Stationary', type: 'distance_duration', equipment: 'cardio', met: 7 });
    const timed = { id: 'a', type: 'normal' as const, distanceM: 2000, durationSec: 500, done: true }; // 4 m/s
    const own = estimateCalories({
      durationSec: 3600,
      bodyweightKg: 80,
      exercises: [we('c_row_gym_b', [timed, { id: 'b', type: 'normal', distanceM: 2000, done: true }])],
      getExercise: () => row,
    });
    expect(own.cardioSec).toBeCloseTo(1000, 6);
    const base = estimateCalories({
      durationSec: 3600,
      bodyweightKg: 80,
      exercises: [we('c_row_gym_b', [{ id: 'b', type: 'normal', distanceM: 3700, done: true }])],
      getExercise: () => row,
    });
    expect(base.cardioSec).toBeCloseTo(1000, 6); // Rowing_Stationary: 3.7 m/s
  });
  it('clamps estimated cardio time to the session', () => {
    const run = ex({ id: 'Running_Treadmill', type: 'distance_duration', equipment: 'cardio', met: 9.8 });
    const r = estimateCalories({
      durationSec: 1200,
      bodyweightKg: 75,
      exercises: [we('Running_Treadmill', [{ id: 's', type: 'normal', distanceM: 10000, done: true }])],
      getExercise: () => run,
    });
    expect(r.cardioSec).toBe(1200);
    expect(r.strengthSec).toBe(0);
    expect(r.total).toBe(Math.round(9.8 * 75 * (1200 / 3600)));
  });
});

import { clockDigits, digitsToSeconds, formatClockDigits, parseTimeEntry } from './units';
describe('time cell entry (digits fill m:ss from the right)', () => {
  it('reads digits right-aligned', () => {
    expect(parseTimeEntry('45')).toBe(45);
    expect(parseTimeEntry('90')).toBe(90);
    expect(parseTimeEntry('100')).toBe(60);
    expect(parseTimeEntry('130')).toBe(90);
    expect(parseTimeEntry('190')).toBe(150); // normalised to 2:30 on blur
    expect(parseTimeEntry('2500')).toBe(1500);
    expect(parseTimeEntry('10000')).toBe(3600);
    expect(parseTimeEntry('13000')).toBe(5400);
  });
  it('ignores separators and leading zeros, and round-trips formatted values', () => {
    expect(parseTimeEntry('1:30')).toBe(90);
    expect(parseTimeEntry('1.30')).toBe(90);
    expect(parseTimeEntry('0:05')).toBe(5);
    expect(parseTimeEntry(formatClock(3725))).toBe(3725); // "1:02:05"
    expect(parseTimeEntry('')).toBeNull();
    expect(parseTimeEntry('000')).toBeNull();
    expect(clockDigits('1234567')).toBe('123456');
    expect(digitsToSeconds('')).toBeNull();
  });
  it('formats the digits live as m:ss', () => {
    expect(formatClockDigits('')).toBe('');
    expect(formatClockDigits('5')).toBe('0:05');
    expect(formatClockDigits('45')).toBe('0:45');
    expect(formatClockDigits('130')).toBe('1:30');
    expect(formatClockDigits('2500')).toBe('25:00');
    expect(formatClockDigits('12345')).toBe('1:23:45');
    expect(formatClockDigits('123456')).toBe('12:34:56');
  });
  it('leaves parseClock reading bare digits as seconds (prompts)', () => {
    expect(parseClock('130')).toBe(130);
  });
});

import { mergeWorkoutIntoRoutine, workoutDiffersFromRoutine } from './routines';
import type { Routine } from '../types';

describe('routine update merge', () => {
  const routine: Routine = {
    id: 'r', name: 'Push', folderId: null, order: 0, createdAt: 0, updatedAt: 0,
    exercises: [
      { id: 're1', exerciseId: 'bench', sets: [{ id: 'a', type: 'normal', weightKg: null, reps: 6, repsMax: 10 }] },
      { id: 're2', exerciseId: 'fly', sets: [{ id: 'b', type: 'normal', weightKg: 20, reps: 12 }] },
    ],
  };
  it('keeps skipped exercises and rep ranges, updates loads, appends new exercises', () => {
    const w = workout('w', 1, [we('bench', [set(60, 8)]), we('curl', [set(15, 10)])], 'r');
    const merged = mergeWorkoutIntoRoutine(routine, w);
    expect(merged.map((e) => e.exerciseId)).toEqual(['bench', 'fly', 'curl']);
    expect(merged[0].sets[0]).toMatchObject({ weightKg: 60, reps: 6, repsMax: 10 });
    expect(merged[1]).toBe(routine.exercises[1]);
  });
  it('does not nag when reps land inside the planned range at the planned load', () => {
    const r2: Routine = { ...routine, exercises: [{ ...routine.exercises[0], sets: [{ id: 'a', type: 'normal', weightKg: 60, reps: 6, repsMax: 10 }] }] };
    expect(workoutDiffersFromRoutine(r2, workout('w', 1, [we('bench', [set(60, 9)])], 'r'))).toBe(false);
    expect(workoutDiffersFromRoutine(r2, workout('w', 1, [we('bench', [set(65, 9)])], 'r'))).toBe(true);
  });
});

import { distanceUnitForType, displayDistanceAny, formatDistanceForType, anyToMeters } from './units';
describe('short distances', () => {
  it('uses yards/meters for weight & distance exercises only', () => {
    expect(distanceUnitForType('weight_distance', 'mi')).toBe('yd');
    expect(distanceUnitForType('weight_distance', 'km')).toBe('m');
    expect(distanceUnitForType('distance_duration', 'mi')).toBe('mi');
    expect(formatDistanceForType(anyToMeters(40, 'yd'), 'weight_distance', 'mi')).toBe('40 yd');
    expect(formatDistanceForType(30, 'weight_distance', 'km')).toBe('30 m');
    expect(formatDistanceForType(1609.344, 'distance_duration', 'mi')).toBe('1 mi');
    // m / yd keep one decimal (a 40.5 yd carry is not "41 yd"); km / mi keep two.
    expect(displayDistanceAny(anyToMeters(40.46, 'yd'), 'yd')).toBe(40.5);
    expect(displayDistanceAny(36.576, 'm')).toBe(36.6);
    expect(formatDistanceForType(anyToMeters(40.5, 'yd'), 'weight_distance', 'mi')).toBe('40.5 yd');
    expect(displayDistanceAny(5123, 'km')).toBe(5.12);
  });
});
