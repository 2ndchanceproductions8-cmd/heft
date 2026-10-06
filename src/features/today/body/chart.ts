import type { Unit } from '../../../types';
import type { BodySummary } from '../../../lib/today';
import { daysBetween } from '../../../lib/today';
import { shiftDay } from '../../../lib/nutrition/math';
import { kgToUnit } from '../../../lib/units';

/*
 * Geometry for the Body card's 30-day weight chart: daily weigh-ins as dots and the smoothed trend through them,
 * on a fixed calendar window ending today (gaps between weigh-ins stay visible). Positions are fractions (0..1,
 * y from the top) so the view can stretch the line to any width and place round dots and labels as HTML.
 */

export const CHART_DAYS = 30;

/** Smallest y range drawn, in the user's unit, so a 0.2 lb wobble doesn't fill the chart like a cliff. */
const MIN_SPAN: Record<Unit, number> = { lb: 2, kg: 1 };

export interface ChartPoint {
  x: number;
  y: number;
}

export interface WeightChartModel {
  /** One per daily weigh-in in the window, oldest first; `latest` marks the newest weigh-in overall. */
  dots: (ChartPoint & { latest: boolean })[];
  /** The smoothed trend at each of those weigh-ins. */
  line: ChartPoint[];
  /** Highest / lowest value drawn (weigh-ins and trend), in the user's unit. */
  hi: number;
  lo: number;
  /** Highest / lowest weigh-in in the window (the trend can sit outside them), for the spoken summary. */
  readingHi: number;
  readingLo: number;
  /** Their y positions (0 = top). */
  yHi: number;
  yLo: number;
  /** First day of the window and today (day keys). */
  startDay: string;
  endDay: string;
}

/** null with fewer than 2 weigh-ins in the window (the card shows a hint instead of an empty chart). */
export function weightChartModel(s: Pick<BodySummary, 'weighIns' | 'trend' | 'latest'>, today: string, unit: Unit): WeightChartModel | null {
  const startDay = shiftDay(today, -(CHART_DAYS - 1));
  const idx: number[] = [];
  s.weighIns.forEach((w, i) => {
    if (w.day >= startDay && w.day <= today) idx.push(i);
  });
  if (idx.length < 2) return null;

  const raw = idx.map((i) => kgToUnit(s.weighIns[i].kg, unit));
  const smooth = idx.map((i) => kgToUnit(s.trend[i] ?? s.weighIns[i].kg, unit));
  const readings = raw.filter(Number.isFinite);
  const all = [...raw, ...smooth].filter(Number.isFinite);
  const hi = Math.max(...all);
  const lo = Math.min(...all);
  const span = Math.max(hi - lo, MIN_SPAN[unit]);
  const mid = (hi + lo) / 2;
  const top = mid + span / 2;
  const y = (v: number) => (top - v) / span;
  const x = (day: string) => daysBetween(startDay, day) / (CHART_DAYS - 1);

  return {
    dots: idx.map((i, k) => ({
      x: x(s.weighIns[i].day),
      y: y(raw[k]),
      latest: s.latest != null && s.weighIns[i].id === s.latest.id,
    })),
    line: idx.map((i, k) => ({ x: x(s.weighIns[i].day), y: y(smooth[k]) })),
    hi,
    lo,
    readingHi: Math.max(...readings),
    readingLo: Math.min(...readings),
    yHi: y(hi),
    yLo: y(lo),
    startDay,
    endDay: today,
  };
}
