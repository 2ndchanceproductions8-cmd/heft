// Server-render tests for the Today dashboard's Training card (no DOM library: effects don't run and live queries
// return undefined, so the states are rendered through the pure TrainingCardView with plain props).
import 'fake-indexeddb/auto';
import { createElement as h, type ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PRRecord, Unit, Workout } from '../../types';
import { TrainingCard } from './TrainingCard';
import { TrainingCardSkeleton, TrainingCardView, type TrainingCardViewProps } from './training/TrainingCardView';
import { buildTraining, elapsedLabel, healthNudge, weekSummary } from './training/model';

// isAppleMobile() reads navigator.userAgent; the nudge's default argument is checked against this stub.
const apple = vi.hoisted(() => ({ mobile: false }));
vi.mock('../../lib/appleHealth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/appleHealth')>()),
  isAppleMobile: () => apple.mobile,
}));

beforeEach(() => {
  apple.mobile = false;
});

/** Visible text of the rendered markup (tags stripped), plus the raw HTML for attribute checks. */
function render(el: ReactElement): string {
  const html = renderToString(h(MemoryRouter, { initialEntries: ['/today'] }, el));
  const text = html
    .replace(/<!-- -->/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'");
  return `${text}\n${html}`;
}

const TODAY = '2026-10-06'; // a Tuesday
const NOW = new Date(2026, 9, 6, 18, 0).getTime();
const at = (day: number, hour: number, month = 9) => new Date(2026, month, day, hour, 0).getTime();

const pr = (n: number): PRRecord => ({
  exerciseId: `e${n}`,
  workoutExerciseId: `we${n}`,
  setId: `s${n}`,
  kind: 'heaviest_weight',
  value: 100,
});

/** 1 h, 1,000 kg volume, 400 kcal total at 80 kg = 320 active kcal (the Apple Health number). */
const workout = (p: Partial<Workout> = {}): Workout => {
  const startedAt = p.startedAt ?? at(6, 9);
  return {
    id: 'w1',
    name: 'Push Day',
    startedAt,
    endedAt: startedAt + 3_600_000,
    durationSec: 3600,
    exercises: [],
    exerciseIds: [],
    photoIds: [],
    bodyweightKg: 80,
    calories: 400,
    caloriesManual: false,
    volumeKg: 1000,
    setCount: 12,
    prs: [],
    healthSentAt: null,
    createdAt: startedAt,
    updatedAt: startedAt,
    ...p,
  };
};

const noop = () => {};
const view = (p: Partial<TrainingCardViewProps> = {}) =>
  render(
    h(TrainingCardView, {
      workouts: [],
      today: TODAY,
      now: NOW,
      unit: 'lb' as Unit,
      weekStartsOn: 0,
      active: null,
      nudge: null,
      onStartEmpty: noop,
      ...p,
    }),
  );

describe('Training card states', () => {
  it('never trained: a one-line welcome and the two ways to start', () => {
    const out = view();
    expect(out).toContain('Log your first workout and it shows up here.');
    expect(out).toContain('Start empty workout');
    expect(out).toContain('href="/workout"');
    expect(out).toContain('No streak yet');
    expect(out).not.toContain('Rest day so far');
    expect(out).not.toContain('This week');
  });

  it('rest day: says so and links the last workout with when and how long', () => {
    const out = view({ workouts: [workout({ id: 'w9', name: 'Pull Day', startedAt: at(5, 19), durationSec: 3720 })] });
    expect(out).toContain('Rest day so far');
    expect(out).toContain('Last: Pull Day · Yesterday · 1h 2min');
    expect(out).toContain('href="/history/w9"');
    expect(out).toContain('1-week streak');
    expect(out).not.toContain('Log your first workout');

    const older = view({ workouts: [workout({ name: 'Legs', startedAt: at(3, 8) })] });
    expect(older).toContain('Last: Legs · 3d ago · 1h 0min');
  });

  it('today with one workout: name, duration, volume in lb, active kcal and the PR chip', () => {
    const out = view({ workouts: [workout({ prs: [pr(1), pr(2)] })] });
    expect(out).toContain('Today');
    expect(out).toContain('Push Day');
    expect(out).toContain('1h 0min');
    expect(out).toContain('2,205 lb');
    expect(out).not.toContain('1,000 kg');
    expect(out).toContain('320 kcal active');
    expect(out).toContain('2 PRs');
    expect(out).toContain('href="/history/w1"');
    expect(out).not.toContain('Rest day so far');
  });

  it('shows volume in kg for kg users and a single PR as "1 PR"', () => {
    const out = view({ unit: 'kg', workouts: [workout({ prs: [pr(1)] })] });
    expect(out).toContain('1,000 kg');
    expect(out).not.toContain('2,205 lb');
    expect(out).toMatch(/1 PR(?!s)/);
  });

  it('today with two workouts: both rows newest first, totals for the day, no PR chip without records', () => {
    const out = view({
      workouts: [
        workout({ id: 'a', name: 'Push Day', startedAt: at(6, 9) }),
        // 45 min, 300 kcal total at 80 kg = 240 active
        workout({ id: 'b', name: 'Evening Run', startedAt: at(6, 17), durationSec: 2700, calories: 300, volumeKg: 0 }),
      ],
    });
    expect(out.indexOf('Evening Run')).toBeLessThan(out.indexOf('Push Day'));
    expect(out).toContain('1h 45min · 560 kcal active');
    expect(out).toContain('href="/history/a"');
    expect(out).toContain('href="/history/b"');
    expect(out).not.toMatch(/\d PRs?\b/);
  });

  it('a workout running: status line with elapsed time and Resume instead of the start buttons', () => {
    const out = view({
      workouts: [workout({ startedAt: at(4, 9) })],
      active: { name: 'Leg Day', startedAt: NOW - 23 * 60_000 },
    });
    expect(out).toContain('Leg DayIn progress · 23min');
    expect(out).toContain('href="/workout/active"');
    expect(out).toContain('Resume');
    expect(out).not.toContain('Start empty workout');
    expect(out).not.toContain('Rest day so far');
    expect(out).toContain('This week');

    const first = view({ active: { name: '  ', startedAt: NOW - 20_000 } });
    expect(first).toContain('WorkoutIn progress · just started');
    expect(first).not.toContain('Log your first workout');
  });

  it('a running workout keeps today\'s finished rows', () => {
    const out = view({ workouts: [workout()], active: { name: 'Second session', startedAt: NOW - 5 * 60_000 } });
    expect(out).toContain('Push Day');
    expect(out).toContain('Second sessionIn progress · 5min');
  });

  it('this week vs last week follows the week start setting', () => {
    const workouts = [
      workout({ id: 't', startedAt: at(6, 9) }), // Tue (today)
      workout({ id: 's', startedAt: at(4, 9) }), // Sun
      workout({ id: 'r', startedAt: at(1, 9) }), // Thu last week
      workout({ id: 'q', startedAt: at(30, 9, 8) }), // Wed Sep 30
    ];
    const sunday = view({ workouts, weekStartsOn: 0 });
    expect(sunday).toContain('Last week · 2 workouts');
    expect(sunday).toContain('2 workouts · 2h 0min · 4,409 lb');
    expect(sunday).toContain('2-week streak');
    expect(sunday).toContain('href="/progress"');

    const monday = view({ workouts, weekStartsOn: 1, unit: 'kg' });
    expect(monday).toContain('Last week · 3 workouts');
    expect(monday).toContain('1 workout · 1h 0min · 1,000 kg');
  });

  it('week line without workouts this week yet', () => {
    const out = view({ workouts: [workout({ startedAt: at(29, 9, 8) })] });
    expect(out).toContain('No workouts yet');
    expect(out).toContain('Last week · 1 workout');
    expect(out).not.toContain('Last week · 1 workouts');
  });

  it('a workout dated after today is neither today nor the last one', () => {
    const out = view({ workouts: [workout({ id: 'future', startedAt: at(7, 9) })] });
    expect(out).toContain('Rest day so far');
    expect(out).not.toContain('href="/history/future"');
  });

  it('Apple Health nudge renders as one line to the newest unsent workout', () => {
    const many = view({ workouts: [workout()], nudge: { count: 2, workoutId: 'w2' } });
    expect(many).toContain('2 workouts not sent to Apple Health');
    expect(many).toContain('href="/history/w2"');
    const one = view({ workouts: [workout()], nudge: { count: 1, workoutId: 'w1' } });
    expect(one).toContain('1 workout not sent to Apple Health');
    expect(view({ workouts: [workout()] })).not.toContain('Apple Health');
  });

  it('loading: the live card shows a fixed-height skeleton until its data lands', () => {
    const out = render(h(TrainingCard, { today: TODAY, now: NOW }));
    expect(out).toContain('aria-busy="true"');
    expect(out).toContain('Training');
    expect(out).not.toContain('Start empty workout');
    expect(render(h(TrainingCardSkeleton))).toContain('h-[60px]');
  });
});

describe('healthNudge', () => {
  const ws = [
    workout({ id: 'new', startedAt: at(6, 9) }),
    workout({ id: 'sent', startedAt: at(5, 9), healthSentAt: at(5, 11) }),
    workout({ id: 'mid', startedAt: at(2, 9) }),
    workout({ id: 'old', startedAt: at(28, 9, 8) }), // 8 days ago: outside the 7-day window
  ];

  it('only on an iPhone with the Shortcut set up', () => {
    expect(healthNudge(ws, { appleHealth: true }, NOW, true)).toEqual({ count: 2, workoutId: 'new' });
    expect(healthNudge(ws, { appleHealth: false }, NOW, true)).toBeNull();
    expect(healthNudge(ws, { appleHealth: true }, NOW, false)).toBeNull();
  });

  it('asks isAppleMobile() by default', () => {
    expect(healthNudge(ws, { appleHealth: true }, NOW)).toBeNull();
    apple.mobile = true;
    expect(healthNudge(ws, { appleHealth: true }, NOW)).toEqual({ count: 2, workoutId: 'new' });
  });

  it('is null when everything recent was sent', () => {
    const sent = ws.map((w) => ({ ...w, healthSentAt: w.startedAt + 1000 }));
    expect(healthNudge(sent, { appleHealth: true }, NOW, true)).toBeNull();
  });
});

describe('training model helpers', () => {
  it('buildTraining matches the Progress numbers', () => {
    const m = buildTraining([workout({ id: 'y', startedAt: at(5, 9) }), workout({ id: 't', startedAt: at(6, 7) })], TODAY, NOW, 0);
    expect(m.todays.map((w) => w.id)).toEqual(['t']);
    expect(m.last?.id).toBe('y');
    expect(m.todayTotals).toMatchObject({ workouts: 1, durationSec: 3600, activeKcal: 320, volumeKg: 1000 });
    expect(m.thisWeek.workouts).toBe(2);
    expect(m.streak).toBe(1);
  });

  it('weekSummary leaves out zero parts', () => {
    expect(weekSummary({ workouts: 0, durationSec: 0, volumeKg: 0 }, 'lb')).toBe('No workouts yet');
    expect(weekSummary({ workouts: 2, durationSec: 5400, volumeKg: 0 }, 'kg')).toBe('2 workouts · 1h 30min');
  });

  it('elapsedLabel is to the minute', () => {
    expect(elapsedLabel(NOW - 30_000, NOW)).toBe('just started');
    expect(elapsedLabel(NOW - 23 * 60_000 - 40_000, NOW)).toBe('23min');
    expect(elapsedLabel(NOW - 65 * 60_000, NOW)).toBe('1h 5min');
    expect(elapsedLabel(NOW + 60_000, NOW)).toBe('just started');
  });
});
