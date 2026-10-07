import type { CSSProperties } from 'react';
import { format } from 'date-fns';
import { db } from '../../db';
import type {
  DistanceUnit,
  Exercise,
  ExerciseType,
  PRKind,
  Routine,
  SetEntry,
  SetType,
  Settings,
  Unit,
  Workout,
  WorkoutExercise,
} from '../../types';
import { isSideSet, previousInstanceSets } from '../../lib/calc';
import { setNumberLabels, typeFields, type TypeFields } from '../../lib/exerciseMeta';
import { uid } from '../../lib/ids';
import { formatSidesLine, hasSideValue } from '../../lib/sides';
import type { RoutineUpdatePlan } from '../../lib/routines';
import {
  displayDistanceAny,
  displayWeight,
  distanceUnitForType,
  formatClock,
  formatDistanceForType,
  formatVolume,
  formatWeight,
} from '../../lib/units';
import {
  dropWeightTarget,
  missingValueMessage,
  newSet,
  setsFromPrevious,
  setsFromRoutineExercise,
  type NewExerciseItem,
  type PickedExercise,
} from '../../lib/workoutStore';

// The tick/save value rules live with the store (finish() applies them too); re-exported for the logger.
export { filledValues, finalizeDoneSets, missingValueMessage } from '../../lib/workoutStore';

/* Pure helpers for the workout logger (active + edit modes). */

// ------------------------------------------------------------------ rest timer

// One rest vocabulary app-wide (lib/rest.ts): the same options and "Off" / "45s" / "1:30" labels everywhere.
export { REST_OPTIONS, restOptionLabel } from '../../lib/rest';

/** Rest for an exercise in this workout: workout override → exercise default → settings default. */
export function effectiveRestSec(we: WorkoutExercise, ex: Exercise, settings: Settings): number {
  return Math.max(0, we.restSec ?? ex.restSec ?? settings.defaultRestSec);
}

// ------------------------------------------------------------------ set badges

export interface SetBadge {
  label: string;
  className: string;
}

const BADGE_CLASS: Record<SetType, string> = {
  normal: 'text-fg',
  warmup: 'text-warn',
  failure: 'text-danger',
  drop: 'text-drop',
};

/** Set number badges (lib/exerciseMeta setNumberLabels: W, 1, 2, F, D, 5 …) colored by set type. */
export function setBadges(sets: SetEntry[]): SetBadge[] {
  const labels = setNumberLabels(sets);
  return sets.map((s, i) => ({ label: labels[i], className: BADGE_CLASS[s.type] }));
}

// ------------------------------------------------------------------ set table layout

export type ValueColumn = 'weight' | 'reps' | 'distance' | 'duration' | 'rpe';

/** Value columns for an exercise type (in display order). */
export function valueColumns(fields: TypeFields, showRpe: boolean): ValueColumn[] {
  const cols: ValueColumn[] = [];
  if (fields.weight) cols.push('weight');
  if (fields.reps) cols.push('reps');
  if (fields.distance) cols.push('distance');
  if (fields.duration) cols.push('duration');
  if (showRpe) cols.push('rpe');
  return cols;
}

/** Shared grid template for the header and every row of one exercise's set table. */
export function setGridStyle(cols: ValueColumn[]): CSSProperties {
  const w = cols.length >= 3 ? '52px' : '64px';
  return { gridTemplateColumns: `30px minmax(0,1fr) ${cols.map(() => w).join(' ')} 40px` };
}

/** Space reserved at the bottom of the logger while the rest timer bar is showing. */
export const REST_BAR_SPACE = 112;

// ------------------------------------------------------------------ values

type Values = Pick<SetEntry, 'weightKg' | 'reps' | 'durationSec' | 'distanceM'>;

export function hasAnyValue(s: Values & Pick<SetEntry, 'sides'>): boolean {
  return hasSideValue(s) || (isSideSet(s) && (hasSideValue(s.sides.left) || hasSideValue(s.sides.right)));
}

/** Undone sets that already have something typed in (they would be lost on finish). */
export function pendingSetCount(exercises: WorkoutExercise[]): number {
  return exercises.reduce((n, we) => n + we.sets.filter((s) => !s.done && hasAnyValue(s)).length, 0);
}

/**
 * Patches that make a set list fit a different exercise type (after Replace Exercise / Switch Variant):
 * values the new type has no column for are cleared (otherwise they'd be saved invisibly), and completed
 * sets that now lack a required value are un-ticked.
 */
export function adaptSetsToType(sets: SetEntry[], fields: TypeFields): { setId: string; patch: Partial<SetEntry> }[] {
  const out: { setId: string; patch: Partial<SetEntry> }[] = [];
  const unused = <T extends Values>(v: T): Partial<Values> => {
    const p: Partial<Values> = {};
    if (!fields.weight && v.weightKg != null) p.weightKg = null;
    if (!fields.reps && v.reps != null) p.reps = null;
    if (!fields.duration && v.durationSec != null) p.durationSec = null;
    if (!fields.distance && v.distanceM != null) p.distanceM = null;
    return p;
  };
  for (const s of sets) {
    const patch: Partial<SetEntry> = unused(s);
    if (isSideSet(s)) {
      const left = unused(s.sides.left);
      const right = unused(s.sides.right);
      if (Object.keys(left).length || Object.keys(right).length) {
        patch.sides = { left: { ...s.sides.left, ...left }, right: { ...s.sides.right, ...right } };
      }
    }
    if (s.done && missingValueMessage(fields, { ...s, ...patch })) patch.done = false;
    if (Object.keys(patch).length) out.push({ setId: s.id, patch });
  }
  return out;
}

/** True when two exercise types log the same columns. */
export function sameFields(a: TypeFields, b: TypeFields): boolean {
  return a.weight === b.weight && a.reps === b.reps && a.duration === b.duration && a.distance === b.distance;
}

// ------------------------------------------------------------------ formatting

/** Compact summary of a set for the PREVIOUS column: "135 lb x 8", "1:00", "1.2 mi | 10:00", "60 lb | 40 yd". */
export function formatSetSummary(
  s: Values,
  type: ExerciseType,
  unit: Unit,
  distanceUnit: DistanceUnit,
): string {
  const f = typeFields(type);
  const w = f.weight && s.weightKg != null ? `${f.weightSign}${formatWeight(s.weightKg, unit)}` : null;
  const t = f.duration && s.durationSec != null ? formatClock(s.durationSec) : null;
  // Carries/sleds read in yd/m ("40 yd"), runs in mi/km.
  const d = f.distance && s.distanceM != null ? formatDistanceForType(s.distanceM, type, distanceUnit) : null;
  if (f.reps) {
    if (s.reps == null) return w ?? '-';
    return w ? `${w} x ${s.reps}` : `${s.reps} reps`;
  }
  const parts = [w, d, t].filter(Boolean);
  return parts.length ? parts.join(' | ') : '-';
}

/**
 * A whole set in one line: a plain set as formatSetSummary, a per-side set as "L 50 lb x 10 · R 50 lb x 9"
 * (one value when both sides match: "L/R 50 lb x 10").
 */
export function formatSetLine(
  s: Values & Pick<SetEntry, 'sides'>,
  type: ExerciseType,
  unit: Unit,
  distanceUnit: DistanceUnit,
): string {
  if (!isSideSet(s)) return formatSetSummary(s, type, unit, distanceUnit);
  return formatSidesLine(s.sides, (v) => formatSetSummary(v, type, unit, distanceUnit));
}

/** Weight (kg) as a short string in the display unit, no unit suffix ("225", "62.5"). */
export function weightText(kg: number | null | undefined, unit: Unit): string {
  const v = displayWeight(kg, unit);
  return v == null ? '' : String(v);
}

/** Distance (m) as a short string in the exercise type's unit, no suffix ("1.25" mi, "40" yd). */
export function distanceText(m: number | null | undefined, type: ExerciseType, unit: DistanceUnit): string {
  const v = displayDistanceAny(m, distanceUnitForType(type, unit));
  return v == null ? '' : String(v);
}

/** Human value for a PR toast/badge ("+45 lb" weighted dip, "40 yd" farmer's walk). */
export function formatPRValue(
  kind: PRKind,
  value: number,
  type: ExerciseType,
  settings: Pick<Settings, 'unit' | 'distanceUnit'>,
): string {
  switch (kind) {
    case 'heaviest_weight':
      return `${typeFields(type).weightSign === '+' ? '+' : ''}${formatWeight(value, settings.unit)}`;
    case 'best_1rm':
      return formatWeight(value, settings.unit);
    case 'best_set_volume':
      return formatVolume(value, settings.unit);
    case 'most_reps':
      return `${value} ${value === 1 ? 'rep' : 'reps'}`;
    case 'longest_duration':
      return formatClock(value);
    case 'longest_distance':
      return formatDistanceForType(value, type, settings.distanceUnit);
  }
}

// ------------------------------------------------------------------ supersets

export interface SupersetColor {
  bar: string;
  text: string;
}

const SUPERSET_PALETTE: SupersetColor[] = [
  { bar: 'bg-accent', text: 'text-accent' },
  { bar: 'bg-drop', text: 'text-drop' },
  { bar: 'bg-gold', text: 'text-gold' },
  { bar: 'bg-success', text: 'text-success' },
  { bar: 'bg-danger', text: 'text-danger' },
  { bar: 'bg-warn', text: 'text-warn' },
];

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** A stable color per superset id (hash-preferred, collisions resolved so supersets never share one). */
export function supersetColors(exercises: WorkoutExercise[]): Map<string, SupersetColor> {
  const map = new Map<string, SupersetColor>();
  const used = new Set<number>();
  const n = SUPERSET_PALETTE.length;
  for (const we of exercises) {
    const sid = we.supersetId;
    if (!sid || map.has(sid)) continue;
    let i = hashString(sid) % n;
    for (let k = 0; k < n && used.has(i); k++) i = (i + 1) % n;
    used.add(i);
    map.set(sid, SUPERSET_PALETTE[i]);
  }
  return map;
}

/** True when another member of the same superset comes later in the list and still has sets to do. */
export function supersetContinues(exercises: WorkoutExercise[], weId: string): boolean {
  const idx = exercises.findIndex((e) => e.id === weId);
  const we = exercises[idx];
  if (!we?.supersetId) return false;
  return exercises.slice(idx + 1).some((e) => e.supersetId === we.supersetId && e.sets.some((s) => !s.done));
}

// ------------------------------------------------------------------ previous session

// The occurrence-aware PREVIOUS lookup lives in lib/calc (the routine editor prefills plain picks with it too).
export { previousInstanceSets } from '../../lib/calc';

/**
 * Last session's set that lines up with each current set: the k-th warm-up with the k-th previous warm-up,
 * the k-th working set (normal/failure/drop together - the last normal set often becomes a failure set) with
 * the k-th previous working set. Unmatched sets get null.
 */
export function alignPreviousSets(sets: SetEntry[], prev: SetEntry[] | null | undefined): (SetEntry | null)[] {
  if (!prev?.length) return sets.map(() => null);
  const warm = (s: SetEntry) => s.type === 'warmup';
  const pw = prev.filter(warm);
  const pn = prev.filter((s) => !warm(s));
  let w = 0;
  let n = 0;
  return sets.map((s) => (warm(s) ? pw[w++] : pn[n++]) ?? null);
}

// ------------------------------------------------------------------ adding exercises

/**
 * Turn picker selections into exercises with planned sets: routine picks bring the routine's sets, notes,
 * rest, superset pairings and their routine slot link; plain picks mirror the previous session as
 * placeholders; otherwise one empty set. A routine pick whose exercise was switched in the picker (e.g. a
 * gym/brand variant created there) keeps the plan's set count, types, reps, time and distance but not its
 * weights: those belong to the routine's machine.
 */
export async function buildExerciseItems(
  picked: PickedExercise[],
  opts: {
    history: Workout[] | undefined;
    previousMode: Settings['previousValues'];
    routineId?: string | null;
    /** Edit mode: new sets start completed. */
    done?: boolean;
    /** Exercises already in the workout (a second Bench instance mirrors last time's second Bench block). */
    existing?: WorkoutExercise[];
  },
): Promise<NewExerciseItem[]> {
  const routines = new Map<string, Routine | undefined>();
  const items: NewExerciseItem[] = [];
  // A fresh superset id per routine superset and add batch, so a repeat add never joins a group added earlier.
  const ssMap = new Map<string, string>();
  const counts = new Map<string, number>();
  for (const e of opts.existing ?? []) counts.set(e.exerciseId, (counts.get(e.exerciseId) ?? 0) + 1);
  for (const p of picked) {
    const occurrence = counts.get(p.exerciseId) ?? 0;
    counts.set(p.exerciseId, occurrence + 1);
    const item: NewExerciseItem = { id: uid(), exerciseId: p.exerciseId };
    if (p.fromRoutine) {
      const rid = p.fromRoutine.routineId;
      if (!routines.has(rid)) routines.set(rid, await db.routines.get(rid));
      const re = routines.get(rid)?.exercises.find((e) => e.id === p.fromRoutine!.routineExerciseId);
      if (re) {
        const sets = re.sets.length ? setsFromRoutineExercise(re) : [newSet()];
        item.sets = p.exerciseId === re.exerciseId ? sets : sets.map(dropWeightTarget);
        item.notes = re.notes;
        item.restSec = re.restSec ?? null;
        item.routineExerciseId = re.id;
        if (re.supersetId) {
          const k = `${rid}:${re.supersetId}`; // keyed by routine too: duplicated routines may share ids
          if (!ssMap.has(k)) ssMap.set(k, uid());
          item.supersetId = ssMap.get(k)!;
        }
      }
    }
    if (!item.sets) {
      const prev = opts.history
        ? previousInstanceSets(opts.history, p.exerciseId, {
            mode: opts.previousMode,
            routineId: opts.routineId,
            occurrence,
          })
        : null;
      item.sets = prev?.length ? setsFromPrevious(prev) : [newSet()];
    }
    if (opts.done) item.sets = item.sets.map((s) => ({ ...s, done: true }));
    items.push(item);
  }
  return items;
}

// ------------------------------------------------------------------ routine update

/**
 * The "Update routine?" question for a plan (lib/routines.ts planRoutineUpdate): what gets saved, which slots
 * change exercise ("Lat Pulldown (Cable) will become Lat Pulldown (Cable) - Hammer Strength.") and which
 * exercises get added.
 */
export function routineUpdateMessage(
  routineName: string,
  plan: Pick<RoutineUpdatePlan, 'swaps' | 'added'>,
  nameOf: (exerciseId: string) => string,
): string {
  const parts = [`Save today's sets and weights to '${routineName}' for next time?`];
  for (const s of plan.swaps) parts.push(`${nameOf(s.from)} will become ${nameOf(s.to)}.`);
  if (plan.added.length) {
    const names = [...new Set(plan.added.map(nameOf))];
    const list = names.length <= 3 ? joinNames(names) : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
    parts.push(`${list} will be added.`);
  }
  parts.push('Exercises you skipped stay in the routine.');
  return parts.join(' ');
}

const joinNames = (names: string[]) =>
  names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

// ------------------------------------------------------------------ dates

/** epoch ms → value for <input type="datetime-local"> (local time). */
export function toLocalInput(ms: number): string {
  return format(ms, "yyyy-MM-dd'T'HH:mm");
}

/** <input type="datetime-local"> value → epoch ms (local time); null when invalid. */
export function fromLocalInput(v: string): number | null {
  if (!v) return null;
  const ms = new Date(v).getTime();
  return Number.isFinite(ms) ? ms : null;
}
