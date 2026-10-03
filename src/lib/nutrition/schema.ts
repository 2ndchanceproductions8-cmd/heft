import type { Confidence } from './types';
import type { AiItem } from './foodAi';

/*
 * The JSON Schema Claude's answer is constrained to (structured outputs, output_config.format). Structured
 * outputs require additionalProperties:false and every property listed in `required` at every level, and do
 * NOT support numeric bounds (minimum/maximum) — so the bounds live in parseMealOutput() instead, which
 * validates and clamps whatever comes back before anything else trusts it.
 */

const num = { type: 'number' } as const;

export const MEAL_SCHEMA = {
  type: 'object',
  properties: {
    is_food: { type: 'boolean' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          fdc_query: { type: 'string' },
          portion: { type: 'string' },
          weight_g: num,
          calories: num,
          protein_g: num,
          carbs_g: num,
          fat_g: num,
          fiber_g: num,
          sugar_g: num,
          sodium_mg: num,
        },
        required: ['name', 'fdc_query', 'portion', 'weight_g', 'calories', 'protein_g', 'carbs_g', 'fat_g', 'fiber_g', 'sugar_g', 'sodium_mg'],
        additionalProperties: false,
      },
    },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    scale_reference: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    notes: { type: 'string' },
  },
  required: ['is_food', 'items', 'confidence', 'scale_reference', 'notes'],
  additionalProperties: false,
} as const;

export const MIN_ITEM_WEIGHT_G = 1;
export const MAX_ITEM_WEIGHT_G = 5000;
/** Used when the model gives no usable weight at all (the UI shows it as an editable baseline). */
const FALLBACK_WEIGHT_G = 100;

export interface ParsedMeal {
  isFood: boolean;
  items: AiItem[];
  confidence: Confidence;
  scaleReference: string | null;
  notes: string;
}

export class MealOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MealOutputError';
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const nonNeg = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, v) : 0);

/** weight_g clamped to 1..5000 g (non-numbers → 100 g). */
export function clampWeightG(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return FALLBACK_WEIGHT_G;
  return Math.min(MAX_ITEM_WEIGHT_G, Math.max(MIN_ITEM_WEIGHT_G, v));
}

/**
 * Validate Claude's parsed JSON against MEAL_SCHEMA's shape and clamp it (snake_case → camelCase). Throws
 * MealOutputError when the top-level shape is unusable. Items without a name are dropped; a meal reported as
 * food with no items left is returned as not-food.
 */
export function parseMealOutput(raw: unknown): ParsedMeal {
  if (!isObj(raw)) throw new MealOutputError('not an object');
  if (typeof raw.is_food !== 'boolean') throw new MealOutputError('is_food missing');
  if (!Array.isArray(raw.items)) throw new MealOutputError('items missing');
  const items: AiItem[] = [];
  for (const it of raw.items) {
    if (!isObj(it)) continue;
    const name = str(it.name);
    if (!name) continue;
    items.push({
      name,
      fdcQuery: str(it.fdc_query) || name,
      portion: str(it.portion),
      weightG: clampWeightG(it.weight_g),
      estimate: {
        kcal: nonNeg(it.calories),
        proteinG: nonNeg(it.protein_g),
        carbsG: nonNeg(it.carbs_g),
        fatG: nonNeg(it.fat_g),
        fiberG: nonNeg(it.fiber_g),
        sugarG: nonNeg(it.sugar_g),
        sodiumMg: nonNeg(it.sodium_mg),
      },
    });
  }
  const c = raw.confidence;
  const confidence: Confidence = c === 'low' || c === 'medium' || c === 'high' ? c : 'low';
  const scaleReference = str(raw.scale_reference) || null;
  return {
    isFood: raw.is_food && items.length > 0,
    items: raw.is_food ? items : [],
    confidence,
    scaleReference,
    notes: str(raw.notes),
  };
}
