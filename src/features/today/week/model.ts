import { format } from 'date-fns';
import type { Measurement, Unit, Workout } from '../../../types';
import type { Meal, Targets } from '../../../lib/nutrition/types';
import { dayKey, dayStart } from '../../../lib/nutrition/math';
import {
  averageIntake,
  bodySummary,
  buildWeek,
  daysBetween,
  goalRateKgPerWeek,
  lastDays,
  type WeekDay,
  type WeighIn,
} from '../../../lib/today';
import { kgToUnit } from '../../../lib/units';
import { formatKcal } from '../../nutrition/ui';
import { dayQuery } from '../../nutrition/diary/day';

/*
 * The "Last 7 days" card's numbers and geometry, pure so they test in node. The card lines up body (weigh-ins and
 * the smoothed trend), food (kcal eaten vs the target) and training (workouts) in 7 day columns, today last.
 * Weights stay in kg until a *Text helper converts them for display.
 */

export const WEEK_LEN = 7;

export interface WeekInput {
  /** Local day key yyyy-MM-dd (the window ends here). */
  today: string;
  /** Meals in the window (any status; only `done` meals count). */
  meals: readonly Meal[];
  /** Saved workouts (any range; the window is picked out here). */
  workouts: readonly Workout[];
  /** Every measurement row (the trend and the weekly rate need the history before the window). */
  measurements: readonly Measurement[];
  /** null = no targets (body details missing). */
  targets: Pick<Targets, 'kcal' | 'proteinG' | 'tdee' | 'recomp'> | null;
  /** Maintain · Recomp: days the user marked as training (true) / rest (false). */
  trainingMarks?: Record<string, boolean>;
  /** Maintain · Recomp: a workout is running now (today counts as training). */
  runningToday?: boolean;
}

export interface WeekModel {
  today: string;
  /** 7 rows, oldest first, today last. */
  days: WeekDay[];
  /** Workouts per day key inside the window, in the order they were started. */
  workoutsByDay: Record<string, Workout[]>;
  /** The kcal target (Maintain · Recomp: the week's AVERAGE target; each day's own is in `dayTargetKcal`). */
  targetKcal: number | null;
  /** Each day's own kcal target (recomp: training days at maintenance, rest days below; else = targetKcal). */
  dayTargetKcal: Record<string, number | null>;
  /** Maintain · Recomp: per-day targets differ, so the lane marks each day's target instead of one line. */
  recomp: boolean;
  targetProteinG: number | null;
  /** At least one weigh-in ever (not just this week). */
  everWeighed: boolean;
  /** The newest weigh-in ever. */
  lastWeighIn: WeighIn | null;
  /** Weigh-in days inside the window. */
  weighInDays: number;
  /** Smoothed weight today (carried forward from the newest weigh-in). */
  trendKg: number | null;
  /** The trend at the last weigh-in before the window (null when none). */
  trendIn: { day: string; kg: number } | null;
  /** kg per week over the last 28 days (null until 3 readings span 7+ days). */
  rateKgPerWeek: number | null;
  /** The weekly change the calorie target is built for; null without targets. */
  goalRateKgPerWeek: number | null;
  /** Average of the LOGGED days before today (today is still being eaten). */
  average: { kcal: number; proteinG: number; days: number } | null;
  /** Logged days in the window, today included. */
  loggedDays: number;
  workoutCount: number;
  durationSec: number;
  /** Nothing in the 7 days: no logged meal, no workout, no weigh-in. */
  empty: boolean;
}

const validTarget = (v: number | null | undefined): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;

export function weekModel(input: WeekInput): WeekModel {
  const { today, meals, workouts, measurements, targets } = input;
  const span = lastDays(today, WEEK_LEN);
  const inWindow = new Set(span);
  const body = bodySummary(measurements, today);
  const days = buildWeek(span, meals, workouts, body.weighIns, body.trend);

  const workoutsByDay: Record<string, Workout[]> = {};
  for (const w of workouts) {
    const day = dayKey(w.startedAt);
    if (!inWindow.has(day)) continue;
    (workoutsByDay[day] ??= []).push(w);
  }
  for (const list of Object.values(workoutsByDay)) list.sort((a, b) => a.startedAt - b.startedAt);

  const loggedDays = days.filter((d) => d.intake.logged).length;
  const weighInDays = days.filter((d) => d.weighIn).length;
  const workoutCount = days.reduce((a, d) => a + d.training.workouts, 0);
  const durationSec = days.reduce((a, d) => a + d.training.durationSec, 0);
  const goal = targets && Number.isFinite(targets.kcal) && Number.isFinite(targets.tdee) ? goalRateKgPerWeek(targets) : null;
  const j = body.weighIns.findLastIndex((w) => w.day < span[0]);

  // Recomp: a day's target follows its kind (same rule as lib/nutrition/store.ts trainingDayInfo: the user's mark,
  // else a workout that day, else today with a workout running).
  const recomp = targets?.recomp ?? null;
  const dayTargetKcal: Record<string, number | null> = {};
  for (const d of days) {
    const training = input.trainingMarks?.[d.day] ?? (d.training.workouts > 0 || (d.day === today && !!input.runningToday));
    dayTargetKcal[d.day] = validTarget(recomp ? (training ? recomp.trainingKcal : recomp.restKcal) : targets?.kcal);
  }

  return {
    today,
    days,
    workoutsByDay,
    dayTargetKcal,
    recomp: !!recomp,
    targetKcal: validTarget(recomp ? recomp.avgKcal : targets?.kcal),
    targetProteinG: validTarget(targets?.proteinG),
    everWeighed: body.weighIns.length > 0,
    lastWeighIn: body.latest,
    weighInDays,
    trendKg: days[days.length - 1]?.trendKg ?? null,
    trendIn: j >= 0 ? { day: body.weighIns[j].day, kg: body.trend[j] } : null,
    rateKgPerWeek: body.rateKgPerWeek,
    goalRateKgPerWeek: goal,
    average: averageIntake(
      days.map((d) => d.intake),
      today,
    ),
    loggedDays,
    workoutCount,
    durationSec,
    empty: loggedDays === 0 && workoutCount === 0 && weighInDays === 0,
  };
}

// ------------------------------------------------------------------ geometry (percent of a lane)

/** Center of column `i` of `n`, in percent of the lane width. */
export const colPct = (i: number, n = WEEK_LEN) => ((i + 0.5) / n) * 100;

export interface Range {
  lo: number;
  hi: number;
}

/**
 * Smallest kg span the weight lane shows. A day-to-day scale swing of 0.5 kg should look like noise, not a cliff;
 * over ~1.5 kg a 0.5 lb change still moves the line a visible few pixels.
 */
export const MIN_WEIGHT_SPAN_KG = 1.5;

/** y range for the weight lane: the values plus 12 % padding, at least `minSpan` kg tall. null with no values. */
export function weightRange(values: readonly number[], minSpan = MIN_WEIGHT_SPAN_KG): Range | null {
  const v = values.filter((x) => Number.isFinite(x));
  if (!v.length) return null;
  let lo = Math.min(...v);
  let hi = Math.max(...v);
  const pad = (hi - lo) * 0.12;
  lo -= pad;
  hi += pad;
  if (hi - lo < minSpan) {
    const mid = (hi + lo) / 2;
    lo = mid - minSpan / 2;
    hi = mid + minSpan / 2;
  }
  return { lo, hi };
}

/** Vertical position in percent from the TOP of the lane (hi = 0, lo = 100). */
export const yPct = (v: number, r: Range) => ((r.hi - v) / (r.hi - r.lo)) * 100;

export interface TrendPoint {
  /** Column index (0 = oldest day). */
  i: number;
  kg: number;
}

export interface TrendGeometry {
  range: Range;
  /** The smoothed line through the weigh-in days (plus a first-column point when the trend comes in from before). */
  line: TrendPoint[];
  /** Dashed carry from the last weigh-in to today, when today has no weigh-in yet. */
  tail: [TrendPoint, TrendPoint] | null;
  /** Actual scale readings: one per weigh-in day. */
  dots: (TrendPoint & { day: string })[];
}

/**
 * The weight lane. The line joins the trend at each weigh-in day (straight between them, rather than the
 * step a carried-forward value would draw), starting at column 0 when the trend comes in from before the window.
 * Column 0 is then interpolated between `trendIn` (the trend at the last weigh-in before the window, however
 * old) and the first weigh-in in the window, so the line shows only the change inside the 7 days: a reading
 * from two months ago doesn't draw its whole drop into "Last 7 days" or stretch the range. With no weigh-in in
 * the window column 0 keeps the carried value. After the last weigh-in the trend is only carried, so that
 * stretch is a dashed tail. Dots are the raw readings.
 * null when there's nothing to draw (no weigh-in on or before any day of the window).
 */
export function trendGeometry(
  days: readonly WeekDay[],
  trendIn: { day: string; kg: number } | null = null,
): TrendGeometry | null {
  const line: TrendPoint[] = [];
  const dots: (TrendPoint & { day: string })[] = [];
  days.forEach((d, i) => {
    if (d.trendKg == null) return;
    if (d.weighIn) {
      line.push({ i, kg: d.trendKg });
      dots.push({ i, kg: d.weighIn.kg, day: d.day });
    } else if (i === 0) {
      line.push({ i, kg: d.trendKg }); // carried in from before the window
    }
  });
  if (!line.length) return null;
  const first = line.find((p) => days[p.i].weighIn);
  if (trendIn && first && first.i > 0 && line[0].i === 0 && !days[0].weighIn) {
    const t = daysBetween(trendIn.day, days[0].day) / daysBetween(trendIn.day, days[first.i].day);
    line[0] = { i: 0, kg: trendIn.kg + (first.kg - trendIn.kg) * t };
  }
  const lastIdx = days.length - 1;
  const last = days[lastIdx];
  const end = line[line.length - 1];
  const tail: [TrendPoint, TrendPoint] | null =
    last && !last.weighIn && last.trendKg != null && end.i < lastIdx ? [end, { i: lastIdx, kg: last.trendKg }] : null;
  const range = weightRange([...line.map((p) => p.kg), ...dots.map((p) => p.kg), ...(tail ? [tail[1].kg] : [])]);
  return range ? { range, line, tail, dots } : null;
}

/** Headroom over the tallest bar (or the target) so neither touches the lane's top. */
export const FOOD_HEADROOM = 1.1;

export interface FoodBar {
  day: string;
  /** none = nothing logged (a faint dash, never a 0 kcal bar); today = still being eaten (drawn in progress). */
  kind: 'none' | 'logged' | 'today';
  kcal: number;
  /** Bar height in percent of the lane. */
  heightPct: number;
  /** Share of the bar above the day's target (0 … 1). */
  overShare: number;
  /** This day's own target height in percent of the lane (per-day targets only, else null). */
  targetPct: number | null;
}

export interface FoodGeometry {
  bars: FoodBar[];
  /** The one target line's height in percent of the lane; null without a target or with per-day targets. */
  targetPct: number | null;
}

/**
 * The food lane: scaled to the larger of the target(s) and the biggest logged day (bars only without a target).
 * With `dayTargets` (Maintain · Recomp) each day is measured against its own target and gets its own mark.
 */
export function foodGeometry(
  days: readonly WeekDay[],
  targetKcal: number | null,
  today: string,
  dayTargets?: Record<string, number | null>,
): FoodGeometry {
  const target = validTarget(targetKcal);
  const own = (day: string) => (dayTargets ? validTarget(dayTargets[day]) : target);
  const maxLogged = Math.max(0, ...days.filter((d) => d.intake.logged).map((d) => d.intake.kcal));
  const maxTarget = Math.max(0, ...days.map((d) => own(d.day) ?? 0));
  const top = Math.max(maxLogged, maxTarget) * FOOD_HEADROOM || 1;
  const pct = (kcal: number | null) => (kcal != null ? (kcal / top) * 100 : null);
  const bars = days.map((d): FoodBar => {
    const kcal = Math.max(0, d.intake.kcal);
    const t = own(d.day);
    const targetPct = dayTargets ? pct(t) : null;
    if (!d.intake.logged) return { day: d.day, kind: 'none', kcal: 0, heightPct: 0, overShare: 0, targetPct };
    return {
      day: d.day,
      kind: d.day === today ? 'today' : 'logged',
      kcal,
      // A logged 0 kcal day (black coffee) still shows a sliver, so it never reads as "not logged".
      heightPct: Math.max(2.5, Math.min(100, (kcal / top) * 100)),
      overShare: t != null && kcal > t ? (kcal - t) / kcal : 0,
      targetPct,
    };
  });
  return { bars, targetPct: dayTargets ? null : pct(target) };
}

// ------------------------------------------------------------------ text

const oneDp = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** Body weight with one decimal in the user's unit: "184.2 lb", "83.5 kg". */
export const bodyWeightText = (kg: number, unit: Unit) => `${oneDp(kgToUnit(kg, unit))} ${unit}`;

/** Body fat percent with one decimal: "18.5%". */
export const bodyFatText = (pct: number) => `${oneDp(pct)}%`;

/** Signed weekly change in the user's unit, one decimal, without the unit: "+0.4", "−0.6", "0.0". */
export function rateText(kgPerWeek: number, unit: Unit): string {
  const r = Math.round(kgToUnit(kgPerWeek, unit) * 10) / 10;
  if (r === 0 || !Number.isFinite(r)) return '0.0';
  return `${r > 0 ? '+' : '−'}${oneDp(Math.abs(r))}`;
}

/** Workout minutes for a narrow column: "48m", "1h 5m", "2h". '' for no time. */
export function shortDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '';
  const min = Math.max(1, Math.round(sec / 60));
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** "Sep 30 – Oct 6". */
export function rangeText(days: readonly string[]): string {
  if (!days.length) return '';
  const f = (d: string) => format(dayStart(d), 'MMM d');
  return `${f(days[0])} – ${f(days[days.length - 1])}`;
}

/** The day column's accessible name: "Mon, Oct 5: 2,140 kcal, 1 workout, 184.2 lb". */
export function columnLabel(d: WeekDay, today: string, unit: Unit): string {
  const isToday = d.day === today;
  const date = format(dayStart(d.day), 'EEE, MMM d');
  const food = d.intake.logged ? `${formatKcal(d.intake.kcal)} kcal${isToday ? ' so far' : ''}` : 'nothing logged';
  const n = d.training.workouts;
  const training = n ? `${n} ${n === 1 ? 'workout' : 'workouts'}` : 'no workout';
  const weight = d.weighIn ? bodyWeightText(d.weighIn.kg, unit) : 'no weigh-in';
  return `${isToday ? 'Today, ' : ''}${date}: ${food}, ${training}, ${weight}`;
}

/** Where "Open food diary" goes for a day: the Diary itself for today, else that day (?d=). */
export function diaryHref(day: string, today: string): string {
  return `/nutrition${dayQuery(day, today)}`;
}
