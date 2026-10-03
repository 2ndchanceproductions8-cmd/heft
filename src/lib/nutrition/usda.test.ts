import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import riceFx from './__fixtures__/usda-rice.json';
import chickenNoDtFx from './__fixtures__/usda-chicken-nodt.json';
import chickenFoundationFx from './__fixtures__/usda-chicken-foundation.json';
import chickenCommaDtFx from './__fixtures__/usda-chicken-comma-dt.json';
import chickenNoCommaDtFx from './__fixtures__/usda-chicken-nocomma-dt.json';
import {
  bestMatch,
  choiceFromFdc,
  extractPer100g,
  FDC_DATA_TYPES,
  rankFoods,
  resetUsdaDataTypeMemo,
  searchFoods,
  type FdcFood,
} from './usda';

/*
 * Fixtures were recorded 2026-10-03 with USDA's public DEMO_KEY (api_key stripped; nutrients trimmed to the
 * numbers we read): usda-rice = "rice, white, cooked" with dataType "Foundation,SR Legacy";
 * usda-chicken-*-dt = the two nginx 400s for "chicken breast, roasted" / "chicken breast roasted" with
 * SnapPlate's filter; usda-chicken-nodt = "chicken breast, roasted" without a filter;
 * usda-chicken-foundation = "chicken breast roasted" with "Foundation,SR Legacy,Survey" (has 957/958 rows).
 */

type Fx = { status: number; body: unknown };
const NGINX_400 = '<html><head><title>400 Bad Request</title></head><body><center><h1>400 Bad Request</h1></center><hr><center>nginx</center></body></html>';

function respond(fx: Fx): Response {
  if (fx.body == null) return new Response(NGINX_400, { status: fx.status, headers: { 'content-type': 'text/html' } });
  return new Response(JSON.stringify(fx.body), { status: fx.status, headers: { 'content-type': 'application/json' } });
}

interface Call {
  url: URL;
  init: RequestInit | undefined;
}

/** A fetch stub that answers each request with the next fixture (or a function of the URL). */
function stubFetch(answer: (url: URL, i: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    return answer(url, calls.length - 1);
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

const foods = (fx: Fx) => (fx.body as { foods: FdcFood[] }).foods;

beforeEach(() => resetUsdaDataTypeMemo());
afterEach(() => vi.useRealTimers());

describe('nutrient extraction', () => {
  it('reads 208 and leaves missing fiber/sugar/sodium null (not 0)', () => {
    const medium = foods(riceFx as Fx).find((f) => f.fdcId === 168930)!; // no 269, no 291 listed
    expect(extractPer100g(medium.foodNutrients!)).toEqual({
      kcal: 130,
      proteinG: 2.38,
      carbsG: 28.6,
      fatG: 0.21,
      fiberG: null,
      sugarG: null,
      sodiumMg: 0,
    });
  });

  it('falls back to 958 (Atwater SPECIFIC) when 208 is missing, and clamps negative carbs', () => {
    const fx = foods(chickenFoundationFx as Fx);
    const skinless = choiceFromFdc(fx.find((f) => f.fdcId === 2646170)!)!;
    expect(skinless.per100g.kcal).toBe(112); // 958 = 112, 957 = 106
    expect(skinless.dataType).toBe('Foundation');
    const withSkin = choiceFromFdc(fx.find((f) => f.fdcId === 2727569)!)!;
    expect(withSkin.per100g.kcal).toBe(133); // 958 = 133, 957 = 127
    expect(withSkin.per100g.carbsG).toBe(0); // USDA lists -0.428 g
    // a Foundation row without any energy value is unusable
    expect(choiceFromFdc(fx.find((f) => f.fdcId === 2759004)!)).toBeNull();
  });

  it('uses 957 (Atwater general) only when 208 and 958 are both missing', () => {
    const p = extractPer100g([
      { nutrientNumber: '957', value: 106 },
      { nutrientNumber: '203', value: 22.5 },
    ]);
    expect(p?.kcal).toBe(106);
    expect(p?.proteinG).toBe(22.5);
    expect(p?.fatG).toBe(0);
    expect(extractPer100g([{ nutrientNumber: '203', value: 1 }])).toBeNull();
  });

  it('Foundation rows: energy 958 before 957, carbs 205.2 and sugar 269.3 when 205 / 269 are missing', () => {
    // Shaped like the live Foundation 'apple raw' search (2026-10-03): "Apples, fuji, with skin, raw" lists
    // 957 = 64.7 and 958 = 58.2 and no 208; its sugars come only as 269.3.
    const fuji: FdcFood = {
      fdcId: 1750340,
      description: 'Apples, fuji, with skin, raw',
      dataType: 'Foundation',
      foodNutrients: [
        { nutrientNumber: '957', nutrientName: 'Energy (Atwater General Factors)', unitName: 'KCAL', value: 64.7 },
        { nutrientNumber: '958', nutrientName: 'Energy (Atwater Specific Factors)', unitName: 'KCAL', value: 58.2 },
        { nutrientNumber: '203', value: 0.148 },
        { nutrientNumber: '204', value: 0.162 },
        { nutrientNumber: '205.2', nutrientName: 'Carbohydrates, by summation', value: 15.7 },
        { nutrientNumber: '269.3', nutrientName: 'Sugars, Total', unitName: 'G', value: 13.3 },
        { nutrientNumber: '307', value: 1 },
      ],
    };
    expect(choiceFromFdc(fuji)!.per100g).toEqual({ kcal: 58.2, proteinG: 0.148, carbsG: 15.7, fatG: 0.162, fiberG: null, sugarG: 13.3, sodiumMg: 1 });
    // "Beets, raw": sugar only as 269.3 → 5.1 g, not unknown (numbers may also arrive as JSON numbers)
    expect(extractPer100g([{ nutrientNumber: 957, value: 44 }, { nutrientNumber: 269.3, value: 5.1 }])?.sugarG).toBe(5.1);
    // the classic numbers still win when present
    const both = extractPer100g([
      { nutrientNumber: '957', value: 64.7 },
      { nutrientNumber: '958', value: 58.2 },
      { nutrientNumber: '208', value: 52 },
      { nutrientNumber: '205.2', value: 15.7 },
      { nutrientNumber: '205', value: 13.8 },
      { nutrientNumber: '269.3', value: 13.3 },
      { nutrientNumber: '269', value: 10.4 },
    ]);
    expect(both).toMatchObject({ kcal: 52, carbsG: 13.8, sugarG: 10.4 });
  });

  it('builds usda:<fdcId> choices with the USDA description as the name', () => {
    const c = choiceFromFdc(foods(riceFx as Fx)[1])!;
    expect(c).toMatchObject({ id: 'usda:168930', fdcId: 168930, source: 'usda', name: 'Rice, white, medium-grain, cooked, unenriched', servingG: null });
  });
});

describe('ranking', () => {
  it('rice, white, cooked → plain cooked white rice, not glutinous / salted / parboiled / noodles', () => {
    const ranked = rankFoods('rice, white, cooked', foods(riceFx as Fx));
    const best = ranked[0];
    expect(best.per100g.kcal).toBe(130);
    expect([168930, 168880, 168932, 168882, 168878]).toContain(best.fdcId);
    // USDA's own first hit is glutinous rice (97 kcal) — SnapPlate's scorer picked it.
    expect(foods(riceFx as Fx)[0].fdcId).toBe(169711);
    const pos = (id: number) => ranked.findIndex((c) => c.fdcId === id);
    expect(pos(169711)).toBeGreaterThan(0);
    expect(pos(169753)).toBeGreaterThan(pos(168878)); // "with salt" below the same rice without
  });

  it('chicken breast, roasted → a plain roasted breast beats "breast roll" and deli slices', () => {
    const ranked = rankFoods('chicken breast, roasted', foods(chickenNoDtFx as Fx));
    const best = ranked[0];
    expect(best.fdcId).toBe(171477); // Chicken, broilers or fryers, breast, meat only, cooked, roasted (165 kcal)
    expect(best.name).not.toMatch(/roll|sliced/i);
    const pos = (id: number) => ranked.findIndex((c) => c.fdcId === id);
    expect(pos(174608)).toBeGreaterThan(pos(best.fdcId!)); // Chicken breast, roll, oven-roasted
    expect(pos(172963)).toBeGreaterThan(pos(best.fdcId!)); // oven-roasted, fat-free, sliced
  });

  it('a cooked query does not pick a raw row', () => {
    const ranked = rankFoods('chicken breast, roasted', foods(chickenFoundationFx as Fx));
    expect(ranked[0].name).not.toMatch(/\braw\b/i);
  });

  it('pushes Branded rows below whole foods and tidies their all-caps names', () => {
    const rows: FdcFood[] = [
      { fdcId: 1, description: 'OLIVE OIL', dataType: 'Branded', brandOwner: 'ACME FOODS', servingSize: 15, servingSizeUnit: 'g', foodNutrients: [{ nutrientNumber: '208', value: 800 }] },
      { fdcId: 2, description: 'EXTRA VIRGIN OLIVE OIL', dataType: 'Branded', foodNutrients: [{ nutrientNumber: '208', value: 800 }] },
      { fdcId: 3, description: 'Oil, olive, salad or cooking', dataType: 'SR Legacy', foodNutrients: [{ nutrientNumber: '208', value: 884 }] },
    ];
    const ranked = rankFoods('olive oil', rows);
    expect(ranked[0].fdcId).toBe(3);
    const branded = ranked.find((c) => c.fdcId === 1)!;
    expect(branded).toMatchObject({ name: 'Olive Oil', brand: 'Acme Foods', servingG: 15, dataType: 'Branded' });
  });
});

describe('searchFoods / bestMatch requests', () => {
  it('GET with URLSearchParams, the DEMO_KEY, SnapPlate dataType filter and NO custom headers', async () => {
    const s = stubFetch(() => respond(riceFx as Fx));
    const r = await searchFoods('rice, white, cooked', { fetch: s.fetch });
    expect(r.status).toBe('ok');
    expect(r.demoKey).toBe(true);
    expect(r.foods[0].per100g.kcal).toBe(130);
    expect(s.calls).toHaveLength(1);
    const { url, init } = s.calls[0];
    expect(url.origin + url.pathname).toBe('https://api.nal.usda.gov/fdc/v1/foods/search');
    expect(url.searchParams.get('query')).toBe('rice, white, cooked');
    expect(url.searchParams.get('dataType')).toBe(FDC_DATA_TYPES);
    expect(url.searchParams.get('api_key')).toBe('DEMO_KEY');
    expect(url.searchParams.get('pageSize')).toBe('12');
    expect(init?.method ?? 'GET').toBe('GET');
    expect(init?.headers).toBeUndefined();
    expect(init?.body).toBeUndefined();
  });

  it('400 chain: filter → filter without commas → no filter (then remembers the filter is rejected)', async () => {
    const s = stubFetch((_u, i) => respond([chickenCommaDtFx, chickenNoCommaDtFx, chickenNoDtFx][i] as Fx));
    const m = await bestMatch('chicken breast, roasted', undefined, { fetch: s.fetch });
    expect(m.status).toBe('ok');
    expect(m.choice?.name).not.toMatch(/roll/i);
    expect(s.calls.map((c) => [c.url.searchParams.get('query'), c.url.searchParams.get('dataType')])).toEqual([
      ['chicken breast, roasted', FDC_DATA_TYPES],
      ['chicken breast roasted', FDC_DATA_TYPES],
      ['chicken breast, roasted', null],
    ]);
    expect(s.calls[2].url.searchParams.get('pageSize')).toBe('20');

    // The next search skips the known-bad filter: one request.
    const s2 = stubFetch(() => respond(chickenNoDtFx as Fx));
    const m2 = await bestMatch('chicken breast, roasted', undefined, { fetch: s2.fetch });
    expect(m2.status).toBe('ok');
    expect(s2.calls).toHaveLength(1);
    expect(s2.calls[0].url.searchParams.get('dataType')).toBeNull();
  });

  it('a query without commas skips the comma-free retry', async () => {
    const s = stubFetch((_u, i) => respond([chickenNoCommaDtFx, chickenNoDtFx][i] as Fx));
    const m = await bestMatch('chicken breast roasted', undefined, { fetch: s.fetch });
    expect(m.status).toBe('ok');
    expect(s.calls.map((c) => c.url.searchParams.get('dataType'))).toEqual([FDC_DATA_TYPES, null]);
  });

  it('400 on every variant → failed (and the filter is NOT marked rejected)', async () => {
    const s = stubFetch(() => respond(chickenCommaDtFx as Fx));
    expect((await bestMatch('chicken breast, roasted', undefined, { fetch: s.fetch })).status).toBe('failed');
    expect(s.calls).toHaveLength(3);
    const s2 = stubFetch(() => respond(riceFx as Fx));
    await searchFoods('rice', { fetch: s2.fetch });
    expect(s2.calls[0].url.searchParams.get('dataType')).toBe(FDC_DATA_TYPES);
  });

  it('concurrent first lookups wait for one probe instead of each burning three requests', async () => {
    const s = stubFetch((u) => respond((u.searchParams.get('dataType') ? chickenNoCommaDtFx : chickenNoDtFx) as Fx));
    const rs = await Promise.all(['chicken breast roasted', 'roasted chicken breast', 'chicken roasted'].map((q) => bestMatch(q, undefined, { fetch: s.fetch })));
    expect(rs.map((r) => r.status)).toEqual(['ok', 'ok', 'ok']);
    expect(s.calls).toHaveLength(4); // probe: filtered 400 + unfiltered; the other two: unfiltered only
  });

  it('429 → rate_limited', async () => {
    const s = stubFetch(() => new Response('{"error":{"code":"OVER_RATE_LIMIT"}}', { status: 429 }));
    const m = await bestMatch('rice, white, cooked', undefined, { fetch: s.fetch });
    expect(m).toEqual({ status: 'rate_limited', choice: null, demoKey: true });
    expect(s.calls).toHaveLength(1);
  });

  it('401 / 403 (bad or disabled USDA key) → key_rejected after ONE request: no retry, not the 400 chain', async () => {
    for (const status of [401, 403]) {
      resetUsdaDataTypeMemo();
      const s = stubFetch(() => new Response('{"error":{"code":"API_KEY_INVALID","message":"An invalid api_key was supplied."}}', { status }));
      const m = await bestMatch('chicken breast, roasted', undefined, { fetch: s.fetch });
      expect(m).toEqual({ status: 'key_rejected', choice: null, demoKey: true });
      expect(s.calls).toHaveLength(1);

      // the same once the filter is known rejected (the unfiltered request), and for the search sheet
      resetUsdaDataTypeMemo('rejected');
      const s2 = stubFetch(() => new Response('', { status }));
      expect(await searchFoods('rice', { fetch: s2.fetch })).toEqual({ status: 'key_rejected', foods: [], demoKey: true });
      expect(s2.calls).toHaveLength(1);
    }
  });

  it('5xx, network errors and non-JSON bodies → failed', async () => {
    for (const answer of [
      () => new Response('oops', { status: 503 }),
      () => Promise.reject(new TypeError('Failed to fetch')),
      () => new Response('not json', { status: 200 }),
    ]) {
      const s = stubFetch(answer);
      expect((await bestMatch('rice', undefined, { fetch: s.fetch })).status).toBe('failed');
    }
  });

  it("the caller's abort → failed", async () => {
    const ctl = new AbortController();
    const s = stubFetch(
      (_u, i) =>
        new Promise<Response>((_res, rej) => {
          const sig = s.calls[i].init?.signal;
          sig?.addEventListener('abort', () => rej(new DOMException('Aborted', 'AbortError')));
          setTimeout(() => ctl.abort(), 0);
        }),
    );
    expect((await bestMatch('rice', ctl.signal, { fetch: s.fetch })).status).toBe('failed');
    const pre = new AbortController();
    pre.abort();
    const s2 = stubFetch(() => respond(riceFx as Fx));
    expect((await searchFoods('rice', { signal: pre.signal, fetch: s2.fetch })).status).toBe('failed');
  });

  it('times out after 8 s → failed', async () => {
    vi.useFakeTimers();
    const s = stubFetch(
      (_u, i) =>
        new Promise<Response>((_res, rej) => {
          s.calls[i].init?.signal?.addEventListener('abort', () => rej(new DOMException('Aborted', 'AbortError')));
        }),
    );
    const p = bestMatch('rice', undefined, { fetch: s.fetch });
    await vi.advanceTimersByTimeAsync(7999);
    let settled = false;
    void p.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect((await p).status).toBe('failed');
  });

  it('no results → no_match; empty query → ok with no request', async () => {
    const s = stubFetch(() => respond({ status: 200, body: { totalHits: 0, foods: [] } }));
    expect((await bestMatch('zzzz', undefined, { fetch: s.fetch })).status).toBe('no_match');
    const s2 = stubFetch(() => respond(riceFx as Fx));
    expect(await searchFoods('   ', { fetch: s2.fetch })).toEqual({ status: 'ok', foods: [], demoKey: true });
    expect(s2.calls).toHaveLength(0);
  });
});

describe('the dataType probe and the per-search budget', () => {
  const CHICKEN_BODY = (chickenNoDtFx as Fx).body;
  const lightRes = (status: number, body: unknown = null) =>
    ({ status, ok: status >= 200 && status < 300, json: async () => body }) as unknown as Response;

  /** A fetch on the fake clock: each request answers after `ms` (null = never) unless its signal aborts first. */
  function timedFetch(answer: (url: URL) => { ms: number | null; status?: number; body?: unknown }) {
    const t0 = Date.now();
    const calls: { dataType: string | null; at: number }[] = [];
    const fn = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({ dataType: url.searchParams.get('dataType'), at: Date.now() - t0 });
      const a = answer(url);
      return new Promise<Response>((resolve, reject) => {
        const signal = init?.signal;
        const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
        if (signal?.aborted) return onAbort();
        signal?.addEventListener('abort', onAbort, { once: true });
        if (a.ms == null) return;
        setTimeout(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve(lightRes(a.status ?? 200, a.body));
        }, a.ms);
      });
    };
    return { fetch: fn as unknown as typeof fetch, calls };
  }

  it('the rejected-filter memo is saved on the 400s, before the probe’s unfiltered answer arrives', async () => {
    let answer!: (r: Response) => void;
    const s = stubFetch((u) => (u.searchParams.get('dataType') ? respond(chickenCommaDtFx as Fx) : new Promise<Response>((r) => (answer = r))));
    const probe = bestMatch('chicken breast, roasted', undefined, { fetch: s.fetch });
    await vi.waitFor(() => expect(s.calls).toHaveLength(3));
    // the probe's unfiltered request is still in flight, and a new search already skips the filter
    const s2 = stubFetch(() => respond(riceFx as Fx));
    expect((await searchFoods('rice, white, cooked', { fetch: s2.fetch })).status).toBe('ok');
    expect(s2.calls.map((c) => c.url.searchParams.get('dataType'))).toEqual([null]);
    answer(respond(chickenNoDtFx as Fx));
    expect((await probe).status).toBe('ok');
  });

  it('budgetMs starts once a search may send: a 5 s probe does not time out its waiters (2 s budget each)', async () => {
    vi.useFakeTimers();
    const t = timedFetch((u) => (u.searchParams.get('dataType') ? { ms: 5000, status: 400 } : { ms: 1000, body: CHICKEN_BODY }));
    const ps = ['chicken breast roasted', 'roasted chicken breast'].map((q) => bestMatch(q, undefined, { fetch: t.fetch, budgetMs: 2000 }));
    await vi.advanceTimersByTimeAsync(6000);
    expect((await Promise.all(ps)).map((r) => r.status)).toEqual(['ok', 'ok']);
    // the probe's filtered request (off the budget), then both unfiltered requests as soon as it 400'd
    expect(t.calls).toEqual([
      { dataType: FDC_DATA_TYPES, at: 0 },
      { dataType: null, at: 5000 },
      { dataType: null, at: 5000 },
    ]);
  });

  it('budgetMs bounds a search’s own requests (well before the 8 s per-request cap)', async () => {
    vi.useFakeTimers();
    resetUsdaDataTypeMemo('rejected');
    const t = timedFetch(() => ({ ms: null }));
    const p = searchFoods('rice', { fetch: t.fetch, budgetMs: 2000 });
    let settled = false;
    void p.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(1999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect((await p).status).toBe('failed');
  });

  it('a probe that ends without an answer: its waiters send the unfiltered request instead of probing in turn', async () => {
    const s = stubFetch((u) => (u.searchParams.get('dataType') ? new Response('oops', { status: 503 }) : respond(chickenNoDtFx as Fx)));
    const rs = await Promise.all(['chicken breast roasted', 'roasted chicken breast', 'chicken roasted'].map((q) => bestMatch(q, undefined, { fetch: s.fetch })));
    expect(rs.map((r) => r.status)).toEqual(['failed', 'ok', 'ok']);
    expect(s.calls.map((c) => c.url.searchParams.get('dataType'))).toEqual([FDC_DATA_TYPES, null, null]);
    // nothing was learned about the filter: the next search probes again
    const s2 = stubFetch(() => respond(riceFx as Fx));
    await searchFoods('rice', { fetch: s2.fetch });
    expect(s2.calls[0].url.searchParams.get('dataType')).toBe(FDC_DATA_TYPES);
  });

  it("the caller's abort ends a wait on someone else's probe at once (and sends nothing)", async () => {
    vi.useFakeTimers();
    const t = timedFetch(() => ({ ms: null }));
    const probe = bestMatch('chicken breast roasted', undefined, { fetch: t.fetch });
    const ctl = new AbortController();
    const waiter = bestMatch('rice', ctl.signal, { fetch: t.fetch });
    await vi.advanceTimersByTimeAsync(100);
    ctl.abort();
    expect((await waiter).status).toBe('failed');
    expect(t.calls).toHaveLength(1); // only the probe's request
    await vi.advanceTimersByTimeAsync(8000); // the probe's own request times out
    expect((await probe).status).toBe('failed');
  });
});
