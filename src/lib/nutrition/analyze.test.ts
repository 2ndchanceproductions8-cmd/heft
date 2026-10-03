import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { db } from '../../db';
import {
  aiErrorMessage,
  analysisInterrupted,
  GENERIC_FAILURE,
  isAnalysisRunning,
  NO_KEY_MESSAGE,
  runAnalysis,
  titleFromItems,
  useAnalysisRunning,
  type AnalysisDeps,
} from './analyze';
import { AiError, type AnalyzeResult, type analyzeMeal } from './foodAi';
import type { groundItems } from './ground';
import { ImageLoadError } from './images';
import { createMeal, updateMeal } from './store';
import type { MealItem, Per100g } from './types';

const RICE: Per100g = { kcal: 130, proteinG: 2.7, carbsG: 28, fatG: 0.3, fiberG: 0.4, sugarG: 0.1, sodiumMg: 1 };

const RESULT: AnalyzeResult = {
  isFood: true,
  items: [
    { name: 'White rice', fdcQuery: 'rice, white, cooked', portion: '1 cup', weightG: 200, estimate: { kcal: 260, proteinG: 5, carbsG: 56, fatG: 0.6, fiberG: 0.8, sugarG: 0.2, sodiumMg: 2 } },
    { name: 'Chicken', fdcQuery: 'chicken breast, roasted', portion: '1 breast', weightG: 150, estimate: { kcal: 248, proteinG: 46, carbsG: 0, fatG: 5, fiberG: 0, sugarG: 0, sodiumMg: 110 } },
  ],
  confidence: 'medium',
  scaleReference: 'fork',
  notes: 'Fork in frame.',
  calls: [{ model: 'claude-opus-5-5', inputTokens: 1500, outputTokens: 400, costUsd: 0.014, ok: true }],
};

const groundedItem = (name: string, grams: number, source: MealItem['source'] = 'usda'): MealItem => ({
  id: 'it_' + name,
  name,
  portion: '',
  grams,
  baselineGrams: grams,
  per100g: RICE,
  fixed: null,
  source,
  lookup: source === 'usda' ? 'ok' : 'no_match',
});

const fakeGround = vi.fn<typeof groundItems>(async (items) => ({
  items: items.map((i) => groundedItem(i.name, i.weightG)),
  anyRateLimited: false,
  demoKey: true,
}));

function deps(over: Partial<AnalysisDeps> = {}): AnalysisDeps {
  return {
    getApiKey: () => 'test-key',
    loadImages: async (ids) => ids.map(() => ({ data: 'AAAA', mediaType: 'image/jpeg' as const })),
    analyzeMeal: vi.fn<typeof analyzeMeal>(async () => RESULT),
    groundItems: fakeGround,
    // stands in for photos.ts finishMealPhotos (keep the first photo); photos.test.ts runs the real one end to end
    finishPhotos: vi.fn(async (id: string) => {
      await updateMeal(id, (m) => ({ photoIds: m.photoIds.slice(0, 1) }), { force: true });
    }),
    now: () => 1_000,
    ...over,
  };
}

async function pendingMeal(photoIds = ['m_a', 'm_b'], input: Parameters<typeof createMeal>[0]['input'] = { kind: 'photo' }) {
  return createMeal({ input, photoIds, status: 'pending' });
}

beforeEach(async () => {
  await db.transaction('rw', db.tables, async () => {
    await Promise.all(db.tables.map((t) => t.clear()));
  });
  fakeGround.mockClear();
});

describe('runAnalysis', () => {
  it('pending → done: items, totals, confidence, title, aiCalls, angles; photos shrunk to the first', async () => {
    const meal = await pendingMeal();
    const d = deps();
    await runAnalysis(meal.id, d);
    const m = (await db.meals.get(meal.id))!;
    expect(m.status).toBe('done');
    expect(m.error).toBeNull();
    expect(m.items.map((i) => i.name)).toEqual(['White rice', 'Chicken']);
    expect(m.totals.kcal).toBeCloseTo(130 * 3.5); // 350 g of RICE-per-100g
    expect(m.confidence).toBe('high'); // medium + all matched, scale reference present
    expect(m.scaleReference).toBe('fork');
    expect(m.notes).toBe('Fork in frame.');
    expect(m.angles).toBe(2);
    expect(m.title).toBe('White rice & Chicken');
    expect(m.aiCalls).toEqual([{ at: 1_000, model: 'claude-opus-5-5', inputTokens: 1500, outputTokens: 400, costUsd: 0.014, ok: true }]);
    expect(m.photoIds).toEqual(['m_a']);
    expect(d.finishPhotos).toHaveBeenCalledTimes(1);
    expect(d.finishPhotos).toHaveBeenCalledWith(meal.id);
    expect(d.analyzeMeal).toHaveBeenCalledWith(
      { images: [expect.objectContaining({ mediaType: 'image/jpeg' }), expect.anything()], description: undefined, weightG: null },
      { apiKey: 'test-key' },
    );
    expect(isAnalysisRunning(meal.id)).toBe(false);
  });

  it('photos are finished through finishMealPhotos once the meal is saved done; a meal without photos skips it', async () => {
    const meal = await pendingMeal();
    const seen: string[] = [];
    const finishPhotos = vi.fn(async (id: string) => {
      seen.push((await db.meals.get(id))!.status);
    });
    await runAnalysis(meal.id, deps({ finishPhotos }));
    expect(seen).toEqual(['done']);

    const text = await createMeal({ input: { kind: 'text', description: 'two eggs' }, status: 'pending' });
    const none = vi.fn(async () => undefined);
    await runAnalysis(text.id, deps({ finishPhotos: none }));
    expect((await db.meals.get(text.id))!.status).toBe('done');
    expect(none).not.toHaveBeenCalled();
  });

  it('keeps an existing title, passes the description + weight; a user weight allows high without a scale reference', async () => {
    const meal = await createMeal({ input: { kind: 'text', description: '  2 eggs and toast ', weightG: 180 }, title: 'Breakfast', status: 'pending' });
    const d = deps({ analyzeMeal: vi.fn<typeof analyzeMeal>(async () => ({ ...RESULT, scaleReference: null })) });
    await runAnalysis(meal.id, d);
    const m = (await db.meals.get(meal.id))!;
    expect(m.title).toBe('Breakfast');
    expect(m.confidence).toBe('high');
    expect(m.angles).toBe(0);
    expect(d.analyzeMeal).toHaveBeenCalledWith({ images: [], description: '2 eggs and toast', weightG: 180 }, { apiKey: 'test-key' });
  });

  it('no scale reference and no weight → never above medium', async () => {
    const meal = await pendingMeal();
    await runAnalysis(meal.id, deps({ analyzeMeal: async () => ({ ...RESULT, confidence: 'high', scaleReference: null }) }));
    expect((await db.meals.get(meal.id))!.confidence).toBe('medium');
  });

  it('Claude failure → failed with a friendly message, photos kept, billed calls recorded', async () => {
    const meal = await pendingMeal();
    await updateMeal(meal.id, { aiCalls: [{ at: 1, model: 'claude-opus-5-5', inputTokens: 1, outputTokens: 1, costUsd: 0.001, ok: true }] });
    const refusedCall = { model: 'claude-opus-5-5', inputTokens: 1200, outputTokens: 0, costUsd: 0.0048, ok: false, error: 'refused' };
    const shrink = vi.fn(async () => undefined);
    await runAnalysis(meal.id, deps({ analyzeMeal: async () => Promise.reject(new AiError('refused', 'declined', [refusedCall])), finishPhotos: shrink }));
    const m = (await db.meals.get(meal.id))!;
    expect(m.status).toBe('failed');
    expect(m.error).toBe('Claude declined this photo.');
    expect(m.photoIds).toEqual(['m_a', 'm_b']);
    expect(m.items).toEqual([]);
    expect(m.aiCalls).toHaveLength(2);
    expect(m.aiCalls[1]).toEqual({ at: 1_000, ...refusedCall });
    expect(shrink).not.toHaveBeenCalled();
  });

  it('not food → failed "That doesn\'t look like food." + notes, call recorded', async () => {
    const meal = await pendingMeal(['m_a']);
    await runAnalysis(meal.id, deps({ analyzeMeal: async () => ({ ...RESULT, isFood: false, items: [], notes: 'This is a cat.' }) }));
    const m = (await db.meals.get(meal.id))!;
    expect(m.status).toBe('failed');
    expect(m.error).toBe("That doesn't look like food. This is a cat.");
    expect(m.aiCalls).toHaveLength(1);
    expect(m.photoIds).toEqual(['m_a']);
  });

  it('no Anthropic key → pending with the settings message, no Claude call', async () => {
    const meal = await pendingMeal();
    const d = deps({ getApiKey: () => null });
    await runAnalysis(meal.id, d);
    const m = (await db.meals.get(meal.id))!;
    expect(m.status).toBe('pending');
    expect(m.error).toBe(NO_KEY_MESSAGE);
    expect(d.analyzeMeal).not.toHaveBeenCalled();
  });

  it('a photo Claude cannot read → failed with the image error', async () => {
    const meal = await pendingMeal();
    await runAnalysis(meal.id, deps({ loadImages: async () => Promise.reject(new ImageLoadError('One photo is larger than the 5 MB Claude accepts.')) }));
    const m = (await db.meals.get(meal.id))!;
    expect(m.status).toBe('failed');
    expect(m.error).toBe('One photo is larger than the 5 MB Claude accepts.');
  });

  it('an unexpected exception → failed "Something went wrong", and the billed calls are still recorded', async () => {
    const meal = await pendingMeal();
    await runAnalysis(meal.id, deps({ groundItems: async () => Promise.reject(new Error('boom')) }));
    const m = (await db.meals.get(meal.id))!;
    expect(m.status).toBe('failed');
    expect(m.error).toBe(GENERIC_FAILURE);
    expect(m.aiCalls).toHaveLength(1);
  });

  it('missing meal → resolves quietly', async () => {
    await expect(runAnalysis('meal_nope', deps())).resolves.toBeUndefined();
  });

  it('concurrent calls share one run; the running flag + hook track it; analyzing meals block UI writes', async () => {
    const meal = await pendingMeal();
    let release!: (r: AnalyzeResult) => void;
    const analyze = vi.fn<typeof analyzeMeal>(() => new Promise<AnalyzeResult>((r) => (release = r)));
    const d = deps({ analyzeMeal: analyze });

    const p1 = runAnalysis(meal.id, d);
    const p2 = runAnalysis(meal.id, d);
    expect(p2).toBe(p1);
    expect(isAnalysisRunning(meal.id)).toBe(true);
    expect(renderToString(h(() => h('span', null, String(useAnalysisRunning(meal.id)))))).toContain('false'); // server snapshot

    await vi.waitFor(() => expect(analyze).toHaveBeenCalledTimes(1));
    const mid = (await db.meals.get(meal.id))!;
    expect(mid.status).toBe('analyzing');
    expect(analysisInterrupted(mid)).toBe(false);
    await expect(updateMeal(meal.id, { title: 'x' })).rejects.toThrow(/being analyzed/);

    release(RESULT);
    await Promise.all([p1, p2]);
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(isAnalysisRunning(meal.id)).toBe(false);
    expect((await db.meals.get(meal.id))!.status).toBe('done');
  });

  it('detects an interrupted analysis (status analyzing, no run in this session) and Retry recovers it', async () => {
    const meal = await createMeal({ input: { kind: 'photo' }, photoIds: ['m_a'], status: 'analyzing' });
    expect(analysisInterrupted(meal)).toBe(true);
    expect(analysisInterrupted({ id: meal.id, status: 'done' })).toBe(false);
    await runAnalysis(meal.id, deps());
    const m = (await db.meals.get(meal.id))!;
    expect(m.status).toBe('done');
    expect(analysisInterrupted(m)).toBe(false);
  });

  it('a failing photo shrink never fails the meal', async () => {
    const meal = await pendingMeal();
    await runAnalysis(meal.id, deps({ finishPhotos: async () => Promise.reject(new Error('decode')) }));
    const m = (await db.meals.get(meal.id))!;
    expect(m.status).toBe('done');
    expect(m.photoIds).toEqual(['m_a', 'm_b']);
  });
});

describe('helpers', () => {
  it('titleFromItems joins the first 1–3 names', () => {
    expect(titleFromItems([])).toBe('');
    expect(titleFromItems([{ name: 'Pizza' }])).toBe('Pizza');
    expect(titleFromItems([{ name: 'Rice' }, { name: 'Chicken' }, { name: 'Broccoli' }, { name: 'Oil' }])).toBe('Rice, Chicken & Broccoli');
  });

  it('every AiError code has a friendly message', () => {
    expect(aiErrorMessage({ code: 'key_rejected', message: '' })).toBe('Claude rejected your key — check it in Food settings.');
    expect(aiErrorMessage({ code: 'network', message: '' })).toBe("No connection. Retry when you're back online.");
    expect(aiErrorMessage({ code: 'refused', message: '' })).toBe('Claude declined this photo.');
    expect(aiErrorMessage({ code: 'rate_limited', message: 'This request would exceed your workspace spend limit.' })).toContain('spend limit');
    expect(aiErrorMessage({ code: 'forbidden', message: 'No access to this model.' })).toContain('No access to this model.');
    for (const code of ['no_key', 'overloaded', 'bad_request', 'timeout', 'truncated', 'invalid_output', 'unknown'] as const) {
      expect(aiErrorMessage({ code, message: 'x' }).length).toBeGreaterThan(5);
    }
  });
});
