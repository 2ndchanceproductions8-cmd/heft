// Pure helpers for the History feature (no React, no DB) so they can be unit-tested.
import { differenceInCalendarDays, format, isSameDay, isSameYear, startOfWeek, subDays, subWeeks } from 'date-fns';
import type {
  DistanceUnit,
  Exercise,
  ExerciseType,
  Muscle,
  PRKind,
  SetEntry,
  SetType,
  Unit,
  Workout,
  WorkoutExercise,
} from '../../types';
import { estimate1RM } from '../../lib/calc';
import { setNumberLabels, typeFields } from '../../lib/exerciseMeta';
import {
  displayDistance,
  formatClock,
  formatDistance,
  formatDistanceForType,
  formatNumber,
  formatVolume,
  formatWeight,
  kgToUnit,
} from '../../lib/units';

// ---------------------------------------------------------------- dates

/** Local calendar-day key, e.g. "2026-09-28". */
export function dayKey(ts: number | Date): string {
  return format(ts, 'yyyy-MM-dd');
}

/** Card date line: "Today, 6:12 PM" / "Yesterday, 6:12 PM" / "Mon, Sep 28 | 6:12 PM" (year added when not this year). */
export function formatWorkoutWhen(ts: number, now: number = Date.now()): string {
  const d = new Date(ts);
  const n = new Date(now);
  const time = format(d, 'h:mm a');
  if (isSameDay(d, n)) return `Today, ${time}`;
  if (isSameDay(d, subDays(n, 1))) return `Yesterday, ${time}`;
  if (isSameYear(d, n)) return `${format(d, 'EEE, MMM d')} | ${time}`;
  return `${format(d, 'EEE, MMM d, yyyy')} | ${time}`;
}

/** "6:12 – 7:20 PM", "11:40 AM – 12:30 PM", "11:40 PM – 12:30 AM (+1 day)". */
export function formatTimeRange(start: number, end: number): string {
  const s = new Date(start);
  const e = new Date(Math.max(start, end));
  const days = differenceInCalendarDays(e, s);
  const sameHalf = days === 0 && format(s, 'a') === format(e, 'a');
  const left = sameHalf ? format(s, 'h:mm') : format(s, 'h:mm a');
  let right = format(e, 'h:mm a');
  if (days === 1) right += ' (+1 day)';
  else if (days > 1) right += ` (+${days} days)`;
  return `${left} – ${right}`;
}

/** Detail header: "Mon, Sep 28, 2026 | 6:12 – 7:20 PM". */
export function formatWorkoutDateRange(start: number, end: number): string {
  return `${format(start, 'EEE, MMM d, yyyy')} | ${formatTimeRange(start, end)}`;
}

/**
 * Consecutive weeks (ending this week) with at least one workout. The current week keeps the streak
 * alive even before its first workout — it only breaks once a whole week passes without training.
 */
export function weeklyStreak(timestamps: number[], weekStartsOn: 0 | 1, now: number = Date.now()): number {
  if (!timestamps.length) return 0;
  const key = (d: Date | number) => dayKey(startOfWeek(d, { weekStartsOn }));
  const weeks = new Set(timestamps.map(key));
  let cursor = startOfWeek(now, { weekStartsOn });
  if (!weeks.has(dayKey(cursor))) cursor = subWeeks(cursor, 1);
  let n = 0;
  while (weeks.has(dayKey(cursor))) {
    n++;
    cursor = subWeeks(cursor, 1);
  }
  return n;
}

/** Compact total time for summary tiles: "45m", "12h 5m", "152h". */
export function formatTotalTime(totalSec: number): string {
  const mins = Math.round(Math.max(0, totalSec) / 60);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  if (h >= 100 || m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

export function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

export const plural = (n: number, word: string, many = word + 's') => `${n.toLocaleString()} ${n === 1 ? word : many}`;

// ---------------------------------------------------------------- grouping

export interface MonthGroup {
  /** "2026-09" */
  key: string;
  /** "September 2026" */
  label: string;
  workouts: Workout[];
}

/** Groups (already sorted) workouts by calendar month, preserving order. */
export function groupByMonth(workouts: Workout[]): MonthGroup[] {
  const out: MonthGroup[] = [];
  for (const w of workouts) {
    const key = format(w.startedAt, 'yyyy-MM');
    let g = out[out.length - 1];
    if (!g || g.key !== key) {
      g = { key, label: format(w.startedAt, 'MMMM yyyy'), workouts: [] };
      out.push(g);
    }
    g.workouts.push(w);
  }
  return out;
}

export function workoutsByDay(workouts: Workout[]): Map<string, Workout[]> {
  const map = new Map<string, Workout[]>();
  for (const w of workouts) {
    const k = dayKey(w.startedAt);
    const arr = map.get(k);
    if (arr) arr.push(w);
    else map.set(k, [w]);
  }
  return map;
}

export interface PeriodTotals {
  count: number;
  durationSec: number;
  volumeKg: number;
}

export function totals(workouts: Workout[]): PeriodTotals {
  let durationSec = 0;
  let volumeKg = 0;
  for (const w of workouts) {
    durationSec += w.durationSec || 0;
    volumeKg += w.volumeKg || 0;
  }
  return { count: workouts.length, durationSec, volumeKg };
}

// ---------------------------------------------------------------- sets

export const doneSets = (we: WorkoutExercise): SetEntry[] => we.sets.filter((s) => s.done);

/** Comparable score for "best set" per exercise type (compared left to right). */
function setScore(s: SetEntry, type: ExerciseType): number[] {
  const w = Math.abs(s.weightKg ?? 0);
  const r = s.reps ?? 0;
  const d = s.durationSec ?? 0;
  const m = s.distanceM ?? 0;
  switch (type) {
    case 'weight_reps':
      return [estimate1RM(w, r), w, r];
    case 'weighted_bodyweight':
      return [w, r];
    case 'assisted_bodyweight':
      return [r, -w]; // less assistance is harder
    case 'bodyweight_reps':
      return [r];
    case 'duration':
      return [d];
    case 'duration_weight':
      return [w, d];
    case 'distance_duration':
      return [m, m > 0 ? -d : d]; // same distance in less time is better
    case 'weight_distance':
      return [w, m];
  }
}

function compareScores(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (Math.abs(d) > 1e-9) return d;
  }
  return 0;
}

/** The headline set of an exercise (Hevy's "Best set"): working sets only unless everything was a warm-up. */
export function bestSet(sets: SetEntry[], type: ExerciseType): SetEntry | null {
  const done = sets.filter((s) => s.done);
  const work = done.filter((s) => s.type !== 'warmup');
  const pool = work.length ? work : done;
  let best: SetEntry | null = null;
  let bestScore: number[] = [];
  for (const s of pool) {
    const sc = setScore(s, type);
    if (!best || compareScores(sc, bestScore) > 0) {
      best = s;
      bestScore = sc;
    }
  }
  return best;
}

/**
 * Distance for display: carries/sleds in m (km users) or yd (mi users), to 0.1 and never flipped to km/mi,
 * exactly like the logger enters them (formatDistanceForType); runs in the user's unit (tiny distances fall
 * back to meters).
 */
export function formatSetDistance(m: number, type: ExerciseType, unit: DistanceUnit): string {
  if (type === 'weight_distance') return formatDistanceForType(m, type, unit);
  const v = displayDistance(m, unit) ?? 0;
  if (m > 0 && v < 0.1) return `${formatNumber(m, 0)} m`;
  return formatDistance(m, unit);
}

/**
 * One set as text in the user's units, per exercise type:
 * "135 lb x 8", "+25 lb x 6", "-40 lb x 8", "12 reps", "1:30", "2.1 mi in 18:00", "60 lb | 40 yd" (mi users) /
 * "30 kg | 40 m" (km users).
 */
export function formatSetValue(set: SetEntry, type: ExerciseType, unit: Unit, distanceUnit: DistanceUnit): string {
  const f = typeFields(type);
  const kg = set.weightKg;
  const reps = set.reps;
  const dur = set.durationSec;
  const dist = set.distanceM;
  const weightText = (v: number) => `${f.weightSign}${formatWeight(Math.abs(v), unit)}`;
  const repsText = (r: number) => `${r} ${r === 1 ? 'rep' : 'reps'}`;

  if (f.weight && f.reps) {
    // Weighted/assisted bodyweight with no load is just bodyweight reps.
    const hasW = kg != null && (type === 'weight_reps' || Math.abs(kg) > 0);
    const hasR = reps != null;
    if (hasW && hasR) return `${weightText(kg!)} x ${reps}`;
    if (hasW) return weightText(kg!);
    if (hasR) return repsText(reps!);
    return '-';
  }
  if (f.reps) return reps != null ? repsText(reps) : '-';

  const parts: string[] = [];
  // A weighted carry/plank logged without load reads "40 m" / "0:45", not "0 lb | 40 m".
  if (f.weight && kg != null && kg !== 0) parts.push(weightText(kg));
  if (f.distance && f.duration) {
    const d = dist != null && dist > 0 ? formatSetDistance(dist, type, distanceUnit) : null;
    const t = dur != null && dur > 0 ? formatClock(dur) : null;
    if (d && t) return `${d} in ${t}`;
    return d ?? t ?? '-';
  }
  if (f.distance && dist != null) parts.push(formatSetDistance(dist, type, distanceUnit));
  if (f.duration && dur != null) parts.push(formatClock(dur));
  return parts.length ? parts.join(' | ') : '-';
}

/** Estimated 1RM in the display unit, rounded ("161 lb"), or null when it doesn't apply. */
export function formatE1RM(set: SetEntry, type: ExerciseType, unit: Unit): string | null {
  if (type !== 'weight_reps' || !set.reps || set.reps < 2 || !set.weightKg) return null;
  const v = estimate1RM(set.weightKg, set.reps);
  return v > 0 ? `${formatNumber(kgToUnit(v, unit), 0)} ${unit}` : null;
}

/**
 * Badge text for each set row - the app-wide numbering rule (lib/exerciseMeta setNumberLabels), so "set 4"
 * while logging is "set 4" in the saved workout: warm-ups show "W" and are not counted; failure / drop sets
 * show "F" / "D" in place of their number.
 */
export function setLabels(sets: readonly { type: SetType }[]): string[] {
  return setNumberLabels(sets);
}

/** Column header for the set table. */
export function setColumnLabel(type: ExerciseType): string {
  switch (type) {
    case 'weight_reps':
    case 'weighted_bodyweight':
      return 'Weight & Reps';
    case 'assisted_bodyweight':
      return 'Assistance & Reps';
    case 'bodyweight_reps':
      return 'Reps';
    case 'duration':
      return 'Time';
    case 'duration_weight':
      return 'Weight & Time';
    case 'distance_duration':
      return 'Distance & Time';
    case 'weight_distance':
      return 'Weight & Distance';
  }
}

/** A PR value formatted in the user's units. */
export function formatPRValue(
  kind: PRKind,
  value: number,
  type: ExerciseType,
  unit: Unit,
  distanceUnit: DistanceUnit,
): string {
  switch (kind) {
    case 'heaviest_weight':
      return `${typeFields(type).weightSign === '+' ? '+' : ''}${formatWeight(value, unit)}`;
    case 'best_1rm':
      return `${formatNumber(kgToUnit(value, unit), 1)} ${unit}`;
    case 'best_set_volume':
      return formatVolume(value, unit);
    case 'most_reps':
      return `${value} ${value === 1 ? 'rep' : 'reps'}`;
    case 'longest_duration':
      return formatClock(value);
    case 'longest_distance':
      return formatSetDistance(value, type, distanceUnit);
  }
}

// ---------------------------------------------------------------- muscles & supersets

/** Sets per muscle for the heat map: each done working set counts 1 for the primary muscle, 0.5 for secondaries. */
export function muscleSplit(
  exercises: WorkoutExercise[],
  getExercise: (id: string) => Pick<Exercise, 'primary' | 'secondary'>,
): Partial<Record<Muscle, number>> {
  const out: Partial<Record<Muscle, number>> = {};
  for (const we of exercises) {
    const n = we.sets.filter((s) => s.done && s.type !== 'warmup').length;
    if (!n) continue;
    const ex = getExercise(we.exerciseId);
    out[ex.primary] = (out[ex.primary] ?? 0) + n;
    for (const m of ex.secondary) if (m !== ex.primary) out[m] = (out[m] ?? 0) + n * 0.5;
  }
  return out;
}

/** Letter per superset group ("A", "B"...) in order of appearance; groups of one are ignored. */
export function supersetLetters(exercises: Pick<WorkoutExercise, 'supersetId'>[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const e of exercises) if (e.supersetId) counts.set(e.supersetId, (counts.get(e.supersetId) ?? 0) + 1);
  const out = new Map<string, string>();
  for (const e of exercises) {
    if (!e.supersetId || out.has(e.supersetId) || (counts.get(e.supersetId) ?? 0) < 2) continue;
    out.set(e.supersetId, String.fromCharCode(65 + (out.size % 26)));
  }
  return out;
}
