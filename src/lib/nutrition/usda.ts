import { extractPer100g, type FdcNutrient, type IndexDataType } from './fdcData';
import { indexWords, loadFoodIndex, matchStem, prepareFoods, type FoodIndex, type FoodIndexLoader, type PreparedFood } from './foodIndex';
import { FDC_DEMO_KEY, fdcKeyOrDemo } from './keys';
import type { FoodChoice, LookupStatus } from './types';

/*
 * USDA FoodData Central grounding (ported from SnapPlate app/lib/usda.ts).
 *
 * Claude identifies the food and estimates its weight; this module supplies the NUMBERS from USDA, so
 * calories/macros never come from the model's memory. That split is the single biggest accuracy win.
 *
 * Local first: whole foods (Foundation, SR Legacy, FNDDS) are answered from the bundled offline index
 * (foodIndex.ts; searchLocal below, ranked by the same scoreCandidate as API rows). bestMatch and findFoods ask the
 * live API only when the index has no GOOD match (every word of the query found in one food) or can't load. The
 * API's numbers and the index's are the same USDA rows (same fdcId); a choice from the index carries `bundled`.
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

// The nutrient-number rules live in fdcData.ts (shared with the offline index's build script).
export { NUTRIENT, extractPer100g, type FdcNutrient } from './fdcData';

const FDC_SEARCH_URL = 'https://api.nal.usda.gov/fdc/v1/foods/search';
/** SnapPlate's filter: whole-food data types only (no Branded). */
export const FDC_DATA_TYPES = 'Foundation,SR Legacy,Survey (FNDDS)';
/** Per-request timeout (combined with the caller's signal). */
export const USDA_TIMEOUT_MS = 8000;
const DEFAULT_PAGE_SIZE = 12;
/** The unfiltered request may return Branded rows; ask for a few more so whole foods still make the page. */
const UNFILTERED_PAGE_SIZE = 20;

/** 'key_rejected' = USDA answered 401/403: the saved USDA key is wrong (or disabled). */
export type UsdaStatus = 'ok' | 'rate_limited' | 'failed' | 'key_rejected';

export interface UsdaSearchResult {
  status: UsdaStatus;
  foods: FoodChoice[];
  /** True when the request used USDA's shared DEMO_KEY (no personal key saved). */
  demoKey: boolean;
}

/** Raw shape of an FDC search row (only the fields we read). */
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
/** Per processed / specialty word in a candidate that the query didn't ask for (the marker sets below). */
const PROCESSED_PENALTY = 0.6;
const SPECIALTY_PENALTY = 0.4;

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
  'meatless', // "Chicken, meatless" is a soy product
  'chinese', // a different vegetable: "broccoli" is not Chinese broccoli (22 kcal vs 35), "cabbage" not pak-choi
  // concentrated forms: "orange juice" is not the frozen concentrate (148 kcal vs 47), "milk" not evaporated
  'concentrate',
  'evaporated',
  'condensed',
  'dried',
  'powder',
  'powdered',
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
  // A single digit is kept: "milk, 2%" must not search for just "milk".
  return allTokens(s).filter((t) => (t.length > 1 || /\d/.test(t)) && !STOPWORDS.has(t));
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
    processed * PROCESSED_PENALTY -
    specialty * SPECIALTY_PENALTY -
    stateMismatch * 0.5 -
    branded
  );
}

// ------------------------------------------------------------------ nutrients

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

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

// ------------------------------------------------------------------ the bundled index (offline)

/** Ranking bonus for a food whose head noun (USDA's words before the first comma) the query covers entirely. */
const HEAD_BONUS = 0.5;
/** A chain-restaurant / brand row ("DENNY'S, french fries") the query didn't name. */
const BRAND_PENALTY = 0.5;
/** A query word found only through its cooking-method class ("grilled" ~ "roasted"): below the exact word. */
const COOK_CLASS_PENALTY = 0.3;
/** The query's words appear in the food's name in the query's order ("spaghetti with meat sauce"). */
const ORDER_BONUS = 0.2;
const LOCAL_LIMIT = 25;

/**
 * Cooking words USDA uses for the same food prepared without added fat (FNDDS even groups "baked, broiled, or
 * roasted"): Claude's "chicken breast, grilled" or "broccoli, steamed" then still has a good local match.
 */
const COOK_CLASS = new Map<string, number>(
  [
    ['steamed', 'boiled', 'cooked', 'poached', 'simmered'],
    ['grilled', 'broiled', 'roasted', 'baked'],
  ].flatMap((words, i) => words.map((w) => [w, i] as [string, number])),
);

export interface LocalSearch {
  /** Best first. Only GOOD matches when there are any, else the closest partial ones (half the words or more). */
  foods: FoodChoice[];
  /** Every word of the query was found in the first food: trust it instead of asking the live API. */
  good: boolean;
}

/** A bundled food as a FoodChoice (same id scheme as an API row, so recents don't duplicate it). */
export function choiceFromIndex(f: PreparedFood): FoodChoice {
  return {
    id: `usda:${f.fdcId}`,
    name: f.name,
    source: 'usda',
    fdcId: f.fdcId,
    per100g: f.per100g,
    servingG: null,
    dataType: f.dataType,
    portions: f.portions,
    bundled: true,
  };
}

/**
 * Search the bundled index. Every word of the query (tokens(): no stopwords, so "raw" doesn't have to appear) is
 * looked up in each food's name: by plural-insensitive stem (never a negated word: "no cheese"), else through its
 * cooking-method class (COOK_CLASS), else — `prefix`, for search-as-you-type — the LAST word as the start of a
 * name word ("chicken bre"). Hits are ranked by scoreCandidate on the query respelled with the food's own words (so
 * "eggs" counts for "Egg, whole, …" and the processed / specialty / raw-vs-cooked rules apply exactly as for API
 * rows), plus HEAD_BONUS when the query covers the food's head noun ("rice" ranks "Rice, white, …" above "Rice
 * crackers" and "Beans and rice"), minus BRAND_PENALTY for an unasked-for brand row, minus the processed /
 * specialty penalty for a word only the prefix filled in ("bre" → "breaded"), minus COOK_CLASS_PENALTY.
 */
export function searchLocal(index: FoodIndex, query: string, opts: { prefix?: boolean; limit?: number } = {}): LocalSearch {
  const want = tokens(query);
  if (!want.length) return { foods: [], good: false };
  const wantStems = want.map(matchStem);
  const wantClass = want.map((t) => COOK_CLASS.get(t));
  const last = want.length - 1;
  const words = indexWords(query);
  const hits: { food: PreparedFood; score: number; full: boolean }[] = [];
  let anyFull = false;

  for (const food of index.foods) {
    let adjust = 0;
    const surface: (string | undefined)[] = want.map((t, i) => {
      const at = food.stems.indexOf(wantStems[i]);
      if (at >= 0) return food.words[at];
      if (wantClass[i] != null) {
        const same = food.stems.findIndex((s) => COOK_CLASS.get(s) === wantClass[i]);
        if (same >= 0) {
          adjust -= COOK_CLASS_PENALTY;
          return food.words[same];
        }
      }
      if (!opts.prefix || i !== last) return undefined;
      const w = food.words.find((x, j) => food.stems[j] && x.startsWith(t));
      if (w && PROCESSED_MARKERS.has(w)) adjust -= PROCESSED_PENALTY;
      else if (w && SPECIALTY_MARKERS.has(w)) adjust -= SPECIALTY_PENALTY;
      return w;
    });
    const matched = surface.filter(Boolean).length;
    if (!matched || matched * 2 < want.length) continue;
    const full = matched === want.length;
    if (!full && anyFull) continue;
    anyFull ||= full;
    const respell = new Map(want.map((t, i) => [t, surface[i] ?? t]));
    const aligned = words.map((w) => respell.get(w) ?? w).join(' ');
    const covered = new Set(surface);
    const headWords = food.head.filter((w) => w.length > 1 && !STOPWORDS.has(w));
    if (headWords.length > 0 && headWords.every((w) => covered.has(w))) adjust += HEAD_BONUS;
    if (full && want.length > 1 && inOrder(food.words, surface as string[])) adjust += ORDER_BONUS;
    if (food.brand.length && !food.brand.some((w) => covered.has(w))) adjust -= BRAND_PENALTY;
    hits.push({ food, score: scoreCandidate(aligned, { description: food.name, dataType: food.dataType }, 0) + adjust, full });
  }

  const ranked = (anyFull ? hits.filter((h) => h.full) : hits).sort(
    (a, b) => b.score - a.score || a.food.name.length - b.food.name.length || a.food.fdcId - b.food.fdcId,
  );
  return { foods: ranked.slice(0, opts.limit ?? LOCAL_LIMIT).map((h) => choiceFromIndex(h.food)), good: anyFull };
}

/** `seq` is a subsequence of `words` (each found after the previous one). */
function inOrder(words: string[], seq: string[]): boolean {
  let from = 0;
  for (const w of seq) {
    const at = words.indexOf(w, from);
    if (at < 0) return false;
    from = at + 1;
  }
  return true;
}

/** The bundled index's best GOOD match for a query, or null (no good match, or the index can't load). */
async function localBestMatch(query: string, load: FoodIndexLoader): Promise<FoodChoice | null> {
  const index = await load();
  if (!index) return null;
  const r = searchLocal(index, query, { limit: 1 });
  return r.good ? r.foods[0] : null;
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

/**
 * Best single USDA match for Claude's fdc_query: the bundled index's GOOD match when it has one (no request, so
 * `demoKey` is false), else the live API's best SAME-food row (sameFood; none → no_match). `budgetMs`: see
 * SearchOptions (ground.ts passes 6 s per item); it covers the API request only. `expectKcal100`: Claude's own
 * kcal per 100 g for the item, which an API row must be within MAX_KCAL_RATIO of. `localIndex` is injected in tests.
 */
export async function bestMatch(
  query: string,
  signal?: AbortSignal,
  deps: { fetch?: typeof fetch; budgetMs?: number; expectKcal100?: number; localIndex?: FoodIndexLoader } = {},
): Promise<{ status: LookupStatus; choice: FoodChoice | null; demoKey: boolean }> {
  const local = await localBestMatch(query, deps.localIndex ?? (() => loadFoodIndex()));
  if (local) return { status: 'ok', choice: local, demoKey: false };
  const r = await searchFoods(query, { signal, fetch: deps.fetch, budgetMs: deps.budgetMs });
  if (r.status !== 'ok') return { status: r.status, choice: null, demoKey: r.demoKey };
  const choice = sameFood(query, r.foods, deps.expectKcal100);
  return { status: choice ? 'ok' : 'no_match', choice, demoKey: r.demoKey };
}

/**
 * How far an API row's energy density may be from Claude's own estimate (either way). Claude's portion guess can
 * be far off, but its kcal per gram for a food it named is not: 2× rejects avocado OIL for avocado toast (884 vs
 * ~210), a 0 kcal seasoning blend, and dry rice for cooked (360 vs 130).
 */
export const MAX_KCAL_RATIO = 2;

/**
 * The best live-API row that is the SAME food as the query, or null. The API answers every query with something
 * ("avocado toast" → "Oil, avocado", 884 kcal/100 g; "oatmeal, cooked" → "Bread, oatmeal"), and a wrong row
 * silently replaces Claude's estimate, so a row must pass the bundled index's GOOD rule (searchLocal: every query
 * word found, by stem or cooking class), name one of the query's words in its head noun (not "Soup, chicken
 * noodle, …" for "chicken, cooked"), and — given Claude's kcal per 100 g — be within MAX_KCAL_RATIO of it ("Avocado
 * Toast Seasoning Blend" has every word). No such row → no_match, and grounding keeps Claude's own numbers.
 */
export function sameFood(query: string, foods: FoodChoice[], expectKcal100?: number): FoodChoice | null {
  const rows = foods.filter((c) => c.fdcId != null);
  if (!rows.length) return null;
  const byId = new Map(rows.map((c) => [c.fdcId!, c]));
  const index = prepareFoods(
    rows.map((c) => ({ fdcId: c.fdcId!, name: c.name, dataType: c.dataType as IndexDataType, per100g: c.per100g, portions: [] })),
  );
  const local = searchLocal(index, query, { limit: rows.length });
  if (!local.good) return null;
  const wantStems = new Set(tokens(query).map(matchStem));
  const plausible = (kcal: number) =>
    !(expectKcal100 && expectKcal100 > 0) || (kcal * MAX_KCAL_RATIO >= expectKcal100 && kcal <= expectKcal100 * MAX_KCAL_RATIO);
  for (const hit of local.foods) {
    const head = index.byId.get(hit.fdcId!)!.head;
    if (!head.some((w) => !STOPWORDS.has(w) && wantStems.has(matchStem(w)))) continue;
    const row = byId.get(hit.fdcId!);
    if (row && plausible(row.per100g.kcal)) return row;
  }
  return null;
}

export interface FindResult extends UsdaSearchResult {
  /** Where `foods` came from: the bundled index or the live API. */
  from: 'bundled' | 'api';
  /**
   * Set when the index had only partial matches and the live API couldn't answer: its status. `foods` are then
   * the index's closest matches, and the sheet says why it shows them.
   */
  apiStatus?: Exclude<UsdaStatus, 'ok'>;
}

export interface FindOptions extends SearchOptions {
  /** Skip the index and ask the live API ("Search USDA online"). */
  online?: boolean;
  /** Wait this long (abortable) before asking the API, so typing doesn't spend DEMO_KEY requests. */
  liveDelayMs?: number;
  /** Called right before that wait: the index had no good match (the sheet shows its spinner now). */
  onLive?: () => void;
  localIndex?: FoodIndexLoader;
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * The search sheet's search: the bundled index first (search-as-you-type prefix matching). GOOD matches there are
 * the answer, with no request. Otherwise the live API; if it can't answer, the index's partial matches with the
 * API's status (`apiStatus`), else the API's own outcome.
 */
export async function findFoods(query: string, opts: FindOptions = {}): Promise<FindResult> {
  const q = query.trim().replace(/\s+/g, ' ');
  const index = q && !opts.online ? await (opts.localIndex ?? (() => loadFoodIndex()))() : null;
  const local = index ? searchLocal(index, q, { prefix: true }) : null;
  if (local?.good) return { status: 'ok', foods: local.foods, demoKey: false, from: 'bundled' };
  opts.onLive?.();
  if (opts.liveDelayMs && !(await abortableDelay(opts.liveDelayMs, opts.signal))) {
    return { status: 'failed', foods: [], demoKey: false, from: 'api' };
  }
  const live = await searchFoods(q, opts);
  const partial = local?.foods ?? [];
  if (partial.length && (live.status !== 'ok' || !live.foods.length)) {
    return { status: 'ok', foods: partial, demoKey: live.demoKey, from: 'bundled', apiStatus: live.status === 'ok' ? undefined : live.status };
  }
  return { ...live, from: 'api' };
}
