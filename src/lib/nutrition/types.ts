// Domain model for the Food tab (nutrition). Food MASS is stored in GRAMS and energy in KCAL (the one
// exception to Heft's kg/m storage rule: nutrition databases are per 100 g). Convert to oz only at the UI
// edge (lib/units.ts gToOz / formatGrams). Timestamps are epoch ms; `day` is the local 'yyyy-MM-dd'.

export type Confidence = 'low' | 'medium' | 'high';

/** Where an item's numbers come from. 'estimate' = Claude's own figure (no database match). */
export type NutrientSource = 'usda' | 'off' | 'estimate' | 'manual';

/**
 * Meal lifecycle.
 * - draft: photos are being collected on the capture screen (saved immediately so an iOS kill can't lose them)
 * - pending: ready to analyze (e.g. logged offline, or the user left before it ran)
 * - analyzing: a Claude call is in flight IN THIS APP SESSION (see lib/nutrition/analyze.ts isAnalysisRunning)
 * - done: items/totals are final (and editable)
 * - failed: the last analysis failed; `error` says why; photos are kept for Retry
 */
export type MealStatus = 'draft' | 'pending' | 'analyzing' | 'done' | 'failed';

/** Per-item database lookup outcome (shown per row, never as a whole-meal warning). */
export type LookupStatus = 'ok' | 'no_match' | 'rate_limited' | 'failed' | 'skipped' | 'key_rejected';

export type Activity = 'sedentary' | 'light' | 'moderate' | 'active' | 'very_active';
export type Goal = 'lose' | 'maintain' | 'gain';
export type Pace = 'steady' | 'aggressive';

/** Nutrients for 100 g. Fiber/sugar/sodium can be unknown (null), e.g. a label that doesn't list them. */
export interface Per100g {
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  fiberG: number | null;
  sugarG: number | null;
  sodiumMg: number | null;
}

/** Summed nutrients (unknown values count as 0 in a sum). */
export interface Totals {
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  fiberG: number;
  sugarG: number;
  sodiumMg: number;
}

export interface MealItem {
  id: string;
  /** Friendly name shown in the UI. NEVER overwritten by a database match (that goes in matchedName). */
  name: string;
  /** Claude's free-text portion, e.g. "1 cup" ('' when none). */
  portion: string;
  /** Grams PER SERVING (user-editable). null only for fixed (quick-add) items. */
  grams: number | null;
  /** What the model / label first said, for "reset". */
  baselineGrams: number | null;
  /** SOURCE OF TRUTH for scalable items: nutrients = per100g × grams/100 × meal.serves. null for fixed items. */
  per100g: Per100g | null;
  /** Quick-add items: nutrients for ONE serving, not scaled by grams (still × meal.serves). */
  fixed: Totals | null;
  source: NutrientSource;
  /** USDA description / Open Food Facts product name of the matched food. */
  matchedName?: string;
  fdcId?: number;
  barcode?: string;
  /** Claude's USDA search phrase, kept so the item can be re-matched. */
  fdcQuery?: string;
  lookup?: LookupStatus;
}

export interface MealInput {
  kind: 'photo' | 'text' | 'barcode' | 'search' | 'quick';
  /** User's description (authoritative context for the model). */
  description?: string;
  /** User-weighed total weight in grams (authoritative; lifts confidence). */
  weightG?: number | null;
}

/** One billed Claude call (append-only: retries, failures and refusals are all recorded). */
export interface AiCall {
  at: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  ok: boolean;
  error?: string;
}

export interface Meal {
  id: string; // 'meal_' + uid()
  /** When it was eaten (epoch ms). */
  at: number;
  /** Local 'yyyy-MM-dd' of `at` (indexed; derived by recomputeMeal). */
  day: string;
  title: string;
  status: MealStatus;
  /** Epoch ms of the last status change. */
  statusAt: number;
  error: string | null;
  input: MealInput;
  /** db.media ids (protected from the orphan sweep because they're referenced here). */
  photoIds: string[];
  /** 1–20; multiplies every item. */
  serves: number;
  items: MealItem[];
  /** Cache of the summed items × serves — always rewritten by recomputeMeal(). */
  totals: Totals;
  confidence: Confidence | null;
  /** The object Claude used for scale ("US quarter", "fork") or null. */
  scaleReference: string | null;
  notes: string;
  /** How many photos the last analysis used. */
  angles: number;
  aiCalls: AiCall[];
  createdAt: number;
  updatedAt: number;
}

/**
 * Append-only spend ledger: one row per billed Claude call, written by store.updateMeal/createMeal whenever a
 * meal's aiCalls grows. Survives meal deletion and back-dating (the meter sums by CALL time).
 */
export interface AiSpendRow extends AiCall {
  id: string;
  mealId: string;
}

/** Personal food library: recents for search + offline barcode cache. */
export interface Food {
  id: string; // 'usda:<fdcId>' | 'off:<barcode>' | 'custom:<uid>'
  name: string;
  brand?: string;
  source: NutrientSource;
  fdcId?: number;
  barcode?: string;
  per100g: Per100g;
  /** Label serving size in grams, when known. */
  servingG: number | null;
  lastUsedAt: number;
  useCount: number;
}

export interface NutritionProfile {
  id: 'profile';
  activity: Activity;
  goal: Goal;
  pace: Pace;
  /** Optional hand-set targets (null = use the computed value). */
  kcalOverride: number | null;
  proteinOverride: number | null;
  /** Set once the user has confirmed their targets (hides the setup prompt). */
  setupDoneAt: number | null;
}

/** Body inputs for BMR. Comes from Heft Settings (sex, birthYear, heightCm) + current bodyweight. */
export interface Body {
  sex: 'male' | 'female';
  age: number;
  heightCm: number;
  weightKg: number;
}

export interface Targets {
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  fiberG: number;
  bmr: number;
  tdee: number;
  /** True when kcal or protein came from an override. */
  overridden: boolean;
}

/** A food you can pick: a USDA search hit, an Open Food Facts product, or a cached Food. */
export interface FoodChoice {
  id: string; // same id scheme as Food
  name: string;
  brand?: string;
  source: 'usda' | 'off';
  fdcId?: number;
  barcode?: string;
  per100g: Per100g;
  servingG: number | null;
  /** USDA dataType ("Foundation", "SR Legacy", "Survey (FNDDS)", "Branded") when known. */
  dataType?: string;
}
