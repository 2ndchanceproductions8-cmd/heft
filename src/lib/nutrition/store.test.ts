import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import Dexie from 'dexie';
import { db, HeftDB } from '../../db';
import { DEFAULT_SETTINGS } from '../settings';
import {
  createMeal,
  deleteMeal,
  foodByBarcode,
  loadAiSpend,
  recordSpend,
  loadTargets,
  MealBusyError,
  updateItem,
  updateMeal,
  updateNutritionProfile,
  upsertFood,
} from './store';
import { loadDayBurn } from './burn';
import { remaining, sumMeals } from './math';
import type { FoodChoice, MealItem, Per100g } from './types';

const RICE: Per100g = { kcal: 130, proteinG: 2.7, carbsG: 28, fatG: 0.3, fiberG: 0.4, sugarG: 0.1, sodiumMg: 1 };
const item = (id: string, grams: number): MealItem => ({
  id,
  name: 'Rice',
  portion: '1 cup',
  grams,
  baselineGrams: grams,
  per100g: RICE,
  fixed: null,
  source: 'usda',
});
const AT = new Date(2026, 9, 3, 12, 0).getTime();

beforeEach(async () => {
  await db.transaction('rw', db.tables, async () => {
    await Promise.all(db.tables.map((t) => t.clear()));
  });
});

describe('meal store', () => {
  it('createMeal derives day + totals; updateMeal recomputes on every write', async () => {
    const m = await createMeal({ input: { kind: 'photo' }, at: AT, status: 'done', items: [item('a', 200)] }, AT);
    expect(m.day).toBe('2026-10-03');
    expect(m.totals.kcal).toBeCloseTo(260, 6);
    const next = await updateItem(m.id, 'a', { grams: 100 });
    expect(next!.totals.kcal).toBeCloseTo(130, 6);
    const twice = await updateMeal(m.id, { serves: 2 });
    expect(twice!.totals.kcal).toBeCloseTo(260, 6);
  });

  it('a status change stamps statusAt', async () => {
    const m = await createMeal({ input: { kind: 'photo' } }, 1000);
    const next = await updateMeal(m.id, { status: 'pending' }, { now: 5000 });
    expect(next!.statusAt).toBe(5000);
    const same = await updateMeal(m.id, { title: 'x' }, { now: 9000 });
    expect(same!.statusAt).toBe(5000);
  });

  it('refuses UI writes while analyzing (only the pipeline may force)', async () => {
    const m = await createMeal({ input: { kind: 'photo' }, status: 'analyzing' });
    await expect(updateMeal(m.id, { title: 'stale edit' })).rejects.toBeInstanceOf(MealBusyError);
    const forced = await updateMeal(m.id, { status: 'done' }, { force: true });
    expect(forced!.status).toBe('done');
  });

  it('updateMeal on a deleted meal returns null', async () => {
    expect(await updateMeal('nope', { title: 'x' })).toBeNull();
  });

  it('deleteMeal removes its photos', async () => {
    await db.media.put({ id: 'm_1', blob: new Blob([new Uint8Array([1])], { type: 'image/jpeg' }), type: 'image/jpeg', createdAt: 0 });
    const m = await createMeal({ input: { kind: 'photo' }, photoIds: ['m_1'] });
    await deleteMeal(m.id);
    expect(await db.meals.get(m.id)).toBeUndefined();
    expect(await db.media.get('m_1')).toBeUndefined();
  });
});

describe('food library', () => {
  const nutella: FoodChoice = {
    id: 'off:3017624010701',
    name: 'Nutella',
    brand: 'Ferrero',
    source: 'off',
    barcode: '3017624010701',
    per100g: { kcal: 539, proteinG: 6.3, carbsG: 57.5, fatG: 30.9, fiberG: null, sugarG: 56.3, sodiumMg: 43 },
    servingG: 15,
  };
  it('upsert bumps use count and caches barcodes', async () => {
    await upsertFood(nutella, 1);
    const f = await upsertFood(nutella, 2);
    expect(f.useCount).toBe(2);
    expect(f.lastUsedAt).toBe(2);
    expect((await foodByBarcode('3017624010701'))?.name).toBe('Nutella');
  });
});

describe('targets from Heft settings', () => {
  it('missing body data → no targets, and lists what is missing', async () => {
    const t = await loadTargets(AT);
    expect(t.targets).toBeNull();
    expect(t.missing).toEqual(['sex', 'birthYear', 'heightCm', 'bodyweight']);
  });

  it('uses the newest weigh-in and the nutrition profile', async () => {
    await db.settings.put({ ...DEFAULT_SETTINGS, sex: 'male', birthYear: 1996, heightCm: 177.8, bodyweightKg: 90, bodyweightUpdatedAt: 1 });
    await db.measurements.put({ id: 'w', date: AT - 1000, bodyweightKg: 170 * 0.45359237, photoIds: [] });
    await updateNutritionProfile({ goal: 'lose' });
    const t = await loadTargets(AT);
    expect(t.targets).toMatchObject({ kcal: 2293, proteinG: 170 });
  });
});

describe('display-only burn', () => {
  it('a workout today shows active kcal but leaves the budget untouched', async () => {
    const m = await createMeal({ input: { kind: 'photo' }, at: AT, status: 'done', items: [item('a', 1000)] }, AT);
    const before = remaining(2693, sumMeals([m]).kcal);
    await db.workouts.put({
      id: 'w1',
      name: 'Push',
      startedAt: AT - 3_600_000,
      endedAt: AT,
      durationSec: 3600,
      exercises: [],
      exerciseIds: [],
      photoIds: [],
      bodyweightKg: 80,
      calories: 500,
      volumeKg: 0,
      setCount: 0,
      prs: [],
      createdAt: AT,
      updatedAt: AT,
    });
    const burn = await loadDayBurn('2026-10-03');
    expect(burn).toEqual({ activeKcal: 420, workouts: 1 }); // 500 − 1 MET × 80 kg × 1 h
    const meals = await db.meals.where('day').equals('2026-10-03').toArray();
    expect(remaining(2693, sumMeals(meals).kcal)).toBe(before);
  });
});

describe('Dexie v1 → v2 migration', () => {
  it('keeps every v1 row and adds empty food tables', async () => {
    const name = 'heft-migration-test';
    await Dexie.delete(name);
    const v1 = new Dexie(name);
    v1.version(1).stores({
      workouts: 'id, startedAt, *exerciseIds, routineId',
      routines: 'id, folderId, order',
      folders: 'id, order',
      customExercises: 'id, name, variantOf',
      overrides: 'id',
      measurements: 'id, date',
      media: 'id',
      settings: 'id',
      active: 'id',
    });
    await v1.table('measurements').put({ id: 'm1', date: 1, bodyweightKg: 80, photoIds: [] });
    await v1.table('settings').put({ ...DEFAULT_SETTINGS });
    v1.close();

    const v2 = new HeftDB(name);
    await v2.open();
    expect(v2.verno).toBe(2);
    expect(await v2.measurements.get('m1')).toMatchObject({ bodyweightKg: 80 });
    expect(await v2.settings.get('settings')).toMatchObject({ unit: 'lb' });
    expect(await v2.meals.count()).toBe(0);
    expect(await v2.foods.count()).toBe(0);
    expect(await v2.nutrition.count()).toBe(0);
    v2.close();
    await Dexie.delete(name);
  });
});

describe('spend ledger', () => {
  const call = (at: number, costUsd: number) => ({ at, model: 'claude-opus-5-5', inputTokens: 3000, outputTokens: 900, costUsd, ok: true });
  it('counts by call time, survives meal deletion and back-dated meals', async () => {
    const OCT1 = new Date(2026, 9, 1).getTime();
    const backdated = await createMeal({ input: { kind: 'photo' }, at: new Date(2026, 8, 20, 12).getTime() }, AT);
    await updateMeal(backdated.id, (m) => ({ aiCalls: [...m.aiCalls, call(AT, 0.05)] }));
    const other = await createMeal({ input: { kind: 'photo' }, at: AT, aiCalls: [call(AT, 0.07)] }, AT);
    const spend = await loadAiSpend(OCT1);
    expect(spend.calls).toBe(2);
    expect(spend.costUsd).toBeCloseTo(0.12, 10);
    await deleteMeal(other.id);
    expect((await loadAiSpend(OCT1)).calls).toBe(2);
    // An edit that doesn't add calls writes no ledger rows.
    await updateMeal(backdated.id, { title: 'x' });
    expect((await loadAiSpend(OCT1)).calls).toBe(2);
  });

  it('only a change of `at` moves the meal to another day', async () => {
    const m = await createMeal({ input: { kind: 'photo' }, at: AT, status: 'done', items: [item('a', 100)] }, AT);
    await db.meals.update(m.id, { day: '2026-10-02' }); // as if logged in another time zone
    expect((await updateItem(m.id, 'a', { grams: 150 }))!.day).toBe('2026-10-02');
    const moved = await updateMeal(m.id, { at: new Date(2026, 9, 1, 9).getTime() });
    expect(moved!.day).toBe('2026-10-01');
  });
});

describe('recordSpend', () => {
  it('writes ledger rows without a meal row (meal deleted mid-analysis)', async () => {
    await recordSpend('gone', [{ at: AT, model: 'claude-opus-5-5', inputTokens: 1, outputTokens: 1, costUsd: 0.5, ok: true }]);
    expect((await loadAiSpend(AT - 1)).costUsd).toBeCloseTo(0.5, 10);
  });
});
