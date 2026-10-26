import type { FoodPortion, Per100g } from './types';

export type { FoodPortion };

/*
 * USDA FoodData Central data rules shared by the app (usda.ts, foodIndex.ts) and scripts/build-food-index.mjs.
 *
 * This module has NO value imports on purpose: Node runs the build script straight against this .ts file (type
 * stripping), so the bundled offline index and the live API read nutrients by exactly the same rules.
 *
 *   - extractPer100g: per-100 g nutrients from an FDC nutrient list (live search rows and bulk downloads)
 *   - foodFromBulk: one food of the bulk JSON downloads (Foundation / SR Legacy / Survey (FNDDS)) → IndexFood
 *   - encodeFoodIndex / decodeFoodIndex: the compact file in public/ (FOOD_INDEX_VERSION)
 */

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

/** One nutrient of an FDC search row (only the fields we read). */
export interface FdcNutrient {
  nutrientNumber?: string | number;
  nutrientName?: string;
  unitName?: string;
  value?: number;
}

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

// ------------------------------------------------------------------ bulk downloads

/** The bulk JSON downloads' shapes (fdc.nal.usda.gov/download-datasets; only the fields we read). */
export interface FdcBulkNutrient {
  nutrient?: { number?: string | number; name?: string; unitName?: string };
  amount?: number;
}

export interface FdcBulkPortion {
  /** Foundation / SR Legacy: how many of the measure ("3" oz). */
  amount?: number;
  /** Foundation: the measure ("cup", "RACC"); SR Legacy and FNDDS say "undetermined". */
  measureUnit?: { name?: string };
  /** Foundation / SR Legacy: the measure's wording ("cup, chopped"); FNDDS: a numeric portion code. */
  modifier?: string;
  /** FNDDS: the full wording ("1 cup", "Quantity not specified"). */
  portionDescription?: string;
  gramWeight?: number;
  sequenceNumber?: number;
}

export interface FdcBulkFood {
  fdcId?: number;
  description?: string;
  dataType?: string;
  foodNutrients?: FdcBulkNutrient[];
  foodPortions?: FdcBulkPortion[];
}

/** One food of the offline index. */
export interface IndexFood {
  fdcId: number;
  /** The USDA description, as published ("Rice, white, long-grain, regular, enriched, cooked"). */
  name: string;
  dataType: IndexDataType;
  per100g: Per100g;
  portions: FoodPortion[];
}

/** The whole-food data types in the index (Branded stays on the live API and Open Food Facts). */
export const INDEX_DATA_TYPES = ['Foundation', 'SR Legacy', 'Survey (FNDDS)'] as const;
export type IndexDataType = (typeof INDEX_DATA_TYPES)[number];

/** Portions kept per food (FNDDS lists up to 16; the first few in USDA's own order are the common ones). */
export const MAX_PORTIONS = 6;
const MAX_LABEL = 48;

const num = (v: number) => String(Math.round(v * 100) / 100);

/**
 * A portion's label, or null when it's not a household measure worth offering.
 * - FNDDS: its portionDescription ("1 cup"); "Quantity not specified" (FNDDS's default amount) reads "Typical
 *   amount"; the "Guideline amount per …" rows (milk per cup of cereal) are dropped.
 * - Foundation: amount + unit + modifier ("1 fruit large (2-3/4" dia)"); RACC (FDA's Reference Amount Customarily
 *   Consumed) reads "1 serving (RACC)".
 * - SR Legacy: amount + modifier ("1 cup, chopped"), without the "(yield from 1 raw chop, with refuse …)" note.
 */
export function portionLabel(p: FdcBulkPortion, dataType: string): string | null {
  let label: string;
  if (dataType === 'Survey (FNDDS)') {
    const d = (p.portionDescription ?? '').trim();
    if (!d || /^guideline amount/i.test(d)) return null;
    label = /^quantity not specified$/i.test(d) ? 'Typical amount' : d;
  } else {
    const amount = finite(p.amount) && p.amount > 0 ? p.amount : 1;
    const unit = (p.measureUnit?.name ?? '').trim();
    const modifier = (p.modifier ?? '')
      .replace(/\s*\((yield|includes?)\b[^)]*\)?/gi, '')
      .trim();
    if (unit.toUpperCase() === 'RACC') label = `${num(amount)} serving (RACC)`;
    else {
      const measure = unit && unit.toLowerCase() !== 'undetermined' ? unit.toLowerCase() : '';
      const words = [measure, modifier].filter(Boolean).join(' ');
      if (!words) return null;
      label = `${num(amount)} ${words}`;
    }
  }
  label = label.replace(/\s+/g, ' ');
  if (label.length > MAX_LABEL) label = label.slice(0, MAX_LABEL - 1).replace(/[\s,;(]+\S*$/, '') + '…';
  return label;
}

/** A food's household measures in USDA's order, deduplicated by label, at most MAX_PORTIONS. */
export function portionsFromBulk(food: Pick<FdcBulkFood, 'dataType' | 'foodPortions'>): FoodPortion[] {
  const sorted = [...(food.foodPortions ?? [])].sort((a, b) => (a.sequenceNumber ?? 1e9) - (b.sequenceNumber ?? 1e9));
  const out: FoodPortion[] = [];
  const seen = new Set<string>();
  for (const p of sorted) {
    if (!p || !finite(p.gramWeight) || p.gramWeight <= 0) continue;
    const label = portionLabel(p, food.dataType ?? '');
    if (!label || seen.has(label.toLowerCase())) continue;
    seen.add(label.toLowerCase());
    out.push({ label, grams: Math.round(p.gramWeight * 10) / 10 });
    if (out.length === MAX_PORTIONS) break;
  }
  return out;
}

/** One bulk-download food as an index food, or null (no fdcId / description / energy, or not a whole food). */
export function foodFromBulk(food: FdcBulkFood | null | undefined): IndexFood | null {
  if (!food || !finite(food.fdcId)) return null;
  const name = (food.description ?? '').trim().replace(/\s+/g, ' ');
  const dataType = INDEX_DATA_TYPES.find((d) => d === food.dataType);
  if (!name || !dataType) return null;
  const per100g = extractPer100g(
    (food.foodNutrients ?? []).map((n) => ({ nutrientNumber: n?.nutrient?.number, value: n?.amount })),
  );
  if (!per100g) return null;
  return { fdcId: food.fdcId, name, dataType, per100g, portions: portionsFromBulk({ ...food, dataType }) };
}

// ------------------------------------------------------------------ the index file

/** Bumped whenever the row layout changes (the app refuses a file it can't read and falls back to the API). */
export const FOOD_INDEX_VERSION = 1;

/** Where a dataset came from: its data type and the release date of the download. */
export interface FoodIndexSource {
  dataType: IndexDataType;
  release: string;
}

/**
 * One food as a JSON row: [fdcId, name, dataType index, kcal, protein, carbs, fat, fiber, sugar, sodium,
 * portions?] — fiber / sugar / sodium null when unknown; portions flattened as [label, grams, label, grams, …]
 * and left off when there are none. Macros keep 2 decimals and kcal 1 (USDA publishes up to 3).
 */
export type FoodIndexRow = [number, string, number, number, number, number, number, number | null, number | null, number | null, ...(string | number)[][]];

export interface FoodIndexFile {
  v: number;
  sources: FoodIndexSource[];
  foods: FoodIndexRow[];
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;
const r2n = (v: number | null) => (v == null ? null : r2(v));

export function encodeFoodRow(f: IndexFood): FoodIndexRow {
  const p = f.per100g;
  const row: FoodIndexRow = [
    f.fdcId,
    f.name,
    INDEX_DATA_TYPES.indexOf(f.dataType),
    r1(p.kcal),
    r2(p.proteinG),
    r2(p.carbsG),
    r2(p.fatG),
    r2n(p.fiberG),
    r2n(p.sugarG),
    p.sodiumMg == null ? null : Math.round(p.sodiumMg),
  ];
  if (f.portions.length) row.push(f.portions.flatMap((x) => [x.label, x.grams]));
  return row;
}

export function encodeFoodIndex(foods: IndexFood[], sources: FoodIndexSource[]): FoodIndexFile {
  return { v: FOOD_INDEX_VERSION, sources, foods: foods.map(encodeFoodRow) };
}

const numOrNull = (v: unknown) => (finite(v) ? v : null);

/** One row back to a food, or null when it's malformed (skipped, never fatal). */
export function decodeFoodRow(row: unknown): IndexFood | null {
  if (!Array.isArray(row) || row.length < 10) return null;
  const [fdcId, name, dt, kcal, proteinG, carbsG, fatG, fiberG, sugarG, sodiumMg, flat] = row as unknown[];
  const dataType = typeof dt === 'number' ? INDEX_DATA_TYPES[dt] : undefined;
  if (!finite(fdcId) || typeof name !== 'string' || !name || !dataType) return null;
  if (!finite(kcal) || !finite(proteinG) || !finite(carbsG) || !finite(fatG)) return null;
  const portions: FoodPortion[] = [];
  if (Array.isArray(flat)) {
    for (let i = 0; i + 1 < flat.length; i += 2) {
      const label = flat[i];
      const grams = flat[i + 1];
      if (typeof label === 'string' && finite(grams) && grams > 0) portions.push({ label, grams });
    }
  }
  return {
    fdcId,
    name,
    dataType,
    per100g: { kcal, proteinG, carbsG, fatG, fiberG: numOrNull(fiberG), sugarG: numOrNull(sugarG), sodiumMg: numOrNull(sodiumMg) },
    portions,
  };
}

/** The index file's foods. Throws on a file of another version or shape (the caller falls back to the API). */
export function decodeFoodIndex(json: unknown): IndexFood[] {
  const file = json as Partial<FoodIndexFile> | null;
  if (!file || typeof file !== 'object' || file.v !== FOOD_INDEX_VERSION || !Array.isArray(file.foods)) {
    throw new Error('Unreadable food index');
  }
  const out: IndexFood[] = [];
  for (const row of file.foods) {
    const f = decodeFoodRow(row);
    if (f) out.push(f);
  }
  return out;
}
