import type { Measurement, Workout } from '../types';
import type { Meal, Targets } from './nutrition/types';
import { dayKey, dayStart, shiftDay, sumMeals } from './nutrition/math';
import { activeCalories } from './appleHealth';

/*
 * The Today dashboard's numbers: body (the Hume scale's weigh-ins, via Apple Health or typed in), food (the Food
 * tab's meals) and training (saved workouts), lined up by LOCAL calendar day. Pure functions over stored rows so
 * they test in node; the screens are features/today/*.
 *
 * Days are `yyyy-MM-dd` keys (lib/nutrition/math dayKey / shiftDay, DST-safe). Weights stay in kg here; convert
 * at the UI edge. A day with nothing logged is `logged: false`, never a 0 kcal day: not logging is not fasting.
 */

/** Energy in one kg of body weight change (the usual 3,500 kcal per lb). */
export const KCAL_PER_KG = 7700;
const DAY_MS = 86_400_000;

/** `n` day keys ending with `today` (oldest first, today last). */
export function lastDays(today: string, n: number): string[] {
  const count = Math.max(0, Math.floor(n));
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i--) out.push(shiftDay(today, -i));
  return out;
}

/** Whole calendar days from `from` to `to` (DST-safe; negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return Math.round((dayStart(to) - dayStart(from)) / DAY_MS);
}

// ------------------------------------------------------------------ body

export interface WeighIn {
  /** Local day key of the weigh-in. */
  day: string;
  /** Epoch ms of the measurement row it came from. */
  at: number;
  kg: number;
  /** Body fat from the same row, else the day's latest body fat reading; null when the day has none. */
  bodyFatPct: number | null;
  /** 'health' = imported from Apple Health (the Hume scale); 'manual' = typed into Heft. */
  source: 'manual' | 'health';
  /** The measurement row id (open it on the Measurements page). */
  id: string;
}

type MeasurementLike = Pick<Measurement, 'id' | 'date' | 'bodyweightKg' | 'bodyFatPct' | 'source'>;

const validKg = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
const validPct = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 100;

/**
 * One weigh-in per local day, oldest first (the trend, the pace, the chart and Today's big number all read it):
 * - a TYPED row (source not 'health': entered in Heft, or an imported row the user edited) beats the scale's;
 * - otherwise the day's LATEST Apple Health row. Every Hume reading is its own row, and stepping back on the scale
 *   after a bad reading replaces it (the bad one can also be deleted from Today's weigh-ins sheet);
 * - among several typed rows, likewise the latest.
 * Body fat rides along from that row, else the day's latest body fat reading (a body-fat-only row: fat measured with
 * no weight within 10 minutes of it).
 */
export function dailyWeighIns(measurements: readonly MeasurementLike[]): WeighIn[] {
  const sorted = [...measurements].filter((m) => Number.isFinite(m.date)).sort((a, b) => a.date - b.date);
  const typed = new Map<string, MeasurementLike>();
  const health = new Map<string, MeasurementLike>();
  const fat = new Map<string, number>();
  // Oldest first, so a later row of the day overwrites an earlier one: each map ends with the day's latest.
  for (const m of sorted) {
    const day = dayKey(m.date);
    if (validKg(m.bodyweightKg)) (m.source === 'health' ? health : typed).set(day, m);
    if (validPct(m.bodyFatPct)) fat.set(day, m.bodyFatPct);
  }
  const weight = new Map(health);
  for (const [day, m] of typed) weight.set(day, m); // a typed weigh-in beats the scale's
  const out: WeighIn[] = [];
  for (const [day, m] of weight) {
    out.push({
      day,
      at: m.date,
      kg: m.bodyweightKg as number,
      bodyFatPct: validPct(m.bodyFatPct) ? m.bodyFatPct : (fat.get(day) ?? null),
      source: m.source === 'health' ? 'health' : 'manual',
      id: m.id,
    });
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * One body fat reading per local day, oldest first, from ALL rows (a typed caliper reading or a fat-only Apple Health
 * row counts too): the day's weigh-in row's own fat when it has one, else the day's latest reading (the rule
 * dailyWeighIns uses).
 */
export function dailyBodyFat(measurements: readonly MeasurementLike[]): { day: string; value: number }[] {
  const fromWeighIn = new Map<string, number>();
  for (const w of dailyWeighIns(measurements)) if (w.bodyFatPct != null) fromWeighIn.set(w.day, w.bodyFatPct);
  const byDay = new Map(fromWeighIn);
  const sorted = [...measurements].filter((m) => Number.isFinite(m.date)).sort((a, b) => a.date - b.date);
  // Oldest first: a later reading overwrites an earlier one, so a day without a weigh-in keeps its latest.
  for (const m of sorted) {
    const day = dayKey(m.date);
    if (validPct(m.bodyFatPct) && !fromWeighIn.has(day)) byDay.set(day, m.bodyFatPct);
  }
  return [...byDay].map(([day, value]) => ({ day, value })).sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

/** The newest body fat reading from any row (a body-fat-only row counts), or null. */
export function latestBodyFat(measurements: readonly MeasurementLike[]): { pct: number; at: number } | null {
  let best: { pct: number; at: number } | null = null;
  for (const m of measurements) {
    if (!validPct(m.bodyFatPct) || !Number.isFinite(m.date)) continue;
    if (!best || m.date > best.at) best = { pct: m.bodyFatPct, at: m.date };
  }
  return best;
}

/**
 * Smoothed body weight at each weigh-in (oldest first, same length as `points`): an exponential moving average
 * that moves `dailyAlpha` of the way toward each new reading per day (Hacker's Diet: 10%). Gap-aware: after a gap
 * of g days the step is 1 − (1 − α)^g, so a week without weighing doesn't make the next reading count as one day.
 * Seeds at the first reading. Daily scale readings swing 1–2 kg with water and food; the trend is the real signal.
 */
export function weightTrend(points: readonly Pick<WeighIn, 'day' | 'kg'>[], dailyAlpha = 0.1): number[] {
  const out: number[] = [];
  let trend: number | null = null;
  let prevDay: string | null = null;
  for (const p of points) {
    if (trend === null || prevDay === null) {
      trend = p.kg;
    } else {
      const gap = Math.max(1, daysBetween(prevDay, p.day));
      const step = 1 - Math.pow(1 - dailyAlpha, gap);
      trend = trend + step * (p.kg - trend);
    }
    prevDay = p.day;
    out.push(trend);
  }
  return out;
}

/**
 * Least-squares slope per WEEK of `value` over the readings in the `windowDays` days ending with `today`
 * (x = calendar days). null when there are fewer than 3 readings or they span less than `minSpanDays` days
 * (default 7): two scale readings a few days apart say more about water than about fat.
 */
export function weeklySlope(
  points: readonly { day: string; value: number }[],
  today: string,
  windowDays = 28,
  minSpanDays = 7,
): number | null {
  const first = shiftDay(today, -(Math.max(1, Math.floor(windowDays)) - 1));
  const pts = points.filter((p) => p.day >= first && p.day <= today && Number.isFinite(p.value));
  if (pts.length < 3) return null;
  const xs = pts.map((p) => daysBetween(first, p.day));
  const span = Math.max(...xs) - Math.min(...xs);
  if (span < minSpanDays) return null;
  const n = pts.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = pts.reduce((a, p) => a + p.value, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (pts[i].value - my);
    sxx += (xs[i] - mx) ** 2;
  }
  return sxx > 0 ? (sxy / sxx) * 7 : null;
}

/** Weekly weight change in kg/week from the daily weigh-ins (see weeklySlope). */
export function weeklyRateKg(points: readonly WeighIn[], today: string, windowDays = 28): number | null {
  return weeklySlope(points.map((p) => ({ day: p.day, value: p.kg })), today, windowDays);
}

/**
 * The weekly weight change the calorie target is built for: (target − TDEE) × 7 / 7,700 kg. Negative = losing.
 * Follows a hand-set kcal override too, because it reads the final target.
 */
export function goalRateKgPerWeek(t: Pick<Targets, 'kcal' | 'tdee'>): number {
  if (!Number.isFinite(t.kcal) || !Number.isFinite(t.tdee)) return 0;
  return ((t.kcal - t.tdee) * 7) / KCAL_PER_KG;
}

export interface BodySummary {
  /** Daily weigh-ins, oldest first (all of them). */
  weighIns: WeighIn[];
  /** Smoothed weight at each weigh-in (same length as weighIns). */
  trend: number[];
  latest: WeighIn | null;
  /** Smoothed weight now (the trend at the latest weigh-in). */
  trendKg: number | null;
  /** kg per week over the last 28 days; null until there's enough data. */
  rateKgPerWeek: number | null;
  /** Newest body fat from any row. */
  bodyFat: { pct: number; at: number } | null;
  /**
   * Body fat % change per week over the last 28 days. Needs 3+ readings across 21+ days, so 'in 4 wk' is mostly
   * observed rather than projected from one noisy week.
   */
  bodyFatRatePerWeek: number | null;
  /** Calendar days since the latest weigh-in (0 = today); null with no weigh-ins. */
  daysSinceWeighIn: number | null;
}

export function bodySummary(measurements: readonly MeasurementLike[], today: string): BodySummary {
  const weighIns = dailyWeighIns(measurements);
  const trend = weightTrend(weighIns);
  const latest = weighIns[weighIns.length - 1] ?? null;
  return {
    weighIns,
    trend,
    latest,
    trendKg: trend.length ? trend[trend.length - 1] : null,
    rateKgPerWeek: weeklyRateKg(weighIns, today),
    bodyFat: latestBodyFat(measurements),
    bodyFatRatePerWeek: weeklySlope(dailyBodyFat(measurements), today, 28, 21),
    daysSinceWeighIn: latest ? Math.max(0, daysBetween(latest.day, today)) : null,
  };
}

// ------------------------------------------------------------------ food

export interface DayIntake {
  day: string;
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  /** Meals that count (analyzed / done). */
  meals: number;
  /** At least one counted meal. false = nothing logged (NOT a 0 kcal day). */
  logged: boolean;
}

/** Per-day food totals for `days` (in that order). Only `done` meals count, as in the Diary. */
export function dailyIntake(meals: readonly Meal[], days: readonly string[]): DayIntake[] {
  const byDay = new Map<string, Meal[]>();
  for (const m of meals) {
    const list = byDay.get(m.day);
    if (list) list.push(m);
    else byDay.set(m.day, [m]);
  }
  return days.map((day) => {
    const list = byDay.get(day) ?? [];
    const counted = list.filter((m) => m.status === 'done');
    const t = sumMeals(list);
    return {
      day,
      kcal: t.kcal,
      proteinG: t.proteinG,
      carbsG: t.carbsG,
      fatG: t.fatG,
      meals: counted.length,
      logged: counted.length > 0,
    };
  });
}

/**
 * Average daily intake over the LOGGED days, leaving out `exclude` (today: a day still being eaten would drag the
 * average down). null when no day qualifies.
 */
export function averageIntake(
  rows: readonly DayIntake[],
  exclude?: string,
): { kcal: number; proteinG: number; days: number } | null {
  const used = rows.filter((r) => r.logged && r.day !== exclude);
  if (!used.length) return null;
  return {
    kcal: used.reduce((a, r) => a + r.kcal, 0) / used.length,
    proteinG: used.reduce((a, r) => a + r.proteinG, 0) / used.length,
    days: used.length,
  };
}

// ------------------------------------------------------------------ training

export interface DayTraining {
  day: string;
  workouts: number;
  durationSec: number;
  /** Active calories (the number Apple Health gets; display only, never added to the food budget). */
  activeKcal: number;
  volumeKg: number;
  prs: number;
}

/** Per-day training totals for `days` (in that order), by the local day each workout STARTED. */
export function dailyTraining(workouts: readonly Workout[], days: readonly string[]): DayTraining[] {
  const rows = new Map<string, DayTraining>(
    days.map((day) => [day, { day, workouts: 0, durationSec: 0, activeKcal: 0, volumeKg: 0, prs: 0 }]),
  );
  for (const w of workouts) {
    if (!Number.isFinite(w.startedAt)) continue;
    const r = rows.get(dayKey(w.startedAt));
    if (!r) continue;
    r.workouts += 1;
    r.durationSec += Math.max(0, w.durationSec || 0);
    r.activeKcal += activeCalories(w);
    r.volumeKg += Math.max(0, w.volumeKg || 0);
    r.prs += w.prs?.length ?? 0;
  }
  return days.map((d) => rows.get(d)!);
}

/**
 * Finished workouts not yet handed to Apple Health, started at or after `sinceMs`, newest first (for the
 * dashboard's "not sent" nudge when the Heft to Health Shortcut is set up).
 */
export function unsentWorkouts(workouts: readonly Workout[], sinceMs: number): Workout[] {
  return workouts.filter((w) => w.startedAt >= sinceMs && !w.healthSentAt).sort((a, b) => b.startedAt - a.startedAt);
}

// ------------------------------------------------------------------ the week, lined up

export interface WeekDay {
  day: string;
  intake: DayIntake;
  training: DayTraining;
  /** That day's weigh-in, if there was one. */
  weighIn: WeighIn | null;
  /**
   * Smoothed weight on that day: the trend at that day's weigh-in, else carried forward from the last weigh-in
   * before it (null before the first weigh-in ever).
   */
  trendKg: number | null;
}

/** One row per day in `days` (oldest first) with food, training and body side by side. */
export function buildWeek(
  days: readonly string[],
  meals: readonly Meal[],
  workouts: readonly Workout[],
  weighIns: readonly WeighIn[],
  trend: readonly number[],
): WeekDay[] {
  const intake = dailyIntake(meals, days);
  const training = dailyTraining(workouts, days);
  const byDay = new Map(weighIns.map((w, i) => [w.day, i]));
  return days.map((day, i) => {
    const idx = byDay.get(day);
    let trendKg: number | null = null;
    if (idx !== undefined) {
      trendKg = trend[idx] ?? null;
    } else {
      // Carry the trend forward from the last weigh-in before this day.
      for (let j = weighIns.length - 1; j >= 0; j--) {
        if (weighIns[j].day < day) {
          trendKg = trend[j] ?? null;
          break;
        }
      }
    }
    return { day, intake: intake[i], training: training[i], weighIn: idx !== undefined ? weighIns[idx] : null, trendKg };
  });
}
