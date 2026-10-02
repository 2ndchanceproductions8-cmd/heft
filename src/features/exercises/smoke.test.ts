import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { createElement as h, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter, Route, RouterProvider, Routes, createMemoryRouter } from 'react-router-dom';
import type { SetEntry, Workout, WorkoutExercise } from '../../types';
import { ExerciseProvider } from '../../lib/ExerciseProvider';
import { CATALOG_BY_ID, buildExerciseIndex } from '../../lib/exercises';
import { exerciseSessions } from '../../lib/calc';
import { HistoryTab } from './HistoryTab';
import { RecordsTab } from './RecordsTab';
import { ExerciseChart } from './ExerciseChart';
import { ExerciseLibraryPage } from './ExerciseLibraryPage';
import { ExerciseDetailPage } from './ExerciseDetailPage';
import { ExerciseFormPage } from './ExerciseFormPage';

const BENCH = 'Barbell_Bench_Press_-_Medium_Grip';
let n = 0;
const set = (p: Partial<SetEntry>): SetEntry => ({ id: `s${++n}`, type: 'normal', done: true, ...p });
const we = (exerciseId: string, sets: SetEntry[]): WorkoutExercise => ({ id: `we${++n}`, exerciseId, sets });
const workout = (id: string, startedAt: number, exercises: WorkoutExercise[]): Workout => ({
  id,
  name: `Push ${id}`,
  startedAt,
  endedAt: startedAt + 1,
  durationSec: 3600,
  exercises,
  exerciseIds: exercises.map((e) => e.exerciseId),
  photoIds: [],
  volumeKg: 0,
  setCount: 0,
  prs: [],
  createdAt: startedAt,
  updatedAt: startedAt,
});

const day = 86400000;
const now = Date.now();
const w1 = workout('w1', now - 40 * day, [we(BENCH, [set({ type: 'warmup', weightKg: 40, reps: 10 }), set({ weightKg: 80, reps: 8 })])]);
const w2 = workout('w2', now - 10 * day, [we(BENCH, [set({ weightKg: 85, reps: 8 }), set({ type: 'drop', weightKg: 60, reps: 12 })])]);
w2.prs = [{ exerciseId: BENCH, workoutExerciseId: w2.exercises[0].id, setId: w2.exercises[0].sets[0].id, kind: 'heaviest_weight', value: 85 }];

const wrap = (el: ReactNode, path = '/') =>
  renderToString(h(MemoryRouter, { initialEntries: [path] }, h(ExerciseProvider, null, el)));

describe('exercises feature renders (SSR smoke)', () => {
  const ex = buildExerciseIndex([], []).get(BENCH);
  it('history tab', () => {
    const html = wrap(h(HistoryTab, { exercise: ex, workouts: [w1, w2] }));
    expect(html).toContain('Push w2');
    expect(html).toContain('PR');
    expect(html).toMatch(/187(\.\d+)? lb × 8/);
    expect(html).toContain('Best est. 1RM');
  });
  it('records tab', () => {
    const html = wrap(h(RecordsTab, { exercise: ex, workouts: [w1, w2] }));
    expect(html).toContain('Heaviest Weight');
    expect(html).toContain('Set Records');
    expect(html).toContain('Lifetime');
  });
  it('chart', () => {
    const html = wrap(h(ExerciseChart, { sessions: exerciseSessions([w1, w2], BENCH, 'weight_reps'), type: 'weight_reps' }));
    expect(html).toContain('Heaviest Weight');
    expect(html).toContain('One Rep Max');
  });
  it('chart + records for a carry show yd, not mi', () => {
    const FW = 'Farmers_Walk';
    const carry = buildExerciseIndex([], []).get(FW);
    const c1 = workout('c1', now - 20 * day, [we(FW, [set({ weightKg: 60 * 0.45359237, distanceM: 36.576 })])]);
    const c2 = workout('c2', now - 5 * day, [we(FW, [set({ weightKg: 70 * 0.45359237, distanceM: 36.576 })])]);
    const chart = wrap(h(ExerciseChart, { sessions: exerciseSessions([c1, c2], FW, 'weight_distance'), type: 'weight_distance' }));
    expect(chart).toContain('Longest Distance');
    expect(chart).not.toContain(' mi');
    const records = wrap(h(RecordsTab, { exercise: carry, workouts: [c1, c2] })).replace(/<!-- -->/g, '');
    expect(records).toContain('40 yd');
    expect(records).toContain('80 yd'); // lifetime distance
    expect(records).not.toContain(' mi');
    const history = wrap(h(HistoryTab, { exercise: carry, workouts: [c1, c2] })).replace(/<!-- -->/g, '');
    expect(history).toContain('70 lb × 40 yd');
  });
  it('library page', () => {
    const html = wrap(h(ExerciseLibraryPage));
    expect(html).toContain('Exercises');
    expect(html).toContain('All Equipment');
    expect(html).toContain('My Exercises');
  });
  it('detail page (catalog exercise)', () => {
    const html = wrap(h(Routes, null, h(Route, { path: '/exercises/:id', element: h(ExerciseDetailPage) })), `/exercises/${BENCH}`);
    expect(html).toContain(CATALOG_BY_ID.get(BENCH)!.name);
    expect(html).toContain('Machine / Brand Variants');
    expect(html).toContain('Add machine/brand variant');
  });
  it('detail page how-to tab', () => {
    const html = wrap(h(Routes, null, h(Route, { path: '/exercises/:id', element: h(ExerciseDetailPage) })), `/exercises/${BENCH}?tab=howto`);
    expect(html).toContain('<ol');
  });
  // The form page guards unsaved changes with useBlocker, which needs a data router (as in App.tsx).
  const dataRouter = (path: string) =>
    renderToString(
      h(RouterProvider, {
        router: createMemoryRouter(
          [
            { path: '/exercises/new', element: h(ExerciseProvider, null, h(ExerciseFormPage)) },
            { path: '/exercises/:id/edit', element: h(ExerciseProvider, null, h(ExerciseFormPage)) },
            { path: '/exercises/:id', element: h('div', null, 'detail page') },
          ],
          { initialEntries: [path] },
        ),
      }),
    );
  it('form page (create)', () => {
    const html = dataRouter('/exercises/new');
    expect(html).toContain('Create Exercise');
    expect(html).toContain('Smith Machine');
    expect(html).toContain('Weight &amp; Reps');
  });
  it('form page (variant of a catalog exercise)', () => {
    const html = dataRouter(`/exercises/new?variantOf=${encodeURIComponent(BENCH)}`);
    expect(html).toContain('New Variant');
    expect(html).toContain('Machine Brand / Gym Label');
    expect(html.replace(/<!-- -->/g, '')).toContain(`Variant of ${CATALOG_BY_ID.get(BENCH)!.name}`);
    // prefilled from the base on the first render (no spinner flash): equipment chip selected, primary muscle set
    expect(html).toMatch(/aria-pressed="true"[^>]*>Barbell</);
    expect(html).toContain('Create Variant');
  });
});
