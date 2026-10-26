import { describe, expect, it } from 'vitest';
import bulkFx from './__fixtures__/fdc-bulk.json';
import {
  decodeFoodIndex,
  decodeFoodRow,
  encodeFoodIndex,
  encodeFoodRow,
  FOOD_INDEX_VERSION,
  foodFromBulk,
  MAX_PORTIONS,
  portionLabel,
  portionsFromBulk,
  type FdcBulkFood,
  type IndexFood,
} from './fdcData';

/*
 * fdc-bulk.json: real rows of USDA's bulk JSON downloads (Foundation 2026-04-30, SR Legacy 2018-04, Survey (FNDDS)
 * 2024-10-31), trimmed to the nutrients and portion fields Heft reads: Kale (208), Fuji apple (958 + 957, no 208),
 * beet greens (957 only, sugar only as 269.3), iodized salt (no energy value), a null row (the Foundation file has
 * 32), rice / roasted chicken breast / a pork chop (SR Legacy portions with "(yield …)" notes), skim milk and a
 * pre-cooked chicken breast (FNDDS: "Quantity not specified", "Guideline amount …", 10 portions).
 */

type Bulk = Record<string, (FdcBulkFood | null)[]>;
const bulk = bulkFx as unknown as Bulk;
const byId = (id: number) => Object.values(bulk).flat().find((f) => f?.fdcId === id)!;

describe('foodFromBulk: nutrients (the live API rules: 208 → 958 → 957, 205 → 205.2, 269 → 269.3)', () => {
  it('Foundation kale: 208, and sugar from 269.3 when 269 is missing', () => {
    expect(foodFromBulk(byId(323505))).toMatchObject({
      fdcId: 323505,
      name: 'Kale, raw',
      dataType: 'Foundation',
      per100g: { kcal: 35, proteinG: 2.92, carbsG: 4.42, fatG: 1.49, fiberG: 4.1, sugarG: 0.8, sodiumMg: 53 },
    });
  });

  it('Foundation Fuji apple: 958 (Atwater specific, 58.2) beats 957 (64.7); 205 beats 205.2', () => {
    const apple = foodFromBulk(byId(1750340))!;
    expect(apple.per100g.kcal).toBe(58.2);
    expect(apple.per100g.carbsG).toBe(15.7); // 205.2 = 15.4
  });

  it('Foundation beet greens: 957 when it is the only energy number', () => {
    const greens = foodFromBulk(byId(2747653))!;
    expect(greens.per100g).toMatchObject({ kcal: 26.4, sugarG: 0.89, fiberG: 2.58 });
    expect(greens.portions).toEqual([]);
  });

  it('drops rows without an energy value, null rows and non-whole-food data types', () => {
    expect(foodFromBulk(byId(746775))).toBeNull(); // Salt, table, iodized: sodium only
    expect(bulk.FoundationFoods.filter((f) => f === null)).toHaveLength(1);
    expect(foodFromBulk(null)).toBeNull();
    expect(foodFromBulk({ ...byId(168878), dataType: 'Branded' })).toBeNull();
    expect(foodFromBulk({ ...byId(168878), description: '  ' })).toBeNull();
  });

  it('SR Legacy rice and FNDDS milk', () => {
    expect(foodFromBulk(byId(168878))).toEqual({
      fdcId: 168878,
      name: 'Rice, white, long-grain, regular, enriched, cooked',
      dataType: 'SR Legacy',
      per100g: { kcal: 130, proteinG: 2.69, carbsG: 28.2, fatG: 0.28, fiberG: 0.4, sugarG: 0.05, sodiumMg: 1 },
      portions: [{ label: '1 cup', grams: 158 }],
    });
    expect(foodFromBulk(byId(2705388))).toMatchObject({ dataType: 'Survey (FNDDS)', per100g: { kcal: 34, proteinG: 3.43 } });
  });
});

describe('portions', () => {
  it('Foundation: amount + unit + modifier, RACC as a serving', () => {
    expect(foodFromBulk(byId(323505))!.portions).toEqual([
      { label: '1 cup pieces of ~1"', grams: 20.6 },
      { label: '1 serving (RACC)', grams: 85 },
    ]);
  });

  it('SR Legacy: amount + modifier, without the "(yield …)" note, halves kept as 0.5', () => {
    expect(foodFromBulk(byId(171477))!.portions).toEqual([
      { label: '1 cup, chopped or diced', grams: 140 },
      { label: '1 unit', grams: 52 },
      { label: '0.5 breast, bone and skin removed', grams: 86 },
    ]);
    expect(foodFromBulk(byId(168240))!.portions).toEqual([
      { label: '1 chop without refuse', grams: 146 }, // "(Yield from 1 cooked chop, with refuse, weighing 209g)"
      { label: '3 oz', grams: 85 },
    ]);
  });

  it('FNDDS: USDA order, "Quantity not specified" → "Typical amount", the "Guideline amount …" rows dropped', () => {
    expect(foodFromBulk(byId(2705388))!.portions).toEqual([
      { label: '1 cup', grams: 244 },
      { label: '1 fl oz', grams: 30.5 },
      { label: '1 individual school container', grams: 244 },
      { label: 'Typical amount', grams: 244 },
    ]);
  });

  it(`keeps at most ${MAX_PORTIONS}, in sequence order`, () => {
    const chicken = byId(2705958);
    expect(chicken.foodPortions).toHaveLength(10);
    expect(foodFromBulk(chicken)!.portions.map((p) => p.label)).toEqual([
      '1 cup, cooked, diced',
      '1 small breast',
      '1 medium breast',
      '1 large breast',
      '1 small or thin slice',
      '1 medium slice',
    ]);
  });

  it('skips zero / missing gram weights and duplicate labels; trims long labels at a word', () => {
    expect(
      portionsFromBulk({
        dataType: 'SR Legacy',
        foodPortions: [
          { amount: 1, modifier: 'cup', gramWeight: 0 },
          { amount: 1, modifier: 'cup', gramWeight: 100 },
          { amount: 1, modifier: 'Cup', gramWeight: 120 },
          { amount: 1, modifier: 'slice' },
          { amount: 2, modifier: 'tbsp', gramWeight: 32.04 },
        ],
      }),
    ).toEqual([
      { label: '1 cup', grams: 100 },
      { label: '2 tbsp', grams: 32 },
    ]);
    const long = portionLabel({ amount: 1, modifier: 'individual serving of something with a very long description indeed' }, 'SR Legacy')!;
    expect(long.length).toBeLessThanOrEqual(48);
    expect(long).toBe('1 individual serving of something with a very…');
    expect(portionLabel({ amount: 1, measureUnit: { name: 'undetermined' }, modifier: '' }, 'SR Legacy')).toBeNull();
  });
});

describe('the index file', () => {
  const kale = foodFromBulk(byId(323505))!;
  const beets = foodFromBulk(byId(2747653))!;

  it('a food is one compact row (portions flattened, left off when there are none) and decodes back', () => {
    expect(encodeFoodRow(kale)).toEqual([323505, 'Kale, raw', 0, 35, 2.92, 4.42, 1.49, 4.1, 0.8, 53, ['1 cup pieces of ~1"', 20.6, '1 serving (RACC)', 85]]);
    expect(encodeFoodRow(beets)).toHaveLength(10);
    const file = encodeFoodIndex([kale, beets], [{ dataType: 'Foundation', release: '2026-04-30' }]);
    expect(file.v).toBe(FOOD_INDEX_VERSION);
    // beet greens' fat (0.144 g) comes back at the file's 2 decimals
    expect(decodeFoodIndex(JSON.parse(JSON.stringify(file)))).toEqual([kale, { ...beets, per100g: { ...beets.per100g, fatG: 0.14 } }]);
  });

  it('rounds kcal to 1 decimal and macros to 2; unknown stays null', () => {
    const f: IndexFood = {
      fdcId: 1,
      name: 'Test',
      dataType: 'SR Legacy',
      per100g: { kcal: 64.73, proteinG: 0.1484, carbsG: 15.705, fatG: 0.162, fiberG: null, sugarG: 13.333, sodiumMg: 1.4 },
      portions: [],
    };
    expect(encodeFoodRow(f)).toEqual([1, 'Test', 1, 64.7, 0.15, 15.71, 0.16, null, 13.33, 1]);
  });

  it('refuses another version or shape; skips malformed rows and portion pairs', () => {
    expect(() => decodeFoodIndex({ v: FOOD_INDEX_VERSION + 1, sources: [], foods: [] })).toThrow();
    expect(() => decodeFoodIndex(null)).toThrow();
    expect(() => decodeFoodIndex({ v: FOOD_INDEX_VERSION })).toThrow();
    const good = encodeFoodRow(kale);
    const foods = decodeFoodIndex({
      v: FOOD_INDEX_VERSION,
      sources: [],
      foods: [good, 'junk', [2, 'No type', 9, 1, 1, 1, 1, null, null, null], [3, 'No kcal', 1, null, 1, 1, 1, null, null, null]],
    });
    expect(foods).toEqual([kale]);
    expect(decodeFoodRow([4, 'Bad portions', 1, 10, 1, 1, 1, null, null, null, ['1 cup', 0, 5, 10, '1 oz', 28.35, 'dangling']])!.portions).toEqual([
      { label: '1 oz', grams: 28.35 },
    ]);
  });
});
