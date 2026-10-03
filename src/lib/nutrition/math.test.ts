import { describe, expect, it } from 'vitest';
import {
  clampServes,
  dayKey,
  dayStart,
  itemNutrients,
  macroG,
  mealTotals,
  per100gFromEstimate,
  atForDay,
  recomputeMeal,
  remaining,
  shiftDay,
  sumMeals,
} from './math';
import type { Meal, MealItem, Per100g } from './types';

const RICE: Per100g = { kcal: 130, proteinG: 2.7, carbsG: 28, fatG: 0.3, fiberG: 0.4, sugarG: 0.1, sodiumMg: 1 };
const NUTELLA: Per100g = { kcal: 539, proteinG: 6.3, carbsG: 57.5, fatG: 30.9, fiberG: null, sugarG: 56.3, sodiumMg: 43 };

const item = (p: Partial<MealItem>): MealItem => ({
  id: 'i',
  name: 'x',
  portion: '',
  grams: 100,
  baselineGrams: 100,
  per100g: RICE,
  fixed: null,
  source: 'usda',
  ...p,
});

const meal = (p: Partial<Meal>): Meal => ({
  id: 'm',
  at: new Date(2026, 9, 3, 12, 30).getTime(),
  day: '',
  title: 'Lunch',
  status: 'done',
  statusAt: 0,
  error: null,
  input: { kind: 'photo' },
  photoIds: [],
  serves: 1,
  items: [],
  totals: { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0, fiberG: 0, sugarG: 0, sodiumMg: 0 },
  confidence: null,
  scaleReference: null,
  notes: '',
  angles: 0,
  aiCalls: [],
  createdAt: 0,
  updatedAt: 0,
  ...p,
});

describe('item and meal nutrients', () => {
  it('scales per100g × grams/100 × serves', () => {
    const n = itemNutrients(item({ grams: 150 }), 2);
    expect(n.kcal).toBeCloseTo(130 * 1.5 * 2, 6);
    expect(n.proteinG).toBeCloseTo(2.7 * 3, 6);
  });

  it('Nutella 37 g ≈ 199 kcal, 74 g (serves 2) ≈ 399 kcal; unknown fiber counts as 0', () => {
    const it37 = item({ grams: 37, per100g: NUTELLA, source: 'off' });
    expect(Math.round(itemNutrients(it37, 1).kcal)).toBe(199);
    expect(Math.round(itemNutrients(it37, 2).kcal)).toBe(399);
    expect(itemNutrients(it37, 1).fiberG).toBe(0);
  });

  it('fixed (quick-add) items ignore grams but still multiply by serves', () => {
    const q = item({ grams: null, per100g: null, fixed: { kcal: 250, proteinG: 20, carbsG: 10, fatG: 5, fiberG: 0, sugarG: 0, sodiumMg: 0 } });
    expect(itemNutrients(q, 1).kcal).toBe(250);
    expect(itemNutrients(q, 3).kcal).toBe(750);
  });

  it('sums all items', () => {
    const t = mealTotals([item({ grams: 200 }), item({ id: 'b', grams: 37, per100g: NUTELLA })], 1);
    expect(t.kcal).toBeCloseTo(260 + 199.43, 6);
  });

  it('clamps serves to 1..20 integers', () => {
    expect(clampServes(0)).toBe(1);
    expect(clampServes(-3)).toBe(1);
    expect(clampServes(2.4)).toBe(2);
    expect(clampServes(99)).toBe(20);
    expect(clampServes(null)).toBe(1);
  });
});

describe('recomputeMeal / sumMeals', () => {
  it('derives day and totals from at + items', () => {
    const m = recomputeMeal(meal({ items: [item({ grams: 200 })], serves: 2 }));
    expect(m.day).toBe('2026-10-03');
    expect(m.totals.kcal).toBeCloseTo(520, 6);
  });

  it('only done meals count toward the day', () => {
    const done = recomputeMeal(meal({ items: [item({ grams: 100 })] }));
    const others = (['draft', 'pending', 'analyzing', 'failed'] as const).map((status) =>
      recomputeMeal(meal({ status, items: [item({ grams: 500 })] })),
    );
    expect(sumMeals([done, ...others]).kcal).toBeCloseTo(130, 6);
  });
});

describe('remaining (display-only burn rule)', () => {
  it('is target minus eaten — exactly two inputs', () => {
    expect(remaining(2693, 1200)).toBe(1493);
    expect(remaining(2000, 2150)).toBe(-150);
    expect(remaining.length).toBe(2);
  });
});

describe('per100gFromEstimate', () => {
  it('turns a whole-item estimate into per-100 g values', () => {
    const p = per100gFromEstimate({ kcal: 300, proteinG: 30, carbsG: 0, fatG: 15, fiberG: 0, sugarG: null }, 150);
    expect(p.kcal).toBeCloseTo(200, 6);
    expect(p.proteinG).toBeCloseTo(20, 6);
    expect(p.sugarG).toBeNull();
  });

  it('treats a missing weight as 100 g', () => {
    expect(per100gFromEstimate({ kcal: 90, proteinG: 1, carbsG: 2, fatG: 3 }, 0).kcal).toBe(90);
  });
});

describe('days', () => {
  it('day keys are local calendar days', () => {
    expect(dayKey(new Date(2026, 0, 5, 23, 59).getTime())).toBe('2026-01-05');
    expect(dayStart('2026-01-05')).toBe(new Date(2026, 0, 5).getTime());
    expect(Number.isNaN(dayStart('junk'))).toBe(true);
  });

  it('shiftDay walks calendar days across month/year ends', () => {
    expect(shiftDay('2026-12-31', 1)).toBe('2027-01-01');
    expect(shiftDay('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('macroG shows a decimal only under 10 g', () => {
    expect(macroG(6.34)).toBe('6.3');
    expect(macroG(30.9)).toBe('31');
  });
});

describe('atForDay', () => {
  it('today → now; another day → that day at the same wall-clock time', () => {
    const now = new Date(2026, 9, 3, 19, 45, 10).getTime();
    expect(atForDay('2026-10-03', now)).toBe(now);
    expect(atForDay(null, now)).toBe(now);
    const t = new Date(atForDay('2026-09-29', now));
    expect([t.getFullYear(), t.getMonth(), t.getDate(), t.getHours(), t.getMinutes()]).toEqual([2026, 8, 29, 19, 45]);
  });

  it('DST days keep the day and the wall-clock hour (US spring-forward / fall-back)', () => {
    const late = new Date(2026, 2, 10, 23, 30).getTime();
    expect(dayKey(atForDay('2026-03-08', late))).toBe('2026-03-08');
    expect(new Date(atForDay('2026-03-08', late)).getHours()).toBe(23);
    const ten = new Date(2026, 10, 5, 10, 0).getTime();
    expect(new Date(atForDay('2026-11-01', ten)).getHours()).toBe(10);
  });

  it('junk day → now', () => {
    expect(atForDay('yesterday', 5)).toBe(5);
  });
});

describe('recomputeMeal day handling', () => {
  it('keeps a valid stored day unless asked to re-derive (no silent day moves after travel)', () => {
    const m = meal({ day: '2026-10-02', items: [item({ grams: 100 })] });
    expect(recomputeMeal(m).day).toBe('2026-10-02');
    expect(recomputeMeal(m, { rederiveDay: true }).day).toBe('2026-10-03');
  });
});
