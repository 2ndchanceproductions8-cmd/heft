import type { Settings, Unit, Workout } from '../../../types';
import { isAppleMobile } from '../../../lib/appleHealth';
import { dayKey } from '../../../lib/nutrition/math';
import { weekStreak, weeklyBuckets, type WeekBucket } from '../../../lib/stats';
import { dailyTraining, unsentWorkouts, type DayTraining } from '../../../lib/today';
import { formatDuration, formatVolume } from '../../../lib/units';

/*
 * The Today dashboard's Training card, as plain data: today's finished workouts, the last one before today, this
 * week vs last week (the same numbers as Progress' This Week card) and the Apple Health "not sent" nudge. Pure, so
 * the card's states test in node.
 */

const DAY_MS = 86_400_000;
/** How far back the "not sent to Apple Health" nudge looks. */
export const HEALTH_NUDGE_DAYS = 7;

export interface TrainingModel {
  /** Any saved workout at all (false = brand new user). */
  trained: boolean;
  /** Workouts that started on today's local day, newest first. */
  todays: Workout[];
  /** Today's totals (active kcal is the Apple Health number: display only). */
  todayTotals: DayTraining;
  /** The newest workout from before today (the "rest day" line), or null. */
  last: Workout | null;
  thisWeek: WeekBucket;
  lastWeek: WeekBucket;
  /** Consecutive weeks with a workout (lib/stats weekStreak, as on Progress). */
  streak: number;
}

/** `workouts` in any order (useWorkouts gives newest first). */
export function buildTraining(workouts: Workout[], today: string, now: number, weekStartsOn: 0 | 1): TrainingModel {
  const sorted = [...workouts].sort((a, b) => b.startedAt - a.startedAt);
  const todays = sorted.filter((w) => dayKey(w.startedAt) === today);
  // A workout dated after today (edited start time, a clock change) is neither "today" nor "the last one".
  const last = sorted.find((w) => dayKey(w.startedAt) < today) ?? null;
  const [lastWeek, thisWeek] = weeklyBuckets(sorted, 2, weekStartsOn, now);
  return {
    trained: sorted.length > 0,
    todays,
    todayTotals: dailyTraining(sorted, [today])[0],
    last,
    thisWeek,
    lastWeek,
    streak: weekStreak(sorted, weekStartsOn, now),
  };
}

export interface HealthNudge {
  count: number;
  /** The newest unsent workout: its detail page has the Send to Apple Health button. */
  workoutId: string;
}

/**
 * Workouts from the last 7 days not handed to Apple Health yet. Only on an iPhone/iPad (the Shortcuts app) and only
 * once the "Heft to Health" Shortcut is set up (`settings.appleHealth`); null otherwise or when everything is sent.
 */
export function healthNudge(
  workouts: readonly Workout[],
  settings: Pick<Settings, 'appleHealth'>,
  now: number,
  appleMobile: boolean = isAppleMobile(),
): HealthNudge | null {
  if (!appleMobile || !settings.appleHealth) return null;
  const unsent = unsentWorkouts(workouts, now - HEALTH_NUDGE_DAYS * DAY_MS);
  return unsent.length ? { count: unsent.length, workoutId: unsent[0].id } : null;
}

export const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** "3 workouts · 2h 40min · 31,250 lb"; zero parts are left out (a cardio week has no volume). */
export function weekSummary(b: Pick<WeekBucket, 'workouts' | 'durationSec' | 'volumeKg'>, unit: Unit): string {
  if (b.workouts <= 0) return 'No workouts yet';
  const parts = [plural(b.workouts, 'workout', 'workouts')];
  if (b.durationSec > 0) parts.push(formatDuration(b.durationSec));
  if (b.volumeKg > 0) parts.push(formatVolume(b.volumeKg, unit));
  return parts.join(' · ');
}

/** Time since a running workout started, to the minute: "just started", "23min", "1h 5min". */
export function elapsedLabel(startedAt: number, now: number): string {
  const sec = Math.max(0, (now - startedAt) / 1000);
  if (sec < 60) return 'just started';
  return formatDuration(Math.floor(sec / 60) * 60);
}

export const workoutName = (name: string | undefined | null) => name?.trim() || 'Workout';
