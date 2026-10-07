import { describe, expect, it } from 'vitest';
import type { SetEntry, Workout } from '../types';
import {
  detectPRs,
  exerciseSessions,
  isSideSet,
  prMetricSide,
  repRecords,
  setLimbs,
  setReps,
  setVolumeKg,
  sideBalance,
  totalReps,
  workoutVolumeKg,
} from './calc';
import { buildExerciseIndex, CATALOG } from './exercises';
import { typeFields } from './exerciseMeta';
import {
  betterSide,
  defaultPerSide,
  formatSidesLine,
  joinSet,
  patchSide,
  sideTarget,
  sidesDiffer,
  splitSet,
  syncSideSet,
} from './sides';
import { filledValues, finalizeDoneSets, missingValueMessage, setsFromPrevious, targetFromValues } from './workoutStore';
import { adaptSetsToType, formatSetLine, hasAnyValue } from '../features/workout/logic';
import { formatSetValue as historySetValue } from '../features/history/historyUtils';
import { formatSetValue as exerciseSetValue } from '../features/exercises/format';
import { personalRecords } from '../features/exercises/stats';

const side = (lw: number, lr: number, rw: number, rr: number, p: Partial<SetEntry> = {}): SetEntry =>
  syncSideSet({
    id: p.id ?? 's',
    type: 'normal',
    done: true,
    sides: { left: { weightKg: lw, reps: lr }, right: { weightKg: rw, reps: rr } },
    ...p,
  });
const plain = (w: number, r: number, p: Partial<SetEntry> = {}): SetEntry => ({ id: 'p', type: 'normal', done: true, weightKg: w, reps: r, ...p });

const workout = (id: string, startedAt: number, sets: SetEntry[], exerciseId = 'row'): Workout => ({
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

describe('per-side sets: reading values', () => {
  it('a set is per-side only with both sides', () => {
    expect(isSideSet(side(20, 10, 20, 8))).toBe(true);
    expect(isSideSet(plain(20, 10))).toBe(false);
    expect(isSideSet({ sides: null })).toBe(false);
  });

  it('limbs: two sides, or the set itself', () => {
    expect(setLimbs(side(20, 10, 22, 8)).map((l) => [l.side, l.values.weightKg, l.values.reps])).toEqual([
      ['left', 20, 10],
      ['right', 22, 8],
    ]);
    expect(setLimbs(plain(20, 10))).toEqual([{ side: null, values: plain(20, 10) }]);
  });

  it('totals add both sides: volume, reps', () => {
    const s = side(20, 10, 22, 8);
    expect(setVolumeKg(s, 'weight_reps')).toBe(20 * 10 + 22 * 8);
    expect(setVolumeKg(s, 'bodyweight_reps')).toBe(0);
    expect(setReps(s)).toBe(18);
    const ex = [{ id: 'a', exerciseId: 'row', sets: [s, plain(30, 5)] }];
    expect(workoutVolumeKg(ex, () => 'weight_reps')).toBe(200 + 176 + 150);
    expect(totalReps(ex)).toBe(23);
  });

  it('records take the better side and say which', () => {
    const s = side(20, 10, 22, 8); // e1RM L 26.67, R 27.87; volume L 200, R 176
    expect(prMetricSide('best_1rm', s, 'weight_reps')).toEqual({ value: 22 * (1 + 8 / 30), side: 'right' });
    expect(prMetricSide('best_set_volume', s, 'weight_reps')).toEqual({ value: 200, side: 'left' });
    expect(prMetricSide('heaviest_weight', s, 'weight_reps')).toEqual({ value: 22, side: 'right' });
    expect(prMetricSide('most_reps', plain(20, 10), 'weight_reps')).toEqual({ value: 10, side: null });
  });

  it('a PR credited to a per-side set carries its side', () => {
    const bests = new Map([['row', { heaviest_weight: 20, best_1rm: 25, best_set_volume: 150 }]]);
    const { prs } = detectPRs([{ id: 'we', exerciseId: 'row', sets: [side(20, 10, 24, 6, { id: 'x' })] }], bests, () => 'weight_reps');
    const byKind = Object.fromEntries(prs.map((p) => [p.kind, p]));
    expect(byKind.heaviest_weight).toMatchObject({ setId: 'x', value: 24, side: 'right' });
    expect(byKind.best_set_volume).toMatchObject({ value: 200, side: 'left' });
  });

  it('plain history and per-side sets compare limb to limb (no fake PR from adding the sides)', () => {
    // Old habit: "50 x 10" meant each arm. A per-side 50 x 10 / 50 x 10 is not a volume PR over it.
    const bests = new Map([['row', { heaviest_weight: 50, best_1rm: 66.7, best_set_volume: 500 }]]);
    const { prs } = detectPRs([{ id: 'we', exerciseId: 'row', sets: [side(50, 10, 50, 10)] }], bests, () => 'weight_reps');
    expect(prs.map((p) => p.kind)).not.toContain('best_set_volume');
  });

  it('sessions carry left/right bests from per-side sets only', () => {
    const rows = exerciseSessions([workout('w', 1, [side(20, 10, 22, 8), plain(30, 5)])], 'row', 'weight_reps');
    expect(rows[0].heaviestKg).toBe(30);
    expect(rows[0].sessionVolume).toBe(200 + 176 + 150);
    expect(rows[0].totalReps).toBe(23);
    expect(rows[0].sides?.left.heaviestKg).toBe(20);
    expect(rows[0].sides?.right.maxReps).toBe(8);
    expect(exerciseSessions([workout('w', 1, [plain(30, 5)])], 'row', 'weight_reps')[0].sides).toBeUndefined();
  });

  it('set records are per limb and name the side', () => {
    const rr = repRecords([workout('w', 1, [side(20, 10, 24, 8)])], 'row');
    expect(rr.find((r) => r.reps === 8)).toMatchObject({ weightKg: 24, side: 'right' });
    expect(rr.find((r) => r.reps === 10)).toMatchObject({ weightKg: 20, side: 'left' });
  });

  it('personal records name the side', () => {
    const recs = personalRecords([workout('w', 1, [side(20, 10, 24, 8)])], 'row', 'weight_reps');
    expect(recs.find((r) => r.kind === 'heaviest_weight')).toMatchObject({ value: 24, side: 'right' });
  });
});

describe('left vs right balance', () => {
  it('compares the latest session on estimated 1RM and finds the weaker side', () => {
    const sessions = exerciseSessions(
      [workout('a', 1, [side(20, 10, 20, 10)]), workout('b', 2, [side(20, 10, 20, 8)])],
      'row',
      'weight_reps',
    );
    const b = sideBalance(sessions, 'weight_reps');
    expect(b.metric).toBe('best1RM');
    expect(b.points).toHaveLength(2);
    expect(b.weaker).toBe('right');
    const l = 20 * (1 + 10 / 30);
    const r = 20 * (1 + 8 / 30);
    expect(b.gapPct).toBeCloseTo(((l - r) / l) * 100, 6);
    expect(b.bestLeft).toBeCloseTo(l, 6);
  });

  it('even sides: no weaker side, 0 % gap; no per-side data: nothing', () => {
    const even = sideBalance(exerciseSessions([workout('a', 1, [side(20, 10, 20, 10)])], 'row', 'weight_reps'), 'weight_reps');
    expect(even.weaker).toBeNull();
    expect(even.gapPct).toBe(0);
    const none = sideBalance(exerciseSessions([workout('a', 1, [plain(20, 10)])], 'row', 'weight_reps'), 'weight_reps');
    expect(none.points).toEqual([]);
    expect(none.gapPct).toBeNull();
  });

  it('uses reps for bodyweight work and hold time for planks', () => {
    const bw: SetEntry = { id: 'b', type: 'normal', done: true, sides: { left: { reps: 12 }, right: { reps: 9 } } };
    const b = sideBalance(exerciseSessions([workout('a', 1, [bw])], 'row', 'bodyweight_reps'), 'bodyweight_reps');
    expect([b.metric, b.weaker, b.gapPct]).toEqual(['maxReps', 'right', 25]);
    const plank: SetEntry = { id: 'p', type: 'normal', done: true, sides: { left: { durationSec: 40 }, right: { durationSec: 50 } } };
    const p = sideBalance(exerciseSessions([workout('a', 1, [plank])], 'row', 'duration'), 'duration');
    expect([p.metric, p.weaker, p.gapPct]).toEqual(['maxDuration', 'left', 20]);
  });
});

describe('per-side sets: editing', () => {
  it('the mirror is the better side (assisted: less help is stronger)', () => {
    const s = side(20, 10, 22, 8);
    expect(betterSide(s.sides!, 'weight_reps')).toBe('right');
    expect([s.weightKg, s.reps]).toEqual([22, 8]);
    expect(betterSide({ left: { weightKg: 30, reps: 8 }, right: { weightKg: 20, reps: 8 } }, 'assisted_bodyweight')).toBe('right');
    expect(betterSide({ left: { reps: 8 }, right: { reps: 8 } })).toBe('left');
  });

  it('split copies the plain values to each side; join keeps the better side', () => {
    const split = splitSet(plain(20, 10));
    expect(split.sides).toEqual({
      left: { weightKg: 20, reps: 10, durationSec: null, distanceM: null },
      right: { weightKg: 20, reps: 10, durationSec: null, distanceM: null },
    });
    const joined = joinSet(side(20, 10, 22, 8));
    expect(isSideSet(joined)).toBe(false);
    expect([joined.weightKg, joined.reps]).toEqual([22, 8]);
    expect(sidesDiffer(side(20, 10, 22, 8))).toBe(true);
    expect(sidesDiffer(side(20, 10, 20, 10))).toBe(false);
    expect(sidesDiffer(plain(20, 10))).toBe(false);
  });

  it('patching one side of a plain set keeps the shared values on the other side', () => {
    const p = patchSide(plain(20, 10, { done: false }), 'right', { reps: 7 });
    expect(p.sides?.left).toMatchObject({ weightKg: 20, reps: 10 });
    expect(p.sides?.right).toMatchObject({ weightKg: 20, reps: 7 });
    expect(p.reps).toBe(10); // mirror = the better (left) side
  });

  it('side targets: own per-side plan, else the plain plan (rep range included)', () => {
    const t = targetFromValues(side(20, 10, 22, 8));
    expect(sideTarget(t, 'left')).toMatchObject({ weightKg: 20, reps: 10 });
    expect(sideTarget(t, 'right')).toMatchObject({ weightKg: 22, reps: 8 });
    const plan = { weightKg: 20, reps: 8, repsMax: 12 };
    expect(sideTarget(plan, 'left')).toBe(plan);
    expect(targetFromValues(plain(20, 10)).sides).toBeUndefined();
    expect(setsFromPrevious([side(20, 10, 22, 8)])[0].target?.sides?.right).toMatchObject({ weightKg: 22, reps: 8 });
  });

  it('ticking fills each side from its own plan; a missing side is named', () => {
    const fields = typeFields('weight_reps');
    const s: SetEntry = {
      id: 'a',
      type: 'normal',
      done: false,
      sides: { left: { weightKg: null, reps: 9 }, right: { weightKg: null, reps: null } },
      target: { weightKg: 20, reps: 10, sides: { left: { weightKg: 20, reps: 10 }, right: { weightKg: 22, reps: 8 } } },
    };
    const v = filledValues(s, null, fields);
    expect(v.sides?.left).toMatchObject({ weightKg: 20, reps: 9 });
    expect(v.sides?.right).toMatchObject({ weightKg: 22, reps: 8 });
    expect(missingValueMessage(fields, v)).toBeNull();
    const noPlan = { ...s, target: null };
    expect(missingValueMessage(fields, filledValues(noPlan, null, fields))).toBe('Enter right reps first');
    expect(missingValueMessage(fields, { reps: null })).toBe('Enter reps first');
  });

  it('a ticked per-side set missing a side is dropped on save', () => {
    const fields = typeFields('weight_reps');
    const bad: SetEntry = { id: 'b', type: 'normal', done: true, sides: { left: { weightKg: 20, reps: 10 }, right: { weightKg: 20 } } };
    const { exercises, dropped } = finalizeDoneSets([{ id: 'we', exerciseId: 'row', sets: [bad, side(20, 10, 20, 9)] }], () => fields);
    expect(dropped).toBe(1);
    expect(exercises[0].sets).toHaveLength(1);
  });

  it('values that a new exercise type has no column for are cleared on both sides', () => {
    const s: SetEntry = { ...side(20, 10, 22, 8) };
    const [p] = adaptSetsToType([s], typeFields('bodyweight_reps'));
    expect(p.patch.weightKg).toBeNull();
    expect(p.patch.sides?.left).toMatchObject({ weightKg: null, reps: 10 });
    expect(p.patch.sides?.right).toMatchObject({ weightKg: null, reps: 8 });
  });

  it('a set with only a side typed has a value', () => {
    expect(hasAnyValue({ sides: { left: {}, right: { reps: 5 } } })).toBe(true);
    expect(hasAnyValue({ sides: { left: {}, right: {} } })).toBe(false);
  });
});

describe('per-side sets: text', () => {
  it('one line for both sides', () => {
    expect(formatSetLine(side(20, 10, 20, 9), 'weight_reps', 'kg', 'km')).toBe('L 20 kg x 10 · R 20 kg x 9');
    expect(formatSetLine(side(20, 10, 20, 10), 'weight_reps', 'kg', 'km')).toBe('L/R 20 kg x 10');
    expect(historySetValue(side(20, 10, 20, 9), 'weight_reps', 'kg', 'km')).toBe('L 20 kg x 10 · R 20 kg x 9');
    expect(exerciseSetValue(side(20, 10, 20, 9), 'weight_reps', 'kg', 'km')).toBe('L 20 kg × 10 · R 20 kg × 9');
    expect(formatSidesLine({ left: { reps: 1 }, right: { reps: 2 } }, (v) => String(v.reps))).toBe('L 1 · R 2');
  });
});

describe('which exercises log per side', () => {
  it('one-sided names by default', () => {
    for (const name of [
      'Single Arm Row (Dumbbell)',
      'Single Leg Press (Machine)',
      'Bulgarian Split Squat (Dumbbell)',
      'Lunge (Barbell)',
      'Walking Lunge',
      'Step Up (Dumbbell)',
      'Concentration Curl (Dumbbell)',
      'Pistol Squat (Kettlebell)',
      'Side Plank',
      'Suitcase Deadlift (Barbell)',
      'Iso-Lateral Row (Machine)',
      'Iso-Lateral Chest Press (Machine)',
      'Isolateral Leg Press',
      'Unilateral Cable Row',
    ])
      expect(defaultPerSide(name), name).toBe(true);
    for (const name of [
      'Bench Press (Barbell)',
      'Bicep Curl (Dumbbell)',
      'Lunge Pass Through (Kettlebell)',
      'Push Up to Side Plank',
      'Seated Concentration Curl (Barbell)',
      'Lat Pulldown (Cable)',
      'Isometric Chest Squeeze',
    ])
      expect(defaultPerSide(name), name).toBe(false);
  });

  it('the catalog gets a sensible number of defaults', () => {
    const n = CATALOG.filter((c) => defaultPerSide(c.name)).length;
    expect(n).toBeGreaterThan(60);
    expect(n).toBeLessThan(120);
  });

  it('resolves: catalog default, override wins, a variant follows its base, custom off', () => {
    const row = CATALOG.find((c) => c.name === 'Single Arm Row (Dumbbell)')!;
    const bench = CATALOG.find((c) => c.name === 'Bench Press (Barbell)')!;
    const base = { name: 'x', equipment: 'other' as const, primary: 'lats' as const, secondary: [], type: 'weight_reps' as const, photoIds: [], createdAt: 0 };
    const idx = buildExerciseIndex(
      [
        { ...base, id: 'c_var', variantOf: row.id, brand: 'Hammer' },
        { ...base, id: 'c_own' },
      ],
      [{ id: bench.id, perSide: true }],
    );
    expect(idx.get(row.id).perSide).toBe(true);
    expect(idx.get(bench.id).perSide).toBe(true);
    expect(idx.get('c_var').perSide).toBe(true);
    expect(idx.get('c_own').perSide).toBe(false);
    expect(buildExerciseIndex([], [{ id: row.id, perSide: false }]).get(row.id).perSide).toBe(false);
  });
});
