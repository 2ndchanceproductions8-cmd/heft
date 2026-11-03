import type { ExerciseType, SetEntry, Settings, Workout } from '../../types';
import {
  compareTopSets,
  estimate1RM,
  isRecordSet,
  setDistanceM,
  setDurationSec,
  setLimbs,
  setReps,
  setVolumeKg,
  topSet,
  type TopSet,
} from '../../lib/calc';
import { formatWeight, kgToUnit } from '../../lib/units';
import { deltaText, topText } from '../workout/ExerciseRecap';

/*
 * The coach review shown after a workout (CoachCard): this session against the last time you did each exercise,
 * and what to do next. Rule-based on purpose: instant, free, offline and works without a Claude key.
 *
 * The rules are the standard ones from strength coaching:
 *  - progress = a heavier top set, or more reps at the same weight (compareTopSets);
 *  - double progression: keep the weight until EVERY working set reaches 12 reps, then add a small step and let the
 *    reps fall back to ~8 (5 lb / 2.5 kg);
 *  - reps first, weight second after a drop; a 10% deload when a lift is stuck for three sessions.
 */

type Units = Pick<Settings, 'unit' | 'distanceUnit'>;
type Ex = (id: string) => { name: string; type: ExerciseType };

export type CoachStatus = 'first' | 'up' | 'same' | 'down' | 'mixed';
export type CoachTone = 'great' | 'good' | 'steady' | 'caution' | 'baseline';

export interface ExerciseCoach {
  exerciseId: string;
  name: string;
  status: CoachStatus;
  today: string;
  /** Last time's top set, null the first time. */
  previous: string | null;
  /** What changed on the first value that differs: "+5 lb", "−2 reps". */
  change: string | null;
  /** This session's total work against last time's, in percent (null when not comparable). */
  workChangePct: number | null;
  stalled: boolean;
  /** What to do next session; null when a later workout already has this exercise. */
  next: string | null;
  /** A left/right gap worth fixing. */
  sideNote: string | null;
}

export interface CoachReview {
  headline: string;
  tone: CoachTone;
  /** Short coach notes for the whole session (records, volume, recovery). */
  notes: string[];
  exercises: ExerciseCoach[];
}

const LB_STEP = 5;
const KG_STEP = 2.5;
const REP_CEILING = 12;
const GOOD_GAP = 0.1; // left/right 1RM gap that counts as an imbalance

const workSets = (w: Workout, exerciseId: string): SetEntry[] =>
  w.exercises.filter((e) => e.exerciseId === exerciseId).flatMap((e) => e.sets.filter(isRecordSet));

/** Total work of a session for one exercise: volume for loaded lifts, else reps, time or distance. */
function totalWork(sets: SetEntry[], type: ExerciseType): number {
  const sum = (f: (s: SetEntry) => number) => sets.reduce((n, s) => n + f(s), 0);
  return sum((s) => setVolumeKg(s, type)) || sum(setReps) || sum(setDurationSec) || sum(setDistanceM);
}

const loadStep = (unit: Settings['unit']) => (unit === 'lb' ? LB_STEP : KG_STEP);
const stepKg = (unit: Settings['unit']) => (unit === 'lb' ? LB_STEP * 0.45359237 : KG_STEP);

/** A load (kg) rounded to the nearest plate step in the user's unit, as text ("150 lb"). */
function loadText(kg: number, unit: Settings['unit']): string {
  const step = loadStep(unit);
  const v = Math.round(kgToUnit(kg, unit) / step) * step;
  return `${v} ${unit}`;
}

/**
 * A load 10% lighter, rounded to the finer 2.5 lb / 1 kg steps (light dumbbells would round a 10% drop back to the
 * same weight at 5 lb) and never equal to the current load.
 */
function deloadText(kg: number, unit: Settings['unit']): string {
  const step = unit === 'lb' ? 2.5 : 1;
  const current = kgToUnit(kg, unit);
  let v = Math.round(kgToUnit(kg * 0.9, unit) / step) * step;
  if (v >= Math.round(current / step) * step) v = Math.round(current / step) * step - step;
  return `${v} ${unit}`;
}

/** The fewest reps in any working set at the top weight: the set that decides whether the weight is "owned". */
function weakestRepsAtTop(sets: SetEntry[], top: TopSet): number {
  const reps = sets
    .flatMap((s) => setLimbs(s).map((l) => l.values))
    .filter((v) => Math.abs((v.weightKg ?? 0) - (top.weightKg ?? 0)) < 1e-6 && (v.reps ?? 0) > 0)
    .map((v) => v.reps ?? 0);
  return reps.length ? Math.min(...reps) : top.reps ?? 0;
}

/** What to do next time, by exercise type (double progression for loaded rep work). */
function nextTarget(
  type: ExerciseType,
  sets: SetEntry[],
  top: TopSet,
  status: CoachStatus,
  stalled: boolean,
  previous: TopSet | null,
  u: Units,
): string {
  switch (type) {
    case 'weight_reps':
    case 'weighted_bodyweight': {
      const weight = top.weightKg ?? 0;
      const sign = type === 'weighted_bodyweight' ? '+' : '';
      const w = (kg: number) => `${sign}${loadText(kg, u.unit)}`;
      const step = `${loadStep(u.unit)} ${u.unit}`;
      if (status === 'down' && previous) {
        return `Match last time first (${topText(previous, type, u)}). Win the reps back before you add weight.`;
      }
      if (stalled && weight > 0) {
        return `Stuck for 3 sessions. Drop to ${sign}${deloadText(weight, u.unit)} for a week, hit clean reps, then build back up. Or switch the rep range (6-8 to 10-12).`;
      }
      const min = weakestRepsAtTop(sets, top);
      if (min >= REP_CEILING) return `Every set hit ${REP_CEILING}+. Add ${step}: ${w(weight + stepKg(u.unit))}. Expect ~8-10 reps, then build back to ${REP_CEILING}.`;
      if (min >= 8) return `Stay at ${w(weight)} and aim for ${min + 1} reps on every set. At ${REP_CEILING} on every set, add ${step}.`;
      if (min >= 5) return `Stay at ${w(weight)} and build to 8 reps on every set, then add ${step}.`;
      return `Stay at ${w(weight)} and add a rep each set. Get all sets to 5, then to 8, then add ${step}.`;
    }
    case 'bodyweight_reps': {
      const min = Math.min(...sets.map(setReps).filter((r) => r > 0), top.reps ?? 0);
      return min >= 20
        ? 'Over 20 clean reps is your cue to progress: add weight or move to a harder variation.'
        : `Add 1-2 reps on every set. At 20 clean reps, make it harder.`;
    }
    case 'assisted_bodyweight':
      return `Add 1 rep on every set. When every set hits ${REP_CEILING}, use ${loadStep(u.unit)} ${u.unit} less assistance.`;
    case 'duration':
      return 'Add 5-10 seconds to your best hold, or add a set.';
    case 'distance_duration':
      return 'Beat today by a little distance at the same pace, or hold the distance and cut the time.';
    case 'duration_weight':
    case 'weight_distance':
      return `Keep ${top.weightKg != null ? loadText(top.weightKg, u.unit) : 'the load'} and add a little time or distance. Add weight only when it feels easy.`;
  }
}

/** A left vs right gap worth fixing, from today's per-side sets. */
function sideNote(name: string, sets: SetEntry[], type: ExerciseType): string | null {
  const best = { left: 0, right: 0 };
  for (const s of sets) {
    if (!s.sides) continue;
    (['left', 'right'] as const).forEach((k) => {
      const v = s.sides![k];
      best[k] = Math.max(best[k], type === 'weight_reps' || type === 'weighted_bodyweight' ? estimate1RM(v.weightKg, v.reps) : v.reps ?? 0);
    });
  }
  const hi = Math.max(best.left, best.right);
  if (!hi) return null;
  const gap = (hi - Math.min(best.left, best.right)) / hi;
  if (gap < GOOD_GAP) return null;
  const weak = best.left < best.right ? 'left' : 'right';
  return `Your ${weak} side is ${Math.round(gap * 100)}% behind on ${name}. Start with the ${weak} side and give the stronger side only the reps the ${weak} manages.`;
}

/**
 * The review of `workout` against `before` (workouts that started earlier, newest first). `laterIds` holds the
 * exercise ids of any LATER workout: a "next time" target is only worth giving for an exercise with none.
 */
export function coachReview(workout: Workout, before: Workout[], laterIds: ReadonlySet<string>, ex: Ex, u: Units): CoachReview {
  const exercises: ExerciseCoach[] = [];
  const seen = new Set<string>();
  for (const we of workout.exercises) {
    if (seen.has(we.exerciseId)) continue;
    seen.add(we.exerciseId);
    const { name, type } = ex(we.exerciseId);
    const sets = workSets(workout, we.exerciseId);
    const today = topSet(sets, type);
    if (!today) continue;

    // The sessions of this exercise before today, newest first.
    const past = before
      .map((w) => ({ w, sets: workSets(w, we.exerciseId) }))
      .filter((p) => p.sets.length)
      .map((p) => ({ ...p, top: topSet(p.sets, type) }))
      .filter((p): p is { w: Workout; sets: SetEntry[]; top: TopSet } => !!p.top);
    const last = past[0];

    let status: CoachStatus = 'first';
    let workChangePct: number | null = null;
    if (last) {
      const cmp = compareTopSets(today, last.top, type);
      const prevWork = totalWork(last.sets, type);
      workChangePct = prevWork > 0 ? Math.round(((totalWork(sets, type) - prevWork) / prevWork) * 100) : null;
      status = cmp > 0 ? 'up' : cmp === 0 ? 'same' : (workChangePct ?? 0) >= 5 ? 'mixed' : 'down';
    }
    // Not better than either of the last two sessions: three in a row with no progress.
    const stalled =
      past.length >= 2 && compareTopSets(today, past[0].top, type) <= 0 && compareTopSets(past[0].top, past[1].top, type) <= 0 && compareTopSets(today, past[1].top, type) <= 0;

    exercises.push({
      exerciseId: we.exerciseId,
      name,
      status,
      today: topText(today, type, u),
      previous: last ? topText(last.top, type, u) : null,
      change: last && status !== 'same' ? deltaText(today, last.top, type, u) : null,
      workChangePct,
      stalled,
      next: laterIds.has(we.exerciseId) ? null : nextTarget(type, sets, today, status, stalled, last?.top ?? null, u),
      sideNote: sideNote(name, sets, type),
    });
  }

  const count = (s: CoachStatus) => exercises.filter((e) => e.status === s).length;
  const up = count('up');
  const down = count('down');
  const same = count('same');
  const mixed = count('mixed');
  const compared = up + down + same + mixed;
  const prs = workout.prs?.length ?? 0;

  let tone: CoachTone;
  let headline: string;
  if (!exercises.length) {
    tone = 'steady';
    headline = 'No sets logged, so there is nothing to review yet.';
  } else if (!compared) {
    tone = 'baseline';
    headline = 'First session on record. Today is your baseline, so beat it next time.';
  } else if (up > 0 && down === 0) {
    tone = 'great';
    headline = `Strong session. You progressed on ${up} of ${compared} lifts and went backwards on none.`;
  } else if (up > down) {
    tone = 'good';
    headline = `Good session. Up on ${up}, down on ${down}. The wins outweigh the dips.`;
  } else if (up === 0 && down === 0) {
    tone = 'steady';
    headline = `Steady session. You matched last time on ${compared} ${compared === 1 ? 'lift' : 'lifts'}. Next time, push one rep or one step.`;
  } else if (up === down) {
    tone = 'steady';
    headline = `Mixed session. Up on ${up}, down on ${down}. Keep the plan and look at what dipped.`;
  } else {
    tone = 'caution';
    headline = `Off day: down on ${down} ${down === 1 ? 'lift' : 'lifts'}, up on ${up}. One session is noise, not a trend.`;
  }

  const notes: string[] = [];
  if (prs > 0) notes.push(`${prs} new ${prs === 1 ? 'record' : 'records'} in this workout.`);

  // Volume against the newest earlier workout that shares at least half of today's exercises.
  const ids = new Set(exercises.map((e) => e.exerciseId));
  const twin = before.find((w) => {
    const shared = [...ids].filter((id) => w.exercises.some((e) => e.exerciseId === id)).length;
    return shared >= Math.max(1, Math.ceil(ids.size / 2));
  });
  if (twin) {
    // Like for like: only the lifts BOTH workouts contain, counted from their sets (a short session must not read as
    // "down 49%" against a long one).
    const shared = [...ids].filter((id) => twin.exercises.some((e) => e.exerciseId === id));
    const volume = (w: Workout) => shared.reduce((n, id) => n + workSets(w, id).reduce((v, s) => v + setVolumeKg(s, ex(id).type), 0), 0);
    const now = volume(workout);
    const then = volume(twin);
    if (now > 0 && then > 0) {
      const pct = Math.round(((now - then) / then) * 100);
      const label = twin.name || 'similar workout';
      notes.push(
        Math.abs(pct) < 2
          ? `Volume on these lifts matched your last ${label} (${formatWeight(now, u.unit)}).`
          : `Volume on these lifts is ${pct > 0 ? 'up' : 'down'} ${Math.abs(pct)}% on your last ${label} (${formatWeight(now, u.unit)}).`,
      );
    }
  }
  if (down >= 2 || (down > up && down > 0)) {
    notes.push('When several lifts dip at once it is usually sleep, food or stress, not lost strength. Eat enough, sleep 7-9 hours, and repeat these weights next time.');
  }
  const stuck = exercises.filter((e) => e.stalled).map((e) => e.name);
  if (stuck.length) notes.push(`Stuck for 3 sessions: ${stuck.join(', ')}. A short deload usually breaks a plateau.`);

  return { headline, tone, notes, exercises };
}
