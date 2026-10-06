// Server-render tests for the Today Food card (no DOM library: effects don't run and live queries return
// undefined, so the view is rendered with plain props, and the live card only in its loading state).
import 'fake-indexeddb/auto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createElement as h, type ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { emptyTotals, recomputeMeal } from '../../lib/nutrition/math';
import { computeTargets } from '../../lib/nutrition/targets';
import type { Meal, MealItem, Targets } from '../../lib/nutrition/types';
import type { BodyField } from '../../lib/nutrition/targets';
import { FuelCard, FuelCardView } from './FuelCard';
import { useInterruptedAnalyses } from './fuel/interrupted';
import { interruptedIds, mealCountLabel, unfinishedLabel, unfinishedLines } from './fuel/model';

/** Visible text of the rendered markup (tags stripped), plus the raw HTML for attribute checks. */
function render(el: ReactElement): string {
  const html = renderToString(h(MemoryRouter, { initialEntries: ['/today'] }, el));
  const text = html
    .replace(/<!-- -->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'");
  return `${text}\n${html}`;
}
/** Only the visible text of render()'s output (class names like text-left stay out of it). */
const textOf = (rendered: string) => rendered.split('\n')[0];

const AT = new Date(2026, 9, 6, 12, 30).getTime();
const item = (p: Partial<MealItem> = {}): MealItem => ({
  id: 'it1',
  name: 'Chicken breast',
  portion: '',
  grams: 200,
  baselineGrams: 200,
  per100g: { kcal: 165, proteinG: 31, carbsG: 0, fatG: 3.6, fiberG: 0, sugarG: 0, sodiumMg: 74 },
  fixed: null,
  source: 'usda',
  ...p,
});
let seq = 0;
const meal = (p: Partial<Meal> = {}): Meal =>
  recomputeMeal({
    id: `meal_${++seq}`,
    at: AT,
    day: '',
    title: 'Chicken lunch',
    status: 'done',
    statusAt: AT,
    error: null,
    input: { kind: 'photo' },
    photoIds: [],
    serves: 1,
    items: [item()], // 330 kcal, 62 g protein, 7.2 g fat
    totals: emptyTotals(),
    confidence: 'medium',
    scaleReference: null,
    notes: '',
    angles: 1,
    aiCalls: [],
    createdAt: AT,
    updatedAt: AT,
    ...p,
  });

const TARGETS: Targets = computeTargets(
  { activity: 'moderate', goal: 'maintain', pace: 'steady', kcalOverride: 2000, proteinOverride: 180 },
  { sex: 'male', age: 32, heightCm: 178, weightKg: 80 },
);
const WITH = { targets: TARGETS, missing: [] as BodyField[] };
const WITHOUT = { targets: null, missing: ['sex', 'birthYear', 'heightCm'] as BodyField[] };

const card = (p: Partial<Parameters<typeof FuelCardView>[0]>) => render(h(FuelCardView, { meals: [], targets: WITH, ...p }));

describe('Today Food card: loading', () => {
  it('the live card renders a skeleton the height of the loaded ring row, and the log actions already work', () => {
    const html = render(h(FuelCard, { today: '2026-10-06', now: AT }));
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('min-h-[134px]');
    expect(html).toContain('Snap a meal');
    expect(html).toContain('Scan');
    expect(html).not.toContain('Nothing logged yet');
    expect(html).not.toMatch(/\d+ meals?\b/);
  });

  it('targets still loading is loading too (never a no-target prompt flash)', () => {
    const html = card({ meals: [meal()], targets: undefined });
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain('to get a daily target');
  });

  it('the loaded budget row keeps the skeleton height, with no meals as with one', () => {
    for (const html of [card({}), card({ meals: [meal()] })]) {
      expect(html).toContain('min-h-[134px]');
      expect(html).not.toMatch(/<p class="text-center/); // no extra row under the ring row
      expect(html).not.toContain('Only analyzed meals count');
    }
  });
});

describe('Today Food card: nothing logged', () => {
  it('no targets: a message, the setup link naming the missing fields, no 0 kcal verdict', () => {
    const html = card({ targets: WITHOUT });
    expect(html).toContain('Nothing logged yet');
    expect(html).toContain('Add your sex, birth year and height to get a daily target');
    expect(html).toContain('href="/nutrition/settings"');
    expect(html).not.toContain('kcal eaten');
    expect(html).not.toMatch(/\b0 kcal/);
    expect(textOf(html)).not.toMatch(/\bleft\b/);
  });

  it('no targets and no field named: falls back to body details', () => {
    expect(card({ targets: { targets: null, missing: [] } })).toContain('Add your body details to get a daily target');
  });

  it('with targets: the full budget left and the target, not "0 / 2,000"', () => {
    const html = card({});
    expect(html).toContain('aria-label="2,000 kcal left"');
    expect(textOf(html).indexOf('Nothing logged yet')).toBeLessThan(textOf(html).indexOf('Protein')); // the line under the ring
    expect(html).toContain('Nothing logged yet');
    expect(html).not.toContain('0 / 2,000');
    expect(html).not.toContain('to get a daily target');
    expect(html).toContain('Protein');
    expect(html).toContain('/ 180g');
  });
});

describe('Today Food card: totals', () => {
  it('under target: what is left, eaten / target, protein first', () => {
    const html = card({ meals: [meal()] });
    expect(html).toContain('aria-label="1,670 kcal left"');
    expect(html).toMatch(/330 \/ 2,000 kcal/);
    expect(html).not.toContain('text-danger');
    expect(html).not.toContain('Nothing logged yet');
    const text = textOf(html);
    expect(text.indexOf('Protein')).toBeLessThan(text.indexOf('Carbs'));
    expect(text.indexOf('Carbs')).toBeLessThan(text.indexOf('Fat'));
    expect(text).toMatch(/Protein 62 \/ 180g/);
  });

  it('over target: the overage in danger tone, labelled over', () => {
    const big = meal({ items: [item({ grams: 1400 })] }); // 2,310 kcal
    const html = card({ meals: [big] });
    expect(html).toContain('aria-label="310 kcal over"');
    expect(html).toMatch(/>310<\/span>/);
    expect(html).toContain('>over<');
    expect(html).toContain('text-danger');
    expect(html).toContain('stroke-danger');
    expect(html).toMatch(/2,310 \/ 2,000 kcal/);
  });

  it('no targets with a meal: kcal eaten big, macros without targets, and the setup link', () => {
    const html = card({ meals: [meal()], targets: WITHOUT });
    expect(html).toMatch(/330 kcal eaten/);
    expect(html).toMatch(/Protein 62 g Carbs 0 g Fat 7\.2 g/);
    expect(html).toContain('to get a daily target');
    expect(textOf(html)).not.toMatch(/\bleft\b/);
  });

  it('meals that are not done never count toward the totals', () => {
    const html = card({
      meals: [
        meal(),
        meal({ status: 'failed', error: 'Claude is overloaded' }),
        meal({ status: 'pending' }),
        meal({ status: 'draft' }),
        meal({ status: 'analyzing' }),
      ],
    });
    expect(html).toMatch(/330 \/ 2,000 kcal/);
    expect(html).toContain('aria-label="1,670 kcal left"');
    expect(html).toMatch(/Protein 62 \/ 180g/);
    expect(html).toContain('5 meals'); // the header counts what the Diary lists
  });

  it('only unfinished meals today: the target still shows as untouched, no "Nothing logged yet"', () => {
    const html = card({ meals: [meal({ status: 'pending' })] });
    expect(html).toContain('2,000 kcal target');
    expect(html).toContain('aria-label="2,000 kcal left"');
    expect(html).not.toContain('Nothing logged yet');
    expect(html).toContain('1 meal waiting to analyze');
  });
});

describe('Today Food card: unfinished meals', () => {
  const lineText = (meals: Meal[], interrupted?: ReadonlySet<string>) => textOf(card({ meals, interrupted }));

  it('each kind has its own line, and the block explains and opens the Diary', () => {
    const html = card({ meals: [meal({ status: 'failed' })] });
    expect(html).toContain('1 meal needs a retry');
    expect(html).toContain('Only analyzed meals count toward your totals.');
    expect(html).toContain('href="/nutrition"');
    expect(lineText([meal({ status: 'draft' })])).toContain('1 photo meal not finished');
    expect(lineText([meal({ status: 'pending' })])).toContain('1 meal waiting to analyze');
    expect(lineText([meal({ status: 'analyzing' })])).toContain('1 meal still analyzing');
  });

  it('an analyzing meal whose run died with the app needs a retry, not a spinner', () => {
    const stuck = meal({ status: 'analyzing' });
    const text = lineText([stuck, meal({ status: 'failed' })], new Set([stuck.id]));
    expect(text).toContain('2 meals need a retry');
    expect(text).not.toContain('still analyzing');
  });

  it('interruptedIds: a dead analyzing run needs a retry, a live one keeps analyzing, other statuses are ignored', () => {
    const live = meal({ status: 'analyzing' });
    const dead = meal({ status: 'analyzing' });
    const meals = [live, dead, meal({ status: 'failed' }), meal({ status: 'pending' }), meal()];
    const ids = interruptedIds(meals, (id) => id === live.id);
    expect([...ids]).toEqual([dead.id]);
    expect(interruptedIds([meal({ status: 'pending' })], () => false).size).toBe(0);
    const text = lineText(meals, ids);
    expect(text).toContain('2 meals need a retry');
    expect(text).toContain('1 meal still analyzing');
  });

  it('the hook answers on the first render', () => {
    function Probe({ meals }: { meals: Meal[] }) {
      return h('i', null, [...useInterruptedAnalyses(meals)].join(','));
    }
    // Nothing runs in the test process, so an 'analyzing' meal has lost its run; a 'pending' one never had one.
    const analyzing = meal({ status: 'analyzing' });
    const pending = meal({ status: 'pending' });
    const html = renderToString(h(Probe, { meals: [analyzing, pending] }));
    expect(html).toBe(`<i>${analyzing.id}</i>`);
  });

  it('several kinds at once, most urgent first', () => {
    const text = lineText([
      meal({ status: 'analyzing' }),
      meal({ status: 'draft' }),
      meal({ status: 'draft' }),
      meal({ status: 'failed' }),
    ]);
    const order = ['1 meal needs a retry', '2 photo meals not finished', '1 meal still analyzing'].map((s) => text.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('no line and no note when every meal is done', () => {
    const html = card({ meals: [meal(), meal()] });
    expect(html).not.toContain('Only analyzed meals count');
    expect(html).not.toMatch(/retry|not finished|waiting to analyze|still analyzing/);
  });

  it('unfinishedLines ignores finished meals and pluralizes', () => {
    const lines = unfinishedLines([meal(), meal({ status: 'pending' }), meal({ status: 'pending' }), meal({ status: 'pending' })]);
    expect(lines).toEqual([{ kind: 'pending', count: 3, label: '3 meals waiting to analyze' }]);
    expect(unfinishedLabel('analyzing', 2)).toBe('2 meals still analyzing');
    expect(unfinishedLabel('draft', 1)).toBe('1 photo meal not finished');
    expect(unfinishedLines([])).toEqual([]);
  });
});

describe('Today Food card: header and actions', () => {
  it('counts meals with the right plural, and hides the count at zero', () => {
    expect(mealCountLabel(1)).toBe('1 meal');
    expect(mealCountLabel(2)).toBe('2 meals');
    expect(card({ meals: [meal()] })).toMatch(/Food 1 meal\b/);
    expect(card({ meals: [meal(), meal()] })).toMatch(/Food 2 meals\b/);
    expect(textOf(card({ meals: [] }))).not.toMatch(/\d+ meals?\b/);
  });

  it('the header opens the Diary and the two log actions are always there', () => {
    const html = card({ meals: [meal()] });
    expect(html).toMatch(/<h2[^>]*><a[^>]*href="\/nutrition"/);
    expect(html).toContain('Snap a meal');
    expect(html).toContain('aria-label="Scan a barcode"');
  });
});

describe('Today Food card: display-only burn', () => {
  it('no file of the card imports workout burn, calories or Apple Health', () => {
    const files = ['FuelCard.tsx', ...readdirSync(join(__dirname, 'fuel')).map((f) => join('fuel', f))];
    for (const f of files) {
      const src = readFileSync(join(__dirname, f), 'utf8');
      const imports = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
      expect(imports.filter((i) => /burn|calories|appleHealth|workouts/.test(i)), f).toEqual([]);
    }
  });
});
