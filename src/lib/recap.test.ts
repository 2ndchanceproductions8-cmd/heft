import { describe, expect, it } from 'vitest';
import type { SetEntry, Workout } from '../types';
import { compareTopSets, exerciseRecap, topSet } from './calc';
import { syncSideSet } from './sides';
import { deltaText, topText } from '../features/workout/ExerciseRecap';

/*
 * The logger's recap strip: last time, best ever, and today against both (lib/calc.ts topSet / exerciseRecap,
 * features/workout/ExerciseRecap.tsx). Weights are kg; LB = one pound in kg.
 */

const LB = 0.45359237;
const DAY = 86_400_000;
const lbs = { unit: 'lb', distanceUnit: 'mi' } as const;

const set = (lb: number, reps: number, p: Partial<SetEntry> = {}): SetEntry => ({
  id: `s${lb}x${reps}`,
  type: 'normal',
  done: true,
  weightKg: lb * LB,
  reps,
  ...p,
});
const sides = (l: [number, number], r: [number, number]): SetEntry =>
  syncSideSet({
    id: 'side',
    type: 'normal',
    done: true,
    sides: { left: { weightKg: l[0] * LB, reps: l[1] }, right: { weightKg: r[0] * LB, reps: r[1] } },
  });
const workout = (id: string, startedAt: number, sets: SetEntry[], exerciseId = 'bench'): Workout => ({
  id,
  name: id,
  startedAt,
  endedAt: startedAt + 3600_000,
  durationSec: 3600,
  exercises: [{ id: `${id}_we`, exerciseId, sets }],
  exerciseIds: [exerciseId],
  photoIds: [],
  volumeKg: 0,
  setCount: sets.length,
  prs: [],
  createdAt: startedAt,
  updatedAt: startedAt,
});

describe('topSet: the strongest working set', () => {
  it('heaviest weight wins; more reps break a tie; warm-ups and unticked sets never count', () => {
    const top = topSet([set(225, 1, { type: 'warmup' }), set(135, 12), set(155, 5), set(155, 6), set(185, 3, { done: false })], 'weight_reps');
    expect(topText(top!, 'weight_reps', lbs)).toBe('155 lb x 6');
  });

  it('per-side sets compare arm to arm and remember which side', () => {
    const top = topSet([sides([50, 10], [55, 8])], 'weight_reps');
    expect(topText(top!, 'weight_reps', lbs)).toBe('55 lb x 8 (R)');
  });

  it('reps for bodyweight, time for planks; nothing logged → null', () => {
    expect(topSet([{ id: 'a', type: 'normal', done: true, reps: 12 }, { id: 'b', type: 'normal', done: true, reps: 15 }], 'bodyweight_reps')?.reps).toBe(15);
    expect(topSet([{ id: 'a', type: 'normal', done: true, durationSec: 90 }], 'duration')?.durationSec).toBe(90);
    expect(topSet([set(0, 0)], 'weight_reps')).toBeNull();
    expect(topSet([], 'weight_reps')).toBeNull();
  });
});

describe('exerciseRecap: last time and best ever', () => {
  const t0 = Date.UTC(2026, 8, 1);
  // Newest first, like the logger's history.
  const history = [
    workout('w4', t0 + 21 * DAY, [set(145, 8)]),
    workout('w3', t0 + 14 * DAY, [set(155, 5)]),
    workout('w2', t0 + 7 * DAY, [set(155, 5)]),
    workout('w1', t0, [set(135, 10)]),
    workout('other', t0 + 22 * DAY, [set(315, 5)], 'squat'),
  ];

  it('last = the newest workout with the exercise; best = the strongest, dated the FIRST time it was reached', () => {
    const r = exerciseRecap(history, 'bench', 'weight_reps');
    expect(r.last?.date).toBe(t0 + 21 * DAY);
    expect(topText(r.last!.top, 'weight_reps', lbs)).toBe('145 lb x 8');
    expect(r.best?.date).toBe(t0 + 7 * DAY);
    expect(topText(r.best!.top, 'weight_reps', lbs)).toBe('155 lb x 5');
  });

  it('never done → no last, no best', () => {
    expect(exerciseRecap(history, 'deadlift', 'weight_reps')).toEqual({ last: null, best: null, lastNote: null });
  });

  it('last note = the newest note written on the exercise, even from a session before the last one', () => {
    const noted = (w: Workout, notes: string): Workout => ({ ...w, exercises: w.exercises.map((e) => ({ ...e, notes })) });
    const h = [history[0], noted(history[1], '  Seat on 4, pin at 7  '), noted(history[2], 'old note'), history[3]];
    expect(exerciseRecap(h, 'bench', 'weight_reps').lastNote).toEqual({ date: t0 + 14 * DAY, text: 'Seat on 4, pin at 7' });
    expect(exerciseRecap([noted(history[0], '   ')], 'bench', 'weight_reps').lastNote).toBeNull();
  });

  it('every instance of the exercise in a workout counts (a heavy block and a back-off block)', () => {
    const w: Workout = {
      ...workout('w', t0, [set(135, 10)]),
      exercises: [
        { id: 'a', exerciseId: 'bench', sets: [set(185, 3)] },
        { id: 'b', exerciseId: 'bench', sets: [set(135, 10)] },
      ],
    };
    expect(exerciseRecap([w], 'bench', 'weight_reps').best?.top.reps).toBe(3);
  });
});

describe('today vs last time and best', () => {
  const last = topSet([set(145, 8)], 'weight_reps')!;
  const best = topSet([set(155, 5)], 'weight_reps')!;

  it('heavier is stronger; same weight → more reps is stronger', () => {
    expect(compareTopSets(topSet([set(150, 6)], 'weight_reps')!, last, 'weight_reps')).toBeGreaterThan(0);
    expect(compareTopSets(topSet([set(145, 9)], 'weight_reps')!, last, 'weight_reps')).toBeGreaterThan(0);
    expect(compareTopSets(topSet([set(145, 8)], 'weight_reps')!, last, 'weight_reps')).toBe(0);
    expect(compareTopSets(topSet([set(140, 12)], 'weight_reps')!, last, 'weight_reps')).toBeLessThan(0);
  });

  it('the difference names the value that decided it', () => {
    expect(deltaText(topSet([set(150, 6)], 'weight_reps')!, last, 'weight_reps', lbs)).toBe('+5 lb');
    expect(deltaText(topSet([set(145, 10)], 'weight_reps')!, last, 'weight_reps', lbs)).toBe('+2 reps');
    expect(deltaText(topSet([set(135, 10)], 'weight_reps')!, last, 'weight_reps', lbs)).toBe('−10 lb');
    expect(deltaText(best, topSet([set(150, 6)], 'weight_reps')!, 'weight_reps', lbs, true)).toBe('5 lb');
    expect(deltaText(topSet([{ id: 'p', type: 'normal', done: true, durationSec: 75 }], 'duration')!, { side: null, durationSec: 60 }, 'duration', lbs)).toBe('+0:15');
  });
});
