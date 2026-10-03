// The Food screens' multi-step writes (meal/actions.ts, capture/draftSaver.ts) against the real store on
// fake-indexeddb. finishMealPhotos is spied on (node has no image decoder to shrink with); the analysis engine
// is stubbed: nothing here calls Claude.
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../db';
import { createMeal, MealBusyError } from '../../lib/nutrition/store';
import type { FoodChoice, Meal } from '../../lib/nutrition/types';
import {
  addProductToMeal,
  deleteUnfinishedMeal,
  enterMealManually,
  keepCapture,
  logSearchFromCapture,
  retryMeal,
  writeDraftText,
} from './meal/actions';
import { createDraftSaver, DRAFT_SAVE_DELAY_MS } from './capture/draftSaver';

const spy = vi.hoisted(() => ({ finished: [] as { id: string; status: string | undefined; items: number }[], running: new Set<string>() }));

vi.mock('../../lib/nutrition/photos', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../lib/nutrition/photos')>();
  const { db: database } = await import('../../db');
  return {
    ...orig,
    // Record what the meal looked like when it was called: it must run AFTER the 'done' write.
    finishMealPhotos: async (id: string) => {
      const m = await database.meals.get(id);
      spy.finished.push({ id, status: m?.status, items: m?.items.length ?? 0 });
    },
  };
});

vi.mock('../../lib/nutrition/analyze', () => ({
  runAnalysis: async () => {},
  isAnalysisRunning: (id: string) => spy.running.has(id),
  analysisInterrupted: (m: { id: string; status: string }) => m.status === 'analyzing' && !spy.running.has(m.id),
  useAnalysisRunning: (id: string | null | undefined) => (id ? spy.running.has(id) : false),
}));

const AT = new Date(2026, 9, 2, 19, 15).getTime();
const per100g = { kcal: 539, proteinG: 6.3, carbsG: 57.5, fatG: 30.9, fiberG: null, sugarG: null, sodiumMg: null };
const nutella: FoodChoice = { id: 'off:3017620422003', name: 'Nutella', brand: 'Ferrero', source: 'off', barcode: '3017620422003', per100g, servingG: 15 };
const rice: FoodChoice = { id: 'usda:168878', name: 'Rice, white, cooked', source: 'usda', fdcId: 168878, per100g: { ...per100g, kcal: 130 }, servingG: null };

const photoDraft = (p: Partial<Meal> = {}) =>
  createMeal({ status: 'draft', input: { kind: 'photo', description: 'toast', weightG: null }, at: AT, photoIds: ['m_1', 'm_2'], ...p });

beforeEach(async () => {
  await db.meals.clear();
  spy.finished.length = 0;
  spy.running.clear();
});

describe('U2/U4 keepCapture: leaving the capture screen keeps the draft', () => {
  it('a photo draft is kept, with what was typed written in', async () => {
    const d = await photoDraft();
    const id = await keepCapture({ draft: d, text: { description: 'toast with butter', weightG: 85 }, atIfNew: Date.now() });
    expect(id).toBe(d.id);
    const row = await db.meals.get(d.id);
    expect(row?.status).toBe('draft');
    expect(row?.photoIds).toEqual(['m_1', 'm_2']);
    expect(row?.input).toMatchObject({ kind: 'photo', description: 'toast with butter', weightG: 85 });
  });

  it('a draft row with no photos and nothing typed is deleted quietly', async () => {
    const d = await photoDraft({ photoIds: [] });
    expect(await keepCapture({ draft: d, text: { description: '  ', weightG: null }, atIfNew: Date.now() })).toBeNull();
    expect(await db.meals.get(d.id)).toBeUndefined();
  });

  it('typed text with no row yet becomes a text draft on the capture day', async () => {
    const id = await keepCapture({ draft: null, text: { description: 'chicken burrito', weightG: null }, atIfNew: AT });
    const row = await db.meals.get(id!);
    expect(row).toMatchObject({ status: 'draft', day: '2026-10-02', input: { kind: 'text', description: 'chicken burrito' } });
    expect(row?.photoIds).toEqual([]);
  });

  it('nothing typed and no row: nothing is created', async () => {
    expect(await keepCapture({ draft: null, text: { description: '', weightG: null }, atIfNew: AT })).toBeNull();
    expect(await db.meals.count()).toBe(0);
  });

  it('a row already sent to analysis is not touched', async () => {
    const m = await photoDraft({ status: 'pending' });
    expect(await keepCapture({ draft: m, text: { description: 'other', weightG: null }, atIfNew: AT })).toBeNull();
    expect((await db.meals.get(m.id))?.input.description).toBe('toast');
  });

  it('writeDraftText only writes into drafts', async () => {
    const d = await photoDraft();
    await writeDraftText(d.id, { description: 'eggs', weightG: 120 });
    expect((await db.meals.get(d.id))?.input).toMatchObject({ description: 'eggs', weightG: 120 });
    const p = await photoDraft({ status: 'pending' });
    await writeDraftText(p.id, { description: 'eggs', weightG: 120 });
    expect((await db.meals.get(p.id))?.input).toMatchObject({ description: 'toast', weightG: null });
  });
});

describe('U3 the typed-text saver', () => {
  afterEach(() => vi.useRealTimers());

  it('writes 600 ms after the last keystroke, once', async () => {
    vi.useFakeTimers();
    const write = vi.fn(async () => {});
    const text = { description: 'soup', weightG: null };
    const saver = createDraftSaver({ target: () => ({ draftId: 'meal_1', text }), write });
    saver.typed();
    await vi.advanceTimersByTimeAsync(DRAFT_SAVE_DELAY_MS - 100);
    saver.typed(); // restarts the quiet time
    await vi.advanceTimersByTimeAsync(DRAFT_SAVE_DELAY_MS - 100);
    expect(write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith('meal_1', text);
    expect(saver.dirty).toBe(false);
  });

  it('flush() writes the last keystrokes NOW (leaving the screen) instead of dropping the timer', async () => {
    vi.useFakeTimers();
    const write = vi.fn(async () => {});
    const saver = createDraftSaver({ target: () => ({ draftId: 'meal_1', text: { description: 'soup w', weightG: null } }), write });
    saver.typed();
    await saver.flush();
    expect(write).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(DRAFT_SAVE_DELAY_MS * 2);
    expect(write).toHaveBeenCalledTimes(1); // the cancelled timer doesn't write again
    await saver.flush();
    expect(write).toHaveBeenCalledTimes(1); // nothing new typed
  });

  it('clear() forgets typing that was written another way; no row yet keeps it pending', async () => {
    vi.useFakeTimers();
    const write = vi.fn(async () => {});
    let target: { draftId: string; text: { description: string; weightG: null } } | null = null;
    const saver = createDraftSaver({ target: () => target, write });
    saver.typed();
    await vi.advanceTimersByTimeAsync(DRAFT_SAVE_DELAY_MS);
    expect(write).not.toHaveBeenCalled();
    expect(saver.dirty).toBe(true); // nowhere to write yet
    target = { draftId: 'meal_9', text: { description: 'x', weightG: null } };
    await saver.flush();
    expect(write).toHaveBeenCalledWith('meal_9', target.text);
    saver.typed();
    saver.clear();
    await vi.advanceTimersByTimeAsync(DRAFT_SAVE_DELAY_MS);
    await saver.flush();
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('a failing write never throws out of flush (unmount)', async () => {
    const saver = createDraftSaver({ target: () => ({ draftId: 'gone', text: { description: 'x', weightG: null } }), write: async () => Promise.reject(new MealBusyError()) });
    saver.typed();
    await expect(saver.flush()).resolves.toBeUndefined();
  });

  it('end to end: the flushed text lands in the draft row', async () => {
    const d = await photoDraft();
    const saver = createDraftSaver({ target: () => ({ draftId: d.id, text: { description: 'toast and jam', weightG: 90 } }), write: writeDraftText });
    saver.typed();
    await saver.flush();
    expect((await db.meals.get(d.id))?.input).toMatchObject({ description: 'toast and jam', weightG: 90 });
  });
});

describe('U4/U12 a scanned product finishes a capture draft', () => {
  it('the draft becomes the done meal: item, product title, high confidence, then its photos shrink', async () => {
    const d = await photoDraft();
    const saved = await addProductToMeal(d.id, nutella, 30, 'barcode');
    expect(saved).toMatchObject({ id: d.id, status: 'done', title: 'Nutella', confidence: 'high', input: { kind: 'barcode' }, day: '2026-10-02' });
    expect(saved?.items).toHaveLength(1);
    expect(saved?.items[0]).toMatchObject({ name: 'Nutella', grams: 30, source: 'off' });
    expect(saved?.totals.kcal).toBeCloseTo(161.7, 1);
    expect(spy.finished).toEqual([{ id: d.id, status: 'done', items: 1 }]); // after the write
  });

  it('a draft title is kept; a search pick (not found on OFF) gets no confidence', async () => {
    const d = await photoDraft({ title: 'Breakfast' });
    const saved = await addProductToMeal(d.id, rice, 150, 'search');
    expect(saved).toMatchObject({ title: 'Breakfast', status: 'done', confidence: null, input: { kind: 'search' } });
  });

  it('a done meal just gets the item, as before (status, title and photos untouched)', async () => {
    const done = await createMeal({ status: 'done', input: { kind: 'photo' }, at: AT, title: 'Lunch', photoIds: ['m_1'], confidence: 'medium' });
    const saved = await addProductToMeal(done.id, nutella, 15, 'barcode');
    expect(saved).toMatchObject({ status: 'done', title: 'Lunch', confidence: 'medium', input: { kind: 'photo' } });
    expect(saved?.items).toHaveLength(1);
    expect(spy.finished).toEqual([]);
  });

  it('a missing meal returns null', async () => {
    expect(await addProductToMeal('meal_gone', nutella, 15, 'barcode')).toBeNull();
  });
});

describe('U12 search from the capture screen', () => {
  it('a photo draft becomes the searched meal and its photos shrink', async () => {
    const d = await photoDraft();
    const id = await logSearchFromCapture({ draft: d, food: rice, grams: 150, atIfNew: Date.now() });
    expect(id).toBe(d.id);
    expect(await db.meals.get(id)).toMatchObject({ status: 'done', title: 'Rice, white, cooked', input: { kind: 'search' } });
    expect(spy.finished).toEqual([{ id: d.id, status: 'done', items: 1 }]);
  });

  it('a text-only draft is replaced by a new meal on the capture day', async () => {
    const d = await createMeal({ status: 'draft', input: { kind: 'text', description: 'rice' }, at: AT });
    const id = await logSearchFromCapture({ draft: d, food: rice, grams: 150, atIfNew: AT });
    expect(id).not.toBe(d.id);
    expect(await db.meals.get(d.id)).toBeUndefined();
    expect(await db.meals.get(id)).toMatchObject({ status: 'done', day: '2026-10-02' });
  });
});

describe('U12 "Enter manually" finishes the meal and shrinks its photos', () => {
  it('failed photo meal → done, then finishMealPhotos', async () => {
    const m = await photoDraft({ status: 'failed', error: "That doesn't look like food." });
    const saved = await enterMealManually(m.id, rice, 150, false);
    expect(saved).toMatchObject({ status: 'done', error: null, title: 'Rice, white, cooked' });
    expect(spy.finished).toEqual([{ id: m.id, status: 'done', items: 1 }]);
  });

  it('an analyzing meal needs force (interrupted run); without it the write is refused', async () => {
    const m = await photoDraft({ status: 'analyzing' });
    await expect(enterMealManually(m.id, rice, 150, false)).rejects.toBeInstanceOf(MealBusyError);
    expect(spy.finished).toEqual([]);
    expect(await enterMealManually(m.id, rice, 150, true)).toMatchObject({ status: 'done' });
  });
});

describe('U1 deleting a meal that is not done', () => {
  const yes = async () => true;
  const no = async () => false;

  it('asks, deletes, and returns the Diary for the meal day', async () => {
    const m = await photoDraft({ status: 'failed', error: 'x' });
    const ask = vi.fn(yes);
    expect(await deleteUnfinishedMeal(m, ask)).toBe('/nutrition?d=2026-10-02');
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ danger: true, message: 'Its photos are deleted too. This can’t be undone.' }));
    expect(await db.meals.get(m.id)).toBeUndefined();
  });

  it('keeps the meal when the user says no', async () => {
    const m = await photoDraft({ status: 'pending' });
    expect(await deleteUnfinishedMeal(m, no)).toBeNull();
    expect(await db.meals.get(m.id)).toBeDefined();
  });

  it('never while its analysis runs here (not even asking)', async () => {
    const m = await photoDraft({ status: 'analyzing' });
    spy.running.add(m.id);
    const ask = vi.fn(yes);
    expect(await deleteUnfinishedMeal(m, ask)).toBeNull();
    expect(ask).not.toHaveBeenCalled();
    expect(await db.meals.get(m.id)).toBeDefined();
  });

  it('an interrupted run (nothing running here) can be deleted', async () => {
    const m = await photoDraft({ status: 'analyzing' });
    expect(await deleteUnfinishedMeal(m, yes)).toBe('/nutrition?d=2026-10-02');
    expect(await db.meals.get(m.id)).toBeUndefined();
  });
});

describe('U5 retryMeal', () => {
  it('with a key: starts the run (not awaited) and opens the meal; without: only opens it', () => {
    const run = vi.fn(() => new Promise<void>(() => {})); // never settles: proves it isn't awaited
    const went: string[] = [];
    retryMeal('meal_1', true, (to) => went.push(to), run);
    expect(run).toHaveBeenCalledWith('meal_1');
    expect(went).toEqual(['/nutrition/meal/meal_1']);
    retryMeal('meal_1', false, (to) => went.push(to), run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(went).toEqual(['/nutrition/meal/meal_1', '/nutrition/meal/meal_1']);
  });
});
