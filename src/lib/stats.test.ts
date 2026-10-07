import { describe, expect, it } from 'vitest';
import type { Exercise, Muscle, PRRecord, SetEntry, Workout } from '../types';
import {
  exerciseTrend,
  exercisesForMuscle,
  muscleSetCounts,
  progressMetricFor,
  recentPRs,
  topExercises,
  weekStreak,
  weeklyBuckets,
} from './stats';

// Thursday 1 Oct 2026, 10:00 local time.
const NOW = new Date(2026, 9, 1, 10, 0).getTime();
const at = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime();

let seq = 0;
function set(p: Partial<SetEntry> = {}): SetEntry {
  return { id: 's' + ++seq, type: 'normal', done: true, weightKg: 60, reps: 8, ...p };
}

function workout(
  startedAt: number,
  exercises: [string, SetEntry[]][],
  extra: Partial<Workout> = {},
): Workout {
  const id = 'w' + ++seq;
  return {
    id,
    name: 'Workout ' + id,
    startedAt,
    endedAt: startedAt + 3600_000,
    durationSec: 3600,
    exercises: exercises.map(([exerciseId, sets], i) => ({ id: `${id}_${i}`, exerciseId, sets })),
    exerciseIds: [...new Set(exercises.map(([e]) => e))],
    photoIds: [],
    calories: 300,
    volumeKg: 1000,
    setCount: exercises.reduce((n, [, s]) => n + s.filter((x) => x.done).length, 0),
    prs: [],
    createdAt: startedAt,
    updatedAt: startedAt,
    ...extra,
  };
}

function ex(id: string, primary: Muscle, secondary: Muscle[] = [], type: Exercise['type'] = 'weight_reps'): Exercise {
  return {
    id,
    name: id,
    originalName: id,
    perSide: false,
    equipment: 'barbell',
    primary,
    secondary,
    type,
    images: [],
    photoIds: [],
    instructions: [],
    source: 'catalog',
    aliases: [],
  };
}

const EXERCISES = new Map<string, Exercise>([
  ['bench', ex('bench', 'chest', ['triceps', 'shoulders'])],
  ['row', ex('row', 'upper_back', ['lats', 'biceps', 'lats'])],
  ['squat', ex('squat', 'quadriceps', ['glutes'])],
  ['plank', ex('plank', 'abdominals', [], 'duration')],
]);
const getExercise = (id: string) => EXERCISES.get(id) ?? ex(id, 'other');

describe('weeklyBuckets', () => {
  const ws = [
    workout(at(2026, 9, 29, 18), [['bench', [set()]]], { durationSec: 1800, volumeKg: 500, calories: 200 }), // Tue
    workout(at(2026, 9, 28, 0, 30), [['squat', [set({ reps: 5 }), set({ reps: 5 })]]], { volumeKg: 1200 }), // Mon 00:30
    workout(at(2026, 9, 27, 9), [['row', [set({ reps: 10 })]]]), // Sun
    workout(at(2026, 9, 10), [['row', [set()]]]), // outside a 3-week window
  ];

  it('returns oldest → newest buckets including empty weeks (Monday start)', () => {
    const b = weeklyBuckets(ws, 3, 1, NOW);
    expect(b.map((x) => new Date(x.weekStart).toDateString())).toEqual([
      new Date(2026, 8, 14).toDateString(),
      new Date(2026, 8, 21).toDateString(),
      new Date(2026, 8, 28).toDateString(),
    ]);
    expect(b.map((x) => x.workouts)).toEqual([0, 1, 2]);
    expect(b[2]).toMatchObject({ durationSec: 1800 + 3600, volumeKg: 1700, sets: 3, reps: 18, calories: 500 });
    expect(b[0]).toMatchObject({ workouts: 0, durationSec: 0, volumeKg: 0, sets: 0, reps: 0, calories: 0 });
  });

  it('respects a Sunday week start', () => {
    const b = weeklyBuckets(ws, 2, 0, NOW);
    expect(new Date(b[1].weekStart).getDay()).toBe(0);
    expect(b.map((x) => x.workouts)).toEqual([0, 3]);
  });

  it('handles zero weeks and missing calories', () => {
    expect(weeklyBuckets(ws, 0, 0, NOW)).toEqual([]);
    const b = weeklyBuckets([workout(at(2026, 9, 30), [], { calories: null })], 1, 1, NOW);
    expect(b[0].calories).toBe(0);
    expect(b[0].workouts).toBe(1);
  });
});

describe('muscleSetCounts', () => {
  it('counts done non-warm-up sets: primary +1, secondary +0.5 (deduped)', () => {
    const ws = [
      workout(at(2026, 9, 30), [
        ['bench', [set({ type: 'warmup' }), set(), set({ type: 'failure' }), set({ type: 'drop' }), set({ done: false })]],
        ['row', [set(), set()]],
      ]),
    ];
    const c = muscleSetCounts(ws, 0, getExercise);
    expect(c.chest).toBe(3);
    expect(c.triceps).toBe(1.5);
    expect(c.shoulders).toBe(1.5);
    expect(c.upper_back).toBe(2);
    expect(c.lats).toBe(1); // listed twice as secondary, counted once
    expect(c.biceps).toBe(1);
    expect(c.quadriceps).toBeUndefined();
  });

  it('ignores workouts before fromMs', () => {
    const ws = [workout(at(2026, 9, 1), [['squat', [set()]]]), workout(at(2026, 9, 30), [['squat', [set(), set()]]])];
    expect(muscleSetCounts(ws, at(2026, 9, 24), getExercise)).toEqual({ quadriceps: 2, glutes: 1 });
  });
});

describe('exercisesForMuscle', () => {
  it('lists exercises that hit a muscle, most sets first', () => {
    const ws = [
      workout(at(2026, 9, 29), [['bench', [set(), set()]]]),
      workout(at(2026, 9, 30), [['row', [set()]], ['bench', [set()]]]),
    ];
    expect(exercisesForMuscle(ws, 0, 'chest', getExercise)).toEqual([
      { exerciseId: 'bench', sets: 3, role: 'primary', lastDate: at(2026, 9, 30) },
    ]);
    const biceps = exercisesForMuscle(ws, 0, 'biceps', getExercise);
    expect(biceps).toEqual([{ exerciseId: 'row', sets: 0.5, role: 'secondary', lastDate: at(2026, 9, 30) }]);
  });
});

describe('weekStreak', () => {
  const thisWeek = at(2026, 9, 30);
  const lastWeek = at(2026, 9, 23);
  const twoAgo = at(2026, 9, 16);
  const fourAgo = at(2026, 9, 2);
  const w = (t: number) => workout(t, []);

  it('counts the current week when it has a workout', () => {
    expect(weekStreak([w(thisWeek), w(lastWeek), w(twoAgo), w(fourAgo)], 1, NOW)).toBe(3);
  });
  it('ends last week when the current week is still empty', () => {
    expect(weekStreak([w(lastWeek), w(twoAgo), w(fourAgo)], 1, NOW)).toBe(2);
  });
  it('is 1 when only this week has a workout, 0 with no recent weeks', () => {
    expect(weekStreak([w(thisWeek), w(twoAgo)], 1, NOW)).toBe(1);
    expect(weekStreak([w(twoAgo)], 1, NOW)).toBe(0);
    expect(weekStreak([], 0, NOW)).toBe(0);
  });
  it('counts multiple workouts in a week once', () => {
    expect(weekStreak([w(thisWeek), w(thisWeek + 1000), w(lastWeek)], 1, NOW)).toBe(2);
  });
});

describe('recentPRs', () => {
  const pr = (exerciseId: string, kind: PRRecord['kind'], value: number): PRRecord => ({
    exerciseId,
    kind,
    value,
    setId: 's',
    workoutExerciseId: 'we',
  });
  it('returns PRs newest workout first, limited to n', () => {
    const old = workout(at(2026, 9, 1), [], { prs: [pr('bench', 'heaviest_weight', 100)] });
    const mid = workout(at(2026, 9, 15), [], { prs: [pr('squat', 'best_1rm', 150), pr('squat', 'heaviest_weight', 140)] });
    const recent = workout(at(2026, 9, 29), [], { prs: [pr('row', 'best_set_volume', 800)] });
    const out = recentPRs([old, recent, mid], 3);
    expect(out.map((r) => [r.workout.id, r.pr.exerciseId, r.pr.kind])).toEqual([
      [recent.id, 'row', 'best_set_volume'],
      [mid.id, 'squat', 'best_1rm'],
      [mid.id, 'squat', 'heaviest_weight'],
    ]);
    expect(recentPRs([old, recent, mid], 0)).toEqual([]);
    expect(recentPRs([old, recent, mid], 10)).toHaveLength(4);
  });
});

describe('topExercises', () => {
  it('ranks by sessions (once per workout), ties by most recent', () => {
    const ws = [
      workout(at(2026, 9, 1), [['bench', [set()]], ['bench', [set()]], ['row', [set()]]]),
      workout(at(2026, 9, 8), [['bench', [set()]], ['squat', [set()]]]),
      workout(at(2026, 9, 15), [['row', [set()]], ['plank', [set({ done: false })]]]),
      workout(at(2026, 9, 22), [['squat', [set()]]]),
    ];
    expect(topExercises(ws, 10)).toEqual([
      { exerciseId: 'squat', sessions: 2, lastDate: at(2026, 9, 22) },
      { exerciseId: 'row', sessions: 2, lastDate: at(2026, 9, 15) },
      { exerciseId: 'bench', sessions: 2, lastDate: at(2026, 9, 8) },
    ]);
    expect(topExercises(ws, 1)).toHaveLength(1);
  });
});

describe('exerciseTrend', () => {
  it('picks the metric by exercise type', () => {
    expect(progressMetricFor('weight_reps')).toBe('best1RM');
    expect(progressMetricFor('weighted_bodyweight')).toBe('heaviestKg');
    expect(progressMetricFor('bodyweight_reps')).toBe('maxReps');
    expect(progressMetricFor('duration')).toBe('maxDuration');
    expect(progressMetricFor('distance_duration')).toBe('maxDistance');
  });
  it('returns per-session values oldest first with the best', () => {
    const ws = [
      workout(at(2026, 9, 15), [['bench', [set({ weightKg: 100, reps: 1 })]]]),
      workout(at(2026, 9, 1), [['bench', [set({ weightKg: 90, reps: 1 })]]]),
    ];
    const t = exerciseTrend(ws, 'bench', 'weight_reps');
    expect(t.points.map((p) => p.value)).toEqual([90, 100]);
    expect(t.best).toBe(100);
  });
});
