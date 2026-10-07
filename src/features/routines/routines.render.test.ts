import 'fake-indexeddb/auto';
import { createElement as h, type ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter, RouterProvider, createMemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { ExerciseProvider } from '../../lib/ExerciseProvider';
import { buildExerciseIndex } from '../../lib/exercises';
import type { Routine } from '../../types';
import { RoutineCard } from './RoutineCard';
import { RoutineEditorPage } from './RoutineEditorPage';
import { RoutineExerciseCard } from './RoutineExerciseCard';
import { WorkoutHomePage } from './WorkoutHomePage';
import { RoutineDetailPage } from './RoutineDetailPage';
import { blankRoutineSet } from './routineUtils';
import { buildStarterRoutines } from './starterRoutines';

/*
 * Server-render smoke tests: every page/card must render without throwing (first paint = loading state for
 * live queries) and show the key labels. Interactive behaviour is covered by the pure-function tests.
 */

const index = buildExerciseIndex([], []);
const starter = buildStarterRoutines(index.list);
const routine: Routine = {
  id: 'r1',
  name: 'Push Day',
  folderId: null,
  order: 0,
  notes: 'Heavy week',
  exercises: starter[0].exercises.map((e, i) => (i < 2 ? { ...e, supersetId: 'ss1' } : e)),
  createdAt: 0,
  updatedAt: 0,
  lastPerformedAt: Date.now() - 3 * 86_400_000,
};

const withProviders = (el: ReactElement) => h(ExerciseProvider, null, el);
const inRouter = (el: ReactElement, path = '/workout') =>
  renderToString(withProviders(h(MemoryRouter, { initialEntries: [path] }, el)));
const inDataRouter = (path: string, routePath: string, el: ReactElement) => {
  const router = createMemoryRouter([{ path: routePath, element: withProviders(el) }], { initialEntries: [path] });
  return renderToString(h(RouterProvider, { router }));
};
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

describe('routines feature renders', () => {
  it('Workout home page', () => {
    const html = text(inRouter(h(WorkoutHomePage)));
    expect(html).toContain('Workout');
    expect(html).toContain('Start Empty Workout');
    expect(html).toContain('New Routine');
    expect(html).toContain('New Folder');
  });

  it('routine card shows name, preview, last performed and Start Routine', () => {
    const html = text(inRouter(h(RoutineCard, { routine, lastPerformedAt: routine.lastPerformedAt })));
    expect(html).toContain('Push Day');
    expect(html).toContain('& 3 more');
    expect(html).toContain('Last performed: 3 days ago');
    expect(html).toContain('Start Routine');
    const never = text(inRouter(h(RoutineCard, { routine, lastPerformedAt: null })));
    expect(never).toContain('Never performed');
  });

  it('editor card shows the set table in the user unit with rep ranges', () => {
    const re = { ...routine.exercises[0], restSec: null, sets: [blankRoutineSet({ type: 'warmup', weightKg: 20 }), blankRoutineSet({ weightKg: 60, reps: 8, repsMax: 12 })] };
    const html = inRouter(
      h(RoutineExerciseCard, {
        re,
        exercise: index.get(re.exerciseId),
        unit: 'lb',
        distanceUnit: 'mi',
        defaultRest: 90,
        superset: 0,
        exerciseCount: 3,
        onUpdate: () => {},
        onAction: () => {},
      }),
    );
    const t = text(html);
    expect(t).toContain('LB');
    expect(t).toContain('REPS');
    expect(t).toContain('Superset A');
    expect(t).toContain('Rest Timer: Default (1:30)');
    expect(t).toContain('Add Set');
    expect(html).toContain('value="132.28"'); // 60 kg in lb
    expect(html).toContain('value="8-12"');
    expect(t).toMatch(/\bW\b/);
  });

  it('editor card plans carries in yards (not 0.02 mi) and runs in miles', () => {
    const card = (exerciseId: string, distanceM: number, distanceUnit: 'mi' | 'km') =>
      inRouter(
        h(RoutineExerciseCard, {
          re: { id: 're', exerciseId, restSec: null, supersetId: null, sets: [blankRoutineSet({ weightKg: 40, distanceM })] },
          exercise: index.get(exerciseId),
          unit: 'kg',
          distanceUnit,
          defaultRest: 90,
          exerciseCount: 1,
          onUpdate: () => {},
          onAction: () => {},
        }),
      );
    const carry = card('Farmers_Walk', 40 * 0.9144, 'mi');
    expect(index.get('Farmers_Walk').type).toBe('weight_distance');
    expect(text(carry)).toContain('YD');
    expect(carry).toContain('value="40"');
    expect(carry).toContain('Set 1 distance (yd)');
    const metric = card('Farmers_Walk', 30, 'km');
    expect(text(metric)).toMatch(/\bM\b/);
    expect(metric).toContain('value="30"');
    const run = index.list.find((e) => e.type === 'distance_duration')!;
    const runHtml = card(run.id, 1609.344, 'mi');
    expect(text(runHtml)).toContain('MI');
    expect(runHtml).toContain('value="1"');
  });

  it('editor page (new routine) renders the form', () => {
    const html = text(inDataRouter('/routines/new?folder=f1', '/routines/new', h(RoutineEditorPage)));
    expect(html).toContain('Create Routine');
    expect(html).toContain('Cancel');
    expect(html).toContain('Save');
    expect(html).toContain('My Routines');
    expect(html).toContain('Add Exercise');
    expect(html).toContain('Get started by adding an exercise');
  });

  it('editor + detail pages render their loading state for an existing routine', () => {
    expect(text(inDataRouter('/routines/r1/edit', '/routines/:id/edit', h(RoutineEditorPage)))).toContain('Edit Routine');
    expect(text(inDataRouter('/routines/r1', '/routines/:id', h(RoutineDetailPage)))).toContain('Routine');
  });
});

describe('left / right switch in the routine editor', () => {
  const card = (exerciseId: string) =>
    inRouter(
      h(RoutineExerciseCard, {
        re: { id: 're', exerciseId, restSec: null, supersetId: null, sets: [blankRoutineSet({ weightKg: 20, reps: 10 })] },
        exercise: index.get(exerciseId),
        unit: 'lb',
        distanceUnit: 'mi',
        defaultRest: 90,
        exerciseCount: 1,
        onUpdate: () => {},
        onAction: () => {},
      }),
    );

  it('every exercise has the L/R switch; a two-arm exercise starts off', () => {
    const html = card('Machine_Triceps_Extension');
    expect(html).toContain('aria-label="Log left and right separately"');
    expect(html).toContain('aria-pressed="false"');
    expect(text(html)).toContain('L/R');
    expect(text(html)).not.toContain('Left & right');
  });

  it('a one-sided exercise shows it on, with "Left & right" under the name', () => {
    const html = card('One-Arm_Dumbbell_Row');
    expect(html).toContain('aria-pressed="true"');
    expect(text(html)).toContain('Left & right');
  });
});
