import { describe, expect, it } from 'vitest';
import { clampWeightG, MEAL_SCHEMA, MealOutputError, parseMealOutput } from './schema';

/** Walk every object schema in MEAL_SCHEMA. */
function objects(node: unknown, path = '$', out: { path: string; node: Record<string, unknown> }[] = []) {
  if (node && typeof node === 'object') {
    const n = node as Record<string, unknown>;
    if (n.type === 'object') out.push({ path, node: n });
    for (const [k, v] of Object.entries(n)) objects(v, `${path}.${k}`, out);
  }
  return out;
}

describe('MEAL_SCHEMA (structured outputs rules)', () => {
  it('every object has additionalProperties:false and requires every property', () => {
    const objs = objects(MEAL_SCHEMA);
    expect(objs.map((o) => o.path)).toEqual(['$', '$.properties.items.items']);
    for (const { node } of objs) {
      expect(node.additionalProperties).toBe(false);
      expect([...(node.required as string[])].sort()).toEqual(Object.keys(node.properties as object).sort());
    }
  });

  it('uses no unsupported numeric / string constraints', () => {
    const s = JSON.stringify(MEAL_SCHEMA);
    for (const kw of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength']) {
      expect(s).not.toContain(`"${kw}"`);
    }
  });

  it('has the documented fields', () => {
    expect(Object.keys(MEAL_SCHEMA.properties)).toEqual(['is_food', 'items', 'confidence', 'scale_reference', 'notes']);
    expect(Object.keys(MEAL_SCHEMA.properties.items.items.properties)).toEqual([
      'name',
      'fdc_query',
      'portion',
      'weight_g',
      'calories',
      'protein_g',
      'carbs_g',
      'fat_g',
      'fiber_g',
      'sugar_g',
      'sodium_mg',
    ]);
    expect(MEAL_SCHEMA.properties.confidence.enum).toEqual(['low', 'medium', 'high']);
  });
});

describe('parseMealOutput', () => {
  const item = (over: Record<string, unknown> = {}) => ({
    name: 'Rice',
    fdc_query: 'rice, white, cooked',
    portion: '1 cup',
    weight_g: 180,
    calories: 234,
    protein_g: 4,
    carbs_g: 51,
    fat_g: 0.5,
    fiber_g: 0.6,
    sugar_g: 0.1,
    sodium_mg: 2,
    ...over,
  });

  it('maps snake_case to camelCase', () => {
    const r = parseMealOutput({ is_food: true, items: [item()], confidence: 'high', scale_reference: ' US quarter ', notes: 'ok' });
    expect(r).toEqual({
      isFood: true,
      items: [{ name: 'Rice', fdcQuery: 'rice, white, cooked', portion: '1 cup', weightG: 180, estimate: { kcal: 234, proteinG: 4, carbsG: 51, fatG: 0.5, fiberG: 0.6, sugarG: 0.1, sodiumMg: 2 } }],
      confidence: 'high',
      scaleReference: 'US quarter',
      notes: 'ok',
    });
  });

  it('clamps weight to 1..5000 g and nutrients to ≥ 0', () => {
    const r = parseMealOutput({
      is_food: true,
      items: [item({ weight_g: 0.2, calories: -5 }), item({ weight_g: 12000, sodium_mg: Number.NaN }), item({ weight_g: 'lots' }), item({ weight_g: 0 })],
      confidence: 'medium',
      scale_reference: null,
      notes: '',
    });
    expect(r.items.map((i) => i.weightG)).toEqual([1, 5000, 100, 100]);
    expect(r.items[0].estimate.kcal).toBe(0);
    expect(r.items[1].estimate.sodiumMg).toBe(0);
    expect(clampWeightG(250)).toBe(250);
  });

  it('drops nameless items, defaults fdc_query to the name, treats empty scale_reference as none', () => {
    const r = parseMealOutput({ is_food: true, items: [item({ name: '  ' }), item({ name: 'Toast', fdc_query: '' })], confidence: 'low', scale_reference: '  ', notes: ' n ' });
    expect(r.items.map((i) => [i.name, i.fdcQuery])).toEqual([['Toast', 'Toast']]);
    expect(r.scaleReference).toBeNull();
    expect(r.notes).toBe('n');
  });

  it('not food, or food with no usable items → isFood false with no items', () => {
    expect(parseMealOutput({ is_food: false, items: [item()], confidence: 'low', scale_reference: null, notes: 'a cat' })).toMatchObject({ isFood: false, items: [], notes: 'a cat' });
    expect(parseMealOutput({ is_food: true, items: [], confidence: 'low', scale_reference: null, notes: '' }).isFood).toBe(false);
  });

  it('an unknown confidence reads as low; a broken shape throws', () => {
    expect(parseMealOutput({ is_food: true, items: [item()], confidence: 'certain', scale_reference: null, notes: '' }).confidence).toBe('low');
    expect(() => parseMealOutput(null)).toThrow(MealOutputError);
    expect(() => parseMealOutput([])).toThrow(MealOutputError);
    expect(() => parseMealOutput({ items: [] })).toThrow(MealOutputError);
    expect(() => parseMealOutput({ is_food: true, items: 'rice' })).toThrow(MealOutputError);
  });
});
