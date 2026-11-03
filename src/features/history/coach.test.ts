import { describe, expect, it } from 'vitest';
import type { ExerciseType, SetEntry, Workout } from '../../types';
import { syncSideSet } from '../../lib/sides';
import { coachReview } from './coach';

/*
 * The coach review (features/history/coach.ts): status against last time, the next-time target (double
 * progression), plateaus, left/right gaps and the headline. Weights are kg; LB = one pound in kg.
 */

const LB = 0.45359237;
const DAY = 86_400_000;
const t0 = Date.UTC(2026, 8, 1);
const units = { unit: 'lb', distanceUnit: 'mi' } as const;
const TYPES: Record<string, ExerciseType> = { bench: 'weight_reps', pullup: 'bodyweight_reps', plank: 'duration', curl: 'weight_reps' };
const ex = (id: string) => ({ name: id[0].toUpperCase() + id.slice(1), type: TYPES[id] ?? 'weight_reps' });

let n = 0;
const set = (lb: number | null, reps: number | null, p: Partial<SetEntry> = {}): SetEntry => ({
  id: `s${n++}`,
  type: 'normal',
  done: true,
  weightKg: lb == null ? null : lb * LB,
  reps,
  ...p,
});
const workout = (id: string, day: number, exercises: Record<string, SetEntry[]>, p: Partial<Workout> = {}): Workout => {
  const startedAt = t0 + day * DAY;
  return {
    id,
    name: 'Push',
    startedAt,
    endedAt: startedAt + 3600_000,
    durationSec: 3600,
    exercises: Object.entries(exercises).map(([exerciseId, sets]) => ({ id: `${id}_${exerciseId}`, exerciseId, sets })),
    exerciseIds: Object.keys(exercises),
    photoIds: [],
    volumeKg: 0,
    setCount: 0,
    prs: [],
    createdAt: startedAt,
    updatedAt: startedAt,
    ...p,
  };
};
const review = (w: Workout, before: Workout[], later: string[] = []) => coachReview(w, before, new Set(later), ex, units);
const only = (r: ReturnType<typeof review>, id = 'bench') => r.exercises.find((e) => e.exerciseId === id)!;

describe('status against last time', () => {
  const prev = workout('prev', 0, { bench: [set(145, 8), set(145, 7)] });

  it('a heavier top set is up and names the change', () => {
    const e = only(review(workout('w', 7, { bench: [set(150, 6)] }), [prev]));
    expect(e).toMatchObject({ status: 'up', change: '+5 lb', today: '150 lb x 6', previous: '145 lb x 8' });
  });

  it('same weight, more reps is up; identical is same', () => {
    expect(only(review(workout('w', 7, { bench: [set(145, 10)] }), [prev]))).toMatchObject({ status: 'up', change: '+2 reps' });
    expect(only(review(workout('w', 7, { bench: [set(145, 8), set(145, 7)] }), [prev]))).toMatchObject({ status: 'same', change: null });
  });

  it('lighter top set is down, unless total work rose 5%+ (mixed)', () => {
    expect(only(review(workout('w', 7, { bench: [set(135, 8)] }), [prev]))).toMatchObject({ status: 'down', change: '−10 lb' });
    const lighterMore = workout('w', 7, { bench: [set(140, 12), set(140, 12), set(140, 12)] });
    const e = only(review(lighterMore, [prev]));
    expect(e.status).toBe('mixed');
    expect(e.workChangePct).toBeGreaterThan(5);
  });

  it('first time ever is a baseline; warm-ups never count', () => {
    const e = only(review(workout('w', 7, { bench: [set(225, 1, { type: 'warmup' }), set(135, 10)] }), []));
    expect(e).toMatchObject({ status: 'first', today: '135 lb x 10', previous: null });
  });
});

describe('next-time target (double progression)', () => {
  const next = (sets: SetEntry[], before: Workout[] = [workout('p', 0, { bench: [set(100, 5)] })]) =>
    only(review(workout('w', 7, { bench: sets }), before)).next;

  it('every set 12+ → add 5 lb', () => {
    expect(next([set(135, 12), set(135, 12), set(135, 13)])).toMatch(/Add 5 lb: 140 lb/);
  });
  it('8-11 reps → stay and add a rep to every set', () => {
    expect(next([set(135, 10), set(135, 9)])).toMatch(/Stay at 135 lb and aim for 10 reps on every set/);
  });
  it('the weakest set at the top weight decides (not the best)', () => {
    expect(next([set(135, 12), set(135, 8)])).toMatch(/aim for 9 reps/);
  });
  it('under 8 → build to 8; under 5 → build to 5 first', () => {
    expect(next([set(185, 6), set(185, 6)])).toMatch(/build to 8 reps/);
    expect(next([set(225, 3)])).toMatch(/to 5, then to 8/);
  });
  it('after a drop: match last time first, reps before weight', () => {
    expect(next([set(135, 8)], [workout('p', 0, { bench: [set(145, 8)] })])).toMatch(/Match last time first \(145 lb x 8\)/);
  });
  it('kg users get 2.5 kg steps', () => {
    const w = workout('w', 7, { bench: [{ id: 'k', type: 'normal', done: true, weightKg: 60, reps: 12 }] });
    const e = coachReview(w, [workout('p', 0, { bench: [set(100, 5)] })], new Set(), ex, { unit: 'kg', distanceUnit: 'km' }).exercises[0];
    expect(e.next).toMatch(/Add 2.5 kg: 62.5 kg/);
  });
  it('bodyweight, holds and no target when a later workout has the exercise', () => {
    expect(only(review(workout('w', 7, { pullup: [set(null, 10), set(null, 9)] }), [workout('p', 0, { pullup: [set(null, 8)] })]), 'pullup').next).toMatch(/Add 1-2 reps/);
    expect(only(review(workout('w', 7, { plank: [{ id: 'd', type: 'normal', done: true, durationSec: 60 }] }), []), 'plank').next).toMatch(/5-10 seconds/);
    expect(only(review(workout('w', 7, { bench: [set(135, 8)] }), [], ['bench'])).next).toBeNull();
  });
});

describe('plateaus', () => {
  it('no progress across three sessions → stalled, deload to 90%', () => {
    const before = [workout('b2', 7, { bench: [set(145, 8)] }), workout('b1', 0, { bench: [set(145, 8)] })];
    const r = review(workout('w', 14, { bench: [set(145, 8)] }), before);
    const e = only(r);
    expect(e.stalled).toBe(true);
    expect(e.next).toMatch(/Stuck for 3 sessions\. Drop to 130 lb/);
    expect(r.notes.join(' ')).toMatch(/Stuck for 3 sessions: Bench/);
  });
  it('a light load still gets a real drop (25 lb → 22.5 lb, not back to 25)', () => {
    const before = [workout('b2', 7, { curl: [set(25, 12)] }), workout('b1', 0, { curl: [set(25, 12)] })];
    expect(only(review(workout('w', 14, { curl: [set(25, 12)] }), before), 'curl').next).toMatch(/Drop to 22.5 lb/);
  });
  it('any progress inside the window is not a plateau', () => {
    const before = [workout('b2', 7, { bench: [set(145, 9)] }), workout('b1', 0, { bench: [set(145, 8)] })];
    expect(only(review(workout('w', 14, { bench: [set(145, 8)] }), before)).stalled).toBe(false);
  });
});

describe('left / right gaps', () => {
  const side = (l: number, r: number) =>
    syncSideSet({
      id: `s${n++}`,
      type: 'normal',
      done: true,
      sides: { left: { weightKg: l * LB, reps: 10 }, right: { weightKg: r * LB, reps: 10 } },
    } as SetEntry);

  it('a 10%+ gap is called out and names the weaker side', () => {
    const e = only(review(workout('w', 7, { curl: [side(40, 50)] }), []), 'curl');
    expect(e.sideNote).toMatch(/left side is 20% behind on Curl/);
  });
  it('a small gap is not', () => {
    expect(only(review(workout('w', 7, { curl: [side(50, 52)] }), []), 'curl').sideNote).toBeNull();
  });
});

describe('headline and notes', () => {
  const prev = workout('prev', 0, { bench: [set(145, 8)], pullup: [set(null, 8)], curl: [set(30, 10)] }, { volumeKg: 1000, name: 'Push' });
  const tone = (b: SetEntry[], p: SetEntry[], c: SetEntry[]) => review(workout('w', 7, { bench: b, pullup: p, curl: c }), [prev]).tone;

  it('first session on record is a baseline', () => {
    expect(review(workout('w', 7, { bench: [set(135, 8)] }), [])).toMatchObject({ tone: 'baseline' });
  });
  it('progress with no drops is great; more up than down is good; a tie or flat is steady; mostly down is caution', () => {
    expect(tone([set(150, 8)], [set(null, 9)], [set(30, 10)])).toBe('great');
    expect(tone([set(150, 8)], [set(null, 9)], [set(25, 10)])).toBe('good');
    expect(tone([set(150, 8)], [set(null, 5)], [set(30, 10)])).toBe('steady'); // 1 up, 1 down, 1 same
    expect(review(workout('w', 7, { bench: [set(150, 8)], pullup: [set(null, 5)] }), [prev]).headline).toMatch(/^Mixed session\. Up on 1, down on 1/);
    expect(tone([set(145, 8)], [set(null, 8)], [set(30, 10)])).toBe('steady');
    const r = review(workout('w', 7, { bench: [set(135, 8)], pullup: [set(null, 5)], curl: [set(30, 10)] }), [prev]);
    expect(r.tone).toBe('caution');
    expect(r.notes.join(' ')).toMatch(/sleep, food or stress/);
  });
  it('records, and volume on the lifts both workouts share (from the sets, not the stored total)', () => {
    const w = workout('w', 7, { bench: [set(160, 8)], pullup: [set(null, 9)] }, { prs: [{ setId: 'x', kind: 'heaviest_weight', exerciseId: 'bench', value: 1 }] as Workout['prs'] });
    const notes = review(w, [prev]).notes.join(' ');
    expect(notes).toMatch(/1 new record/);
    // bench 145x8 = 1160 lb-equivalent before, 160x8 = 1280 now: +10%. The pull-up carries no load.
    expect(notes).toMatch(/Volume on these lifts is up 10% on your last Push/);
  });
  it('a short session is not "down" against a long one: only the shared lifts are compared', () => {
    const full = workout('full', 0, { bench: [set(145, 8)], pullup: [set(null, 8)], curl: [set(30, 10)] }, { volumeKg: 99999, name: 'Push' });
    const notes = review(workout('w', 7, { bench: [set(145, 8)] }), [full]).notes.join(' ');
    expect(notes).toMatch(/Volume on these lifts matched your last Push/);
  });
  it('an empty workout has nothing to review', () => {
    expect(review(workout('w', 7, { bench: [] }), [prev]).exercises).toEqual([]);
  });
});
