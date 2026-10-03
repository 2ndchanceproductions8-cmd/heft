import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../db';
import { buildBackup, exportBackup, importBackup, parseBackup } from '../backup';
import { createMeal, updateNutritionProfile, upsertFood } from './store';
import type { MealItem } from './types';

const AT = new Date(2026, 9, 3, 12, 0).getTime();
const jpeg = (b: number) => new Blob([new Uint8Array([0xff, 0xd8, b])], { type: 'image/jpeg' });
const item: MealItem = {
  id: 'i1',
  name: 'Rice',
  portion: '',
  grams: 200,
  baselineGrams: 200,
  per100g: { kcal: 130, proteinG: 2.7, carbsG: 28, fatG: 0.3, fiberG: 0.4, sugarG: 0.1, sodiumMg: 1 },
  fixed: null,
  source: 'usda',
};

async function seedFood() {
  await db.media.put({ id: 'm_meal', blob: jpeg(1), type: 'image/jpeg', createdAt: AT });
  const meal = await createMeal({ input: { kind: 'photo' }, at: AT, status: 'done', items: [item], photoIds: ['m_meal'] }, AT);
  await upsertFood({ id: 'usda:1', name: 'Rice', source: 'usda', fdcId: 1, per100g: item.per100g!, servingG: null }, AT);
  await updateNutritionProfile({ goal: 'lose', kcalOverride: 2100 });
  return meal;
}

beforeEach(async () => {
  await db.transaction('rw', db.tables, async () => {
    await Promise.all(db.tables.map((t) => t.clear()));
  });
});

describe('backup v2 — food data', () => {
  it('round-trips meals, foods, targets and meal photos', async () => {
    const meal = await seedFood();
    const text = await (await exportBackup()).text();
    expect(parseBackup(text).version).toBe(2);

    await db.transaction('rw', db.tables, async () => {
      await Promise.all(db.tables.map((t) => t.clear()));
    });
    const counts = await importBackup(text);
    expect(counts).toMatchObject({ meals: 1, foods: 1, media: 1 });
    expect(await db.meals.get(meal.id)).toMatchObject({ day: '2026-10-03', photoIds: ['m_meal'] });
    expect((await db.meals.get(meal.id))!.totals.kcal).toBeCloseTo(260, 6);
    expect(await db.foods.get('usda:1')).toMatchObject({ name: 'Rice' });
    expect(await db.nutrition.get('profile')).toMatchObject({ goal: 'lose', kcalOverride: 2100 });
    expect(await db.media.get('m_meal')).toBeTruthy();
  });

  it('never contains API keys', async () => {
    await seedFood();
    const b = await buildBackup();
    expect(JSON.stringify(b)).not.toMatch(/sk-ant-|heft-key/);
  });

  it('restoring a version-1 (pre-Food) backup keeps the food log AND the photos its meals use', async () => {
    // A v1 file made on another day: one workout photo, no food keys at all.
    const v1 = {
      app: 'heft',
      version: 1,
      exportedAt: AT,
      data: {
        workouts: [],
        routines: [],
        folders: [],
        customExercises: [],
        overrides: [],
        measurements: [{ id: 'meas', date: AT, bodyweightKg: 80, photoIds: ['m_w'] }],
        settings: null,
        active: null,
        media: [{ id: 'm_w', type: 'image/jpeg', createdAt: AT, dataUrl: 'data:image/jpeg;base64,/9gC' }],
      },
    };
    const meal = await seedFood();
    await db.media.put({ id: 'm_stray', blob: jpeg(9), type: 'image/jpeg', createdAt: AT });

    const counts = await importBackup(JSON.stringify(v1));
    expect(counts).toMatchObject({ measurements: 1, media: 1, meals: 0, foods: 0 });
    expect(await db.meals.get(meal.id)).toBeTruthy();
    expect(await db.foods.count()).toBe(1);
    expect(await db.nutrition.get('profile')).toMatchObject({ goal: 'lose' });
    expect(await db.media.get('m_meal')).toBeTruthy(); // the kept meal's photo survived
    expect(await db.media.get('m_w')).toBeTruthy(); // the backup's photo was restored
    expect(await db.media.get('m_stray')).toBeUndefined(); // everything else was replaced
  });

  it('a version-2 restore replaces the food log too', async () => {
    await seedFood();
    const empty = { app: 'heft', version: 2, exportedAt: AT, data: { meals: [], foods: [], nutrition: null } };
    await importBackup(JSON.stringify(empty));
    expect(await db.meals.count()).toBe(0);
    expect(await db.foods.count()).toBe(0);
  });

  it('rejects damaged meals and files from a newer app', async () => {
    const bad = { app: 'heft', version: 2, exportedAt: AT, data: { meals: [{ id: 'x' }] } };
    expect(() => parseBackup(JSON.stringify(bad))).toThrow(/meal #1/);
    expect(() => parseBackup(JSON.stringify({ ...bad, version: 3, data: {} }))).toThrow(/newer version/);
  });
});
