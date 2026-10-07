// Server-render tests for Today's "Last 7 days" card (no DOM library: effects don't run and live queries return
// undefined, so the card is rendered through its pure view with plain rows).
import 'fake-indexeddb/auto';
import { createElement as h, type ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { Measurement, Unit, Workout } from '../../types';
import type { Meal, MealStatus } from '../../lib/nutrition/types';
import { emptyTotals, recomputeMeal } from '../../lib/nutrition/math';
import { bodySummary, buildWeek, lastDays } from '../../lib/today';
import { WeekCard } from './WeekCard';
import { CHART_H, WeekCardSkeleton, WeekCardView } from './week/WeekCardView';
import { DayDetail } from './week/DayDetail';
import { diaryHref, rateText, shortDuration, trendGeometry, weightRange, weekModel } from './week/model';

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

const count = (s: string, re: RegExp) => (s.match(new RegExp(re.source, 'g')) ?? []).length;

const TODAY = '2026-10-06'; // a Tuesday; the window is Wed Sep 30 … Tue Oct 6
const LB = 0.45359237;

/** Local epoch ms on a day key at an hour. */
function on(day: string, hour = 12, minute = 0): number {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d, hour, minute).getTime();
}

function meal(day: string, kcal: number, p: { proteinG?: number; status?: MealStatus; id?: string; hour?: number } = {}): Meal {
  const at = on(day, p.hour ?? 12);
  return recomputeMeal({
    id: p.id ?? `meal_${day}_${kcal}_${p.status ?? 'done'}`,
    at,
    day,
    title: 'Lunch',
    status: p.status ?? 'done',
    statusAt: at,
    error: null,
    input: { kind: 'quick' },
    photoIds: [],
    serves: 1,
    items: [
      {
        id: 'it',
        name: 'Quick add',
        portion: '',
        grams: null,
        baselineGrams: null,
        per100g: null,
        fixed: { ...emptyTotals(), kcal, proteinG: p.proteinG ?? 0 },
        source: 'manual',
      },
    ],
    totals: emptyTotals(),
    confidence: null,
    scaleReference: null,
    notes: '',
    angles: 0,
    aiCalls: [],
    createdAt: at,
    updatedAt: at,
  });
}

function workout(day: string, minutes: number, name = 'Push day', hour = 18): Workout {
  const startedAt = on(day, hour);
  return {
    id: `w_${day}_${hour}`,
    name,
    startedAt,
    endedAt: startedAt + minutes * 60_000,
    durationSec: minutes * 60,
    exercises: [],
    exerciseIds: [],
    photoIds: [],
    calories: null,
    volumeKg: 0,
    setCount: 0,
    prs: [],
    createdAt: startedAt,
    updatedAt: startedAt,
  };
}

function weighIn(day: string, kg: number, p: { bodyFatPct?: number; source?: 'manual' | 'health'; hour?: number } = {}): Measurement {
  return {
    id: `m_${day}`,
    date: on(day, p.hour ?? 7),
    bodyweightKg: kg,
    bodyFatPct: p.bodyFatPct ?? null,
    photoIds: [],
    source: p.source,
  };
}

const TARGETS = { kcal: 2200, proteinG: 180, tdee: 2700 };

function card(p: { meals?: Meal[]; workouts?: Workout[]; measurements?: Measurement[]; targets?: typeof TARGETS | null; unit?: Unit } = {}) {
  return render(
    h(WeekCardView, {
      today: TODAY,
      meals: p.meals ?? [],
      workouts: p.workouts ?? [],
      measurements: p.measurements ?? [],
      targets: p.targets === undefined ? TARGETS : p.targets,
      unit: p.unit ?? 'lb',
    }),
  );
}

/** data-bar of a day's food mark. */
const barOf = (out: string, day: string) => new RegExp(`data-food-day="${day}" data-bar="(\\w+)"`).exec(out)?.[1];
/** data-h (height %) of a day's bar. */
const heightOf = (out: string, day: string) => new RegExp(`data-food-day="${day}" data-bar="\\w+" data-h="([\\d.]+)"`).exec(out)?.[1];

describe('Last 7 days card', () => {
  it('brand-new user: every lane explains itself and the summary says how it fills in', () => {
    const out = card({ targets: null });
    expect(out).toContain('Last 7 days');
    expect(out).toContain('Sep 30 – Oct 6');
    expect(out).toContain('No weigh-ins yet');
    expect(out).toContain('Foodnothing logged'); // the lane's own label, not the 7 column aria-labels
    expect(out).toContain('no workouts');
    expect(out).toContain('Fills in as you log meals, workouts and weigh-ins.');
    expect(count(out, /data-bar="none"/)).toBe(7);
    expect(count(out, /data-rest="/)).toBe(7);
    expect(out).not.toContain('data-trend=');
    expect(out).not.toContain('data-weighin=');
    expect(out).not.toContain('data-target-line');
    // No row of empty stats: the one line explains the card instead.
    expect(out).not.toContain('Avg eaten');
    // The columns are still there (and tappable) with plain labels.
    expect(count(out, /<button[^>]*data-day="/)).toBe(7);
    expect(out).toContain('aria-label="Wed, Sep 30: nothing logged, no workout, no weigh-in"');

    // With targets set but nothing eaten yet, the lane stays dashes (no lone target line).
    const withTargets = card();
    expect(withTargets).not.toContain('data-target-line');
    expect(withTargets).toContain('Foodnothing logged');
  });

  it('a day with nothing logged gets a dash, never a 0 kcal bar (only done meals count)', () => {
    const out = card({
      meals: [
        meal('2026-10-01', 2000),
        meal('2026-10-03', 800, { status: 'failed' }),
        meal('2026-10-04', 650, { status: 'pending' }),
        meal('2026-10-05', 0), // black coffee: logged, 0 kcal
      ],
    });
    expect(barOf(out, '2026-10-01')).toBe('logged');
    expect(barOf(out, '2026-09-30')).toBe('none');
    expect(barOf(out, '2026-10-03')).toBe('none');
    expect(barOf(out, '2026-10-04')).toBe('none');
    // A logged 0 kcal day is a sliver of a bar, not a dash.
    expect(barOf(out, '2026-10-05')).toBe('logged');
    expect(heightOf(out, '2026-10-05')).toBe('2.5');
    expect(count(out, /data-bar="none"/)).toBe(5);
    expect(out).toContain('aria-label="Sat, Oct 3: nothing logged, no workout, no weigh-in"');
  });

  it("draws today's bar as in progress", () => {
    const out = card({ meals: [meal('2026-10-05', 2100), meal(TODAY, 900)] });
    expect(barOf(out, TODAY)).toBe('today');
    expect(barOf(out, '2026-10-05')).toBe('logged');
    expect(out).toMatch(/data-bar="today"[^>]*>(<span[^>]*>)*<span data-part="under" class="[^"]*bg-accent-soft[^"]*" style="background-image:repeating-linear-gradient/);
    expect(out).toContain('aria-label="Today, Tue, Oct 6: 900 kcal so far, no workout, no weigh-in"');
  });

  it('tints the portion above the target danger, under a dashed target line', () => {
    const out = card({ meals: [meal('2026-10-02', 2750), meal('2026-10-03', 1900), meal(TODAY, 2420)] });
    // 2,750 vs 2,200: the top fifth of the bar is over.
    expect(out).toMatch(/data-food-day="2026-10-02" data-bar="logged" data-h="90\.9" data-over="true"[^>]*><span data-part="over" class="shrink-0 bg-danger" style="height:20%"/);
    // Under target: no over part.
    expect(out).toMatch(/data-food-day="2026-10-03" data-bar="logged" data-h="[\d.]+" class=/);
    // Today over target: the over part is in progress too.
    expect(out).toMatch(/data-food-day="2026-10-06" data-bar="today" data-h="[\d.]+" data-over="true"[^>]*><span data-part="over" class="shrink-0 bg-danger-soft text-danger"/);
    // Lane scaled to 2,750 × 1.1: the target sits at 2,200 / 3,025 = 72.7 %.
    expect(out).toMatch(/data-target-line[^>]*style="bottom:72\.72/);
    expect(out).toContain('target 2,200');
  });

  it('no targets: bars only, scaled to the biggest day', () => {
    const out = card({ targets: null, meals: [meal('2026-10-01', 1800), meal('2026-10-02', 2400)] });
    expect(out).not.toContain('data-target-line');
    expect(out).not.toContain('data-over');
    expect(heightOf(out, '2026-10-02')).toBe('90.9'); // 100 / 1.1
    expect(heightOf(out, '2026-10-01')).toBe('68.2'); // 1,800 / 2,640
    expect(out).toContain('no target set');
    expect(out).not.toContain('goal ');
  });

  it('puts weigh-in dots only on weigh-in days while the trend line spans the week', () => {
    const measurements = [weighIn('2026-09-20', 84.4), weighIn('2026-10-01', 83.9), weighIn('2026-10-04', 83.5)];
    const out = card({ measurements });
    expect(count(out, /data-weighin="/)).toBe(2);
    expect(out).toContain('data-weighin="2026-10-01"');
    expect(out).toContain('data-weighin="2026-10-04"');
    // Column 0 interpolated between the Sep 20 trend and Oct 1, carried on (dashed) to today.
    expect(out).toContain('data-trend="0-6"');
    expect(out).toContain('data-trend-tail');
    const trend = bodySummary(measurements, TODAY).trendKg!;
    expect(out).toContain(`trend ${(trend / LB).toFixed(1)} lb`);

    // Weighed today: the line ends on today's reading, no dashed carry.
    const weighed = card({ measurements: [...measurements, weighIn(TODAY, 83.2)] });
    expect(weighed).toContain('data-trend="0-6"');
    expect(weighed).not.toContain('data-trend-tail');
    expect(count(weighed, /data-weighin="/)).toBe(3);

    // First weigh-in ever mid-week: the line starts there (nothing before it).
    const fresh = card({ measurements: [weighIn('2026-10-02', 80)] });
    expect(fresh).toContain('data-trend="2-6"');
    expect(count(fresh, /data-weighin="/)).toBe(1);
  });

  it('no weigh-in this week: the trend carries across dashed, and says when the last one was', () => {
    const out = card({ measurements: [weighIn('2026-09-21', 84)] });
    expect(out).toContain('data-trend="0-6"');
    expect(out).toContain('data-trend-tail');
    expect(out).not.toContain('data-weighin=');
    expect(out).toContain('Last weigh-in Mon, Sep 21');
    expect(out).not.toContain('No weigh-ins yet');
  });

  it('summary: the average leaves out today and unlogged days', () => {
    const out = card({
      meals: [
        meal('2026-10-01', 1800, { proteinG: 150 }),
        meal('2026-10-03', 1500, { id: 'a' }),
        meal('2026-10-03', 900, { id: 'b', hour: 19 }),
        meal('2026-10-02', 5000, { status: 'failed' }),
        meal(TODAY, 600),
      ],
    });
    // (1,800 + 2,400) / 2 — not today's 600, not the failed meal, not the five days with nothing.
    expect(out).toMatch(/Avg eaten2,100kcal2 days loggedtarget 2,200/);
    expect(out).toContain("The average leaves out today until it's over.");

    const onlyToday = card({ meals: [meal(TODAY, 600)] });
    expect(onlyToday).toMatch(/Avg eaten—only today so far/);
    expect(onlyToday).not.toContain('The average leaves out today');
  });

  it('summary: workouts and their time; the training lane marks workout days', () => {
    const out = card({
      workouts: [
        workout('2026-10-02', 52),
        workout('2026-10-05', 45, 'Pull', 7),
        workout('2026-10-05', 30, 'Run', 18),
        workout('2026-09-29', 60), // before the window
      ],
    });
    expect(out).toContain('data-train="2026-10-02" data-workouts="1"');
    expect(out).toContain('data-train="2026-10-05" data-workouts="2"');
    expect(out).toContain('52m');
    expect(out).toContain('1h 15m');
    expect(count(out, /data-rest="/)).toBe(5);
    expect(out).toMatch(/Training3workouts2h 7min/);
    expect(out).toContain('aria-label="Mon, Oct 5: nothing logged, 2 workouts, no weigh-in"');
  });

  it('shows weights and the weekly rate in the user unit', () => {
    const measurements = [
      weighIn('2026-09-16', 84.0),
      weighIn('2026-09-23', 83.6),
      weighIn('2026-09-30', 83.3),
      weighIn('2026-10-05', 83.0),
    ];
    const rate = bodySummary(measurements, TODAY).rateKgPerWeek!;
    expect(rate).toBeLessThan(0);

    const lb = card({ measurements });
    expect(lb).toContain(`Weekly rate${rateText(rate, 'lb')}lb/wk`);
    expect(rateText(rate, 'lb').startsWith('−')).toBe(true);
    expect(lb).toContain('goal −1.0/wk'); // (2,200 − 2,700) × 7 / 7,700 kg = −1.0 lb a week
    expect(lb).toContain('aria-label="Mon, Oct 5: nothing logged, no workout, 183.0 lb"');
    expect(lb).not.toContain(' kg');

    const kg = card({ measurements, unit: 'kg' });
    expect(kg).toContain(`Weekly rate${rateText(rate, 'kg')}kg/wk`);
    expect(kg).toContain('goal −0.5/wk');
    expect(kg).toContain('aria-label="Mon, Oct 5: nothing logged, no workout, 83.0 kg"');
    expect(kg).toMatch(/trend 83\.\d kg/);
    expect(kg).not.toContain(' lb');

    // Too few readings for a rate: a dash, and why.
    const early = card({ measurements: [weighIn('2026-10-04', 83)] });
    expect(early).toMatch(/Weekly rate—not enough weigh-ins yet/);
  });

  it("calls a target inside the Body card's maintain band 'hold', not a tiny goal pace", () => {
    // 2,600 vs 2,700 TDEE: −0.09 kg a week (−0.2 lb), which the Body card calls "goal: hold steady".
    const lb = card({ meals: [meal('2026-10-05', 2500)], targets: { kcal: 2600, proteinG: 180, tdee: 2700 } });
    expect(lb).toContain('goal: hold');
    expect(lb).not.toContain('goal −');
    const kg = card({ meals: [meal('2026-10-05', 2500)], targets: { kcal: 2600, proteinG: 180, tdee: 2700 }, unit: 'kg' });
    expect(kg).toContain('goal: hold');
    expect(kg).not.toContain('goal −');
  });

  it('labels every day column for screen readers', () => {
    const out = card({
      meals: [meal('2026-10-05', 2140)],
      workouts: [workout('2026-10-05', 50)],
      measurements: [weighIn('2026-10-05', 184.2 * LB)],
    });
    const labels = [...out.matchAll(/<button[^>]*data-day="([\d-]+)" aria-label="([^"]+)"/g)].map((m) => [m[1], m[2]]);
    expect(labels.map((l) => l[0])).toEqual(lastDays(TODAY, 7));
    expect(labels[5][1]).toBe('Mon, Oct 5: 2,140 kcal, 1 workout, 184.2 lb');
    expect(labels[6][1]).toBe('Today, Tue, Oct 6: nothing logged, no workout, no weigh-in');
    expect(labels[0][1]).toBe('Wed, Sep 30: nothing logged, no workout, no weigh-in');
  });

  it('loading: the live card holds the card height with a skeleton', () => {
    const live = render(h(WeekCard, { today: TODAY, now: on(TODAY, 9) }));
    expect(live).toContain('data-loading');
    expect(live).toContain(`height:${CHART_H}px`);
    expect(live).not.toContain('data-day=');
    // The loaded card's chart is the same height.
    expect(card()).toContain(`height:${CHART_H}px`);
    expect(render(h(WeekCardSkeleton))).toContain('Last 7 days');
  });
});

describe('day sheet', () => {
  const week = (meals: Meal[], workouts: Workout[], measurements: Measurement[]) => {
    const body = bodySummary(measurements, TODAY);
    return buildWeek(lastDays(TODAY, 7), meals, workouts, body.weighIns, body.trend);
  };
  const detail = (day: ReturnType<typeof week>[number], workouts: Workout[] = [], unit: Unit = 'lb') =>
    render(h(DayDetail, { day, today: TODAY, unit, targetKcal: 2200, targetProteinG: 180, workouts, onGo: () => {} }));

  it('shows food vs target, each workout and the weigh-in', () => {
    const w = workout('2026-10-05', 52, 'Upper A');
    const days = week(
      [meal('2026-10-05', 2750, { proteinG: 162 })],
      [w],
      // An earlier reading so the Oct 5 trend (83.81 kg = 184.8 lb) differs from the reading (184.1 lb).
      [weighIn('2026-09-20', 85), weighIn('2026-10-05', 83.5, { bodyFatPct: 18.4, source: 'health' })],
    );
    const out = detail(days[5], [w]);
    expect(out).toContain('2,750/ 2,200 kcal');
    expect(out).toContain('162 / 180 g protein · 1 meal');
    expect(out).toContain('550 kcal over target');
    // Over target is red, as on the Food card's ring and in the Diary.
    expect(out).toMatch(/class="[^"]*text-danger[^"]*">550 kcal over target/);
    expect(out).toContain('Open food diary');
    expect(out).toContain(`data-workout="${w.id}"`);
    expect(out).toContain('Upper A');
    const link = out.match(/<button[^>]*data-weighin-link[^>]*>([\s\S]*?)<\/button>/)![1];
    expect(link).toContain('184.1 lb');
    expect(link).not.toContain('184.8');
    expect(out).toContain('18.4% body fat · Apple Health · 7:00 AM');
    expect(out).toContain('Trend 184.8 lb');
  });

  it("today counts what's left; an empty day still offers the diary", () => {
    const days = week([meal(TODAY, 900)], [], []);
    const today = detail(days[6]);
    expect(today).toContain('so far');
    expect(today).toContain('1,300 kcal left');
    expect(today).toContain('No workout yet');

    const empty = detail(days[2]);
    expect(empty).toContain('Nothing logged');
    expect(empty).toContain('Rest day');
    expect(empty).toContain('No weigh-in');
    expect(empty).toContain('Open food diary');
    expect(empty).not.toContain('Trend ');
  });

  it("links to that day's diary (the plain Diary for today)", () => {
    expect(diaryHref(TODAY, TODAY)).toBe('/nutrition');
    expect(diaryHref('2026-10-05', TODAY)).toBe('/nutrition?d=2026-10-05');
  });
});

describe('week math', () => {
  it('keeps the weight lane at least 1.5 kg tall so scale noise looks like noise', () => {
    const flat = weightRange([83.2, 83.4])!;
    expect(flat.hi - flat.lo).toBeCloseTo(1.5);
    expect((flat.hi + flat.lo) / 2).toBeCloseTo(83.3);
    const wide = weightRange([80, 84])!;
    expect(wide.lo).toBeLessThan(80);
    expect(wide.hi).toBeGreaterThan(84);
    expect(weightRange([])).toBeNull();
  });

  it('joins the trend at weigh-in days instead of drawing carried steps', () => {
    const body = bodySummary([weighIn('2026-10-01', 84), weighIn('2026-10-04', 83)], TODAY);
    const days = buildWeek(lastDays(TODAY, 7), [], [], body.weighIns, body.trend);
    const geo = trendGeometry(days)!;
    expect(geo.line.map((p) => p.i)).toEqual([1, 4]);
    expect(geo.tail?.map((p) => p.i)).toEqual([4, 6]);
    expect(geo.dots.map((p) => p.kg)).toEqual([84, 83]);
  });

  it("starts the line from the week's own change, not an old weigh-in's whole drop", () => {
    // The Shortcut imports only the latest sample, so a two-month gap before this week's readings is normal.
    const measurements = [
      weighIn('2026-08-01', 90),
      weighIn('2026-10-03', 84.0),
      weighIn('2026-10-04', 83.8),
      weighIn('2026-10-05', 84.1),
    ];
    const m = weekModel({ today: TODAY, meals: [], workouts: [], measurements, targets: null });
    expect(m.trendIn).toEqual({ day: '2026-08-01', kg: 90 });
    const geo = trendGeometry(m.days, m.trendIn)!;
    // Column 0 (Sep 30) is 60/63 of the way from the Aug 1 trend to the Oct 3 one, not 90 kg.
    expect(geo.line[0].i).toBe(0);
    expect(geo.line[0].kg).toBeCloseTo(84.29, 1);
    // The range fits the week's readings instead of stretching up to 90 kg.
    expect(geo.range.hi).toBeLessThan(85);

    // No weigh-in this week: column 0 keeps the carried trend (and the flat dashed tail).
    const quiet = weekModel({ today: TODAY, meals: [], workouts: [], measurements: [weighIn('2026-08-01', 90)], targets: null });
    const carried = trendGeometry(quiet.days, quiet.trendIn)!;
    expect(carried.line).toEqual([{ i: 0, kg: 90 }]);
    expect(carried.tail).toEqual([{ i: 0, kg: 90 }, { i: 6, kg: 90 }]);
  });

  it('counts the week and formats compact times and rates', () => {
    const m = weekModel({ today: TODAY, meals: [], workouts: [], measurements: [], targets: null });
    expect(m.empty).toBe(true);
    expect(m.days).toHaveLength(7);
    expect(m.goalRateKgPerWeek).toBeNull();
    expect(shortDuration(52 * 60)).toBe('52m');
    expect(shortDuration(65 * 60)).toBe('1h 5m');
    expect(shortDuration(120 * 60)).toBe('2h');
    expect(shortDuration(0)).toBe('');
    expect(rateText(0.2 * LB, 'lb')).toBe('+0.2');
    expect(rateText(-0.01, 'kg')).toBe('0.0');
  });
});

describe('Maintain · Recomp in the week', () => {
  const RECOMP_TARGETS = {
    kcal: 2293,
    proteinG: 170,
    tdee: 2693,
    recomp: { trainingDay: false, trainingKcal: 2693, restKcal: 2293, trainingDaysPerWeek: 4, avgKcal: 2521 },
  };

  it('each day has its own target: a workout (or a training mark, or running today) = maintenance, else rest', () => {
    const m = weekModel({
      today: TODAY,
      meals: [],
      workouts: [workout('2026-10-01', 60), workout('2026-10-04', 45)],
      measurements: [],
      targets: RECOMP_TARGETS,
      trainingMarks: { '2026-10-02': true, '2026-10-04': false },
      runningToday: true,
    });
    expect(m.recomp).toBe(true);
    expect(m.targetKcal).toBe(2521); // the week's average
    expect(m.dayTargetKcal).toEqual({
      '2026-09-30': 2293,
      '2026-10-01': 2693, // workout
      '2026-10-02': 2693, // marked training
      '2026-10-03': 2293,
      '2026-10-04': 2293, // workout, but marked rest
      '2026-10-05': 2293,
      '2026-10-06': 2693, // running today
    });
    // The weekly goal follows the average (≈ −0.16 kg a week), not today's rest target.
    expect(m.goalRateKgPerWeek).toBeCloseTo(((2521 - 2693) * 7) / 7700, 6);
  });

  it('bars are over only against their own day: 2,500 is fine on a training day, over on a rest day', () => {
    const out = render(
      h(WeekCardView, {
        today: TODAY,
        meals: [meal('2026-10-01', 2500), meal('2026-10-03', 2500)],
        workouts: [workout('2026-10-01', 60)],
        measurements: [],
        targets: RECOMP_TARGETS,
        unit: 'lb',
      }),
    );
    expect(out).toMatch(/data-food-day="2026-10-01" data-bar="logged" data-h="[\d.]+" class/);
    expect(out).toMatch(/data-food-day="2026-10-03" data-bar="logged" data-h="[\d.]+" data-over="true"/);
    expect(count(out, /data-target-mark=/)).toBe(7);
    expect(out).not.toContain('data-target-line');
    expect(out).toContain('target by day');
    expect(out).toContain('avg target 2,521');
  });
});
