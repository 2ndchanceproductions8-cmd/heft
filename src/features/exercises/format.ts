import { differenceInCalendarDays, formatDistanceStrict } from 'date-fns';
import type { DistanceUnit, ExerciseType, RoutineSet, SetEntry, SetType, SideValues, Unit } from '../../types';
import { isSideSet } from '../../lib/calc';
import { setNumberLabels, typeFields } from '../../lib/exerciseMeta';
import { formatSidesLine } from '../../lib/sides';
import type { ExerciseUsage } from '../../lib/exercises';
import { formatClock, formatDistanceForType, formatNumber, formatWeight, kgToUnit } from '../../lib/units';

/*
 * Pure display helpers for the exercises feature. Inputs are always canonical units (kg, meters, seconds);
 * output strings are in the user's units.
 */

type SetValues = Pick<SetEntry, 'weightKg' | 'reps' | 'durationSec' | 'distanceM' | 'sides'>;

const has = (n: number | null | undefined): n is number => n != null && !Number.isNaN(n);

/** Estimated / derived weights (1RM, averages) — one decimal is plenty. "157.5 lb" */
export function formatEstWeight(kg: number, unit: Unit): string {
  return `${formatNumber(kgToUnit(kg, unit), 1)} ${unit}`;
}

/**
 * One set as a compact line: "135 lb × 8", "+20 lb × 8", "12 reps", "1:00", "1.5 mi in 25:00", "60 lb × 40 yd".
 * A per-side set: "L 50 lb × 10 · R 50 lb × 9" ("L/R 50 lb × 10" when both sides match).
 */
export function formatSetValue(set: SetValues, type: ExerciseType, unit: Unit, distanceUnit: DistanceUnit): string {
  if (isSideSet(set)) return formatSidesLine(set.sides, (v) => formatLimbValue(v, type, unit, distanceUnit));
  return formatLimbValue(set, type, unit, distanceUnit);
}

function formatLimbValue(set: SideValues, type: ExerciseType, unit: Unit, distanceUnit: DistanceUnit): string {
  const f = typeFields(type);
  const weight = f.weight && has(set.weightKg) && set.weightKg !== 0 ? `${f.weightSign}${formatWeight(set.weightKg, unit)}` : null;
  const reps = f.reps && has(set.reps) ? set.reps : null;
  const dur = f.duration && has(set.durationSec) ? formatClock(set.durationSec) : null;
  const dist = f.distance && has(set.distanceM) ? formatDistanceForType(set.distanceM, type, distanceUnit) : null;

  if (f.reps) {
    if (weight && reps != null) return `${weight} × ${reps}`;
    if (reps != null) return `${reps} ${reps === 1 ? 'rep' : 'reps'}`;
    return weight ?? '-';
  }
  if (type === 'distance_duration') {
    if (dist && dur) return `${dist} in ${dur}`;
    return dist ?? dur ?? '-';
  }
  const second = dur ?? dist;
  if (weight && second) return `${weight} × ${second}`;
  return weight ?? second ?? '-';
}

/**
 * Badge text per set - the app-wide numbering rule (lib/exerciseMeta setNumberLabels), the same as the logger:
 * warm-ups "W" and not counted; failure / drop sets "F" / "D" in place of their number.
 */
export function setLabels(sets: readonly { type: SetType }[]): string[] {
  return setNumberLabels(sets);
}

function range(values: number[], fmt: (v: number, withUnit: boolean) => string, suffix = ''): string | null {
  if (!values.length) return null;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  if (lo === hi) return fmt(hi, true) + suffix;
  return `${fmt(lo, false)}–${fmt(hi, true)}${suffix}`;
}

/** Planned sets of a routine exercise in one line: "3 sets · 8–12 reps · 135 lb". */
export function routineSetsSummary(
  sets: RoutineSet[],
  type: ExerciseType,
  unit: Unit,
  distanceUnit: DistanceUnit,
): string {
  const n = sets.length;
  const parts: string[] = [`${n} ${n === 1 ? 'set' : 'sets'}`];
  if (!n) return parts[0];
  const f = typeFields(type);
  const work = sets.filter((s) => s.type !== 'warmup');
  // Every planned limb: a per-side set's left and right, else the set itself.
  const pool: SideValues[] = (work.length ? work : sets).flatMap((s) => (s.sides ? [s.sides.left, s.sides.right] : [s]));

  if (f.reps) {
    const lows = pool.map((s) => s.reps).filter(has);
    const highs = pool.map((s) => s.repsMax ?? s.reps).filter(has);
    if (lows.length) {
      const lo = Math.min(...lows);
      const hi = Math.max(...highs, lo);
      parts.push(lo === hi ? `${lo} ${lo === 1 ? 'rep' : 'reps'}` : `${lo}–${hi} reps`);
    }
  }
  if (f.weight) {
    const w = range(
      pool.map((s) => s.weightKg).filter((v): v is number => has(v) && v > 0),
      (v, withUnit) => formatWeight(v, unit, withUnit),
    );
    if (w) parts.push(f.weightSign + w);
  }
  if (f.duration) {
    const d = range(pool.map((s) => s.durationSec).filter((v): v is number => has(v) && v > 0), (v) => formatClock(v));
    if (d) parts.push(d);
  }
  if (f.distance) {
    const d = range(
      pool.map((s) => s.distanceM).filter((v): v is number => has(v) && v > 0),
      (v, withUnit) => formatDistanceForType(v, type, distanceUnit, withUnit),
    );
    if (d) parts.push(d);
  }
  return parts.join(' · ');
}

/** "Today", "Yesterday", "3 days ago", "2 months ago". */
export function relativeDay(ts: number, now: number = Date.now()): string {
  const days = differenceInCalendarDays(now, ts);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return formatDistanceStrict(ts, now, { addSuffix: true });
}

const joinList = (items: string[]) =>
  items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;

/**
 * Delete confirmation for a custom exercise. When it is used in history, a routine or the current workout, or
 * has gym/brand variants, deleteCustomExercise ARCHIVES it (hidden from the library, kept for history) - the
 * copy says so up front; otherwise it is deleted for good.
 */
export function deleteExerciseCopy(u: ExerciseUsage): { archive: boolean; message: string; confirmLabel: string } {
  const where: string[] = [];
  if (u.workouts > 0) where.push(u.workouts === 1 ? 'a workout in your history' : `${u.workouts} workouts in your history`);
  if (u.routines > 0) where.push(u.routines === 1 ? 'a routine' : `${u.routines} routines`);
  if (u.activeWorkout) where.push('your current workout');
  if (!where.length && u.variants <= 0) {
    return { archive: false, message: 'It will be deleted for good, with its photos.', confirmLabel: 'Delete' };
  }
  const variants = u.variants === 1 ? 'a machine/brand variant' : `${u.variants} machine/brand variants`;
  const reasons = [where.length ? `It's used in ${joinList(where)}` : '', u.variants > 0 ? `${where.length ? 'it has' : 'It has'} ${variants}` : '']
    .filter(Boolean)
    .join(' and ');
  const variantNote = u.variants === 1 ? ' Its variant keeps its own history.' : u.variants > 1 ? ' Its variants keep their own history.' : '';
  return {
    archive: true,
    message: `${reasons}, so it will be archived instead of deleted: hidden from your library, but kept for your history.${variantNote}`,
    confirmLabel: 'Archive',
  };
}
