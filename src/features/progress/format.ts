import { differenceInCalendarDays, format } from 'date-fns';
import type { DistanceUnit, ExerciseType, PRKind, Unit } from '../../types';
import {
  formatClock,
  formatDistanceForType,
  formatNumber,
  formatVolume,
  formatWeight,
  kgToUnit,
} from '../../lib/units';
import { typeFields } from '../../lib/exerciseMeta';
import type { ProgressMetric } from '../../lib/stats';

/* Display helpers for the Progress feature. Inputs are canonical units (kg, cm, m, s); output is in the user's units. */

/** "Today", "Yesterday", "3d ago", "2w ago", "Aug 4", "Aug 4, 2025". */
export function relativeDay(ms: number, now: number = Date.now()): string {
  const d = differenceInCalendarDays(now, ms);
  if (d <= 0) return 'Today';
  if (d === 1) return 'Yesterday';
  if (d < 7) return `${d}d ago`;
  if (d < 35) return `${Math.floor(d / 7)}w ago`;
  return new Date(ms).getFullYear() === new Date(now).getFullYear() ? format(ms, 'MMM d') : format(ms, 'MMM d, yyyy');
}

/** Estimated weights (e1RM) — one decimal. */
export function formatEstWeight(kg: number, unit: Unit): string {
  return `${formatNumber(kgToUnit(kg, unit), 1)} ${unit}`;
}

/** A record's value in the user's units, the way the app shows it for that exercise type ("+20 lb", "40 yd", "3.1 mi"). */
export function formatPRValue(kind: PRKind, value: number, type: ExerciseType, unit: Unit, distanceUnit: DistanceUnit): string {
  switch (kind) {
    case 'heaviest_weight':
      return `${typeFields(type).weightSign === '+' ? '+' : ''}${formatWeight(value, unit)}`;
    case 'best_1rm':
      return formatEstWeight(value, unit);
    case 'best_set_volume':
      return formatVolume(value, unit);
    case 'most_reps':
      return `${value} ${value === 1 ? 'rep' : 'reps'}`;
    case 'longest_duration':
      return formatClock(value);
    case 'longest_distance':
      return formatDistanceForType(value, type, distanceUnit);
  }
}

/** Order used when several records were set on one exercise in the same workout (most meaningful first). */
export const PR_PRIORITY: PRKind[] = [
  'heaviest_weight',
  'best_1rm',
  'longest_distance',
  'longest_duration',
  'most_reps',
  'best_set_volume',
];

export const METRIC_LABEL: Record<ProgressMetric, string> = {
  best1RM: 'Best e1RM',
  heaviestKg: 'Heaviest',
  maxReps: 'Most reps',
  maxDuration: 'Longest',
  maxDistance: 'Longest',
};

/** A progress metric's value in the user's units; distances in the unit the app uses for `type` (yd/m for carries). */
export function formatMetric(
  metric: ProgressMetric,
  value: number,
  type: ExerciseType,
  unit: Unit,
  distanceUnit: DistanceUnit,
): string {
  switch (metric) {
    case 'best1RM':
      return formatEstWeight(value, unit);
    case 'heaviestKg':
      return formatWeight(value, unit);
    case 'maxReps':
      return `${value} ${value === 1 ? 'rep' : 'reps'}`;
    case 'maxDuration':
      return formatClock(value);
    case 'maxDistance':
      return formatDistanceForType(value, type, distanceUnit);
  }
}

/** Set counts can be fractional (secondary muscles count half): "12 sets", "1 set", "4.5 sets". */
export function formatSets(n: number): string {
  const v = Math.round(n * 10) / 10;
  return `${v.toLocaleString()} ${v === 1 ? 'set' : 'sets'}`;
}

/** Compact axis numbers: 950, 1.2k, 12k, 1.3M. */
export function compactNumber(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e6) return `${formatNumber(n / 1e6, 1)}M`;
  if (a >= 1e4) return `${Math.round(n / 1e3)}k`;
  if (a >= 1e3) return `${formatNumber(n / 1e3, 1)}k`;
  return formatNumber(n, 1);
}

// ------------------------------------------------------------------ lengths (body measurements)

export const CM_PER_IN = 2.54;
export type LengthUnit = 'in' | 'cm';

/** Body measurements follow the weight unit: lb → inches, kg → centimeters. */
export const lengthUnitFor = (unit: Unit): LengthUnit => (unit === 'lb' ? 'in' : 'cm');
export const cmToLength = (cm: number, lu: LengthUnit) => (lu === 'in' ? cm / CM_PER_IN : cm);
export const lengthToCm = (v: number, lu: LengthUnit) => (lu === 'in' ? v * CM_PER_IN : v);

export function formatLength(cm: number | null | undefined, lu: LengthUnit, withUnit = true): string {
  if (cm == null || Number.isNaN(cm)) return '–';
  const v = formatNumber(cmToLength(cm, lu), 1);
  return withUnit ? `${v} ${lu}` : v;
}

/** 178 cm → 5'10" (lb users) or "178 cm". */
export function formatHeight(cm: number, unit: Unit): string {
  if (unit === 'lb') {
    const total = Math.round(cm / CM_PER_IN);
    return `${Math.floor(total / 12)}'${total % 12}"`;
  }
  return `${Math.round(cm)} cm`;
}

/**
 * Parse a typed height into cm. Accepts 5'10", 5 10, 5ft 10in, 70 (inches) or 5.8 (feet) for imperial users,
 * and 178, 178cm or 1.78 (meters) for metric users. Returns null when it can't be understood.
 */
export function parseHeight(input: string, unit: Unit): number | null {
  const t = input.trim().toLowerCase().replace(/[’′]/g, "'").replace(/[”″]/g, '"').replace(',', '.');
  if (!t) return null;
  const cm = /^(\d+(?:\.\d+)?)\s*cm$/.exec(t);
  if (cm) return Number(cm[1]);
  const ftIn = /^(\d+)\s*(?:'|ft|feet)\s*(?:(\d+(?:\.\d+)?)\s*(?:"|in|inches)?)?$/.exec(t) ?? /^(\d+)\s+(\d+(?:\.\d+)?)$/.exec(t);
  if (ftIn) return (Number(ftIn[1]) * 12 + Number(ftIn[2] ?? 0)) * CM_PER_IN;
  const inch = /^(\d+(?:\.\d+)?)\s*(?:"|in|inches)$/.exec(t);
  if (inch) return Number(inch[1]) * CM_PER_IN;
  const m = /^(\d+(?:\.\d+)?)\s*m$/.exec(t);
  if (m) return Number(m[1]) * 100;
  if (!/^\d+(?:\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  if (unit === 'lb') return n <= 8 ? n * 12 * CM_PER_IN : n * CM_PER_IN;
  return n < 3 ? n * 100 : n;
}

// ------------------------------------------------------------------ per-viewer UI prefs (best effort)

export function readPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem('heft.' + key);
    return v && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writePref(key: string, value: string): void {
  try {
    localStorage.setItem('heft.' + key, value);
  } catch {
    /* private mode / storage blocked — fine, it's only a UI preference */
  }
}
