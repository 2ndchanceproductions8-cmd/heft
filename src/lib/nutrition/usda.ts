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
 * dataType filter, with Branded results pushed down the ranking. As soon as both filtered variants are
 * answered 400 (the 400 is the signal), the filter is remembered as rejected (module + localStorage, 3 days)
 * and later searches go straight to the unfiltered request: with DEMO_KEY's ~10 requests an hour, three
 * requests per item would rate-limit the second meal of the hour. (If even the unfiltered request 400s, the
 * query was the problem, not the filter, and the memo is undone.)
 *
 * While nobody knows yet whether the filter works, ONE search probes and the others wait for it (see
 * joinDtProbe). A caller's time budget (`budgetMs`, ground.ts's 6 s per meal item) starts only when its search
 * may send — never while it waits on someone else's probe — and the probe's own discovery requests are bounded
 * per request (USDA_TIMEOUT_MS) rather than by the budget, so a slow first answer on weak cellular can't time
 * out the very answer every other lookup is waiting for.
 *
 * HTTP 401/403 (api.data.gov's answer to a missing, invalid or disabled key) is 'key_rejected', never retried
 * and never reported as a connection problem.
 */

const FDC_SEARCH_URL = 'https://api.nal.usda.gov/fdc/v1/foods/search';
/** SnapPlate's filter: whole-food data types only (no Branded). */
export const FDC_DATA_TYPES = 'Foundation,SR Legacy,Survey (FNDDS)';
/** Per-request timeout (combined with the caller's signal). */
export const USDA_TIMEOUT_MS = 8000;
const DEFAULT_PAGE_SIZE = 12;
/** The unfiltered request may return Branded rows; ask for a few more so whole foods still make the page. */
const UNFILTERED_PAGE_SIZE = 20;

/**
 * Standard USDA nutrient numbers (values are per 100 g for Foundation / SR Legacy / FNDDS / Branded).
 * Foundation rows often lack 208 / 269 / 205 and list their own numbers for the same quantities instead.
 */
export const NUTRIENT = {
  energy: '208', // Energy (kcal)
  // Foundation: food-SPECIFIC Atwater factors match SR Legacy's 208 convention; the GENERAL 4-9-4 factors run
  // ~10% high for fruit and vegetables (Fuji apple: 957 = 64.7 vs 958 = 58.2 kcal), so 957 is the last resort.
  energyAtwaterSpecific: '958', // Energy (Atwater Specific Factors), kcal
  energyAtwaterGeneral: '957', // Energy (Atwater General Factors), kcal
  protein: '203',
  fat: '204',
  carbs: '205', // Carbohydrate, by difference
  carbsBySummation: '205.2', // Carbohydrates, by summation (Foundation)
  fiber: '291', // Fiber, total dietary
  sugar: '269', // Sugars, total
  sugarTotal: '269.3', // Sugars, Total (Foundation's number for the same thing, e.g. "Beets, raw")
  sodium: '307', // Sodium, Na (mg)
} as const;

/** 'key_rejected' = USDA answered 401/403: the saved USDA key is wrong (or disabled). */
export type UsdaStatus = 'ok' | 'rate_limited' | 'failed' | 'key_rejected';

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
 * Per-100 g nutrients from an FDC nutrient list. Energy: 208, else 958 (Atwater specific), else 957 (Atwater
 * general), else null (the row is unusable). Carbs: 205, else 205.2; sugar: 269, else 269.3. Fiber / sugar /
 * sodium that aren't listed are null (unknown), never 0. Negative values (USDA's "carbohydrate by difference"
 * can be slightly negative) are clamped to 0.
 */
export function extractPer100g(nutrients: FdcNutrient[]): Per100g | null {
  const byNumber = new Map<string, number>();
  for (const n of nutrients) {
    const num = n.nutrientNumber == null ? '' : String(n.nutrientNumber);
    if (num && finite(n.value) && !byNumber.has(num)) byNumber.set(num, n.value);
  }
  const get = (num: string): number | null => (byNumber.has(num) ? Math.max(0, byNumber.get(num)!) : null);
  const energy = get(NUTRIENT.energy) ?? get(NUTRIENT.energyAtwaterSpecific) ?? get(NUTRIENT.energyAtwaterGeneral);
  if (energy == null) return null;
  return {
    kcal: energy,
    proteinG: get(NUTRIENT.protein) ?? 0,
    carbsG: get(NUTRIENT.carbs) ?? get(NUTRIENT.carbsBySummation) ?? 0,
    fatG: get(NUTRIENT.fat) ?? 0,
    fiberG: get(NUTRIENT.fiber),
    sugarG: get(NUTRIENT.sugar) ?? get(NUTRIENT.sugarTotal),
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

type Attempt =
  | { kind: 'ok'; foods: FdcFood[] }
  | { kind: 'bad_request' }
  | { kind: 'rate_limited' }
  | { kind: 'key_rejected' }
  | { kind: 'failed' };

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
    // api.data.gov: API_KEY_MISSING / API_KEY_INVALID / API_KEY_DISABLED. Retrying can't help.
    if (res.status === 401 || res.status === 403) return { kind: 'key_rejected' };
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
/** The search finding out whether the filter works; resolves true when it found out, false when it couldn't. */
let dtProbe: Promise<boolean> | null = null;

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

function setDtState(s: DtState): void {
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

interface ProbeTicket {
  /** Set when THIS search is the probe: settle() once the filter's fate is known, or when the search ends. */
  probe: { settle: () => void } | null;
  /** The probe this search waited for ended without an answer (network, 429, abort): don't filter. */
  inconclusive: boolean;
}

const NO_PROBE: ProbeTicket = { probe: null, inconclusive: false };

/** Wait for a probe to settle, or for the caller's abort (a cancelled search must not sit in the queue). */
function waitForProbe(probe: Promise<boolean>, signal?: AbortSignal): Promise<'decided' | 'inconclusive' | 'aborted'> {
  if (signal?.aborted) return Promise.resolve('aborted');
  return new Promise((resolve) => {
    const onAbort = () => resolve('aborted');
    signal?.addEventListener('abort', onAbort, { once: true });
    void probe.then((decided) => {
      signal?.removeEventListener('abort', onAbort);
      resolve(decided ? 'decided' : 'inconclusive');
    });
  });
}

/**
 * While nobody knows yet whether the filter works, let ONE search find out and make the others wait for it
 * (a 4-item meal would otherwise spend 12 DEMO_KEY requests on the first lookup). The probe settles as soon as
 * it knows — before its own unfiltered request — so the waiters' requests run alongside it. When a probe ends
 * without an answer, its waiters send the unfiltered request (always valid) instead of probing one after the
 * other; the next search probes again.
 */
async function joinDtProbe(signal?: AbortSignal): Promise<ProbeTicket> {
  loadDtState();
  while (dtState === 'unknown' && dtProbe) {
    const r = await waitForProbe(dtProbe, signal);
    if (r === 'aborted') return NO_PROBE;
    if (r === 'inconclusive') return { probe: null, inconclusive: true };
  }
  if (dtState !== 'unknown' || signal?.aborted) return NO_PROBE;
  let resolve!: (decided: boolean) => void;
  const mine = new Promise<boolean>((r) => (resolve = r));
  dtProbe = mine;
  let open = true;
  return {
    probe: {
      settle: () => {
        if (!open) return;
        open = false;
        if (dtProbe === mine) dtProbe = null;
        resolve(dtState !== 'unknown');
      },
    },
    inconclusive: false,
  };
}

export interface SearchOptions {
  pageSize?: number;
  /** The caller's abort (also ends a wait on another search's probe). */
  signal?: AbortSignal;
  fetch?: typeof fetch;
  /**
   * Time budget (ms) for this search's own requests. It starts once the search may send (after any wait on
   * another search's dataType probe) and does not cover a probe's discovery requests, which are bounded per
   * request instead (see the file header). Without it, only the per-request USDA_TIMEOUT_MS applies.
   */
  budgetMs?: number;
}

/** Ranked USDA FoodData Central search (GET only, no custom headers → no CORS preflight). */
export async function searchFoods(query: string, opts: SearchOptions = {}): Promise<UsdaSearchResult> {
  const apiKey = fdcKeyOrDemo();
  const demoKey = apiKey === FDC_DEMO_KEY;
  const q = query.trim().replace(/\s+/g, ' ');
  if (!q) return { status: 'ok', foods: [], demoKey };
  const doFetch = opts.fetch ?? ((input, init) => fetch(input, init));
  const pageSize = Math.max(1, Math.min(50, Math.round(opts.pageSize ?? DEFAULT_PAGE_SIZE)));
  const failed: UsdaSearchResult = { status: 'failed', foods: [], demoKey };

  const ticket = await joinDtProbe(opts.signal);
  // The budget starts on this search's first budgeted request, so never while it waited above.
  let budget = null as ReturnType<typeof timeoutSignal> | null; // (assigned in a closure: no narrowing to null)
  const budgeted = (): AbortSignal | undefined => {
    if (!opts.budgetMs || opts.budgetMs <= 0) return opts.signal;
    if (!budget) budget = timeoutSignal(opts.budgetMs, opts.signal);
    return budget.signal;
  };
  // A probe's filtered requests are discovery for everyone: off the budget (each still capped at 8 s).
  const filteredSignal = () => (ticket.probe ? opts.signal : budgeted());
  const get = (text: string, size: number, dataType: string | null, signal: AbortSignal | undefined) =>
    fdcGet(text, size, dataType, apiKey, doFetch, signal);
  const done = (a: Attempt): UsdaSearchResult => {
    if (a.kind === 'ok') return { status: 'ok', foods: rankFoods(q, a.foods).slice(0, pageSize), demoKey };
    return a.kind === 'bad_request' ? failed : { status: a.kind, foods: [], demoKey };
  };

  try {
    if (opts.signal?.aborted) return failed;
    let before: DtState | null = null; // the memo before THIS search marked the filter rejected
    if (dtState !== 'rejected' && !ticket.inconclusive) {
      const first = await get(q, pageSize, FDC_DATA_TYPES, filteredSignal());
      if (first.kind === 'ok') {
        if (dtState !== 'ok') setDtState('ok');
        return done(first);
      }
      if (first.kind !== 'bad_request') return done(first);
      // 400 → once more without commas (keep the filter)…
      const noCommas = q.replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
      if (noCommas !== q) {
        const second = await get(noCommas, pageSize, FDC_DATA_TYPES, filteredSignal());
        if (second.kind === 'ok') {
          if (dtState !== 'ok') setDtState('ok'); // it was this query's commas, not the filter
          return done(second);
        }
        if (second.kind !== 'bad_request') return done(second);
      }
      // Both filtered variants were answered 400: that IS the signal. Remember it now and let the searches
      // waiting on this probe go, before (and whatever then happens to) our own unfiltered request.
      before = dtState;
      setDtState('rejected');
      ticket.probe?.settle();
    }
    // …then without the dataType filter (Branded rows are penalized in the ranking).
    const last = await get(q, Math.max(pageSize, UNFILTERED_PAGE_SIZE), null, budgeted());
    if (last.kind === 'bad_request') {
      // Even the unfiltered request 400'd: the query is the problem, not the filter, so undo the memo.
      if (before && dtState === 'rejected') setDtState(before);
      return failed;
    }
    return done(last);
  } finally {
    budget?.done();
    ticket.probe?.settle();
  }
}

/** Best single USDA match for Claude's fdc_query. `budgetMs`: see SearchOptions (ground.ts passes 6 s per item). */
export async function bestMatch(
  query: string,
  signal?: AbortSignal,
  deps: { fetch?: typeof fetch; budgetMs?: number } = {},
): Promise<{ status: LookupStatus; choice: FoodChoice | null; demoKey: boolean }> {
  const r = await searchFoods(query, { signal, fetch: deps.fetch, budgetMs: deps.budgetMs });
  if (r.status !== 'ok') return { status: r.status, choice: null, demoKey: r.demoKey };
  const choice = r.foods[0] ?? null;
  return { status: choice ? 'ok' : 'no_match', choice, demoKey: r.demoKey };
}
