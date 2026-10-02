// Server-render smoke tests: every History component renders real fixture data without throwing and
// shows the expected text (no DOM library needed — effects don't run, live queries return their defaults).
import 'fake-indexeddb/auto';
import { createElement as h, type ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { SetEntry, Workout, WorkoutExercise } from '../../types';
import { ExerciseProvider } from '../../lib/ExerciseProvider';
import { unitToKg, unitToMeters } from '../../lib/units';
import { CalendarView } from './CalendarView';
import { CelebrationCard } from './CelebrationCard';
import { HistoryPage } from './HistoryPage';
import { WorkoutCard } from './WorkoutCard';
import { WorkoutDetail, WorkoutDetailPage } from './WorkoutDetailPage';

const BENCH = 'Barbell_Bench_Press_-_Medium_Grip';
const BIKE = 'Bicycling';
const SITUP = '3_4_Sit-Up';

let n = 0;
const set = (p: Partial<SetEntry>): SetEntry => ({ id: `s${++n}`, type: 'normal', done: true, ...p });
const we = (exerciseId: string, sets: SetEntry[], p: Partial<WorkoutExercise> = {}): WorkoutExercise => ({
  id: `we${++n}`,
  exerciseId,
  sets,
  ...p,
});

const start = new Date(2026, 8, 28, 18, 12).getTime();
const benchTop = set({ weightKg: unitToKg(135, 'lb'), reps: 8 });
const workout: Workout = {
  id: 'w1',
  name: 'Push Day',
  startedAt: start,
  endedAt: start + 68 * 60_000,
  durationSec: 68 * 60,
  notes: 'Felt strong',
  exercises: [
    we(BENCH, [set({ type: 'warmup', weightKg: 20, reps: 10 }), benchTop, set({ weightKg: unitToKg(135, 'lb'), reps: 6 })], {
      supersetId: 'ss1',
      notes: 'Pause reps',
    }),
    we(SITUP, [set({ reps: 20 }), set({ reps: 18, type: 'failure' })], { supersetId: 'ss1' }),
    we(BIKE, [set({ distanceM: unitToMeters(2.1, 'mi'), durationSec: 1080 })]),
    we(BENCH, [set({ weightKg: 60, reps: 5, type: 'drop' })]),
    we(SITUP, [set({ reps: 10 })]),
    we('c_deleted', [set({ weightKg: 10, reps: 10 })]),
  ],
  exerciseIds: [BENCH, SITUP, BIKE, 'c_deleted'],
  photoIds: [],
  calories: 420,
  caloriesManual: false,
  volumeKg: 5000,
  setCount: 9,
  prs: [
    { exerciseId: BENCH, workoutExerciseId: 'x', setId: benchTop.id, kind: 'heaviest_weight', value: unitToKg(135, 'lb') },
    { exerciseId: BENCH, workoutExerciseId: 'x', setId: benchTop.id, kind: 'best_1rm', value: 70 },
  ],
  createdAt: start,
  updatedAt: start,
};

/** Visible text of the rendered markup (tags stripped), plus the raw HTML for attribute checks. */
function render(el: ReactElement, url = '/history'): string {
  const html = renderToString(h(MemoryRouter, { initialEntries: [url] }, h(ExerciseProvider, null, el)));
  const text = html
    .replace(/<!-- -->/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'");
  return `${text}
${html}`;
}

describe('History components render', () => {
  it('WorkoutCard', () => {
    const html = render(h(WorkoutCard, { workout, unit: 'lb', distanceUnit: 'mi', today: '2026-10-01' }));
    expect(html).toContain('Push Day');
    expect(html).toContain('Mon, Sep 28 | 6:12 PM');
    expect(html).toContain('3 x Bench Press (Barbell)');
    expect(html).toContain('135 lb x 8');
    expect(html).toContain('2.1 mi in 18:00');
    expect(html).toContain('+ 2 more exercises');
    expect(html).toContain('2 PRs');
    expect(html).toContain('420 kcal');
    expect(html).toContain('href="/history/w1"');
  });

  it('WorkoutCard dates follow the "today" it is given (refreshed when the app wakes)', () => {
    const props = { workout, unit: 'lb' as const, distanceUnit: 'mi' as const };
    expect(render(h(WorkoutCard, { ...props, today: '2026-09-28' }))).toContain('Today, 6:12 PM');
    expect(render(h(WorkoutCard, { ...props, today: '2026-09-29' }))).toContain('Yesterday, 6:12 PM');
  });

  it('CalendarView', () => {
    const html = render(
      h(CalendarView, { workouts: [workout], weekStartsOn: 0, unit: 'lb', distanceUnit: 'mi', now: Date.now() }),
    );
    expect(html).toMatch(/[A-Z][a-z]+ \d{4}/); // month heading
    expect(html).toContain('aria-label="Previous month"');
  });

  it('CalendarView opens on the current month unless restoring (Back), then on the saved month', () => {
    const store = new Map<string, string>([
      ['heft.history.calMonth', '2026-03'],
      ['heft.history.calDay', '2026-03-14'],
    ]);
    vi.stubGlobal('sessionStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    try {
      const now = new Date(2026, 9, 1, 9).getTime();
      const props = { workouts: [workout], weekStartsOn: 0 as const, unit: 'lb' as const, distanceUnit: 'mi' as const, now };
      const fresh = render(h(CalendarView, props));
      expect(fresh).toContain('October 2026'); // the month of the "now" it was given, not the wall clock
      const restored = render(h(CalendarView, { ...props, restore: true }));
      expect(restored).toContain('March 2026');
      expect(restored).toContain('Saturday, Mar 14'); // the saved day's list heading
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('CelebrationCard', () => {
    const html = render(h(CelebrationCard, { workout, nth: 12, unit: 'lb', distanceUnit: 'mi', onDone: () => {} }));
    expect(html).toContain('Workout complete');
    expect(html).toContain('12th');
    expect(html).toContain('2 new records');
    expect(html).toContain('Heaviest Weight');
    expect(html).toContain('135 lb');
  });

  it('WorkoutDetail', () => {
    const html = render(
      h(WorkoutDetail, { workout, celebrate: true, onBack: () => {}, onDeleteStart: () => {}, onDeleteFailed: () => {} }),
      '/history/w1?celebrate=1',
    );
    expect(html).toContain('Workout complete');
    expect(html).toContain('Mon, Sep 28, 2026 | 6:12 – 7:20 PM');
    expect(html).toContain('1h 8min');
    expect(html).toContain('est.');
    expect(html).toContain('Superset A');
    expect(html).toContain('Pause reps');
    expect(html).toContain('Weight & Reps');
    expect(html).toContain('e1RM');
    expect(html).toContain('Best 1RM');
    expect(html).toMatch(/Deleted exercise|…/); // provider is still 'loading' under SSR
    expect(html).toContain('Muscle Split');
    expect(html).toContain('Chest');
    expect(html).toContain('Felt strong');
    expect(html).toContain('href="/exercises/' + encodeURIComponent(BENCH) + '"');
  });

  it('pages render their loading state', () => {
    expect(render(h(HistoryPage))).toContain('History');
    expect(render(h(WorkoutDetailPage), '/history/w1')).toContain('Workout');
  });
});
