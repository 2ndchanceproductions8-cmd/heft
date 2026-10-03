import { describe, expect, it } from 'vitest';
import { bmr, bodyFromSettings, calorieAdjustment, computeTargets, DEFAULT_NUTRITION, KG_PER_LB, tdee } from './targets';
import type { Body } from './types';

// SnapPlate's default profile: male, 30, 5'10" (177.8 cm), 170 lb, moderately active.
const BODY: Body = { sex: 'male', age: 30, heightCm: 177.8, weightKg: 170 * KG_PER_LB };
const NOW = new Date(2026, 9, 3).getTime();

describe('BMR / TDEE (Mifflin-St Jeor, ported from SnapPlate)', () => {
  it('matches SnapPlate on its default profile', () => {
    expect(Math.round(bmr(BODY))).toBe(1737);
    expect(Math.round(tdee(BODY, 'moderate'))).toBe(2693);
  });

  it('female offset is -161 instead of +5', () => {
    expect(bmr({ ...BODY, sex: 'female' })).toBeCloseTo(bmr(BODY) - 166, 6);
  });

  it('goal offsets', () => {
    expect(calorieAdjustment('maintain', 'aggressive')).toBe(0);
    expect(calorieAdjustment('lose', 'steady')).toBe(-400);
    expect(calorieAdjustment('lose', 'aggressive')).toBe(-750);
    expect(calorieAdjustment('gain', 'steady')).toBe(250);
    expect(calorieAdjustment('gain', 'aggressive')).toBe(500);
  });
});

describe('computeTargets', () => {
  it('maintain: 2693 kcal / P136 / F59 / C405 / fiber 38 (lb-first rounding, like SnapPlate)', () => {
    // 170 lb × 0.35 = 59.4999… → 59 in JS; a kg-first port would give 60 and C402.
    const t = computeTargets(DEFAULT_NUTRITION, BODY);
    expect(t).toMatchObject({ kcal: 2693, proteinG: 136, fatG: 59, carbsG: 405, fiberG: 38, bmr: 1737, tdee: 2693, overridden: false });
  });

  it('lose / steady: 2293 kcal, protein 1 g per lb', () => {
    const t = computeTargets({ ...DEFAULT_NUTRITION, goal: 'lose' }, BODY);
    expect(t.kcal).toBe(2293);
    expect(t.proteinG).toBe(170);
    expect(t.fatG).toBe(59);
    // (2293 − 680 − 531) / 4 = 270.5 → Math.round → 271
    expect(t.carbsG).toBe(271);
  });

  it('overrides replace kcal / protein and carbs fill the rest', () => {
    const t = computeTargets({ ...DEFAULT_NUTRITION, kcalOverride: 2000, proteinOverride: 180 }, BODY);
    expect(t.kcal).toBe(2000);
    expect(t.proteinG).toBe(180);
    expect(t.carbsG).toBe(Math.round((2000 - 180 * 4 - 59 * 9) / 4));
    expect(t.overridden).toBe(true);
  });

  it('carbs never go negative', () => {
    const t = computeTargets({ ...DEFAULT_NUTRITION, kcalOverride: 900 }, BODY);
    expect(t.carbsG).toBe(0);
  });
});

describe('bodyFromSettings', () => {
  it('builds a body from Heft settings + bodyweight, age from birth year at `now`', () => {
    const r = bodyFromSettings({ sex: 'male', birthYear: 1996, heightCm: 177.8 }, 77.1, NOW);
    expect(r.missing).toEqual([]);
    expect(r.body).toEqual({ sex: 'male', age: 30, heightCm: 177.8, weightKg: 77.1 });
  });

  it('lists every missing field', () => {
    const r = bodyFromSettings({ sex: null, birthYear: null, heightCm: 180 }, null, NOW);
    expect(r.body).toBeNull();
    expect(r.missing).toEqual(['sex', 'birthYear', 'bodyweight']);
  });
});
