import { decodeFoodIndex, type FoodPortion, type IndexFood } from './fdcData';
import { FOOD_INDEX_FILE } from './foodIndexMeta';

/*
 * The bundled offline copy of USDA FoodData Central's whole foods (Foundation, SR Legacy, Survey (FNDDS)): a
 * public-domain, MacroFactor-style "common foods" index, so search and photo grounding resolve whole foods with
 * no network and no DEMO_KEY rate limit. Built by scripts/build-food-index.mjs into public/ under a content-hashed
 * name (foodIndexMeta.ts), fetched on first use and kept by the service worker's 'food-index' runtime cache
 * (vite.config.ts), so after one online load it works offline. Search and ranking live in usda.ts (searchLocal).
 *
 * A failed load (offline before the first load, a broken file) resolves null and is retried on the next call;
 * every caller then falls back to the live API.
 */

/** A food prepared for search: its index entry plus lowercase tokens and the tokens of its first segment. */
export interface PreparedFood extends IndexFood {
  /** Lowercase alphanumeric words of the name, in order (stopwords kept; ranking decides what they're worth). */
  words: string[];
  /** matchStems of the words (same order; '' = negated, never matched). */
  stems: string[];
  /** The words before the first comma: USDA's head noun ("Chicken breast" in "Chicken breast, baked, …"). */
  head: string[];
  /** Words of an all-caps brand segment ("DENNY'S, french fries", "Yogurt, Greek, …, CHOBANI"); [] when none. */
  brand: string[];
}

export interface FoodIndex {
  foods: PreparedFood[];
  byId: Map<number, PreparedFood>;
}

/** Loads the index (null = unavailable). Injected in tests. */
export type FoodIndexLoader = () => Promise<FoodIndex | null>;

/** The words a name or query is matched on (also used for queries, so both sides split the same way). */
export function indexWords(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * The plural-insensitive form a word is matched on: "eggs" ~ "egg", "tomatoes" ~ "tomato", "berries" ~ "berry",
 * "cookies" ~ "cookie", "peaches" ~ "peach". Words ending in ss / us / is keep their s ("swiss", "hummus").
 */
export function matchStem(w: string): string {
  let s = w;
  if (s.length > 3 && s.endsWith('s') && !/(ss|us|is)$/.test(s)) s = s.slice(0, -1);
  if (s.endsWith('ie')) return s.slice(0, -2) + 'y';
  if (/(oe|che|she|sse|xe)$/.test(s)) return s.slice(0, -1);
  return s;
}

const NEGATORS = new Set(['no', 'without', 'non']);

/**
 * matchStem of each word, '' for a negated word ("no cheese", "without salt", "skin not eaten"), which never
 * satisfies a query: "pizza, cheese" must not find "Pizza, no cheese, thin crust".
 */
export function matchStems(words: string[]): string[] {
  return words.map((w, i) => (NEGATORS.has(words[i - 1]) || words[i + 1] === 'not' ? '' : matchStem(w)));
}

// All-caps segments that are USDA vocabulary, not a brand: "not (further) specified", barbecue.
const NOT_BRANDS = new Set(['NFS', 'NS', 'BBQ', 'USDA']);

/** The words of a food name's brand segment: mostly capitals, 3+ of them ("McDONALD'S", "T.G.I. FRIDAY'S"). */
export function brandWords(name: string): string[] {
  for (const seg of name.split(',').map((s) => s.trim())) {
    const upper = seg.replace(/[^A-Z]/g, '').length;
    const letters = seg.replace(/[^A-Za-z]/g, '').length;
    if (upper >= 3 && upper >= 0.8 * letters && !NOT_BRANDS.has(seg)) return indexWords(seg);
  }
  return [];
}

export function prepareFoods(foods: IndexFood[]): FoodIndex {
  const prepared = foods.map((f): PreparedFood => {
    const words = indexWords(f.name);
    return { ...f, words, stems: matchStems(words), head: indexWords(f.name.split(',')[0]), brand: brandWords(f.name) };
  });
  return { foods: prepared, byId: new Map(prepared.map((f) => [f.fdcId, f])) };
}

let loading: Promise<FoodIndex | null> | null = null;
let loaded: FoodIndex | null = null;

function indexUrl(): string {
  const base = import.meta.env.BASE_URL || '/';
  return new URL(base + FOOD_INDEX_FILE, globalThis.document?.baseURI ?? globalThis.location?.href).href;
}

/** The bundled index, loaded once (concurrent callers share the request). */
export function loadFoodIndex(doFetch: typeof fetch = (input, init) => fetch(input, init)): Promise<FoodIndex | null> {
  if (loaded) return Promise.resolve(loaded);
  if (!loading) {
    loading = (async () => {
      try {
        const res = await doFetch(indexUrl());
        if (!res.ok) return null;
        loaded = prepareFoods(decodeFoodIndex(await res.json()));
        return loaded;
      } catch {
        return null; // offline before the first load, no document (tests), or an unreadable file
      } finally {
        loading = null;
      }
    })();
  }
  return loading;
}

/** The index if it's already in memory (sync; for portions of a recent food). */
export function loadedFoodIndex(): FoodIndex | null {
  return loaded;
}

/** Household measures of a USDA food, when the index is loaded and has it. */
export function portionsFor(fdcId: number | undefined): FoodPortion[] {
  return fdcId == null ? [] : (loaded?.byId.get(fdcId)?.portions ?? []);
}

/** Load it in the background so the service worker has it before the phone goes offline. */
export function warmFoodIndex(): void {
  void loadFoodIndex();
}

/** Tests: drop the in-memory index (or install one). */
export function resetFoodIndex(index: FoodIndex | null = null): void {
  loaded = index;
  loading = null;
}
