import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../db';
import { uid } from '../ids';
import { deleteMedia } from '../media';
import { getSettings, newestWeighIn, pickBodyweightKg } from '../settings';
import type { Settings } from '../../types';
import { dayKey, emptyTotals, recomputeMeal, sumMeals } from './math';
import { bodyFromSettings, computeTargets, DEFAULT_NUTRITION, type BodyField } from './targets';
import type { AiCall, AiSpendRow, Food, FoodChoice, Meal, MealItem, MealStatus, NutritionProfile, Targets, Totals } from './types';

/*
 * Persistence for the Food tab. Every meal write goes through here so cached fields (day, totals) can never
 * drift from the items: createMeal / updateMeal always run recomputeMeal().
 */

// ------------------------------------------------------------------ meals

export function newItemId(): string {
  return 'it_' + uid();
}

export interface NewMeal extends Partial<Omit<Meal, 'id' | 'day' | 'totals' | 'createdAt' | 'updatedAt'>> {
  input: Meal['input'];
}

/** Ledger rows for billed calls (see AiSpendRow). */
function spendRows(mealId: string, calls: AiCall[]): AiSpendRow[] {
  return calls.map((c) => ({ ...c, id: 'sp_' + uid(), mealId }));
}

/** Create a meal row and return it. Defaults: eaten now, 1 serving, no items, status 'draft'. */
export async function createMeal(init: NewMeal, now = Date.now()): Promise<Meal> {
  const meal = recomputeMeal({
    id: 'meal_' + uid(),
    at: init.at ?? now,
    day: '',
    title: init.title ?? '',
    status: init.status ?? 'draft',
    statusAt: now,
    error: init.error ?? null,
    input: init.input,
    photoIds: init.photoIds ?? [],
    serves: init.serves ?? 1,
    items: init.items ?? [],
    totals: emptyTotals(),
    confidence: init.confidence ?? null,
    scaleReference: init.scaleReference ?? null,
    notes: init.notes ?? '',
    angles: init.angles ?? 0,
    aiCalls: init.aiCalls ?? [],
    createdAt: now,
    updatedAt: now,
  });
  await db.transaction('rw', db.meals, db.aiSpend, async () => {
    await db.meals.add(meal);
    if (meal.aiCalls.length) await db.aiSpend.bulkAdd(spendRows(meal.id, meal.aiCalls));
  });
  return meal;
}

export class MealBusyError extends Error {
  constructor() {
    super('This meal is being analyzed — try again when it finishes.');
    this.name = 'MealBusyError';
  }
}

/**
 * Patch a meal (object patch or updater function). Recomputes totals and stamps updatedAt; a status change
 * also stamps statusAt; `day` is re-derived only when the eaten time `at` changes. While a meal is
 * 'analyzing' only the analysis itself may write to it (`force: true`) — a debounced UI edit landing
 * mid-analysis would otherwise put stale items back. Calls appended to `aiCalls` are also written to the
 * spend ledger (db.aiSpend) in the same transaction. Returns the saved meal, or null when it no longer exists.
 */
export async function updateMeal(
  id: string,
  patch: Partial<Omit<Meal, 'id' | 'createdAt'>> | ((m: Meal) => Partial<Omit<Meal, 'id' | 'createdAt'>>),
  opts: { force?: boolean; now?: number } = {},
): Promise<Meal | null> {
  return db.transaction('rw', db.meals, db.aiSpend, async () => {
    const cur = await db.meals.get(id);
    if (!cur) return null;
    if (cur.status === 'analyzing' && !opts.force) throw new MealBusyError();
    const p = typeof patch === 'function' ? patch(cur) : patch;
    const now = opts.now ?? Date.now();
    const next = recomputeMeal(
      {
        ...cur,
        ...p,
        id: cur.id,
        createdAt: cur.createdAt,
        updatedAt: now,
        statusAt: p.status && p.status !== cur.status ? now : (p.statusAt ?? cur.statusAt),
      },
      { rederiveDay: p.at !== undefined && p.at !== cur.at },
    );
    await db.meals.put(next);
    const prev = cur.aiCalls ?? [];
    if (next.aiCalls.length > prev.length) await db.aiSpend.bulkAdd(spendRows(id, next.aiCalls.slice(prev.length)));
    return next;
  });
}

/** Set a meal's status (and error) — the analysis pipeline uses this with force. */
export function setMealStatus(id: string, status: MealStatus, error: string | null = null, opts: { force?: boolean } = {}) {
  return updateMeal(id, { status, error }, opts);
}

/** Delete a meal and its photos. */
export async function deleteMeal(id: string): Promise<void> {
  const m = await db.meals.get(id);
  await db.meals.delete(id);
  if (m?.photoIds.length) await deleteMedia(m.photoIds);
}

/** Replace one item (by id) inside a meal. */
export function updateItem(mealId: string, itemId: string, patch: Partial<MealItem>) {
  return updateMeal(mealId, (m) => ({ items: m.items.map((it) => (it.id === itemId ? { ...it, ...patch, id: it.id } : it)) }));
}

export function removeItem(mealId: string, itemId: string) {
  return updateMeal(mealId, (m) => ({ items: m.items.filter((it) => it.id !== itemId) }));
}

export function addItem(mealId: string, item: MealItem) {
  return updateMeal(mealId, (m) => ({ items: [...m.items, item] }));
}

/** Meals eaten on a day (oldest first). undefined while loading. */
export function useDayMeals(day: string): Meal[] | undefined {
  return useLiveQuery(() => db.meals.where('day').equals(day).sortBy('at'), [day]);
}

/** One meal: undefined while loading, null when it doesn't exist. */
export function useMeal(id: string | null | undefined): Meal | null | undefined {
  return useLiveQuery(async () => (id ? ((await db.meals.get(id)) ?? null) : null), [id]);
}

/** Totals of the meals that count toward a day (status 'done'). undefined while loading. */
export function useDayTotals(day: string): Totals | undefined {
  const meals = useDayMeals(day);
  return meals ? sumMeals(meals) : undefined;
}

/** Meals waiting for analysis or with an unfinished capture, newest first (for Diary banners). */
export function useUnfinishedMeals(): Meal[] | undefined {
  return useLiveQuery(
    () => db.meals.where('status').anyOf('draft', 'pending', 'analyzing', 'failed').reverse().sortBy('at'),
    [],
  );
}

/**
 * Ledger-only write for billed calls whose meal row is gone (deleted / restored away mid-analysis): the money
 * was spent either way, so the meter must still count it.
 */
export async function recordSpend(mealId: string, calls: AiCall[]): Promise<void> {
  if (calls.length) await db.aiSpend.bulkAdd(spendRows(mealId, calls));
}

/** Claude spend billed since `since` (epoch ms), from the ledger: counts deleted and back-dated meals too. */
export async function loadAiSpend(since: number): Promise<{ costUsd: number; calls: number }> {
  let costUsd = 0;
  let calls = 0;
  await db.aiSpend.where('at').aboveOrEqual(since).each((c) => {
    costUsd += c.costUsd;
    calls++;
  });
  return { costUsd, calls };
}

export function useAiSpend(since: number): { costUsd: number; calls: number } | undefined {
  return useLiveQuery(() => loadAiSpend(since), [since]);
}

// ------------------------------------------------------------------ nutrition profile + targets

export async function getNutritionProfile(): Promise<NutritionProfile> {
  const p = await db.nutrition.get('profile');
  return p ? { ...DEFAULT_NUTRITION, ...p } : DEFAULT_NUTRITION;
}

/** Profile row merged over defaults (never undefined). */
export function useNutritionProfile(): NutritionProfile {
  const p = useLiveQuery(() => db.nutrition.get('profile'), []);
  return p ? { ...DEFAULT_NUTRITION, ...p } : DEFAULT_NUTRITION;
}

export async function updateNutritionProfile(patch: Partial<Omit<NutritionProfile, 'id'>>): Promise<void> {
  await db.transaction('rw', db.nutrition, async () => {
    const cur = await getNutritionProfile();
    await db.nutrition.put({ ...cur, ...patch, id: 'profile' });
  });
}

export interface TargetsState {
  /** null when body data is missing (see `missing`). */
  targets: Targets | null;
  missing: BodyField[];
  profile: NutritionProfile;
  settings: Settings;
  bodyweightKg: number | null;
}

/** Load everything the targets need in one read. Pure function of the DB + `now`. */
export async function loadTargets(now = Date.now()): Promise<TargetsState> {
  const [settings, latest, profile] = await Promise.all([getSettings(), newestWeighIn(), getNutritionProfile()]);
  const bodyweightKg = pickBodyweightKg(settings, latest);
  const b = bodyFromSettings(settings, bodyweightKg, now);
  return {
    targets: b.body ? computeTargets(profile, b.body) : null,
    missing: b.missing,
    profile,
    settings,
    bodyweightKg,
  };
}

/** Live targets (recompute when settings, a weigh-in or the profile change). undefined while loading. */
export function useTargets(): TargetsState | undefined {
  return useLiveQuery(() => loadTargets(), []);
}

// ------------------------------------------------------------------ food library (recents + barcode cache)

export function foodFromChoice(c: FoodChoice, now = Date.now(), prev?: Food): Food {
  return {
    id: c.id,
    name: c.name,
    brand: c.brand,
    source: c.source,
    fdcId: c.fdcId,
    barcode: c.barcode,
    per100g: c.per100g,
    servingG: c.servingG,
    lastUsedAt: now,
    useCount: (prev?.useCount ?? 0) + 1,
  };
}

export function choiceFromFood(f: Food): FoodChoice {
  return {
    id: f.id,
    name: f.name,
    brand: f.brand,
    source: f.source === 'off' ? 'off' : 'usda',
    fdcId: f.fdcId,
    barcode: f.barcode,
    per100g: f.per100g,
    servingG: f.servingG,
  };
}

/** Remember a picked food (bumps it in recents; caches barcodes for offline scans). */
export async function upsertFood(c: FoodChoice, now = Date.now()): Promise<Food> {
  return db.transaction('rw', db.foods, async () => {
    const prev = await db.foods.get(c.id);
    const f = foodFromChoice(c, now, prev);
    await db.foods.put(f);
    return f;
  });
}

/** Most recently used foods, newest first. */
export function useRecentFoods(limit = 30): Food[] | undefined {
  return useLiveQuery(() => db.foods.orderBy('lastUsedAt').reverse().limit(limit).toArray(), [limit]);
}

/** A cached product for a barcode (works offline). */
export async function foodByBarcode(code: string): Promise<Food | undefined> {
  return db.foods.where('barcode').equals(code).first();
}

// ------------------------------------------------------------------ misc

/** Today's day key (re-evaluated by callers on render; pass `now` from useWakeNow for day rollover). */
export const todayKey = (now = Date.now()) => dayKey(now);

/** A meal item for a picked food (USDA hit, label product or cached food) at `grams` per serving. */
export function itemFromChoice(c: FoodChoice, grams: number, name?: string): MealItem {
  return {
    id: newItemId(),
    name: name ?? c.name,
    portion: '',
    grams,
    baselineGrams: grams,
    per100g: c.per100g,
    fixed: null,
    source: c.source,
    matchedName: c.brand ? `${c.name} · ${c.brand}` : c.name,
    fdcId: c.fdcId,
    barcode: c.barcode,
    lookup: 'ok',
  };
}
