import type { Exercise, SetEntry, WorkoutExercise } from '../types';

/**
 * Calorie estimate using the MET method from the Compendium of Physical Activities:
 *   kcal = MET × body weight (kg) × hours
 *
 * - Cardio sets (exercises with a MET value, or duration/distance exercises on cardio equipment) use that
 *   exercise's MET over the time actually logged in their sets. A set logged with a distance but no time
 *   is timed from the user's own pace in this session's timed sets of that exercise, else a typical speed.
 * - The rest of the session is resistance training. Its MET scales with work density — how many working
 *   sets you got through per hour — from 3.5 (relaxed, long rests; Compendium "moderate effort") up to 6.0
 *   (fast-paced, vigorous). A session with no completed sets counts as light activity (MET 2.0).
 *
 * It is an ESTIMATE (±20-30% is typical even for watches). Users can type their own number on the finish
 * screen (e.g. from a heart-rate watch) and that value is stored instead.
 */

export const DEFAULT_BODYWEIGHT_KG = 75;
const DEFAULT_CARDIO_MET = 7;

export interface CalorieEstimate {
  total: number;
  strength: number;
  cardio: number;
  /** MET used for the resistance-training portion. */
  strengthMet: number;
  strengthSec: number;
  cardioSec: number;
  /** True when no body weight was set and DEFAULT_BODYWEIGHT_KG was assumed. */
  assumedBodyweight: boolean;
}

export function strengthMetForDensity(workingSets: number, strengthSec: number): number {
  if (workingSets <= 0 || strengthSec <= 0) return 2.0;
  const setsPerHour = workingSets / (strengthSec / 3600);
  return Math.min(6.0, Math.max(3.5, 3.5 + (setsPerHour - 15) * 0.1));
}

function isCardio(ex: Exercise): boolean {
  if (ex.met) return true;
  return ex.equipment === 'cardio' && (ex.type === 'duration' || ex.type === 'distance_duration');
}

const DEFAULT_SPEED_MPS = 2.5; // ~9 km/h generic fallback
/** Rough typical speeds (m/s) for catalog cardio; anything else falls back to DEFAULT_SPEED_MPS. */
const DEFAULT_SPEEDS: Record<string, number> = {
  hv_walking: 1.4,
  Walking_Treadmill: 1.4,
  hv_incline_treadmill_walk: 1.3,
  Jogging_Treadmill: 2.2,
  Running_Treadmill: 2.8,
  Trail_Running_Walking: 2.8,
  Bicycling: 5.5,
  Bicycling_Stationary: 6,
  hv_spin_bike: 6,
  Recumbent_Bike: 5.5,
  hv_air_bike: 5.5,
  Rowing_Stationary: 3.7,
  hv_ski_erg: 3.7,
  Elliptical_Trainer: 2.2,
  Skating: 4,
};

/** Pace for distance-only sets: the user's own pace from timed sets of this exercise in this session, else a default. */
function cardioSpeedMps(ex: Exercise, done: SetEntry[]): number {
  let d = 0;
  let t = 0;
  for (const s of done) {
    if (s.distanceM && s.durationSec) {
      d += s.distanceM;
      t += s.durationSec;
    }
  }
  if (d > 0 && t > 0) return d / t;
  // Gym/brand variants ("Treadmill Run – Gym B") use their base exercise's speed.
  return DEFAULT_SPEEDS[ex.id] ?? (ex.variantOf ? DEFAULT_SPEEDS[ex.variantOf] : undefined) ?? DEFAULT_SPEED_MPS;
}

export function estimateCalories(input: {
  durationSec: number;
  bodyweightKg: number | null | undefined;
  exercises: WorkoutExercise[];
  getExercise: (id: string) => Exercise;
}): CalorieEstimate {
  const assumedBodyweight = !input.bodyweightKg;
  const kg = input.bodyweightKg || DEFAULT_BODYWEIGHT_KG;
  const duration = Math.max(0, input.durationSec);

  let cardioSec = 0;
  let cardioKcal = 0;
  let workingSets = 0;
  for (const we of input.exercises) {
    const ex = input.getExercise(we.exerciseId);
    const done = we.sets.filter((s) => s.done);
    if (isCardio(ex)) {
      const speed = cardioSpeedMps(ex, done);
      // `?:` not `??`: a stored time of 0 also falls back to the distance estimate.
      const sec = done.reduce((n, s) => n + (s.durationSec ? s.durationSec : s.distanceM ? s.distanceM / speed : 0), 0);
      cardioSec += sec;
      cardioKcal += (ex.met ?? DEFAULT_CARDIO_MET) * kg * (sec / 3600);
    } else {
      workingSets += done.filter((s) => s.type !== 'warmup').length;
    }
  }
  // Logged cardio time can't exceed the session; scale it down if it does.
  if (cardioSec > duration && cardioSec > 0) {
    cardioKcal *= duration / cardioSec;
    cardioSec = duration;
  }
  const strengthSec = Math.max(0, duration - cardioSec);
  const strengthMet = strengthMetForDensity(workingSets, strengthSec);
  const strength = strengthMet * kg * (strengthSec / 3600);
  return {
    total: Math.round(strength + cardioKcal),
    strength: Math.round(strength),
    cardio: Math.round(cardioKcal),
    strengthMet,
    strengthSec,
    cardioSec,
    assumedBodyweight,
  };
}
