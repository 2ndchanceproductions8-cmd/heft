import { describe, expect, it, vi } from 'vitest';
import nutellaFx from './__fixtures__/off-nutella.json';
import saltOnlyFx from './__fixtures__/off-salt-only.json';
import notFoundFx from './__fixtures__/off-not-found.json';
import { lookupBarcode, offServingG } from './off';

/*
 * off-nutella.json was captured from one live OFF GET on 2026-10-03; off-salt-only.json is hand-written
 * (kJ only, salt but no sodium, string values); off-not-found.json is OFF's "no such product" shape.
 */

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function stub(answer: (url: URL, i: number) => Response | Promise<Response>) {
  const calls: { url: URL; init?: RequestInit }[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    return answer(url, calls.length - 1);
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

describe('lookupBarcode', () => {
  it('Nutella: label numbers per 100 g, sodium g → mg, missing fiber → null', async () => {
    const s = stub(() => json(nutellaFx));
    const r = await lookupBarcode('3017624010701', undefined, { fetch: s.fetch });
    expect(r.status).toBe('ok');
    expect(r.food).toEqual({
      id: 'off:3017624010701',
      name: 'Nutella',
      brand: 'Ferrero',
      source: 'off',
      barcode: '3017624010701',
      per100g: { kcal: 539, proteinG: 6.3, carbsG: 57.5, fatG: 30.9, fiberG: null, sugarG: 56.3, sodiumMg: 43 },
      servingG: null,
    });
    const { url, init } = s.calls[0];
    expect(url.href).toBe(
      'https://world.openfoodfacts.org/api/v2/product/3017624010701.json?fields=code,product_name,brands,nutriments,serving_quantity,serving_quantity_unit,serving_size',
    );
    expect(init?.headers).toBeUndefined();
    expect(init?.method ?? 'GET').toBe('GET');
  });

  it('kJ-only energy, salt-only sodium, string values, serving_quantity in g', async () => {
    const s = stub(() => json(saltOnlyFx));
    const r = await lookupBarcode('4006381333931', undefined, { fetch: s.fetch });
    expect(r.status).toBe('ok');
    const p = r.food!.per100g;
    expect(p.kcal).toBeCloseTo(167 / 4.184, 1);
    expect(p.sodiumMg).toBe(360); // 0.9 g salt / 2.5 = 0.36 g sodium
    expect(p.sugarG).toBe(0.4);
    expect(p.fiberG).toBeNull();
    expect(r.food).toMatchObject({ name: 'Chicken noodle soup (hand-written fixture)', brand: 'Test Kitchen', servingG: 245 });
  });

  it('status 0 → not_found (HTTP 200 or OFF’s HTTP 404 form)', async () => {
    for (const status of [200, 404]) {
      const s = stub(() => json(notFoundFx, status));
      expect(await lookupBarcode('0000000000000', undefined, { fetch: s.fetch })).toEqual({ status: 'not_found', food: null });
      expect(s.calls).toHaveLength(1);
    }
  });

  it('a 12-digit UPC-A that is not found is retried once as EAN-13 with a leading 0', async () => {
    const s = stub((_u, i) => (i === 0 ? json(notFoundFx, 404) : json(nutellaFx)));
    const r = await lookupBarcode('036000291452', undefined, { fetch: s.fetch });
    expect(r.status).toBe('ok');
    expect(s.calls.map((c) => c.url.pathname)).toEqual(['/api/v2/product/036000291452.json', '/api/v2/product/0036000291452.json']);
    expect(r.food?.id).toBe('off:036000291452'); // keyed by the code that was scanned (the offline cache looks it up by that)

    const s2 = stub(() => json(notFoundFx, 404));
    expect((await lookupBarcode('036000291452', undefined, { fetch: s2.fetch })).status).toBe('not_found');
    expect(s2.calls).toHaveLength(2);
  });

  it('network errors, timeouts, 5xx and HTML error pages → unavailable (never not_found)', async () => {
    for (const answer of [
      () => Promise.reject(new TypeError('Load failed')),
      () => new Response('<html>502 Bad Gateway</html>', { status: 502 }),
      () => new Response('<html>Too many requests</html>', { status: 429 }),
      () => new Response('<html>Not Found</html>', { status: 404 }),
      () => new Response('{"status":1}', { status: 200 }), // no product object
    ]) {
      const s = stub(answer);
      expect(await lookupBarcode('3017624010701', undefined, { fetch: s.fetch })).toEqual({ status: 'unavailable', food: null });
    }
  });

  it('times out after 8 s → unavailable; an aborted signal → unavailable', async () => {
    vi.useFakeTimers();
    try {
      const s = stub(
        (_u, i) =>
          new Promise<Response>((_res, rej) => {
            s.calls[i].init?.signal?.addEventListener('abort', () => rej(new DOMException('Aborted', 'AbortError')));
          }),
      );
      const p = lookupBarcode('3017624010701', undefined, { fetch: s.fetch });
      await vi.advanceTimersByTimeAsync(8001);
      expect((await p).status).toBe('unavailable');
    } finally {
      vi.useRealTimers();
    }
    const ctl = new AbortController();
    ctl.abort();
    const s2 = stub((_u, i) =>
      s2.calls[i].init?.signal?.aborted ? Promise.reject(new DOMException('Aborted', 'AbortError')) : json(nutellaFx),
    );
    expect((await lookupBarcode('3017624010701', ctl.signal, { fetch: s2.fetch })).status).toBe('unavailable');
  });

  it('a found product without any energy value → not_found', async () => {
    const s = stub(() => json({ status: 1, product: { product_name: 'Mystery', nutriments: { proteins_100g: 3 } } }));
    expect((await lookupBarcode('3017624010701', undefined, { fetch: s.fetch })).status).toBe('not_found');
  });
});

describe('offServingG', () => {
  it('uses serving_quantity only for grams, else parses serving_size', () => {
    expect(offServingG({ serving_quantity: 15, serving_quantity_unit: 'g' })).toBe(15);
    expect(offServingG({ serving_quantity: '30' })).toBe(30);
    expect(offServingG({ serving_quantity: 250, serving_quantity_unit: 'ml', serving_size: '250 ml' })).toBeNull();
    expect(offServingG({ serving_quantity: 250, serving_quantity_unit: 'ml', serving_size: '1 can (250 ml) 260 g' })).toBe(260);
    expect(offServingG({ serving_size: '15 g' })).toBe(15);
    expect(offServingG({ serving_size: '2 tbsp (37g)' })).toBe(37);
    expect(offServingG({ serving_size: '5 mg' })).toBeNull();
    expect(offServingG({})).toBeNull();
  });
});
