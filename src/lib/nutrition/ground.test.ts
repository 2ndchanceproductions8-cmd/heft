import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import riceFx from './__fixtures__/usda-rice.json';
import type { AiItem } from './foodAi';
import { GROUND_ITEM_BUDGET_MS, groundItems } from './ground';
import { bestMatch, FDC_DATA_TYPES, resetUsdaDataTypeMemo } from './usda';
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

  it('hands the per-item budget to bestMatch, which starts it once the item may send', async () => {
    const match = vi.fn<Match>(async () => ({ status: 'ok', choice: riceChoice, demoKey: false }));
    await groundItems([ai('Rice', 'rice', 100)], { bestMatch: match });
    expect(match).toHaveBeenCalledWith('rice', expect.any(AbortSignal), { budgetMs: GROUND_ITEM_BUDGET_MS });
    expect(GROUND_ITEM_BUDGET_MS).toBe(6000);
    await groundItems([ai('Rice', 'rice', 100)], { bestMatch: match, budgetMs: 2500 });
    expect(match.mock.calls[1][2]).toEqual({ budgetMs: 2500 });
  });

  it('a lookup that hangs past the hard cap → failed (estimate kept), even one that ignores its signal', async () => {
    const match = vi.fn<Match>((_q, signal) => new Promise((_res, rej) => signal?.addEventListener('abort', () => rej(new Error('aborted')))));
    const never = vi.fn<Match>(() => new Promise(() => undefined)); // ignores its signal entirely
    const a = await groundItems([ai('Toast', 'bread, toasted', 30)], { bestMatch: match, capMs: 10 });
    const b = await groundItems([ai('Toast', 'bread, toasted', 30)], { bestMatch: never, capMs: 10 });
    for (const r of [a, b]) expect(r.items[0]).toMatchObject({ source: 'estimate', lookup: 'failed', grams: 30 });
  });

  it('a rejected USDA key is recorded per item as key_rejected (Claude’s estimate kept)', async () => {
    const match = vi.fn<Match>(async () => ({ status: 'key_rejected', choice: null, demoKey: false }));
    const r = await groundItems([ai('Rice', 'rice', 100)], { bestMatch: match });
    expect(r.items[0]).toMatchObject({ source: 'estimate', lookup: 'key_rejected' });
    expect(r.anyRateLimited).toBe(false);
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

/*
 * The real bestMatch on a slow network, on a fake clock. The live API answers any dataType list containing
 * "Survey (FNDDS)" with HTTP 400 (usda.ts header), so the first lookup of a session probes: filtered → 400,
 * comma-free filtered → 400, then unfiltered. The other items wait for that probe; their 6 s budget must
 * start only once they may send.
 */
describe('groundItems + the real USDA lookup on a slow network', () => {
  const RICE_BODY = (riceFx as { body: unknown }).body;
  const fakeRes = (status: number, body: unknown) =>
    ({ status, ok: status >= 200 && status < 300, json: async () => body }) as unknown as Response;
  let t0 = 0;

  /** Answers after `latency(filtered)` ms (null = never, until aborted); filtered requests 400 like the live API. */
  function slowFetch(latency: (filtered: boolean) => number | null) {
    const calls: { dataType: string | null; at: number }[] = [];
    const fn = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const filtered = url.searchParams.has('dataType');
      calls.push({ dataType: url.searchParams.get('dataType'), at: Date.now() - t0 });
      return new Promise<Response>((resolve, reject) => {
        const signal = init?.signal;
        const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
        if (signal?.aborted) return onAbort();
        signal?.addEventListener('abort', onAbort, { once: true });
        const ms = latency(filtered);
        if (ms == null) return;
        setTimeout(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve(filtered ? fakeRes(400, null) : fakeRes(200, RICE_BODY));
        }, ms);
      });
    };
    return { fetch: fn as unknown as typeof fetch, calls };
  }

  const withFetch =
    (f: typeof fetch): Match =>
    (q, signal, deps) =>
      bestMatch(q, signal, { ...deps, fetch: f });
  const meal = [
    ai('White rice', 'rice, white, cooked', 180),
    ai('Chicken', 'chicken breast, roasted', 150),
    ai('Broccoli', 'broccoli, steamed', 90),
    ai('Oil', 'olive oil', 10),
  ];

  async function run(f: ReturnType<typeof slowFetch>, ms: number) {
    t0 = Date.now();
    const p = groundItems(meal, { bestMatch: withFetch(f.fetch) });
    await vi.advanceTimersByTimeAsync(ms);
    return p;
  }

  beforeEach(() => {
    resetUsdaDataTypeMemo();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('3 s per response, first meal of the session: all four items match (the probe wait is not on their budget)', async () => {
    const f = slowFetch(() => 3000);
    const r = await run(f, 10_000);
    expect(r.items.map((i) => [i.source, i.lookup])).toEqual(meal.map(() => ['usda', 'ok']));
    // the probe's two 400s, then every item's unfiltered request at once: 6 requests, not 3 per item
    expect(f.calls).toEqual([
      { dataType: FDC_DATA_TYPES, at: 0 },
      { dataType: FDC_DATA_TYPES, at: 3000 },
      ...meal.map(() => ({ dataType: null, at: 6000 })),
    ]);

    // the next meal knows the filter is rejected: one unfiltered request per item
    const f2 = slowFetch(() => 3000);
    const r2 = await run(f2, 4000);
    expect(r2.items.every((i) => i.lookup === 'ok')).toBe(true);
    expect(f2.calls).toEqual(meal.map(() => ({ dataType: null, at: 0 })));
  });

  it('fast 400s, 5 s unfiltered answers: every item matches (each item gets its own 6 s)', async () => {
    const f = slowFetch((filtered) => (filtered ? 300 : 5000));
    const r = await run(f, 6000);
    expect(r.items.map((i) => i.lookup)).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(f.calls.filter((c) => c.dataType)).toHaveLength(2);
  });

  it('the rejected-filter memo is saved on the 400s, even when every unfiltered request then times out', async () => {
    const f = slowFetch((filtered) => (filtered ? 300 : null));
    const r = await run(f, 6600); // released at 0.6 s, then each item's 6 s budget
    expect(r.items.map((i) => i.lookup)).toEqual(['failed', 'failed', 'failed', 'failed']);
    expect(f.calls.map((c) => [c.dataType, c.at])).toEqual([
      [FDC_DATA_TYPES, 0],
      [FDC_DATA_TYPES, 300],
      ...meal.map(() => [null, 600]),
    ]);

    // no re-probe on the next meal: the 400s already settled it
    const f2 = slowFetch(() => 100);
    await run(f2, 200);
    expect(f2.calls).toEqual(meal.map(() => ({ dataType: null, at: 0 })));
  });
});
