import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Measurement, PRRecord, Workout } from '../types';
import type { Meal, MealItem, MealStatus } from './nutrition/types';
import { emptyTotals, recomputeMeal, shiftDay } from './nutrition/math';
import { computeTargets, DEFAULT_NUTRITION } from './nutrition/targets';
import {
  averageIntake,
  bodySummary,
  buildWeek,
  dailyBodyFat,
  dailyIntake,
  dailyTraining,
  dailyWeighIns,
  daysBetween,
  goalRateKgPerWeek,
  KCAL_PER_KG,
  lastDays,
  latestBodyFat,
  unsentWorkouts,
  weeklyRateKg,
  weeklySlope,
  weightTrend,
} from './today';

/*
 * Adversarial tests for the Today dashboard's math (lib/today.ts). Every day key in lib/today is a LOCAL calendar
 * day, so this file pins the process to a zone with daylight saving time (the repo's other tests just inherit the
 * machine's zone). Node re-reads TZ when it is assigned, and this relies on vitest's forks pool (one child process
 * per file, pinned in vite.config.ts; a worker thread would ignore the assignment), so this reaches no other file;
 * it is restored anyway. All dates below are built inside tests or after this line.
 * US 2026: clocks spring forward Sun 8 Mar (a 23 h day) and fall back Sun 1 Nov (a 25 h day).
 */
const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = 'America/New_York';
afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

const HOUR = 3_600_000;

/** Local wall-clock time (month 1-12). */
const at = (y: number, m: number, d: number, h = 7, min = 0) => new Date(y, m - 1, d, h, min).getTime();
/** Local time on a day key. */
const onDay = (day: string, h = 7, min = 0) => {
  const [y, m, d] = day.split('-').map(Number);
  return at(y, m, d, h, min);
};

let seq = 0;

function row(p: {
  date: number;
  kg?: number | null;
  fat?: number | null;
  source?: 'manual' | 'health';
  id?: string;
}): Measurement {
  const m: Measurement = { id: p.id ?? 'm' + ++seq, date: p.date, bodyweightKg: p.kg ?? null, bodyFatPct: p.fat ?? null, photoIds: [] };
  if (p.source) m.source = p.source;
  return m;
}

function meal(
  day: string,
  kcal: number,
  status: MealStatus = 'done',
  extra: { proteinG?: number; carbsG?: number; fatG?: number; serves?: number; at?: number } = {},
): Meal {
  const when = extra.at ?? onDay(day, 12);
  const item: MealItem = {
    id: 'i' + ++seq,
    name: 'Quick add',
    portion: '',
    grams: null,
    baselineGrams: null,
    per100g: null,
    fixed: { ...emptyTotals(), kcal, proteinG: extra.proteinG ?? 0, carbsG: extra.carbsG ?? 0, fatG: extra.fatG ?? 0 },
    source: 'manual',
  };
  // recomputeMeal derives totals from the items (the store's own path), so the cache can't be hand-faked.
  return recomputeMeal({
    id: 'meal_' + ++seq,
    at: when,
    day,
    title: 'Meal',
    status,
    statusAt: when,
    error: status === 'failed' ? 'Claude could not read the photo' : null,
    input: { kind: 'quick' },
    photoIds: [],
    serves: extra.serves ?? 1,
    items: [item],
    totals: emptyTotals(),
    confidence: null,
    scaleReference: null,
    notes: '',
    angles: 0,
    aiCalls: [],
    createdAt: when,
    updatedAt: when,
  });
}

const pr = (kind: PRRecord['kind'] = 'heaviest_weight'): PRRecord => ({
  exerciseId: 'bench',
  workoutExerciseId: 'we' + ++seq,
  setId: 's' + seq,
  kind,
  value: 100,
});

function workout(startedAt: number, extra: Partial<Workout> = {}): Workout {
  const id = 'w' + ++seq;
  return {
    id,
    name: 'Workout ' + id,
    startedAt,
    endedAt: startedAt + HOUR,
    durationSec: 3600,
    exercises: [],
    exerciseIds: [],
    photoIds: [],
    bodyweightKg: 80,
    calories: 400,
    caloriesManual: false,
    volumeKg: 5000,
    setCount: 12,
    prs: [],
    createdAt: startedAt,
    updatedAt: startedAt,
    ...extra,
  };
}

/** Day keys from `first` through `last`, inclusive. */
function dayRange(first: string, last: string): string[] {
  const out: string[] = [];
  for (let d = first; d <= last; d = shiftDay(d, 1)) out.push(d);
  return out;
}

// ------------------------------------------------------------------ environment

describe('test environment', () => {
  it('runs in America/New_York, so the 2026 US DST switches are inside the tested ranges', () => {
    expect(new Date(2026, 2, 7, 12).getTimezoneOffset(), 'TZ pin did not apply: run with pool forks, not threads').toBe(300); // EST
    expect(new Date(2026, 2, 9, 12).getTimezoneOffset()).toBe(240); // EDT after spring-forward
    expect(new Date(2026, 9, 31, 12).getTimezoneOffset()).toBe(240); // EDT
    expect(new Date(2026, 10, 2, 12).getTimezoneOffset()).toBe(300); // EST after fall-back
    // The DST days really are 23 h and 25 h long here.
    expect(at(2026, 3, 9, 0) - at(2026, 3, 8, 0)).toBe(23 * HOUR);
    expect(at(2026, 11, 2, 0) - at(2026, 11, 1, 0)).toBe(25 * HOUR);
  });
});

// ------------------------------------------------------------------ days

describe('lastDays', () => {
  it('returns n day keys ending with today, oldest first', () => {
    expect(lastDays('2026-10-06', 3)).toEqual(['2026-10-04', '2026-10-05', '2026-10-06']);
    expect(lastDays('2026-10-06', 1)).toEqual(['2026-10-06']);
  });

  it('degenerate counts give no days instead of throwing or looping', () => {
    expect(lastDays('2026-10-06', 0)).toEqual([]);
    expect(lastDays('2026-10-06', -4)).toEqual([]);
    expect(lastDays('2026-10-06', Number.NaN)).toEqual([]);
    expect(lastDays('2026-10-06', 2.9)).toEqual(['2026-10-05', '2026-10-06']);
  });

  it('a week across the fall-back day (25 h) has 7 distinct consecutive days', () => {
    expect(lastDays('2026-11-04', 7)).toEqual([
      '2026-10-29',
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
    ]);
  });

  it('a week across the spring-forward day (23 h) skips nothing', () => {
    expect(lastDays('2026-03-11', 7)).toEqual([
      '2026-03-05',
      '2026-03-06',
      '2026-03-07',
      '2026-03-08',
      '2026-03-09',
      '2026-03-10',
      '2026-03-11',
    ]);
  });

  it('starting ON a DST day works too', () => {
    expect(lastDays('2026-11-01', 2)).toEqual(['2026-10-31', '2026-11-01']);
    expect(lastDays('2026-03-08', 2)).toEqual(['2026-03-07', '2026-03-08']);
  });

  it('crosses month, year and leap-day boundaries', () => {
    expect(lastDays('2027-01-02', 4)).toEqual(['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02']);
    expect(lastDays('2028-03-01', 3)).toEqual(['2028-02-28', '2028-02-29', '2028-03-01']);
  });

  it('every 28-day window of 2026 is 28 unique consecutive days ending with today', () => {
    for (const today of dayRange('2026-01-01', '2026-12-31')) {
      const days = lastDays(today, 28);
      expect(days).toHaveLength(28);
      expect(days[27]).toBe(today);
      expect(new Set(days).size).toBe(28);
      for (let i = 1; i < days.length; i++) expect(daysBetween(days[i - 1], days[i])).toBe(1);
    }
  });
});

describe('daysBetween', () => {
  it('counts whole calendar days over the 23 h and 25 h days', () => {
    expect(daysBetween('2026-03-07', '2026-03-08')).toBe(1);
    expect(daysBetween('2026-03-08', '2026-03-09')).toBe(1);
    expect(daysBetween('2026-10-31', '2026-11-01')).toBe(1);
    expect(daysBetween('2026-11-01', '2026-11-02')).toBe(1);
    expect(daysBetween('2026-03-01', '2026-03-31')).toBe(30);
    expect(daysBetween('2026-10-25', '2026-11-08')).toBe(14);
    expect(daysBetween('2026-01-01', '2027-01-01')).toBe(365);
  });

  it('is 0 for the same day and negative when `to` is earlier', () => {
    expect(daysBetween('2026-11-01', '2026-11-01')).toBe(0);
    expect(daysBetween('2026-11-08', '2026-10-25')).toBe(-14);
  });

  it('is an exact inverse of shiftDay for every day of 2026 (no off-by-one around DST)', () => {
    for (const d of dayRange('2026-01-01', '2026-12-31')) {
      for (const k of [1, 7, 27, -1, -7, -27]) expect(daysBetween(d, shiftDay(d, k))).toBe(k);
    }
  });

  it('junk keys give NaN, not a number that looks real', () => {
    expect(Number.isNaN(daysBetween('yesterday', '2026-10-06'))).toBe(true);
    expect(Number.isNaN(daysBetween('2026-10-06', ''))).toBe(true);
  });
});

describe('a zone whose DST switch skips midnight (America/Santiago)', () => {
  // Chile springs forward at 24:00 on Sat 5 Sep 2026: local midnight of Sun 6 Sep never happens (00:00 → 01:00).
  beforeAll(() => {
    process.env.TZ = 'America/Santiago';
  });
  afterAll(() => {
    process.env.TZ = 'America/New_York';
  });

  it('the missing midnight really is missing in this environment', () => {
    expect(new Date(2026, 8, 6).getHours()).toBe(1);
  });

  it('lastDays and daysBetween still count the day that starts at 01:00', () => {
    expect(lastDays('2026-09-07', 4)).toEqual(['2026-09-04', '2026-09-05', '2026-09-06', '2026-09-07']);
    expect(daysBetween('2026-09-05', '2026-09-06')).toBe(1);
    expect(daysBetween('2026-09-06', '2026-09-07')).toBe(1);
    expect(daysBetween('2026-09-01', '2026-09-15')).toBe(14);
  });

  it('a weigh-in in the first hour of that day lands on it, and the trend sees a 1-day gap', () => {
    const w = dailyWeighIns([row({ date: at(2026, 9, 5, 7), kg: 80 }), row({ date: at(2026, 9, 6, 1, 10), kg: 81 })]);
    expect(w.map((x) => x.day)).toEqual(['2026-09-05', '2026-09-06']);
    expect(weightTrend(w)[1]).toBeCloseTo(80.1, 10);
  });
});

// ------------------------------------------------------------------ dailyWeighIns

describe('dailyWeighIns', () => {
  it('no rows → no weigh-ins', () => {
    expect(dailyWeighIns([])).toEqual([]);
  });

  it("the day's LATEST weight wins, whatever order the rows come in", () => {
    const evening = row({ date: at(2026, 10, 5, 21), kg: 82.0 });
    const morning = row({ date: at(2026, 10, 5, 7, 5), kg: 80.4 });
    const noon = row({ date: at(2026, 10, 5, 12), kg: 81.1 });
    for (const order of [
      [evening, morning, noon],
      [noon, evening, morning],
      [morning, noon, evening],
    ]) {
      const out = dailyWeighIns(order);
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ day: '2026-10-05', kg: 82.0, at: evening.date, id: evening.id });
    }
  });

  it('a re-weigh on the Hume scale replaces a bad reading (every reading is its own row)', () => {
    const bad = row({ date: at(2026, 10, 5, 7, 2), kg: 86.2, fat: 31.0, source: 'health', id: 'hk_bad' });
    const good = row({ date: at(2026, 10, 5, 7, 5), kg: 80.1, fat: 19.4, source: 'health', id: 'hk_good' });
    for (const order of [
      [bad, good],
      [good, bad],
    ]) {
      expect(dailyWeighIns(order)).toEqual([
        { day: '2026-10-05', at: good.date, kg: 80.1, bodyFatPct: 19.4, source: 'health', id: 'hk_good' },
      ]);
    }
    // With only the bad reading left it is the day's again: the owner deletes what is wrong.
    expect(dailyWeighIns([bad])[0].id).toBe('hk_bad');
  });

  it('one weigh-in per day, oldest first, from unsorted input (without reordering the caller’s array)', () => {
    const rows = [
      row({ date: at(2026, 10, 7), kg: 79.8 }),
      row({ date: at(2026, 10, 5), kg: 80.4 }),
      row({ date: at(2026, 10, 6, 20), kg: 81.0 }),
      row({ date: at(2026, 10, 6, 6), kg: 80.0 }),
    ];
    const before = rows.map((r) => r.id);
    const out = dailyWeighIns(rows);
    expect(out.map((w) => [w.day, w.kg])).toEqual([
      ['2026-10-05', 80.4],
      ['2026-10-06', 81.0],
      ['2026-10-07', 79.8],
    ]);
    expect(rows.map((r) => r.id)).toEqual(before);
  });

  it('days are LOCAL: 22:30 and 00:15 are different days even though both are the same UTC date', () => {
    const late = at(2026, 10, 5, 22, 30); // 02:30Z on the 6th
    const early = at(2026, 10, 6, 0, 15); // 04:15Z on the 6th
    expect(new Date(late).getUTCDate()).toBe(6);
    const out = dailyWeighIns([row({ date: early, kg: 80.2 }), row({ date: late, kg: 81.0 })]);
    expect(out.map((w) => [w.day, w.kg])).toEqual([
      ['2026-10-05', 81.0],
      ['2026-10-06', 80.2],
    ]);
  });

  it('in the repeated hour of the fall-back day, "latest" is by real time, not by the wall clock', () => {
    const firstPass = Date.UTC(2026, 10, 1, 5, 30); // 01:30 EDT
    const secondPass = Date.UTC(2026, 10, 1, 6, 10); // 01:10 EST, 40 minutes later (earlier on the wall clock)
    expect(new Date(firstPass).getHours()).toBe(1);
    expect(new Date(secondPass).getHours()).toBe(1);
    for (const order of [
      [row({ date: secondPass, kg: 79.0 }), row({ date: firstPass, kg: 80.0 })],
      [row({ date: firstPass, kg: 80.0 }), row({ date: secondPass, kg: 79.0 })],
    ]) {
      const out = dailyWeighIns(order);
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ day: '2026-11-01', kg: 79.0, at: secondPass });
    }
  });

  it('body fat on the weight row rides along with it', () => {
    const out = dailyWeighIns([row({ date: at(2026, 10, 5), kg: 80, fat: 22.4 })]);
    expect(out[0].bodyFatPct).toBe(22.4);
  });

  it('a body-fat-only row joins the same day’s weight row, before or after it', () => {
    const fatFirst = dailyWeighIns([
      row({ date: at(2026, 10, 5, 7, 4), kg: 80 }),
      row({ date: at(2026, 10, 5, 7, 0), fat: 21.9, source: 'health' }),
    ]);
    expect(fatFirst).toHaveLength(1);
    expect(fatFirst[0]).toMatchObject({ kg: 80, bodyFatPct: 21.9, at: at(2026, 10, 5, 7, 4) });

    const fatLater = dailyWeighIns([row({ date: at(2026, 10, 5, 7), kg: 80 }), row({ date: at(2026, 10, 5, 19), fat: 23.0 })]);
    expect(fatLater[0].bodyFatPct).toBe(23.0);
  });

  it("the weight row's own body fat beats any fat-only row; otherwise the day's LATEST fat is used", () => {
    const own = dailyWeighIns([row({ date: at(2026, 10, 5, 6, 50), fat: 25 }), row({ date: at(2026, 10, 5, 7), kg: 80, fat: 22 })]);
    expect(own[0].bodyFatPct).toBe(22);
    const ownLater = dailyWeighIns([row({ date: at(2026, 10, 5, 7), kg: 80, fat: 22 }), row({ date: at(2026, 10, 5, 9), fat: 25 })]);
    expect(ownLater[0].bodyFatPct).toBe(22);

    const latest = dailyWeighIns([
      row({ date: at(2026, 10, 5, 8), fat: 23 }),
      row({ date: at(2026, 10, 5, 7), kg: 80 }),
      row({ date: at(2026, 10, 5, 6), fat: 21 }),
    ]);
    expect(latest[0].bodyFatPct).toBe(23);
  });

  it("a typed weigh-in without body fat takes the day's latest reading from the scale's rows", () => {
    const out = dailyWeighIns([
      row({ date: at(2026, 10, 5, 7), kg: 80.3, fat: 19.8, source: 'health', id: 'hk_1' }),
      row({ date: at(2026, 10, 5, 7, 4), kg: 80.1, fat: 19.5, source: 'health', id: 'hk_2' }),
      row({ date: at(2026, 10, 5, 6, 30), kg: 80, id: 'typed' }),
    ]);
    expect(out).toEqual([{ day: '2026-10-05', at: at(2026, 10, 5, 6, 30), kg: 80, bodyFatPct: 19.5, source: 'manual', id: 'typed' }]);
  });

  it("body fat never crosses into another day's weigh-in", () => {
    const out = dailyWeighIns([row({ date: at(2026, 10, 4, 23, 50), fat: 21 }), row({ date: at(2026, 10, 5, 0, 5), kg: 80 })]);
    expect(out).toHaveLength(1);
    expect(out[0].bodyFatPct).toBeNull();
  });

  it('body-fat-only days produce no weigh-in', () => {
    const out = dailyWeighIns([
      row({ date: at(2026, 10, 4), fat: 21 }),
      row({ date: at(2026, 10, 5), kg: 80, fat: 22 }),
      row({ date: at(2026, 10, 6), fat: 20 }),
    ]);
    expect(out.map((w) => w.day)).toEqual(['2026-10-05']);
  });

  it('invalid weights are ignored (0, negative, NaN, Infinity, null, missing)', () => {
    const bad = [0, -5, Number.NaN, Number.POSITIVE_INFINITY, null, undefined].map((kg, i) =>
      row({ date: at(2026, 10, 1 + i), kg, fat: 20 }),
    );
    expect(dailyWeighIns(bad)).toEqual([]);
  });

  it("an invalid weight, earlier or later, doesn't hide the day's valid one", () => {
    const later = dailyWeighIns([row({ date: at(2026, 10, 5, 6), kg: 80.6 }), row({ date: at(2026, 10, 5, 8), kg: 0 })]);
    expect(later).toHaveLength(1);
    expect(later[0]).toMatchObject({ kg: 80.6, at: at(2026, 10, 5, 6) });
    const earlier = dailyWeighIns([row({ date: at(2026, 10, 5, 6), kg: Number.NaN }), row({ date: at(2026, 10, 5, 8), kg: 80.6 })]);
    expect(earlier[0]).toMatchObject({ kg: 80.6, at: at(2026, 10, 5, 8) });
  });

  it('invalid body fat (0, ≥ 100, negative, NaN) reads as none, and a valid fat-only row can still fill in', () => {
    for (const fat of [0, 100, 150, -3, Number.NaN]) {
      expect(dailyWeighIns([row({ date: at(2026, 10, 5), kg: 80, fat })])[0].bodyFatPct).toBeNull();
    }
    expect(dailyWeighIns([row({ date: at(2026, 10, 5), kg: 80, fat: 99.9 })])[0].bodyFatPct).toBe(99.9);
    const filled = dailyWeighIns([row({ date: at(2026, 10, 5, 7), kg: 80, fat: 100 }), row({ date: at(2026, 10, 5, 9), fat: 21.5 })]);
    expect(filled[0].bodyFatPct).toBe(21.5);
    // A later junk reading doesn't hide an earlier valid one.
    const junkLater = dailyWeighIns([row({ date: at(2026, 10, 5, 6), fat: 21.5 }), row({ date: at(2026, 10, 5, 7), kg: 80, fat: 0 })]);
    expect(junkLater[0].bodyFatPct).toBe(21.5);
  });

  it('rows with a non-finite date are skipped instead of throwing', () => {
    const out = dailyWeighIns([row({ date: Number.NaN, kg: 70 }), row({ date: at(2026, 10, 5), kg: 80 })]);
    expect(out.map((w) => w.kg)).toEqual([80]);
  });

  it('source: health stays health, manual or missing is manual, and a typed weigh-in beats the scale’s, earlier or later', () => {
    // A typed 7:00 reading beats the scale's 6:30 one on the same day.
    const healthFirst = dailyWeighIns([
      row({ date: at(2026, 10, 5, 7), kg: 80, source: 'manual', id: 'typed' }),
      row({ date: at(2026, 10, 5, 6, 30), kg: 80.3, source: 'health', id: 'hk_1' }),
    ]);
    expect(healthFirst[0]).toMatchObject({ source: 'manual', id: 'typed', kg: 80 });

    const manualFirst = dailyWeighIns([
      row({ date: at(2026, 10, 5, 7), kg: 80.3, source: 'health', id: 'hk_2' }),
      row({ date: at(2026, 10, 5, 6, 30), kg: 80, source: 'manual', id: 'typed' }),
    ]);
    expect(manualFirst[0]).toMatchObject({ source: 'manual', id: 'typed', kg: 80 });

    // Nothing typed: the LATEST Health row wins (a re-weigh replaces the reading before it).
    const healthOnly = dailyWeighIns([
      row({ date: at(2026, 10, 5, 7), kg: 80.6, source: 'health', id: 'hk_b' }),
      row({ date: at(2026, 10, 5, 6, 30), kg: 80.3, source: 'health', id: 'hk_a' }),
    ]);
    expect(healthOnly).toHaveLength(1);
    expect(healthOnly[0]).toMatchObject({ source: 'health', id: 'hk_b', kg: 80.6 });

    // An imported row the user edited is theirs ('manual'): it beats a later reading from the scale.
    const edited = dailyWeighIns([
      row({ date: at(2026, 10, 5, 6, 30), kg: 80.0, source: 'manual', id: 'hk_1' }),
      row({ date: at(2026, 10, 5, 7), kg: 80.6, source: 'health', id: 'hk_2' }),
    ]);
    expect(edited[0]).toMatchObject({ source: 'manual', id: 'hk_1', kg: 80.0 });

    expect(dailyWeighIns([row({ date: at(2026, 10, 5), kg: 80 })])[0].source).toBe('manual');
  });
});

describe('dailyBodyFat', () => {
  it("the weigh-in's own reading on a weigh-in day, else the day's latest reading", () => {
    const rows = [
      // 4 Oct: no weigh-in, two caliper readings: the later one.
      row({ date: at(2026, 10, 4, 8), fat: 21 }),
      row({ date: at(2026, 10, 4, 18), fat: 20.5 }),
      // 5 Oct: two scale readings; the re-weigh is the day's, with its own body fat.
      row({ date: at(2026, 10, 5, 7, 2), kg: 86, fat: 31, source: 'health' }),
      row({ date: at(2026, 10, 5, 7, 5), kg: 80, fat: 19.4, source: 'health' }),
      // 6 Oct: the weigh-in has no body fat; the day's latest reading fills in.
      row({ date: at(2026, 10, 6, 6), fat: 19.9 }),
      row({ date: at(2026, 10, 6, 7), kg: 80 }),
      row({ date: at(2026, 10, 6, 9), fat: 19.6 }),
    ];
    expect(dailyBodyFat(rows)).toEqual([
      { day: '2026-10-04', value: 20.5 },
      { day: '2026-10-05', value: 19.4 },
      { day: '2026-10-06', value: 19.6 },
    ]);
    // The same numbers dailyWeighIns carries.
    expect(dailyWeighIns(rows).map((w) => w.bodyFatPct)).toEqual([19.4, 19.6]);
  });

  it('a typed weigh-in’s own body fat beats a later scale reading', () => {
    const rows = [row({ date: at(2026, 10, 5, 6), kg: 80, fat: 18 }), row({ date: at(2026, 10, 5, 7), kg: 80.4, fat: 19.4, source: 'health' })];
    expect(dailyBodyFat(rows)).toEqual([{ day: '2026-10-05', value: 18 }]);
  });
});

describe('latestBodyFat', () => {
  it('null when no row has a valid body fat', () => {
    expect(latestBodyFat([])).toBeNull();
    expect(latestBodyFat([row({ date: at(2026, 10, 5), kg: 80 }), row({ date: at(2026, 10, 6), kg: 80, fat: 0 })])).toBeNull();
  });

  it('the newest valid reading from any row, fat-only rows included, regardless of input order', () => {
    const rows = [
      row({ date: at(2026, 10, 6), fat: 21.5 }),
      row({ date: at(2026, 10, 7), kg: 80, fat: 140 }), // junk, newer
      row({ date: at(2026, 10, 5), kg: 80, fat: 22 }),
      row({ date: Number.NaN, fat: 19 }),
    ];
    expect(latestBodyFat(rows)).toEqual({ pct: 21.5, at: at(2026, 10, 6) });
  });
});

// ------------------------------------------------------------------ weightTrend

describe('weightTrend', () => {
  const pts = (...xs: [string, number][]) => xs.map(([day, kg]) => ({ day, kg }));

  it('empty in, empty out; one reading seeds the trend', () => {
    expect(weightTrend([])).toEqual([]);
    expect(weightTrend(pts(['2026-10-01', 80.4]))).toEqual([80.4]);
  });

  it('output length always equals input length', () => {
    const input = dayRange('2026-09-01', '2026-10-06').map((day, i) => ({ day, kg: 80 + Math.sin(i) }));
    expect(weightTrend(input)).toHaveLength(input.length);
  });

  it('a constant series stays exactly constant, gaps or not', () => {
    const t = weightTrend(pts(['2026-10-01', 80], ['2026-10-02', 80], ['2026-10-09', 80], ['2026-11-20', 80]));
    expect(t).toEqual([80, 80, 80, 80]);
  });

  it('one day moves the trend 10% of the way to the reading', () => {
    const t = weightTrend(pts(['2026-10-01', 80], ['2026-10-02', 81]));
    expect(t[1]).toBeCloseTo(80.1, 12);
  });

  it('after a 7-day gap one reading moves the trend by 1 − 0.9^7 of the difference', () => {
    const t = weightTrend(pts(['2026-10-01', 80], ['2026-10-08', 87]));
    expect(t[1]).toBeCloseTo(80 + (1 - 0.9 ** 7) * 7, 12);
  });

  it('a 7-day gap across either DST switch is still 7 days', () => {
    const expected = 80 + (1 - 0.9 ** 7) * 7;
    expect(weightTrend(pts(['2026-10-29', 80], ['2026-11-05', 87]))[1]).toBeCloseTo(expected, 12);
    expect(weightTrend(pts(['2026-03-05', 80], ['2026-03-12', 87]))[1]).toBeCloseTo(expected, 12);
  });

  it('a gap equals the same reading repeated every day of it (that is what gap-aware means)', () => {
    const gapped = weightTrend(pts(['2026-10-01', 82], ['2026-10-11', 79]));
    const daily = weightTrend([{ day: '2026-10-01', kg: 82 }, ...dayRange('2026-10-02', '2026-10-11').map((day) => ({ day, kg: 79 }))]);
    expect(gapped[1]).toBeCloseTo(daily[daily.length - 1], 12);
  });

  it('monotone falling readings give a monotone falling trend that never undershoots the readings', () => {
    const input = dayRange('2026-09-01', '2026-10-06').map((day, i) => ({ day, kg: 90 - 0.15 * i - (i % 3) * 0.01 }));
    const t = weightTrend(input);
    for (let i = 1; i < t.length; i++) {
      expect(t[i]).toBeLessThanOrEqual(t[i - 1]);
      expect(t[i]).toBeGreaterThanOrEqual(input[i].kg);
    }
  });

  it('each step lands between the previous trend and the new reading (no overshoot on noisy data)', () => {
    const days = dayRange('2026-09-01', '2026-10-06').filter((_, i) => i % 3 !== 1);
    const input = days.map((day, i) => ({ day, kg: 80 + (i % 2 ? 1.6 : -1.4) }));
    const t = weightTrend(input);
    for (let i = 1; i < t.length; i++) {
      const lo = Math.min(t[i - 1], input[i].kg);
      const hi = Math.max(t[i - 1], input[i].kg);
      expect(t[i]).toBeGreaterThanOrEqual(lo);
      expect(t[i]).toBeLessThanOrEqual(hi);
    }
  });

  it('alpha 1 follows the readings; alpha 0 never leaves the seed', () => {
    const input = pts(['2026-10-01', 80], ['2026-10-02', 82], ['2026-10-05', 79]);
    expect(weightTrend(input, 1)).toEqual([80, 82, 79]);
    expect(weightTrend(input, 0)).toEqual([80, 80, 80]);
  });

  it('two points on the same day still take a one-day step (never 0, never NaN)', () => {
    const t = weightTrend(pts(['2026-10-01', 80], ['2026-10-01', 81]));
    expect(t[1]).toBeCloseTo(80.1, 12);
  });
});

// ------------------------------------------------------------------ weekly slope

describe('weeklySlope / weeklyRateKg', () => {
  const TODAY = '2026-10-06';
  const series = (days: string[], f: (x: number) => number) =>
    days.map((day) => ({ day, value: f(daysBetween(days[0], day)) }));

  it('fewer than 3 readings → null, however far apart', () => {
    expect(weeklySlope([], TODAY)).toBeNull();
    expect(weeklySlope([{ day: TODAY, value: 80 }], TODAY)).toBeNull();
    expect(weeklySlope([{ day: shiftDay(TODAY, -20), value: 82 }, { day: TODAY, value: 80 }], TODAY)).toBeNull();
  });

  it('readings spanning less than 7 days → null; exactly 7 is enough', () => {
    const six = [0, 3, 6].map((k) => ({ day: shiftDay(TODAY, k - 6), value: 80 - k * 0.1 }));
    expect(weeklySlope(six, TODAY)).toBeNull();
    const seven = [0, 3, 7].map((k) => ({ day: shiftDay(TODAY, k - 7), value: 80 - k * 0.1 }));
    expect(weeklySlope(seven, TODAY)).toBeCloseTo(-0.7, 10);
  });

  it('exact linear data gives exactly the daily slope × 7', () => {
    const days = lastDays(TODAY, 28);
    expect(weeklySlope(series(days, (x) => 80 - 0.1 * x), TODAY)).toBeCloseTo(-0.7, 10);
    expect(weeklySlope(series(days, (x) => 70 + 0.05 * x), TODAY)).toBeCloseTo(0.35, 10);
    expect(weeklySlope(series(days, () => 75), TODAY)).toBeCloseTo(0, 12);
  });

  it('exact linear data stays exact when the window crosses fall-back or spring-forward (x is calendar days)', () => {
    const fall = lastDays('2026-11-14', 28);
    expect(weeklySlope(series(fall, (x) => 80 - 0.1 * x), '2026-11-14')).toBeCloseTo(-0.7, 10);
    const spring = lastDays('2026-03-20', 28);
    expect(weeklySlope(series(spring, (x) => 80 - 0.1 * x), '2026-03-20')).toBeCloseTo(-0.7, 10);
    // Sparse readings straddling the switch: x must be 0, 7, 14, not 0, 7.04, 14.04.
    const sparse = ['2026-10-25', '2026-11-01', '2026-11-08'].map((day, i) => ({ day, value: 80 - 0.5 * i }));
    expect(weeklySlope(sparse, '2026-11-08')).toBeCloseTo(-0.5, 10);
  });

  it('points outside the 28-day window (older, or after today) are ignored', () => {
    const days = lastDays(TODAY, 28);
    const base = series(days, (x) => 80 - 0.1 * x);
    const noisy = [...base, { day: shiftDay(TODAY, -28), value: 999 }, { day: shiftDay(TODAY, -90), value: 0 }, { day: shiftDay(TODAY, 1), value: 999 }];
    expect(weeklySlope(noisy, TODAY)).toBeCloseTo(-0.7, 10);
  });

  it('the window boundary is inclusive: today − 27 counts, today − 28 does not', () => {
    const tail = [
      { day: shiftDay(TODAY, -20), value: 80 },
      { day: TODAY, value: 79 },
    ];
    expect(weeklySlope([{ day: shiftDay(TODAY, -27), value: 81 }, ...tail], TODAY)).not.toBeNull();
    expect(weeklySlope([{ day: shiftDay(TODAY, -28), value: 81 }, ...tail], TODAY)).toBeNull();
  });

  it('a custom window narrows what counts', () => {
    const days = lastDays(TODAY, 28);
    const data = series(days, (x) => (x < 20 ? 80 : 80 - 0.2 * (x - 19)));
    expect(weeklySlope(data, TODAY, 8)).toBeCloseTo(-1.4, 10);
  });

  it('noise symmetric about the middle of the window does not bias the slope', () => {
    const days = lastDays(TODAY, 21);
    const noise = (x: number) => [0.8, -0.6, 0.3, -0.9, 0.5, -0.2, 0.7, -0.4, 0.1, -0.7, 0.6][Math.min(x, 20 - x)];
    expect(weeklySlope(series(days, (x) => 90 + 0.05 * x + noise(x)), TODAY)).toBeCloseTo(0.35, 10);
  });

  it('non-finite values do not count toward the 3 readings or poison the fit', () => {
    const pts = [
      { day: shiftDay(TODAY, -14), value: 80 },
      { day: shiftDay(TODAY, -7), value: Number.NaN },
      { day: TODAY, value: 79 },
    ];
    expect(weeklySlope(pts, TODAY)).toBeNull();
    const four = [...pts, { day: shiftDay(TODAY, -10), value: 79.7 }];
    const slope = weeklySlope(four, TODAY);
    expect(slope).not.toBeNull();
    expect(Number.isFinite(slope as number)).toBe(true);
  });

  it('weeklyRateKg reads kg straight from daily weigh-ins (4 weeks losing 0.5 kg/week)', () => {
    const rows = lastDays(TODAY, 28).map((day, i) => row({ date: onDay(day, 6, 45), kg: 90 - (0.5 / 7) * i }));
    expect(weeklyRateKg(dailyWeighIns(rows), TODAY)).toBeCloseTo(-0.5, 10);
  });

  it('weekly weigh-ins are enough once 3 readings span 7+ days', () => {
    const rows = [-14, -7, 0].map((k, i) => row({ date: onDay(shiftDay(TODAY, k)), kg: 85 - 0.4 * i }));
    expect(weeklyRateKg(dailyWeighIns(rows), TODAY)).toBeCloseTo(-0.4, 10);
  });
});

// ------------------------------------------------------------------ goal rate

describe('goalRateKgPerWeek', () => {
  const body = { sex: 'male' as const, age: 34, heightCm: 180, weightKg: 88 };
  const targets = (p: Partial<typeof DEFAULT_NUTRITION>) => computeTargets({ ...DEFAULT_NUTRITION, ...p }, body);

  it('uses 7,700 kcal per kg', () => {
    expect(KCAL_PER_KG).toBe(7700);
  });

  it('maintain → 0', () => {
    expect(goalRateKgPerWeek(targets({ goal: 'maintain' }))).toBe(0);
  });

  it('lose / gain at both paces follow the real targets (−400 / −750 / +250 / +500 kcal a day)', () => {
    expect(goalRateKgPerWeek(targets({ goal: 'lose', pace: 'steady' }))).toBeCloseTo((-400 * 7) / 7700, 10);
    expect(goalRateKgPerWeek(targets({ goal: 'lose', pace: 'aggressive' }))).toBeCloseTo((-750 * 7) / 7700, 10);
    expect(goalRateKgPerWeek(targets({ goal: 'gain', pace: 'steady' }))).toBeCloseTo((250 * 7) / 7700, 10);
    expect(goalRateKgPerWeek(targets({ goal: 'gain', pace: 'aggressive' }))).toBeCloseTo((500 * 7) / 7700, 10);
  });

  it('the same deficit gives the same rate at every activity level and body', () => {
    for (const activity of ['sedentary', 'light', 'moderate', 'active', 'very_active'] as const) {
      for (const b of [body, { sex: 'female' as const, age: 51, heightCm: 163, weightKg: 61.3 }]) {
        const t = computeTargets({ ...DEFAULT_NUTRITION, activity, goal: 'lose', pace: 'steady' }, b);
        expect(goalRateKgPerWeek(t)).toBeCloseTo((-400 * 7) / 7700, 10);
      }
    }
  });

  it('a hand-set kcal override drives the rate (it reads the final target), even against the goal', () => {
    const t = targets({ goal: 'maintain', kcalOverride: 1800 });
    expect(t.kcal).toBe(1800);
    expect(t.tdee).toBeGreaterThan(1800);
    expect(goalRateKgPerWeek(t)).toBeCloseTo(((1800 - t.tdee) * 7) / 7700, 10);
    expect(goalRateKgPerWeek(t)).toBeLessThan(0);
    const above = targets({ goal: 'lose', kcalOverride: 4000 });
    expect(goalRateKgPerWeek(above)).toBeGreaterThan(0);
  });

  it('NaN / Infinity inputs give 0, never NaN', () => {
    expect(goalRateKgPerWeek({ kcal: Number.NaN, tdee: 2500 })).toBe(0);
    expect(goalRateKgPerWeek({ kcal: 2000, tdee: Number.NaN })).toBe(0);
    expect(goalRateKgPerWeek({ kcal: Number.POSITIVE_INFINITY, tdee: 2500 })).toBe(0);
  });
});

// ------------------------------------------------------------------ bodySummary

describe('bodySummary', () => {
  const TODAY = '2026-10-06';

  it('a brand-new user: everything empty / null, nothing NaN', () => {
    expect(bodySummary([], TODAY)).toEqual({
      weighIns: [],
      trend: [],
      latest: null,
      trendKg: null,
      rateKgPerWeek: null,
      bodyFat: null,
      bodyFatRatePerWeek: null,
      daysSinceWeighIn: null,
    });
  });

  it('daysSinceWeighIn: 0 today, 1 yesterday, whole days across fall-back', () => {
    expect(bodySummary([row({ date: onDay(TODAY, 0, 1), kg: 80 })], TODAY).daysSinceWeighIn).toBe(0);
    expect(bodySummary([row({ date: onDay('2026-10-05', 23, 59), kg: 80 })], TODAY).daysSinceWeighIn).toBe(1);
    expect(bodySummary([row({ date: at(2026, 10, 30, 23), kg: 80 })], '2026-11-02').daysSinceWeighIn).toBe(3);
  });

  it('a future-dated weigh-in clamps daysSinceWeighIn to 0 (and is the latest)', () => {
    const s = bodySummary([row({ date: onDay('2026-10-04'), kg: 80 }), row({ date: onDay('2026-10-09'), kg: 79 })], TODAY);
    expect(s.daysSinceWeighIn).toBe(0);
    expect(s.latest?.day).toBe('2026-10-09');
  });

  it('latest is the newest weigh-in; trendKg is the trend at it; trend lines up with weighIns', () => {
    const s = bodySummary(
      [row({ date: onDay('2026-10-05'), kg: 81 }), row({ date: onDay('2026-10-04'), kg: 80 }), row({ date: onDay('2026-10-05', 20), kg: 83 })],
      TODAY,
    );
    // 5 Oct has two readings: the later one (20:00) is the day's.
    expect(s.weighIns.map((w) => w.kg)).toEqual([80, 83]);
    expect(s.trend).toHaveLength(2);
    expect(s.latest?.kg).toBe(83);
    expect(s.latest?.at).toBe(onDay('2026-10-05', 20));
    expect(s.trendKg).toBeCloseTo(80.3, 12);
    expect(s.daysSinceWeighIn).toBe(1);
  });

  it('bodyFat comes from a newer body-fat-only row while the weigh-in keeps its own reading', () => {
    const s = bodySummary([row({ date: onDay('2026-10-05'), kg: 80, fat: 22 }), row({ date: onDay(TODAY), fat: 21.5 })], TODAY);
    expect(s.bodyFat).toEqual({ pct: 21.5, at: onDay(TODAY) });
    expect(s.latest?.bodyFatPct).toBe(22);
    expect(s.daysSinceWeighIn).toBe(1);
  });

  it('only body-fat rows: a body fat reading but no weigh-in', () => {
    const s = bodySummary([row({ date: onDay(TODAY), fat: 20 })], TODAY);
    expect(s.weighIns).toEqual([]);
    expect(s.latest).toBeNull();
    expect(s.daysSinceWeighIn).toBeNull();
    expect(s.bodyFat?.pct).toBe(20);
  });

  it('rates: kg/week and body fat %/week over the last 28 days', () => {
    const rows = lastDays(TODAY, 28).map((day, i) => row({ date: onDay(day), kg: 88 - 0.1 * i, fat: 24 - 0.02 * i, source: 'health' }));
    const s = bodySummary(rows, TODAY);
    expect(s.rateKgPerWeek).toBeCloseTo(-0.7, 10);
    expect(s.bodyFatRatePerWeek).toBeCloseTo(-0.14, 10);
  });

  // A scale's body fat swings more than its weight does, so its rate needs readings spanning 21 days, not 7.
  it('body fat %/week needs a 21-day span while kg/week keeps the 7-day minimum', () => {
    const rows = lastDays(TODAY, 8).map((day, i) => row({ date: onDay(day), kg: 88 - 0.1 * i, fat: 24 - 0.3 * i, source: 'health' }));
    const s = bodySummary(rows, TODAY);
    expect(s.rateKgPerWeek).not.toBeNull();
    expect(s.rateKgPerWeek).toBeCloseTo(-0.7, 10);
    expect(s.bodyFatRatePerWeek).toBeNull();

    const span21 = [-21, -14, -7, 0].map((k, i) => ({ day: shiftDay(TODAY, k), value: 24 - 0.5 * i }));
    expect(weeklySlope(span21, TODAY, 28, 21)).toBeCloseTo(-0.5, 10);
    const span20 = [-20, -10, 0].map((k, i) => ({ day: shiftDay(TODAY, k), value: 24 - 0.5 * i }));
    expect(weeklySlope(span20, TODAY, 28, 21)).toBeNull();
    expect(weeklySlope(span20, TODAY)).toBeCloseTo(-0.35, 10); // the default 7-day minimum takes it
  });

  it('rates stay null with too little data (2 weigh-ins), while trend and latest work', () => {
    const s = bodySummary([row({ date: onDay('2026-09-20'), kg: 82, fat: 23 }), row({ date: onDay(TODAY), kg: 80, fat: 22 })], TODAY);
    expect(s.rateKgPerWeek).toBeNull();
    expect(s.bodyFatRatePerWeek).toBeNull();
    expect(s.trendKg).not.toBeNull();
  });

  // Regression: a body-fat reading on a day with no body weight (a typed caliper / DEXA reading, or an Apple Health
  // import where fat synced without weight) counts toward the body fat rate (lib/today dailyBodyFat).
  it('body fat readings on days without a weigh-in still count toward the body fat rate', () => {
    const rows = [-21, -14, -7, 0].map((k, i) => row({ date: onDay(shiftDay(TODAY, k), 9), fat: 24 - 0.5 * i }));
    rows.push(...[-21, -14, -7, 0].map((k) => row({ date: onDay(shiftDay(TODAY, k - 1)), kg: 80 })));
    const s = bodySummary(rows, TODAY);
    expect(s.bodyFat?.pct).toBe(22.5);
    expect(s.bodyFatRatePerWeek).toBeCloseTo(-0.5, 10);
  });
});

// ------------------------------------------------------------------ food

describe('dailyIntake', () => {
  const DAYS = ['2026-10-04', '2026-10-05', '2026-10-06'];

  it('only done meals count; failed / pending / draft / analyzing are not eaten food', () => {
    const meals = [
      meal('2026-10-05', 500, 'done', { proteinG: 30, carbsG: 50, fatG: 15 }),
      meal('2026-10-05', 900, 'failed'),
      meal('2026-10-05', 300, 'pending'),
      meal('2026-10-05', 200, 'draft'),
      meal('2026-10-05', 700, 'analyzing'),
    ];
    const [, day] = dailyIntake(meals, DAYS);
    expect(day).toEqual({ day: '2026-10-05', kcal: 500, proteinG: 30, carbsG: 50, fatG: 15, meals: 1, logged: true });
  });

  it('a day with only failed / pending meals is NOT logged (not a 0 kcal day)', () => {
    const [d] = dailyIntake([meal('2026-10-04', 650, 'failed'), meal('2026-10-04', 420, 'pending')], DAYS);
    expect(d).toMatchObject({ kcal: 0, meals: 0, logged: false });
  });

  it('days with no meals at all are not logged', () => {
    const out = dailyIntake([], DAYS);
    expect(out.map((d) => d.logged)).toEqual([false, false, false]);
    expect(out.map((d) => d.day)).toEqual(DAYS);
  });

  it('a finished 0 kcal meal (black coffee) IS a logged day', () => {
    const [d] = dailyIntake([meal('2026-10-04', 0)], DAYS);
    expect(d).toMatchObject({ kcal: 0, meals: 1, logged: true });
  });

  it('sums several meals and their macros, serves included', () => {
    const [d] = dailyIntake(
      [meal('2026-10-04', 400, 'done', { proteinG: 20, carbsG: 40, fatG: 10 }), meal('2026-10-04', 250, 'done', { proteinG: 10, serves: 2 })],
      DAYS,
    );
    expect(d).toMatchObject({ kcal: 900, proteinG: 40, carbsG: 40, fatG: 10, meals: 2, logged: true });
  });

  it('output follows the days argument, in its order and length, and ignores meals outside it', () => {
    const meals = [meal('2026-10-06', 100), meal('2026-10-04', 400), meal('2026-10-03', 9999), meal('2026-10-07', 9999)];
    const order = ['2026-10-06', '2026-10-04', '2026-10-05'];
    expect(dailyIntake(meals, order).map((d) => [d.day, d.kcal, d.logged])).toEqual([
      ['2026-10-06', 100, true],
      ['2026-10-04', 400, true],
      ['2026-10-05', 0, false],
    ]);
    expect(dailyIntake(meals, [])).toEqual([]);
  });

  it("groups by the meal's stored day (as the Diary does), not by re-deriving it from `at`", () => {
    // Logged on the 5th in another time zone; its `at` is the 6th here.
    const travelled = meal('2026-10-05', 600, 'done', { at: onDay('2026-10-06', 1) });
    expect(travelled.day).toBe('2026-10-05');
    const out = dailyIntake([travelled], DAYS);
    expect(out[1]).toMatchObject({ day: '2026-10-05', kcal: 600, logged: true });
    expect(out[2].logged).toBe(false);
  });
});

describe('averageIntake', () => {
  const day = (d: string, kcal: number, logged = true, proteinG = 0) => ({ day: d, kcal, proteinG, carbsG: 0, fatG: 0, meals: logged ? 1 : 0, logged });

  it('null when nothing qualifies', () => {
    expect(averageIntake([])).toBeNull();
    expect(averageIntake([day('2026-10-05', 0, false), day('2026-10-06', 0, false)])).toBeNull();
    expect(averageIntake([day('2026-10-06', 1800)], '2026-10-06')).toBeNull();
  });

  it('averages logged days only: unlogged days are not 0 kcal days', () => {
    const rows = [
      day('2026-09-30', 0, false),
      day('2026-10-01', 2000, true, 150),
      day('2026-10-02', 0, false),
      day('2026-10-03', 2400, true, 170),
      day('2026-10-04', 0, false),
      day('2026-10-05', 2200, true, 160),
    ];
    expect(averageIntake(rows)).toEqual({ kcal: 2200, proteinG: 160, days: 3 });
  });

  it('leaves out the excluded day (today, still being eaten)', () => {
    const rows = [day('2026-10-04', 2100), day('2026-10-05', 2300), day('2026-10-06', 600)];
    expect(averageIntake(rows, '2026-10-06')).toEqual({ kcal: 2200, proteinG: 0, days: 2 });
    expect(averageIntake(rows)?.days).toBe(3);
  });

  it('works end to end from meals: a failed-only day neither counts as a day nor drags the average', () => {
    const days = lastDays('2026-10-06', 7);
    const meals = [meal('2026-10-01', 2000), meal('2026-10-03', 900, 'failed'), meal('2026-10-04', 2200), meal('2026-10-06', 400)];
    expect(averageIntake(dailyIntake(meals, days), '2026-10-06')).toEqual({ kcal: 2100, proteinG: 0, days: 2 });
  });
});

// ------------------------------------------------------------------ training

describe('dailyTraining', () => {
  const DAYS = ['2026-10-04', '2026-10-05', '2026-10-06'];

  it('rows for every day in order, zeros on rest days', () => {
    const out = dailyTraining([], DAYS);
    expect(out).toEqual(DAYS.map((day) => ({ day, workouts: 0, durationSec: 0, activeKcal: 0, volumeKg: 0, prs: 0 })));
  });

  it('workouts outside the days are ignored', () => {
    const out = dailyTraining([workout(onDay('2026-10-03', 18)), workout(onDay('2026-10-07', 6))], DAYS);
    expect(out.every((d) => d.workouts === 0)).toBe(true);
  });

  it('a workout counts on the local day it STARTED, even when it ends after midnight', () => {
    const late = workout(onDay('2026-10-05', 23, 30), { durationSec: 5400, endedAt: onDay('2026-10-06', 1) });
    const out = dailyTraining([late], DAYS);
    expect(out.map((d) => d.workouts)).toEqual([0, 1, 0]);
  });

  it('active kcal is the Apple Health number: estimate minus resting, typed-in calories unchanged', () => {
    const estimated = workout(onDay('2026-10-04', 18), { calories: 400, durationSec: 3600, bodyweightKg: 80 }); // 400 − 80 = 320
    const typed = workout(onDay('2026-10-05', 18), { calories: 250, caloriesManual: true, durationSec: 3600 });
    const noWeight = workout(onDay('2026-10-06', 18), { calories: 400, durationSec: 3600, bodyweightKg: null }); // 400 − 75
    expect(dailyTraining([estimated, typed, noWeight], DAYS).map((d) => d.activeKcal)).toEqual([320, 250, 325]);
  });

  it('sums workouts, duration, volume and PRs on a two-workout day', () => {
    const a = workout(onDay('2026-10-05', 7), { durationSec: 3000, volumeKg: 4000, prs: [pr(), pr('best_1rm')] });
    const b = workout(onDay('2026-10-05', 18), { durationSec: 1800, volumeKg: 2500, prs: [pr('best_set_volume')] });
    expect(dailyTraining([a, b], DAYS)[1]).toMatchObject({ workouts: 2, durationSec: 4800, volumeKg: 6500, prs: 3 });
  });

  it('negative or NaN duration / volume count as 0, never subtract', () => {
    const w = workout(onDay('2026-10-04', 9), { durationSec: -60, volumeKg: Number.NaN, calories: 0 });
    expect(dailyTraining([w], DAYS)[0]).toMatchObject({ workouts: 1, durationSec: 0, volumeKg: 0, activeKcal: 0 });
  });

  it('a workout in the repeated hour of fall-back night still lands on 1 Nov', () => {
    const w = workout(Date.UTC(2026, 10, 1, 6, 15)); // 01:15 EST, the second 01:15 that night
    expect(dailyTraining([w], ['2026-10-31', '2026-11-01', '2026-11-02']).map((d) => d.workouts)).toEqual([0, 1, 0]);
  });
});

describe('unsentWorkouts', () => {
  const SINCE = at(2026, 9, 29, 0);

  it('nothing in → nothing out', () => {
    expect(unsentWorkouts([], SINCE)).toEqual([]);
  });

  it('the since boundary is inclusive', () => {
    const onEdge = workout(SINCE);
    const before = workout(SINCE - 1);
    expect(unsentWorkouts([onEdge, before], SINCE).map((w) => w.id)).toEqual([onEdge.id]);
  });

  it('workouts already sent to Health are left out; null / missing healthSentAt is unsent', () => {
    const sent = workout(at(2026, 10, 1, 18), { healthSentAt: at(2026, 10, 1, 19) });
    const nullSent = workout(at(2026, 10, 2, 18), { healthSentAt: null });
    const neverSent = workout(at(2026, 10, 3, 18));
    expect(unsentWorkouts([sent, nullSent, neverSent], SINCE).map((w) => w.id).sort()).toEqual([nullSent.id, neverSent.id].sort());
  });

  it('newest first whatever the input order, without reordering the input', () => {
    const a = workout(at(2026, 10, 1, 18));
    const b = workout(at(2026, 10, 4, 7));
    const c = workout(at(2026, 10, 2, 12));
    const input = [a, b, c];
    expect(unsentWorkouts(input, SINCE).map((w) => w.id)).toEqual([b.id, c.id, a.id]);
    expect(input.map((w) => w.id)).toEqual([a.id, b.id, c.id]);
  });
});

// ------------------------------------------------------------------ buildWeek

describe('buildWeek', () => {
  const WEEK = lastDays('2026-10-07', 7); // 1–7 Oct

  function body(rows: Measurement[]) {
    const weighIns = dailyWeighIns(rows);
    return { weighIns, trend: weightTrend(weighIns) };
  }

  it('one row per day, oldest first, with food, training and body lined up on the same day', () => {
    const { weighIns, trend } = body([row({ date: onDay('2026-10-03'), kg: 80 })]);
    const meals = [meal('2026-10-03', 2100), meal('2026-10-05', 1900)];
    const workouts = [workout(onDay('2026-10-03', 18))];
    const week = buildWeek(WEEK, meals, workouts, weighIns, trend);
    expect(week.map((d) => d.day)).toEqual(WEEK);
    const oct3 = week[2];
    expect(oct3.intake).toMatchObject({ kcal: 2100, logged: true });
    expect(oct3.training.workouts).toBe(1);
    expect(oct3.weighIn?.kg).toBe(80);
    expect(week[4].intake.kcal).toBe(1900);
    expect(week[4].training.workouts).toBe(0);
  });

  it('null trend before the first weigh-in ever; carried forward after it', () => {
    const { weighIns, trend } = body([row({ date: onDay('2026-10-03'), kg: 80 })]);
    const week = buildWeek(WEEK, [], [], weighIns, trend);
    expect(week.map((d) => d.trendKg)).toEqual([null, null, 80, 80, 80, 80, 80]);
    expect(week.map((d) => d.weighIn?.kg ?? null)).toEqual([null, null, 80, null, null, null, null]);
  });

  it("a weigh-in day shows that day's TREND (not the raw reading); days after carry the last trend before them", () => {
    const { weighIns, trend } = body([
      row({ date: onDay('2026-09-20'), kg: 82 }),
      row({ date: onDay('2026-10-02'), kg: 80 }),
      row({ date: onDay('2026-10-05'), kg: 81 }),
    ]);
    const week = buildWeek(WEEK, [], [], weighIns, trend);
    expect(week[0].trendKg).toBe(trend[0]); // 1 Oct: carried from 20 Sep
    expect(week[1].trendKg).toBe(trend[1]); // 2 Oct: its own weigh-in
    expect(week[1].trendKg).not.toBe(80);
    expect(week[1].weighIn?.kg).toBe(80);
    expect(week[2].trendKg).toBe(trend[1]); // 3 Oct
    expect(week[3].trendKg).toBe(trend[1]); // 4 Oct
    expect(week[4].trendKg).toBe(trend[2]); // 5 Oct
    expect(week[6].trendKg).toBe(trend[2]); // 7 Oct
  });

  it("a weigh-in AFTER the window doesn't leak backwards", () => {
    const only = body([row({ date: onDay('2026-10-10'), kg: 79 })]);
    expect(buildWeek(WEEK, [], [], only.weighIns, only.trend).map((d) => d.trendKg)).toEqual(Array(7).fill(null));

    const both = body([row({ date: onDay('2026-09-28'), kg: 82 }), row({ date: onDay('2026-10-10'), kg: 79 })]);
    expect(buildWeek(WEEK, [], [], both.weighIns, both.trend).map((d) => d.trendKg)).toEqual(Array(7).fill(82));
  });

  it("the trend is the whole history's, not restarted at the window's first day", () => {
    const rows = dayRange('2026-09-01', '2026-10-07').map((day, i) => row({ date: onDay(day), kg: 90 - 0.2 * i }));
    const { weighIns, trend } = body(rows);
    const week = buildWeek(WEEK, [], [], weighIns, trend);
    expect(week[0].trendKg).toBe(trend[weighIns.findIndex((w) => w.day === '2026-10-01')]);
    expect(week[0].trendKg).toBeGreaterThan(week[0].weighIn!.kg); // a falling trend lags above the readings
  });

  it('a week across fall-back lines everything up by calendar day', () => {
    const days = lastDays('2026-11-04', 7);
    const { weighIns, trend } = body([row({ date: Date.UTC(2026, 10, 1, 6, 30), kg: 80 })]); // 01:30 EST, 1 Nov
    const meals = [meal('2026-11-01', 2000)];
    const workouts = [workout(at(2026, 11, 2, 0, 30))];
    const week = buildWeek(days, meals, workouts, weighIns, trend);
    const nov1 = week.find((d) => d.day === '2026-11-01')!;
    const nov2 = week.find((d) => d.day === '2026-11-02')!;
    expect(nov1.weighIn?.kg).toBe(80);
    expect(nov1.intake.kcal).toBe(2000);
    expect(nov1.training.workouts).toBe(0);
    expect(nov2.training.workouts).toBe(1);
    expect(week.map((d) => d.trendKg)).toEqual([null, null, null, 80, 80, 80, 80]);
  });

  it('workout burn never changes what was eaten (display-only rule)', () => {
    const meals = [meal('2026-10-04', 2000)];
    const big = workout(onDay('2026-10-04', 18), { calories: 1200, caloriesManual: true });
    const withWorkout = buildWeek(WEEK, meals, [big], [], []);
    const without = buildWeek(WEEK, meals, [], [], []);
    expect(withWorkout[3].training.activeKcal).toBe(1200);
    expect(withWorkout.map((d) => d.intake)).toEqual(without.map((d) => d.intake));
  });

  it('an empty history gives a full week of not-logged, rest, no-weight days', () => {
    const week = buildWeek(WEEK, [], [], [], []);
    expect(week).toHaveLength(7);
    for (const d of week) {
      expect(d.intake.logged).toBe(false);
      expect(d.training.workouts).toBe(0);
      expect(d.weighIn).toBeNull();
      expect(d.trendKg).toBeNull();
    }
  });
});
