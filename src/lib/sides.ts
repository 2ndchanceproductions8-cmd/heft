import type { ExerciseType, SetEntry, SetSides, SetTarget, Side, SideValues } from '../types';
import { estimate1RM, isSideSet, sideMetricFor } from './calc';

/*
 * Per-side sets: single-arm / single-leg work logged as one set with a LEFT and a RIGHT value, so each limb's
 * strength can be compared (the exercise detail's Left vs Right card).
 *
 * A set is per-side when it carries `sides` (calc.ts isSideSet). `sides` is the source of truth; the set's
 * top-level values mirror its better side (`syncSideSet`), so code that reads a set as a single value sees its
 * strongest side. Totals and records read every limb through calc.ts `setLimbs`.
 *
 * Whether NEW sets of an exercise are per-side is the exercise's `perSide` (ExerciseOverride.perSide, default
 * `defaultPerSide`). The logger splits a plain set the first time a side is edited or the set is ticked, so
 * routine plans and earlier sessions (plain sets) feed per-side sets with no conversion step.
 */

export const SIDES: readonly Side[] = ['left', 'right'];
export const SIDE_LETTER: Record<Side, string> = { left: 'L', right: 'R' };
export const SIDE_LABEL: Record<Side, string> = { left: 'Left', right: 'Right' };

/** Just the four values (nulls for missing ones). */
export function valuesOf(v: SideValues | null | undefined): Required<SideValues> {
  return {
    weightKg: v?.weightKg ?? null,
    reps: v?.reps ?? null,
    durationSec: v?.durationSec ?? null,
    distanceM: v?.distanceM ?? null,
  };
}

export function hasSideValue(v: SideValues | null | undefined): boolean {
  return v?.weightKg != null || v?.reps != null || v?.durationSec != null || v?.distanceM != null;
}

/** Sort keys for "stronger": the type's own metric first (assisted machines: less help is stronger), then the rest. */
function strengthKeys(v: SideValues, type: ExerciseType): number[] {
  const w = v.weightKg ?? 0;
  const r = v.reps ?? 0;
  const t = v.durationSec ?? 0;
  const d = v.distanceM ?? 0;
  switch (sideMetricFor(type)) {
    case 'best1RM':
    case 'heaviestKg':
      return [estimate1RM(w, r), w, r, t, d];
    case 'maxReps':
      return type === 'assisted_bodyweight' ? [r, -w] : [r, w];
    case 'maxDuration':
      return [t, w, d, r];
    case 'maxDistance':
      return [d, w, t, r];
  }
}

/** The stronger side of a per-side set (ties go left). */
export function betterSide(sides: SetSides, type: ExerciseType = 'weight_reps'): Side {
  const a = strengthKeys(sides.left, type);
  const b = strengthKeys(sides.right, type);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 'left' : 'right';
  return 'left';
}

/** Recompute a per-side set's mirror (its top-level values = its better side). A plain set is returned as is. */
export function syncSideSet<T extends SetEntry>(s: T, type?: ExerciseType): T {
  if (!isSideSet(s)) return s;
  return { ...s, ...valuesOf(s.sides[betterSide(s.sides, type)]) };
}

function splitSides(v: SideValues): SetSides {
  return { left: valuesOf(v), right: valuesOf(v) };
}

/** A plain set made per-side: both sides start from its values (a plain "50 lb x 10" meant each side). */
export function splitSet(s: SetEntry, type?: ExerciseType): SetEntry {
  if (isSideSet(s)) return s;
  return syncSideSet({ ...s, sides: splitSides(s) }, type);
}

/** A per-side set made plain again: it keeps its better side's values. */
export function joinSet(s: SetEntry, type?: ExerciseType): SetEntry {
  if (!isSideSet(s)) return s;
  const { sides: _sides, ...plain } = syncSideSet(s, type);
  return plain;
}

/** True when joining would lose information (the two sides differ). */
export function sidesDiffer(s: SetEntry): boolean {
  if (!isSideSet(s)) return false;
  const a = valuesOf(s.sides.left);
  const b = valuesOf(s.sides.right);
  return a.weightKg !== b.weightKg || a.reps !== b.reps || a.durationSec !== b.durationSec || a.distanceM !== b.distanceM;
}

/** The set with one side patched (a plain set is split first, so the other side keeps the shared values). */
export function patchSide(s: SetEntry, side: Side, patch: SideValues, type?: ExerciseType): SetEntry {
  const sides = isSideSet(s) ? s.sides : splitSides(s);
  return syncSideSet({ ...s, sides: { ...sides, [side]: { ...valuesOf(sides[side]), ...patch } } }, type);
}

/** One side's values of a set: its own side, or the plain values (which applied to each side). */
export function sideOf(s: SetEntry | null | undefined, side: Side): SideValues | null {
  if (!s) return null;
  return isSideSet(s) ? s.sides[side] : s;
}

/** One side's planned values: its own (last session's left/right), else the plain plan (incl. a rep range). */
export function sideTarget(t: SetTarget | null | undefined, side: Side): SetTarget | null {
  if (!t) return null;
  return t.sides?.[side] ?? t;
}

/** A per-side set as one line from a per-limb formatter: "L 50 lb x 10 · R 50 lb x 9", or "L/R 50 lb x 10" when equal. */
export function formatSidesLine(sides: SetSides, fmt: (v: SideValues) => string): string {
  const l = fmt(sides.left);
  const r = fmt(sides.right);
  return l === r ? `L/R ${l}` : `L ${l} · R ${r}`;
}

// ------------------------------------------------------------------ which exercises are one-sided

const ONE_SIDED =
  /\b(single|one)[- ](arm|leg|legged|handed)\b|\biso[- ]?lateral\b|\bunilateral\b|\bconcentration curl\b|\bsplit squat\b|\blunges?\b|\bstep[- ]?ups?\b|\bpistol\b|\bside (plank|bridge)\b|\bsuitcase\b/i;
// Named like one-sided work but done with both sides together.
const NOT_ONE_SIDED = /lunge pass through|push[- ]?up to side plank|concentration curl \(barbell\)/i;

/**
 * Default for catalog exercises, and the custom exercise form's suggestion while a name is typed: one-sided movements
 * by name (Single Arm Row, Iso-Lateral Row, Bulgarian Split Squat, Lunge, Side Plank...).
 */
export function defaultPerSide(name: string): boolean {
  return ONE_SIDED.test(name) && !NOT_ONE_SIDED.test(name);
}
