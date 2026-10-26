import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import riceFx from './__fixtures__/usda-rice.json';
import { decodeFoodIndex, FOOD_INDEX_VERSION, type FoodIndexFile } from './fdcData';
import { brandWords, loadFoodIndex, loadedFoodIndex, matchStem, matchStems, portionsFor, prepareFoods, resetFoodIndex, type FoodIndex } from './foodIndex';
import { FOOD_INDEX_FILE, FOOD_INDEX_FOODS, FOOD_INDEX_SOURCES } from './foodIndexMeta';
import { bestMatch, findFoods, resetUsdaDataTypeMemo, searchLocal } from './usda';

/*
 * The bundled offline index: the committed file itself, word matching, local ranking on the REAL index (the same
 * queries the live-API ranking tests use), the loader, and the fallback order index → live API.
 */

const indexPath = fileURLToPath(new URL(`../../../public/${FOOD_INDEX_FILE}`, import.meta.url));
const file = JSON.parse(readFileSync(indexPath, 'utf8')) as FoodIndexFile;
const index: FoodIndex = prepareFoods(decodeFoodIndex(file));
const local = async () => index;
const names = (q: string, prefix = false) => searchLocal(index, q, { prefix }).foods.map((f) => f.name);

/** A fetch that records calls and answers with the USDA rice fixture (or fails the request). */
function apiStub(answer: 'rice' | 'network' | 429 = 'rice') {
  const calls: string[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    calls.push(String(input));
    if (answer === 'network') throw new TypeError('Failed to fetch');
    if (answer === 429) return new Response('', { status: 429 });
    return new Response(JSON.stringify((riceFx as { body: unknown }).body), { status: 200 });
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

beforeEach(() => resetUsdaDataTypeMemo('ok'));
afterEach(() => {
  resetFoodIndex();
  vi.unstubAllGlobals();
});

describe('the committed index (public/ + foodIndexMeta.ts)', () => {
  it('decodes completely, matches its pointer, and stays small', () => {
    expect(file.v).toBe(FOOD_INDEX_VERSION);
    expect(index.foods).toHaveLength(FOOD_INDEX_FOODS);
    expect(file.foods).toHaveLength(FOOD_INDEX_FOODS); // no row was skipped as malformed
    expect(file.sources).toEqual(FOOD_INDEX_SOURCES);
    expect(FOOD_INDEX_SOURCES.map((s) => s.dataType)).toEqual(['Foundation', 'SR Legacy', 'Survey (FNDDS)']);
    expect(new Set(index.foods.map((f) => f.fdcId)).size).toBe(FOOD_INDEX_FOODS);
    expect(FOOD_INDEX_FILE).toMatch(/^food-index\.[0-9a-f]{10}\.json$/);
    // Macros + portions only: whole foods without Branded rows stay under ~2 MB raw (~400 kB gzipped).
    expect(statSync(indexPath).size).toBeLessThan(2.3e6);
  });

  it('holds the USDA rows the live API returns for the same fdcId', () => {
    // Same numbers as usda-rice.json / usda-chicken-nodt.json (recorded from the API 2026-10-03).
    expect(index.byId.get(168878)).toMatchObject({ per100g: { kcal: 130, proteinG: 2.69, carbsG: 28.2, fatG: 0.28 }, portions: [{ label: '1 cup', grams: 158 }] });
    expect(index.byId.get(171477)?.per100g.kcal).toBe(165);
  });
});

describe('word matching', () => {
  it('matchStem: plurals meet their singular; ss / us / is words keep their s', () => {
    for (const [a, b] of [
      ['eggs', 'egg'],
      ['tomatoes', 'tomato'],
      ['berries', 'berry'],
      ['cookies', 'cookie'],
      ['peaches', 'peach'],
      ['fries', 'fry'],
    ]) {
      expect(matchStem(a)).toBe(matchStem(b));
    }
    expect(matchStem('swiss')).toBe('swiss');
    expect(matchStem('hummus')).toBe('hummus');
    expect(matchStem('glutinous')).toBe('glutinous');
  });

  it('matchStems: a negated word never matches ("no cheese", "without salt", "skin not eaten")', () => {
    expect(matchStems(['pizza', 'no', 'cheese', 'thin', 'crust'])).toEqual(['pizza', 'no', '', 'thin', 'crust']);
    expect(matchStems(['skin', 'not', 'eaten'])[0]).toBe('');
    expect(matchStems(['without', 'salt'])[1]).toBe('');
  });

  it('brandWords: an all-caps segment, not USDA vocabulary', () => {
    expect(brandWords("McDONALD'S, french fries")).toEqual(['mcdonald', 's']);
    expect(brandWords('Yogurt, Greek, nonfat, plain, CHOBANI')).toEqual(['chobani']);
    expect(brandWords('Rice, fried, NFS')).toEqual([]);
    expect(brandWords('Chicken, broiler, rotisserie, BBQ, breast, meat only')).toEqual([]);
  });
});

describe('searchLocal (real index)', () => {
  it('chicken breast, roasted → the plain roasted breast (the live ranking pick), not a roll or deli slices', () => {
    for (const q of ['chicken breast, roasted', 'chicken breast roasted']) {
      const r = searchLocal(index, q);
      expect(r.good).toBe(true);
      expect(r.foods[0]).toMatchObject({ fdcId: 171477, id: 'usda:171477', source: 'usda', bundled: true, servingG: null, dataType: 'SR Legacy' });
      expect(r.foods[0].portions?.length).toBeGreaterThan(0);
    }
  });

  it('rice, white, cooked → plain cooked white rice (130 kcal), not glutinous or salted', () => {
    const r = searchLocal(index, 'rice, white, cooked');
    expect(r.good).toBe(true);
    expect(r.foods[0].per100g.kcal).toBe(130);
    expect(r.foods[0].name).not.toMatch(/glutinous|salt/i);
  });

  it('"rice" as you type: foods whose head noun is rice come first', () => {
    const r = searchLocal(index, 'rice', { prefix: true });
    expect(r.good).toBe(true);
    expect(r.foods).toHaveLength(25);
    for (const n of r.foods.slice(0, 10).map((f) => f.name)) expect(n).toMatch(/^Rice,/);
  });

  it('prefix: the last word may be partial, and a processed word the prefix filled in ranks down', () => {
    const top = names('chicken bre', true).slice(0, 3);
    expect(top[0]).toMatch(/breast/i);
    for (const n of top) expect(n).not.toMatch(/breaded/i);
    expect(searchLocal(index, 'chicken bre').good).toBe(false); // no prefix for grounding: "bre" must be a word
  });

  it('plurals, single digits and concentrated forms', () => {
    expect(searchLocal(index, 'eggs, scrambled').foods[0].fdcId).toBe(172187); // Egg, whole, cooked, scrambled
    expect(names('milk, 2%')[0]).toMatch(/2%/);
    expect(names('orange juice')[0]).not.toMatch(/concentrate/i);
    expect(names('blueberries')[0]).toBe('Blueberries, raw');
  });

  it('cooking words: the exact word first, a same-method word ("grilled" ~ "roasted", "steamed" ~ "boiled") still good', () => {
    expect(names('chicken breast, grilled')[0]).toMatch(/grilled/);
    const broccoli = searchLocal(index, 'broccoli, steamed');
    expect(broccoli.good).toBe(true);
    expect(broccoli.foods[0].name).toMatch(/^Broccoli, .*cooked/);
  });

  it('negation and brands: no "no cheese" pizza for cheese pizza; restaurant rows only when named', () => {
    for (const n of names('pizza, cheese')) expect(n).not.toMatch(/no cheese/i);
    for (const n of names('french fries').slice(0, 5)) expect(brandWords(n)).toEqual([]); // not DENNY'S, WENDY'S, …
    expect(names('chobani greek yogurt')[0]).toMatch(/CHOBANI/);
  });

  it('no good match: partial matches (half the words or more) come back flagged not good; stopword-only finds nothing', () => {
    const partial = searchLocal(index, 'chicken zzzqx');
    expect(partial.good).toBe(false);
    expect(partial.foods.length).toBeGreaterThan(0);
    expect(searchLocal(index, 'quinoa salad with feta zzzqx').foods).toEqual([]);
    expect(searchLocal(index, 'raw')).toEqual({ foods: [], good: false });
  });
});

describe('loadFoodIndex', () => {
  const body = () => new Response(JSON.stringify(file), { status: 200 });

  it("fetches the hashed file next to the page once; concurrent callers share the request; portions by fdcId", async () => {
    vi.stubGlobal('location', { href: 'https://example.test/heft/index.html' });
    const doFetch = vi.fn(async () => body());
    const [a, b] = await Promise.all([loadFoodIndex(doFetch as unknown as typeof fetch), loadFoodIndex(doFetch as unknown as typeof fetch)]);
    expect(doFetch).toHaveBeenCalledTimes(1);
    expect(String((doFetch.mock.calls[0] as unknown[])[0])).toMatch(new RegExp(`^https://example\\.test/.*${FOOD_INDEX_FILE.replace(/\./g, '\\.')}$`));
    expect(a).toBe(b);
    expect(a?.foods).toHaveLength(FOOD_INDEX_FOODS);
    expect(loadedFoodIndex()).toBe(a);
    expect(await loadFoodIndex(doFetch as unknown as typeof fetch)).toBe(a);
    expect(doFetch).toHaveBeenCalledTimes(1);
    expect(portionsFor(168878)).toEqual([{ label: '1 cup', grams: 158 }]);
    expect(portionsFor(undefined)).toEqual([]);
  });

  it('a failed load (offline, 404, another version) resolves null and the next call tries again', async () => {
    vi.stubGlobal('location', { href: 'https://example.test/heft/' });
    const answers = [
      () => Promise.reject(new TypeError('Failed to fetch')),
      () => Promise.resolve(new Response('', { status: 404 })),
      () => Promise.resolve(new Response(JSON.stringify({ ...file, v: FOOD_INDEX_VERSION + 1 }), { status: 200 })),
      () => Promise.resolve(body()),
    ];
    const doFetch = vi.fn(() => answers.shift()!()) as unknown as typeof fetch;
    expect(await loadFoodIndex(doFetch)).toBeNull();
    expect(await loadFoodIndex(doFetch)).toBeNull();
    expect(await loadFoodIndex(doFetch)).toBeNull();
    expect(portionsFor(168878)).toEqual([]);
    expect((await loadFoodIndex(doFetch))?.foods).toHaveLength(FOOD_INDEX_FOODS);
  });
});

describe('fallback order: bundled index → live API', () => {
  it('bestMatch: a good local match answers with no request (and no DEMO_KEY flag)', async () => {
    const api = apiStub();
    const m = await bestMatch('chicken breast, roasted', undefined, { fetch: api.fetch, localIndex: local });
    expect(m).toMatchObject({ status: 'ok', demoKey: false, choice: { fdcId: 171477, bundled: true } });
    expect(api.calls).toHaveLength(0);
  });

  it('bestMatch: no good local match → the live API (the index never answers with a partial match)', async () => {
    const api = apiStub();
    const m = await bestMatch('rice zzzqx', undefined, { fetch: api.fetch, localIndex: local });
    expect(api.calls).toHaveLength(1);
    expect(new URL(api.calls[0]).searchParams.get('query')).toBe('rice zzzqx');
    expect(m.status).toBe('ok');
    expect(m.choice?.bundled).toBeUndefined();

    const busy = apiStub(429);
    expect(await bestMatch('rice zzzqx', undefined, { fetch: busy.fetch, localIndex: local })).toEqual({ status: 'rate_limited', choice: null, demoKey: true });
  });

  it('bestMatch: index unavailable (offline before its first load) → the live API, exactly as before', async () => {
    const api = apiStub();
    const m = await bestMatch('rice, white, cooked', undefined, { fetch: api.fetch, localIndex: async () => null });
    expect(api.calls).toHaveLength(1);
    expect(m.choice?.per100g.kcal).toBe(130);
  });

  it('findFoods: good local matches → bundled, no request, no live wait', async () => {
    const api = apiStub();
    const onLive = vi.fn();
    const r = await findFoods('chicken bre', { fetch: api.fetch, localIndex: local, liveDelayMs: 10_000, onLive });
    expect(r).toMatchObject({ status: 'ok', from: 'bundled', demoKey: false });
    expect(r.apiStatus).toBeUndefined();
    expect(r.foods[0].name).toMatch(/breast/i);
    expect(api.calls).toHaveLength(0);
    expect(onLive).not.toHaveBeenCalled();
  });

  it('findFoods: partial local matches → the live API; its foods win, and its failure shows the partial matches', async () => {
    const ok = apiStub();
    const onLive = vi.fn();
    const live = await findFoods('rice zzzqx', { fetch: ok.fetch, localIndex: local, onLive });
    expect(onLive).toHaveBeenCalledTimes(1);
    expect(live).toMatchObject({ status: 'ok', from: 'api' });
    expect(live.foods[0].bundled).toBeUndefined();

    const offline = apiStub('network');
    const r = await findFoods('rice zzzqx', { fetch: offline.fetch, localIndex: local });
    expect(offline.calls).toHaveLength(1);
    expect(r).toMatchObject({ status: 'ok', from: 'bundled', apiStatus: 'failed' });
    expect(r.foods.length).toBeGreaterThan(0);
    expect(r.foods.every((f) => f.bundled && /rice/i.test(f.name))).toBe(true);

    // nothing local either → the API's own outcome
    expect(await findFoods('zzzqx', { fetch: offline.fetch, localIndex: local })).toMatchObject({ status: 'failed', from: 'api', foods: [] });
  });

  it('findFoods online (Search USDA online) skips the index; an abort during the live wait sends nothing', async () => {
    const api = apiStub();
    const loader = vi.fn(local);
    const r = await findFoods('rice, white, cooked', { fetch: api.fetch, localIndex: loader, online: true });
    expect(loader).not.toHaveBeenCalled();
    expect(r.from).toBe('api');
    expect(api.calls).toHaveLength(1);

    const ctrl = new AbortController();
    const pending = findFoods('rice zzzqx', { fetch: api.fetch, localIndex: local, liveDelayMs: 5000, signal: ctrl.signal });
    ctrl.abort();
    expect((await pending).status).toBe('failed');
    expect(api.calls).toHaveLength(1);
  });
});
