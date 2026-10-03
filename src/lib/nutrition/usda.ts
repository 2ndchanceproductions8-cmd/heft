import { FDC_DEMO_KEY, fdcKeyOrDemo } from './keys';
import type { FoodChoice, LookupStatus, Per100g } from './types';

/*
 * USDA FoodData Central grounding (ported from SnapPlate app/lib/usda.ts).
 *
 * Claude identifies the food and estimates its weight; this module supplies the NUMBERS from USDA, so
 * calories/macros never come from the model's memory. That split is the single biggest accuracy win.
 *
 * Browser rules: GET only, the query built with URLSearchParams, NO custom headers (a simple request needs no
 * CORS preflight). The key is the user's own FDC key or the public DEMO_KEY (keys.ts) and is never logged.
 *
 * The dataType 400 (the SnapPlate "chicken breast, roasted" bug). Measured 2026-10-03 with DEMO_KEY: every GET
 * whose dataType list contains "Survey (FNDDS)" is answered with an nginx "400 Bad Request", whatever the
 * encoding (%28/%29 or raw parens, %2C or literal commas) and with or without commas in the query.
 * "Foundation,SR Legacy" works; "Survey" alone is silently ignored; no dataType at all works and includes
 * FNDDS. So the chain below is: SnapPlate's filter → (400) the same without commas in the query → (400) no
 * dataType filter, with Branded results pushed down the ranking. Once the unfiltered request succeeds after
 * the filtered ones 400'd, the filter is remembered as rejected (module + localStorage, 3 days) and later
 * searches go straight to the unfiltered request: with DEMO_KEY's ~10 requests an hour, three requests per
 * item would rate-limit the second meal of the hour.
 */

const FDC_SEARCH_URL = 'https://api.nal.usda.gov/fdc/v1/foods/search';
/** SnapPlate's filter: whole-food data types only (no Branded). */
export const FDC_DATA_TYPES = 'Foundation,SR Legacy,Survey (FNDDS)';
/** Per-request timeout (combined with the caller's signal). */
export const USDA_TIMEOUT_MS = 8000;
const DEFAULT_PAGE_SIZE = 12;
/** The unfiltered request may return Branded rows; ask for a few more so whole foods still make the page. */
const UNFILTERED_PAGE_SIZE = 20;

/** Standard USDA nutrient numbers (values are per 100 g for Foundation / SR Legacy / FNDDS / Branded). */
export const NUTRIENT = {
  energy: '208', // Energy (kcal)
  energyAtwaterGeneral: '957', // Energy (Atwater General Factors), kcal — Foundation foods often lack 208
  energyAtwaterSpecific: '958', // Energy (Atwater Specific Factors), kcal
  protein: '203',
  fat: '204',
  carbs: '205', // Carbohydrate, by difference
  fiber: '291', // Fiber, total dietary
  sugar: '269', // Sugars, total
  sodium: '307', // Sodium, Na (mg)
} as const;

export type UsdaStatus = 'ok' | 'rate_limited' | 'failed';

export interface UsdaSearchResult {
  status: UsdaStatus;
  foods: FoodChoice[];
  /** True when the request used USDA's shared DEMO_KEY (no personal key saved). */
  demoKey: boolean;
}

/** Raw shapes from the FDC search response (only the fields we read). */
export interface FdcNutrient {
  nutrientNumber?: string | number;
  nutrientName?: string;
  unitName?: string;
  value?: number;
}

export interface FdcFood {
  fdcId?: number;
  description?: string;
  dataType?: string;
  brandOwner?: string;
  brandName?: string;
  servingSize?: number;
  servingSizeUnit?: string;
  foodNutrients?: FdcNutrient[];
}

// ------------------------------------------------------------------ ranking

// Whole-food data types are cleaner than survey/branded entries; used to break ties when relevance is close.
const DATATYPE_PRIORITY: Record<string, number> = {
  Foundation: 3,
  'SR Legacy': 2,
  'Survey (FNDDS)': 1,
};
/** Only reachable through the unfiltered fallback request: a label product is a last resort for a photo. */
const BRANDED_PENALTY = 0.8;

const STOPWORDS = new Set(['and', 'with', 'the', 'a', 'of', 'in', 'raw', 'fresh']);

// Words that signal a processed / deli / restaurant variant. When these appear in a candidate but not in the
// query, they usually mean it's the wrong entry ("chicken breast ROLL", "SLICED, fat-free").
const PROCESSED_MARKERS = new Set([
  'roll',
  'sliced',
  'slices',
  'deli',
  'luncheon',
  'lunchmeat',
  'canned',
  'restaurant',
  'nugget',
  'nuggets',
  'patty',
  'patties',
  'breaded',
  'prepackaged',
  'processed',
  'cured',
  'smoked',
  'loaf',
  'spread',
]);

// Milder: specialty varieties and formulations a plain query didn't ask for ("rice, white, cooked" should not
// pick GLUTINOUS rice at 97 kcal over regular rice at 130; "with salt" adds ~380 mg sodium per 100 g).
const SPECIALTY_MARKERS = new Set([
  'glutinous',
  'parboiled',
  'instant',
  'precooked',
  'dehydrated',
  'salt',
  'babyfood',
  'baby',
  'infant',
  'toddler',
  'imitation',
  'substitute',
  'free',
  'reduced',
  'lowfat',
  'nonfat',
  'light',
  'diet',
  'fortified',
  'skin', // "chicken breast" means the meat; Claude says "with skin" when it sees skin
]);

const COOKED_WORDS = new Set([
  'cooked',
  'roasted',
  'baked',
  'grilled',
  'boiled',
  'fried',
  'steamed',
  'broiled',
  'sauteed',
  'braised',
  'poached',
  'scrambled',
  'toasted',
  'microwaved',
  'stewed',
  'simmered',
]);
const UNCOOKED_WORDS = new Set(['raw', 'uncooked', 'dry']);

function allTokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/\b(without|no)\s+salt(\s+added)?\b/g, ' ') // "without salt" is the PLAIN version, not a salty one
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Lowercase search tokens without stopwords (exported for tests). */
export function tokens(s: string): string[] {
  return allTokens(s).filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/**
 * Score a candidate against the query; higher is better. Token overlap with the query, minus a little for
 * every extra word (long descriptions tend to be over-specific processed variants), plus a data-type nudge
 * and USDA's own relevance rank; minus penalties for processed / specialty words the query didn't ask for,
 * for a raw-vs-cooked mismatch, and for Branded rows.
 */
export function scoreCandidate(query: string, food: Pick<FdcFood, 'description' | 'dataType'>, rank: number): number {
  const qTokens = tokens(query);
  const dTokens = tokens(food.description || '');
  if (!qTokens.length || !dTokens.length) return -rank;

  const dSet = new Set(dTokens);
  const qSet = new Set(qTokens);
  const overlap = qTokens.filter((t) => dSet.has(t)).length / qTokens.length;
  const extra = Math.max(0, dTokens.length - qTokens.length);
  const dtBonus = (DATATYPE_PRIORITY[food.dataType || ''] || 0) * 0.15;
  const rankBonus = Math.max(0, 1 - rank * 0.05);
  const processed = dTokens.filter((t) => PROCESSED_MARKERS.has(t) && !qSet.has(t)).length;
  const specialty = dTokens.filter((t) => SPECIALTY_MARKERS.has(t) && !qSet.has(t)).length;

  // Raw vs cooked mismatch (uses the full token lists: "raw" is a stopword for overlap purposes).
  const qAll = new Set(allTokens(query));
  const dAll = new Set(allTokens(food.description || ''));
  const qCooked = [...qAll].some((t) => COOKED_WORDS.has(t));
  const qRaw = [...qAll].some((t) => UNCOOKED_WORDS.has(t));
  const dCooked = [...dAll].some((t) => COOKED_WORDS.has(t));
  const dRaw = [...dAll].some((t) => UNCOOKED_WORDS.has(t));
  // FNDDS says "roasted ... from raw": a row with both words is a cooked food.
  const stateMismatch = (qCooked && !qRaw && dRaw && !dCooked) || (qRaw && !qCooked && dCooked && !dRaw) ? 1 : 0;

  const branded = food.dataType === 'Branded' ? BRANDED_PENALTY : 0;

  return (
    overlap * 2 +
    dtBonus +
    rankBonus * 0.5 -
    extra * 0.08 -
    processed * 0.6 -
    specialty * 0.4 -
    stateMismatch * 0.5 -
    branded
  );
}

// ------------------------------------------------------------------ nutrients

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Per-100 g nutrients from an FDC nutrient list. Energy: 208, else 957, else 958 (Atwater), else null (the row
 * is unusable). Fiber / sugar / sodium that aren't listed are null (unknown), never 0. Negative values (USDA's
 * "carbohydrate by difference" can be slightly negative) are clamped to 0.
 */
export function extractPer100g(nutrients: FdcNutrient[]): Per100g | null {
  const byNumber = new Map<string, number>();
  for (const n of nutrients) {
    const num = n.nutrientNumber == null ? '' : String(n.nutrientNumber);
    if (num && finite(n.value) && !byNumber.has(num)) byNumber.set(num, n.value);
  }
  const get = (num: string): number | null => (byNumber.has(num) ? Math.max(0, byNumber.get(num)!) : null);
  const energy = get(NUTRIENT.energy) ?? get(NUTRIENT.energyAtwaterGeneral) ?? get(NUTRIENT.energyAtwaterSpecific);
  if (energy == null) return null;
  return {
    kcal: energy,
    proteinG: get(NUTRIENT.protein) ?? 0,
    carbsG: get(NUTRIENT.carbs) ?? 0,
    fatG: get(NUTRIENT.fat) ?? 0,
    fiberG: get(NUTRIENT.fiber),
    sugarG: get(NUTRIENT.sugar),
    sodiumMg: get(NUTRIENT.sodium),
  };
}

/** "CHICKEN BREAST, GRILLED" → "Chicken Breast, Grilled" (Branded descriptions are all caps). */
function tidyName(s: string): string {
  const t = s.trim();
  if (/[A-Z]/.test(t) && t === t.toUpperCase()) {
    return t.toLowerCase().replace(/(^|[\s,(/-])([a-z])/g, (_m, p: string, c: string) => p + c.toUpperCase());
  }
  return t;
}

/** One FDC row as a FoodChoice, or null when it has no usable energy value. */
export function choiceFromFdc(food: FdcFood): FoodChoice | null {
  if (!finite(food.fdcId)) return null;
  const per100g = extractPer100g(food.foodNutrients ?? []);
  if (!per100g) return null;
  const unit = (food.servingSizeUnit ?? '').toLowerCase();
  const servingG = finite(food.servingSize) && food.servingSize > 0 && (unit === 'g' || unit === 'grm') ? food.servingSize : null;
  const brand = food.dataType === 'Branded' ? tidyName(food.brandName || food.brandOwner || '') || undefined : undefined;
  return {
    id: `usda:${food.fdcId}`,
    name: tidyName(food.description || '') || `USDA food ${food.fdcId}`,
    brand,
    source: 'usda',
    fdcId: food.fdcId,
    per100g,
    servingG,
    dataType: food.dataType || undefined,
  };
}

/** Rank FDC rows for a query (best first), dropping rows without energy and duplicate fdcIds. */
export function rankFoods(query: string, foods: FdcFood[]): FoodChoice[] {
  const scored = foods
    .map((food, i) => ({ food, score: scoreCandidate(query, food, i) }))
    .sort((a, b) => b.score - a.score);
  const out: FoodChoice[] = [];
  const seen = new Set<number>();
  for (const { food } of scored) {
    const c = choiceFromFdc(food);
    if (c && !seen.has(c.fdcId!)) {
      seen.add(c.fdcId!);
      out.push(c);
    }
  }
  return out;
}

// ------------------------------------------------------------------ requests

/** A signal that aborts after `ms` or when `outer` aborts. Call done() to release the timer + listener. */
export function timeoutSignal(ms: number, outer?: AbortSignal): { signal: AbortSignal; done: () => void } {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  const onAbort = () => ctl.abort();
  if (outer) {
    if (outer.aborted) ctl.abort();
    else outer.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: ctl.signal,
    done: () => {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onAbort);
    },
  };
}

type Attempt = { kind: 'ok'; foods: FdcFood[] } | { kind: 'bad_request' } | { kind: 'rate_limited' } | { kind: 'failed' };

async function fdcGet(
  query: string,
  pageSize: number,
  dataType: string | null,
  apiKey: string,
  doFetch: typeof fetch,
  outer?: AbortSignal,
): Promise<Attempt> {
  const params = new URLSearchParams({ api_key: apiKey, query, pageSize: String(pageSize) });
  if (dataType) params.set('dataType', dataType);
  const t = timeoutSignal(USDA_TIMEOUT_MS, outer);
  try {
    const res = await doFetch(`${FDC_SEARCH_URL}?${params.toString()}`, { signal: t.signal });
    if (res.status === 429) return { kind: 'rate_limited' };
    if (res.status === 400) return { kind: 'bad_request' };
    if (!res.ok) return { kind: 'failed' };
    const data = (await res.json()) as { foods?: FdcFood[] };
    return { kind: 'ok', foods: Array.isArray(data?.foods) ? data.foods : [] };
  } catch {
    // network error, the timeout, the caller's abort, or a body that isn't JSON — infrastructure, not a miss
    return { kind: 'failed' };
  } finally {
    t.done();
  }
}

// --- memo: does USDA accept our dataType filter? (see the file header)

const DT_STORE_KEY = 'heft-fdc-datatype-rejected';
const DT_TTL_MS = 3 * 864e5;
type DtState = 'unknown' | 'ok' | 'rejected';
let dtState: DtState = 'unknown';
let dtLoaded = false;
let dtProbe: Promise<void> | null = null;

function loadDtState(): void {
  if (dtLoaded) return;
  dtLoaded = true;
  try {
    const at = Number(localStorage.getItem(DT_STORE_KEY));
    if (at && Date.now() - at < DT_TTL_MS) dtState = 'rejected';
  } catch {
    /* no storage (tests, blocked site data): probe again this session */
  }
}

function setDtState(s: 'ok' | 'rejected'): void {
  dtState = s;
  try {
    if (s === 'rejected') localStorage.setItem(DT_STORE_KEY, String(Date.now()));
    else localStorage.removeItem(DT_STORE_KEY);
  } catch {
    /* storage blocked */
  }
}

/** Tests: forget what we learned about the dataType filter (and ignore localStorage). */
export function resetUsdaDataTypeMemo(state: DtState = 'unknown'): void {
  dtState = state;
  dtLoaded = true;
  dtProbe = null;
}

/**
 * While nobody knows yet whether the filter works, let ONE search find out and make the others wait for it
 * (a 4-item meal would otherwise spend 12 DEMO_KEY requests on the first lookup). Returns a release function
 * when this call is the probe.
 */
async function joinDtProbe(): Promise<(() => void) | null> {
  loadDtState();
  while (dtState === 'unknown' && dtProbe) await dtProbe;
  if (dtState !== 'unknown') return null;
  let release!: () => void;
  dtProbe = new Promise<void>((r) => (release = r));
  return () => {
    dtProbe = null;
    release();
  };
}

/** Ranked USDA FoodData Central search (GET only, no custom headers → no CORS preflight). */
export async function searchFoods(
  query: string,
  opts: { pageSize?: number; signal?: AbortSignal; fetch?: typeof fetch } = {},
): Promise<UsdaSearchResult> {
  const apiKey = fdcKeyOrDemo();
  const demoKey = apiKey === FDC_DEMO_KEY;
  const q = query.trim().replace(/\s+/g, ' ');
  if (!q) return { status: 'ok', foods: [], demoKey };
  const doFetch = opts.fetch ?? ((input, init) => fetch(input, init));
  const pageSize = Math.max(1, Math.min(50, Math.round(opts.pageSize ?? DEFAULT_PAGE_SIZE)));

  const release = await joinDtProbe();
  try {
    if (opts.signal?.aborted) return { status: 'failed', foods: [], demoKey };
    const done = (a: Attempt): UsdaSearchResult =>
      a.kind === 'ok'
        ? { status: 'ok', foods: rankFoods(q, a.foods).slice(0, pageSize), demoKey }
        : { status: a.kind === 'rate_limited' ? 'rate_limited' : 'failed', foods: [], demoKey };

    let filterRejected = dtState === 'rejected';
    if (!filterRejected) {
      const first = await fdcGet(q, pageSize, FDC_DATA_TYPES, apiKey, doFetch, opts.signal);
      if (first.kind === 'ok') {
        if (dtState !== 'ok') setDtState('ok');
        return done(first);
      }
      if (first.kind !== 'bad_request') return done(first);
      // 400 → once more without commas (keep the filter)…
      const noCommas = q.replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
      if (noCommas !== q) {
        const second = await fdcGet(noCommas, pageSize, FDC_DATA_TYPES, apiKey, doFetch, opts.signal);
        if (second.kind === 'ok') {
          if (dtState !== 'ok') setDtState('ok'); // it was this query's commas, not the filter
          return done(second);
        }
        if (second.kind !== 'bad_request') return done(second);
      }
      filterRejected = true;
    }
    // …then without the dataType filter (Branded rows are penalized in the ranking).
    const last = await fdcGet(q, Math.max(pageSize, UNFILTERED_PAGE_SIZE), null, apiKey, doFetch, opts.signal);
    if (last.kind === 'ok' && filterRejected && dtState !== 'rejected') setDtState('rejected');
    return last.kind === 'bad_request' ? { status: 'failed', foods: [], demoKey } : done(last);
  } finally {
    release?.();
  }
}

/** Best single USDA match for Claude's fdc_query. */
export async function bestMatch(
  query: string,
  signal?: AbortSignal,
  deps: { fetch?: typeof fetch } = {},
): Promise<{ status: LookupStatus; choice: FoodChoice | null; demoKey: boolean }> {
  const r = await searchFoods(query, { signal, fetch: deps.fetch });
  if (r.status !== 'ok') return { status: r.status, choice: null, demoKey: r.demoKey };
  const choice = r.foods[0] ?? null;
  return { status: choice ? 'ok' : 'no_match', choice, demoKey: r.demoKey };
}
