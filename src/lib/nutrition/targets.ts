import type { Settings } from '../../types';
import type { Activity, Body, Goal, NutritionProfile, Pace, Targets } from './types';

/*
 * Daily calorie + macro targets. Ported VERBATIM from SnapPlate (app/lib/profile.ts) including its order of
 * operations — protein/fat are rounded from POUNDS (lb × factor), so a kg-first rewrite would round some
 * values the other way (e.g. 170 lb × 0.35 = 59.4999… → 59, but 77.11 kg × 0.35 / 0.4536 = 59.5 → 60).
 *
 * DISPLAY-ONLY BURN RULE: computeTargets has NO burn input. ACTIVITY_FACTOR already assumes the user's
 * training; logged workouts are shown beside the budget, never added to it (guard.test.ts enforces this).
 */

export const ACTIVITY_FACTOR: Record<Activity, number> = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  active: 1.725,
  very_active: 1.9,
};

export const ACTIVITY_LABEL: Record<Activity, string> = {
  sedentary: 'Sedentary',
  light: 'Lightly active',
  moderate: 'Moderately active',
  active: 'Active',
  very_active: 'Very active',
};

export const ACTIVITY_SUBTITLE: Record<Activity, string> = {
  sedentary: 'Desk job, little exercise',
  light: '1–3 light workouts / week',
  moderate: '3–5 workouts / week',
  active: '6–7 workouts / week',
  very_active: 'Twice-daily, physical job',
};

export const GOAL_LABEL: Record<Goal, string> = { lose: 'Lose weight', maintain: 'Maintain', gain: 'Gain weight' };
export const PACE_LABEL: Record<Pace, string> = { steady: 'Steady', aggressive: 'Aggressive' };

export const KG_PER_LB = 0.45359237;
const kgToLb = (kg: number) => kg / KG_PER_LB;

export const DEFAULT_NUTRITION: NutritionProfile = {
  id: 'profile',
  activity: 'moderate',
  goal: 'maintain',
  pace: 'steady',
  kcalOverride: null,
  proteinOverride: null,
  setupDoneAt: null,
};

/** Mifflin-St Jeor BMR (kcal/day). */
export function bmr(b: Body): number {
  const base = 10 * b.weightKg + 6.25 * b.heightCm - 5 * b.age;
  return b.sex === 'male' ? base + 5 : base - 161;
}

/** Total daily energy expenditure (maintenance). */
export function tdee(b: Body, activity: Activity): number {
  return bmr(b) * ACTIVITY_FACTOR[activity];
}

/**
 * Maintain · Recomp (body recomposition: build muscle and lose fat together): the owner (≈23 % body fat) settled on a
 * small FLAT deficit, the same every day, training or rest (after trying training days at maintenance / rest days
 * −400, then asking for −200 on both). Protein goes to 1 g/lb, as when losing.
 */
export const RECOMP_OFFSET = -200;

/** Recomp drives the calories: Maintain · Recomp. */
export function isRecomp(p: Pick<NutritionProfile, 'goal' | 'recomp'>): boolean {
  return p.goal === 'maintain' && !!p.recomp;
}

/** kcal offset from maintenance for a goal + pace (Maintain · Recomp: RECOMP_OFFSET). */
export function calorieAdjustment(goal: Goal, pace: Pace, recomp = false): number {
  if (goal === 'maintain') return recomp ? RECOMP_OFFSET : 0;
  if (goal === 'lose') return pace === 'aggressive' ? -750 : -400;
  return pace === 'aggressive' ? 500 : 250;
}

/** Targets for a body + nutrition profile. Overrides replace kcal / protein; carbs fill the remainder. */
export function computeTargets(
  p: Pick<NutritionProfile, 'activity' | 'goal' | 'pace' | 'kcalOverride' | 'proteinOverride' | 'recomp'>,
  b: Body,
): Targets {
  const bmrV = bmr(b);
  const tdeeV = bmrV * ACTIVITY_FACTOR[p.activity];
  const recomp = isRecomp(p);
  const computedKcal = Math.round(tdeeV + calorieAdjustment(p.goal, p.pace, recomp));
  const kcal = p.kcalOverride && p.kcalOverride > 0 ? Math.round(p.kcalOverride) : computedKcal;
  const lb = kgToLb(b.weightKg);
  // Higher protein when cutting or recomping, to keep (and build) lean mass; standard intake otherwise.
  const computedProtein = Math.round(p.goal === 'lose' || recomp ? lb * 1.0 : lb * 0.8);
  const proteinG = p.proteinOverride && p.proteinOverride > 0 ? Math.round(p.proteinOverride) : computedProtein;
  const fatG = Math.round(lb * 0.35);
  const carbKcal = Math.max(0, kcal - proteinG * 4 - fatG * 9);
  const carbsG = Math.round(carbKcal / 4);
  // USDA dietary fiber guideline: ~14 g per 1000 kcal.
  const fiberG = Math.round((kcal / 1000) * 14);
  return {
    kcal,
    proteinG,
    carbsG,
    fatG,
    fiberG,
    bmr: Math.round(bmrV),
    tdee: Math.round(tdeeV),
    overridden: kcal !== computedKcal || proteinG !== computedProtein,
  };
}

export type BodyField = 'sex' | 'birthYear' | 'heightCm' | 'bodyweight';

export const BODY_FIELD_LABEL: Record<BodyField, string> = {
  sex: 'Sex',
  birthYear: 'Birth year',
  heightCm: 'Height',
  bodyweight: 'Body weight',
};

/**
 * Build the BMR inputs from Heft's own Settings + current body weight (profile value or newest weigh-in,
 * see lib/settings.ts currentBodyweightKg). Returns the missing fields instead when any are unset.
 * `now` is injected so tests don't depend on the clock.
 */
export function bodyFromSettings(
  s: Pick<Settings, 'sex' | 'birthYear' | 'heightCm'>,
  bodyweightKg: number | null,
  now: number,
): { body: Body; missing: [] } | { body: null; missing: BodyField[] } {
  const missing: BodyField[] = [];
  if (!s.sex) missing.push('sex');
  if (!s.birthYear) missing.push('birthYear');
  if (!s.heightCm) missing.push('heightCm');
  if (!bodyweightKg) missing.push('bodyweight');
  if (missing.length) return { body: null, missing };
  const age = new Date(now).getFullYear() - s.birthYear!;
  return { body: { sex: s.sex!, age, heightCm: s.heightCm!, weightKg: bodyweightKg! }, missing: [] };
}
