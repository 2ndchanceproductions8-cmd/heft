import { timeoutSignal } from './usda';
import type { FoodChoice, Per100g } from './types';

/*
 * Open Food Facts barcode lookup (ported from SnapPlate app/lib/off.ts) — the manufacturer's own label, the
 * highest-accuracy path for anything with a barcode. Free, no key.
 *
 * GET only and NO custom headers (OFF asks server clients for a User-Agent, but a browser can't set one and an
 * extra header would force a CORS preflight). "not_found" is ONLY ever OFF saying "no such product"; any
 * network error, timeout or unexpected HTTP status is "unavailable", so the UI never tells the user a product
 * doesn't exist when we simply couldn't ask.
 */

const OFF_PRODUCT_URL = 'https://world.openfoodfacts.org/api/v2/product/';
const OFF_FIELDS = 'code,product_name,brands,nutriments,serving_quantity,serving_quantity_unit,serving_size';
export const OFF_TIMEOUT_MS = 8000;

export type OffStatus = 'ok' | 'not_found' | 'unavailable';

type OffNutriments = Record<string, number | string | undefined>;

export interface OffProduct {
  code?: string;
  product_name?: string;
  brands?: string;
  nutriments?: OffNutriments;
  serving_quantity?: number | string;
  serving_quantity_unit?: string;
  serving_size?: string;
}

function num(v: unknown): number | null {
  const n = typeof v === 'string' ? parseFloat(v.replace(',', '.')) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/** Label nutrients per 100 g, or null when the product has no energy value at all. */
export function offPer100g(n: OffNutriments | undefined): Per100g | null {
  if (!n) return null;
  const kcal = num(n['energy-kcal_100g']);
  const kj = num(n['energy-kj_100g']) ?? num(n['energy_100g']); // OFF's plain "energy" is kJ
  const energy = kcal ?? (kj != null ? kj / 4.184 : null);
  if (energy == null) return null;
  const pos = (v: number | null) => (v == null ? null : Math.max(0, v));
  // sodium_100g is GRAMS per 100 g; salt is 2.5 × sodium.
  const sodiumG = num(n['sodium_100g']) ?? (num(n['salt_100g']) != null ? num(n['salt_100g'])! / 2.5 : null);
  return {
    kcal: r2(Math.max(0, energy)),
    proteinG: pos(num(n['proteins_100g'])) ?? 0,
    carbsG: pos(num(n['carbohydrates_100g'])) ?? 0,
    fatG: pos(num(n['fat_100g'])) ?? 0,
    fiberG: pos(num(n['fiber_100g'])),
    sugarG: pos(num(n['sugars_100g'])),
    sodiumMg: sodiumG == null ? null : r2(Math.max(0, sodiumG) * 1000),
  };
}

/** Label serving in grams: serving_quantity when its unit is g (or unstated), else "15 g" in serving_size. */
export function offServingG(p: Pick<OffProduct, 'serving_quantity' | 'serving_quantity_unit' | 'serving_size'>): number | null {
  const unit = (p.serving_quantity_unit ?? '').trim().toLowerCase();
  const q = num(p.serving_quantity);
  if (q != null && q > 0 && (unit === '' || unit === 'g')) return q;
  const m = /(\d+(?:[.,]\d+)?)\s*(?:g|gr|grams?)\b/i.exec(p.serving_size ?? '');
  const g = m ? num(m[1]) : null;
  return g != null && g > 0 ? g : null;
}

/** An OFF product as a FoodChoice (id 'off:<code>'), or null when it has no usable nutrition. */
export function choiceFromOff(code: string, p: OffProduct): FoodChoice | null {
  const per100g = offPer100g(p.nutriments);
  if (!per100g) return null;
  const brand = (p.brands ?? '').split(',')[0]?.trim() || undefined;
  const name = p.product_name?.trim() || (brand ? `${brand} product` : 'Packaged food');
  return { id: `off:${code}`, name, brand, source: 'off', barcode: code, per100g, servingG: offServingG(p) };
}

type Fetched = { kind: 'found'; product: OffProduct } | { kind: 'not_found' } | { kind: 'unavailable' };

async function fetchProduct(code: string, doFetch: typeof fetch, outer?: AbortSignal): Promise<Fetched> {
  const t = timeoutSignal(OFF_TIMEOUT_MS, outer);
  try {
    const res = await doFetch(`${OFF_PRODUCT_URL}${encodeURIComponent(code)}.json?fields=${OFF_FIELDS}`, { signal: t.signal });
    // OFF answers an unknown code with HTTP 404 + {"status":0}; any other non-200 is an outage.
    if (!res.ok && res.status !== 404) return { kind: 'unavailable' };
    let data: { status?: number | string; product?: OffProduct } | null = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (data && (data.status === 0 || data.status === '0')) return { kind: 'not_found' };
    if (res.ok && data && (data.status === 1 || data.status === '1') && data.product) return { kind: 'found', product: data.product };
    return { kind: 'unavailable' };
  } catch {
    return { kind: 'unavailable' };
  } finally {
    t.done();
  }
}

/** Open Food Facts product lookup. `not_found` = OFF answered "no such product"; `unavailable` = network/HTTP failure. */
export async function lookupBarcode(
  code: string,
  signal?: AbortSignal,
  deps: { fetch?: typeof fetch } = {},
): Promise<{ status: OffStatus; food: FoodChoice | null }> {
  const digits = code.replace(/\D/g, '');
  if (!digits) return { status: 'not_found', food: null };
  const doFetch = deps.fetch ?? ((input, init) => fetch(input, init));

  let r = await fetchProduct(digits, doFetch, signal);
  // A UPC-A is stored by some OFF entries as its 13-digit EAN form.
  if (r.kind === 'not_found' && digits.length === 12) r = await fetchProduct('0' + digits, doFetch, signal);

  if (r.kind === 'unavailable') return { status: 'unavailable', food: null };
  if (r.kind === 'not_found') return { status: 'not_found', food: null };
  // Found, but without any energy value: nothing we can log from it.
  const food = choiceFromOff(digits, r.product);
  return food ? { status: 'ok', food } : { status: 'not_found', food: null };
}
