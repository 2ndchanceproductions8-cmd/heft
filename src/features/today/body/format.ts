import { format } from 'date-fns';
import type { Unit } from '../../../types';
import { dayKey, shiftDay } from '../../../lib/nutrition/math';
import { kgToUnit } from '../../../lib/units';
import { relativeDay } from '../../progress/format';

/*
 * Words and numbers for the Today Body card. Inputs are kg / kg per week / epoch ms; output is in the user's unit.
 * Pure, so the card's copy is tested without a DOM.
 */

/** A weigh-in older than this many days gets a gentle "step on the scale" nudge. */
export const STALE_DAYS = 7;

/** |rate| under this counts as holding steady (0.25 lb/wk). Also how close to 0 a goal pace counts as maintain. */
export const MAINTAIN_BAND_KG = 0.11;

const MINUS = '−';

/** One fixed decimal ("184.0", "83.4"): a weight that changes every day shouldn't change width when it hits .0. */
export function fixed1(n: number): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

/** A body weight in the user's unit, one decimal: "184.2 lb". */
export function weightText(kg: number, unit: Unit): string {
  return `${fixed1(kgToUnit(kg, unit))} ${unit}`;
}

/** Rounded to the one decimal it is shown with, so the sign, arrow and colour agree with the number. */
function shownRate(kgPerWeek: number, unit: Unit): number {
  const v = Math.round(kgToUnit(kgPerWeek, unit) * 10) / 10;
  return Object.is(v, -0) ? 0 : v;
}

/** -1 falling, 1 rising, 0 flat — by the number as shown (one decimal in the user's unit). */
export function rateDirection(kgPerWeek: number, unit: Unit): -1 | 0 | 1 {
  const v = shownRate(kgPerWeek, unit);
  return v < 0 ? -1 : v > 0 ? 1 : 0;
}

/** "−0.6 lb/wk", "+0.3 kg/wk", "0.0 lb/wk". */
export function formatRate(kgPerWeek: number, unit: Unit): string {
  const v = shownRate(kgPerWeek, unit);
  const sign = v < 0 ? MINUS : v > 0 ? '+' : '';
  return `${sign}${fixed1(Math.abs(v))} ${unit}/wk`;
}

export type GoalKind = 'lose' | 'maintain' | 'gain';

/** What the calorie target is built to do, from its weekly pace (goalRateKgPerWeek). */
export function goalKind(goalRateKg: number): GoalKind {
  if (Math.abs(goalRateKg) < MAINTAIN_BAND_KG) return 'maintain';
  return goalRateKg < 0 ? 'lose' : 'gain';
}

/** "goal −0.8 lb/wk", or "goal: hold steady" for a maintenance target. */
export function formatGoal(goalRateKg: number, unit: Unit): string {
  return goalKind(goalRateKg) === 'maintain' ? 'goal: hold steady' : `goal ${formatRate(goalRateKg, unit)}`;
}

/**
 * Does the scale trend go where the calorie target points? Losing and falling, gaining and rising, or holding
 * within the band as shown (±0.2 lb/wk or ±0.1 kg/wk) on maintenance. false without a trend or without a target
 * (the card stays neutral; a scale trend is never shown as an error).
 */
export function onTrack(rateKg: number | null, goalRateKg: number | null, unit: Unit): boolean {
  if (rateKg == null || goalRateKg == null || !Number.isFinite(rateKg) || !Number.isFinite(goalRateKg)) return false;
  switch (goalKind(goalRateKg)) {
    case 'maintain':
      return Math.abs(shownRate(rateKg, unit)) < kgToUnit(MAINTAIN_BAND_KG, unit);
    case 'lose':
      return rateDirection(rateKg, unit) < 0;
    case 'gain':
      return rateDirection(rateKg, unit) > 0;
  }
}

/** When the latest weigh-in was: "Today, 7:02 AM", "Yesterday", "4 days ago", then "2w ago" / "Aug 4". */
export function weighInWhen(at: number, daysAgo: number, now: number): string {
  if (daysAgo <= 0) return `Today, ${format(at, 'h:mm a')}`;
  if (daysAgo === 1) return 'Yesterday';
  if (daysAgo < 14) return `${daysAgo} days ago`;
  return relativeDay(at, now);
}

/** The stale nudge, or null while the weigh-in is recent. */
export function staleNudge(daysAgo: number | null): string | null {
  if (daysAgo == null || daysAgo <= STALE_DAYS) return null;
  return `No weigh-in for ${daysAgo} days. Step on the scale when you can.`;
}

/** Body fat change over 4 weeks from its weekly slope: "−0.3% in 4 wk", "No change in 4 wk". */
export function bodyFatChange(ratePerWeek: number): string {
  const v = Math.round(ratePerWeek * 4 * 10) / 10;
  if (v === 0 || Object.is(v, -0)) return 'No change in 4 wk';
  return `${v < 0 ? MINUS : '+'}${fixed1(Math.abs(v))}% in 4 wk`;
}

/** "1 photo", "2 photos". */
export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

// ------------------------------------------------------------------ the weigh-ins sheet

/** A reading's day and time for the list: "Today, 7:02 AM", "Yesterday, 6:58 AM", "Sat, Oct 3, 7:02 AM". */
export function readingWhen(at: number, today: string): string {
  const day = dayKey(at);
  const time = format(at, 'h:mm a');
  if (day === today) return `Today, ${time}`;
  if (day === shiftDay(today, -1)) return `Yesterday, ${time}`;
  return format(at, 'EEE, MMM d, h:mm a');
}

/** One reading in a sentence: "184.2 lb · Oct 6, 7:02 AM", or "19.4% body fat · Oct 6, 7:02 AM" without a weight. */
export function readingText(r: { at: number; kg: number | null; bodyFatPct: number | null }, unit: Unit): string {
  const value = r.kg != null ? weightText(r.kg, unit) : r.bodyFatPct != null ? `${fixed1(r.bodyFatPct)}% body fat` : 'Entry';
  return `${value} · ${format(r.at, 'MMM d, h:mm a')}`;
}
