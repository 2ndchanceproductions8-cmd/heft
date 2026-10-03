import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import type { AiItem } from './foodAi';
import { groundItems } from './ground';
import type { bestMatch } from './usda';
import type { FoodChoice, Per100g } from './types';

const RICE: Per100g = { kcal: 130, proteinG: 2.38, carbsG: 28.6, fatG: 0.21, fiberG: null, sugarG: null, sodiumMg: 0 };
const riceChoice: FoodChoice = { id: 'usda:168930', name: 'Rice, white, medium-grain, cooked, unenriched', source: 'usda', fdcId: 168930, per100g: RICE, servingG: null, dataType: 'SR Legacy' };

const ai = (name: string, fdcQuery: string, weightG: number, kcal = 100): AiItem => ({
  name,
  fdcQuery,
  portion: '1 cup',
  weightG,
  estimate: { kcal, proteinG: 10, carbsG: 20, fatG: 5, fiberG: 2, sugarG: 1, sodiumMg: 50 },
});

type Match = typeof bestMatch;

describe('groundItems', () => {
  it('matched → USDA per100g + matchedName; unmatched → per-100 g of Claude’s estimate with the lookup status', async () => {
    const match = vi.fn<Match>(async (q) => {
      if (q === 'rice, white, cooked') return { status: 'ok', choice: riceChoice, demoKey: true };
      if (q === 'mystery stew') return { status: 'no_match', choice: null, demoKey: true };
      return { status: 'rate_limited', choice: null, demoKey: true };
    });
    const r = await groundItems([ai('White rice', 'rice, white, cooked', 180), ai('Stew', 'mystery stew', 250, 300), ai('Sauce', 'sauce', 9999, 80)], { bestMatch: match });

    expect(r.demoKey).toBe(true);
    expect(r.anyRateLimited).toBe(true);
    const [rice, stew, sauce] = r.items;
    expect(rice).toMatchObject({
      name: 'White rice', // never the database name
      portion: '1 cup',
      grams: 180,
      baselineGrams: 180,
      per100g: RICE,
      fixed: null,
      source: 'usda',
      matchedName: 'Rice, white, medium-grain, cooked, unenriched',
      fdcId: 168930,
      fdcQuery: 'rice, white, cooked',
      lookup: 'ok',
    });
    expect(rice.id).toMatch(/^it_/);
    expect(stew).toMatchObject({ name: 'Stew', source: 'estimate', lookup: 'no_match', grams: 250 });
    expect(stew.per100g!.kcal).toBeCloseTo(120); // 300 kcal for 250 g
    expect(stew.per100g!.fiberG).toBeCloseTo(0.8);
    expect(stew.matchedName).toBeUndefined();
    expect(sauce).toMatchObject({ source: 'estimate', lookup: 'rate_limited', grams: 5000, baselineGrams: 5000 }); // clamped
    expect(new Set(r.items.map((i) => i.id)).size).toBe(3);
  });

  it('runs at most 4 lookups at once and keeps item order', async () => {
    let inFlight = 0;
    let peak = 0;
    const match = vi.fn<Match>(async (q) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { status: 'ok', choice: { ...riceChoice, name: 'match ' + q }, demoKey: false };
    });
    const names = Array.from({ length: 9 }, (_, i) => `food ${i}`);
    const r = await groundItems(names.map((n) => ai(n, n, 100)), { bestMatch: match });
    expect(peak).toBe(4);
    expect(r.items.map((i) => i.name)).toEqual(names);
    expect(r.items.map((i) => i.matchedName)).toEqual(names.map((n) => 'match ' + n));
    expect(r.demoKey).toBe(false);
    expect(r.anyRateLimited).toBe(false);
  });

  it('a lookup that hangs past the per-item timeout → failed (estimate kept)', async () => {
    const match = vi.fn<Match>((_q, signal) => new Promise((_res, rej) => signal?.addEventListener('abort', () => rej(new Error('aborted')))));
    const never = vi.fn<Match>(() => new Promise(() => undefined)); // ignores its signal entirely
    const a = await groundItems([ai('Toast', 'bread, toasted', 30)], { bestMatch: match, timeoutMs: 10 });
    const b = await groundItems([ai('Toast', 'bread, toasted', 30)], { bestMatch: never, timeoutMs: 10 });
    for (const r of [a, b]) expect(r.items[0]).toMatchObject({ source: 'estimate', lookup: 'failed', grams: 30 });
  });

  it('an empty search phrase falls back to the name; nothing at all → skipped', async () => {
    const match = vi.fn<Match>(async () => ({ status: 'no_match', choice: null, demoKey: false }));
    const r = await groundItems([ai('Apple', '', 150), { ...ai('', '', 10), name: '' }], { bestMatch: match });
    expect(match).toHaveBeenCalledTimes(1);
    expect(match.mock.calls[0][0]).toBe('Apple');
    expect(r.items[0].lookup).toBe('no_match');
    expect(r.items[1].lookup).toBe('skipped');
  });

  it('the caller’s abort fails the remaining lookups', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const match = vi.fn<Match>(async () => ({ status: 'ok', choice: riceChoice, demoKey: false }));
    const r = await groundItems([ai('Rice', 'rice', 100)], { bestMatch: match, signal: ctl.signal });
    expect(r.items[0].lookup).toBe('failed');
  });
});
