// Server-render tests for the capture / meal / search / scan screens (no DOM library: effects don't run and
// live queries return their loading defaults), plus the pure helpers those screens rely on.
import 'fake-indexeddb/auto';
import { createElement as h, type ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { dayKey, recomputeMeal, shiftDay } from '../../lib/nutrition/math';
import type { FoodChoice, Meal, MealItem, NutrientSource, Per100g } from '../../lib/nutrition/types';
import { SourceChip } from './ui';
import { FoodRow, SearchMessage } from './FoodSearchSheet';
import { CapturePage, parseWeightField } from './CapturePage';
import { MealPage } from './MealPage';
import { ScanPage } from './ScanPage';
import { ShotTray } from './capture/ShotTray';
import { DetailsPanel } from './capture/DetailsPanel';
import { gramsEdited, ItemRow } from './meal/ItemRow';
import { AnalysisNotes, AnalyzingView, MealProblem, MealSummary } from './meal/MealStates';
import { MealDoneView, needsFdcKeyBanner } from './meal/MealDoneView';
import { ProductCard } from './scan/ProductCard';
import {
  barcodeCandidates,
  dayLabel,
  fromDateTimeLocal,
  lookupNote,
  matchedLine,
  mealDisplayTitle,
  per100Line,
  quickAmounts,
  toDateTimeLocal,
} from './meal/format';
import { diaryPath, logPath, mealPath, scanPath, validDay } from './meal/nav';

/** Visible text of the rendered markup (tags stripped), plus the raw HTML for attribute checks. */
function render(el: ReactElement, url = '/nutrition'): string {
  const html = renderToString(h(MemoryRouter, { initialEntries: [url] }, el));
  return `${textOf(html)}\n${html}`;
}
function textOf(html: string): string {
  return html
    .replace(/<!-- -->/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'");
}
/** Render only the visible text. */
const text = (el: ReactElement, url?: string) => textOf(renderToString(h(MemoryRouter, { initialEntries: [url ?? '/nutrition'] }, el)));

const noop = () => {};
const per100 = (kcal: number, p: number, c: number, f: number): Per100g => ({
  kcal,
  proteinG: p,
  carbsG: c,
  fatG: f,
  fiberG: null,
  sugarG: null,
  sodiumMg: null,
});

const rice: MealItem = {
  id: 'i1',
  name: 'Steamed rice',
  portion: '1 cup',
  grams: 158,
  baselineGrams: 158,
  per100g: per100(130, 2.69, 28.17, 0.28),
  fixed: null,
  source: 'usda',
  matchedName: 'Rice, white, cooked',
  fdcId: 168878,
  fdcQuery: 'rice white cooked',
  lookup: 'ok',
};
const chicken: MealItem = {
  id: 'i2',
  name: 'Grilled chicken',
  portion: '1 breast',
  grams: 150,
  baselineGrams: 120,
  per100g: per100(165, 31, 0, 3.6),
  fixed: null,
  source: 'estimate',
  fdcQuery: 'chicken breast grilled',
  lookup: 'rate_limited',
};
const coffee: MealItem = {
  id: 'i3',
  name: 'Latte',
  portion: '',
  grams: null,
  baselineGrams: null,
  per100g: null,
  fixed: { kcal: 190, proteinG: 12, carbsG: 18, fatG: 7, fiberG: 0, sugarG: 17, sodiumMg: 150 },
  source: 'manual',
};
const nutella: MealItem = {
  id: 'i4',
  name: 'Nutella',
  portion: '',
  grams: 37,
  baselineGrams: 37,
  per100g: per100(539, 6.3, 57.5, 30.9),
  fixed: null,
  source: 'off',
  matchedName: 'Nutella · Ferrero',
  barcode: '3017620422003',
  lookup: 'ok',
};

const AT = new Date(2026, 9, 3, 12, 30).getTime();
function meal(p: Partial<Meal> = {}): Meal {
  return recomputeMeal({
    id: 'meal_1',
    at: AT,
    day: '',
    title: 'Chicken rice bowl',
    status: 'done',
    statusAt: AT,
    error: null,
    input: { kind: 'photo', description: 'chicken rice bowl' },
    photoIds: [],
    serves: 1,
    items: [rice, chicken],
    totals: { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0, fiberG: 0, sugarG: 0, sodiumMg: 0 },
    confidence: 'medium',
    scaleReference: 'US quarter',
    notes: 'The rice looks like about a cup.',
    angles: 2,
    aiCalls: [],
    createdAt: AT,
    updatedAt: AT,
    ...p,
  });
}

const itemRow = (item: MealItem, serves = 1, mu: 'g' | 'oz' = 'g') =>
  render(h(ItemRow, { item, serves, mu, onRename: noop, onGrams: noop, onResetGrams: noop, onMenu: noop }));

describe('ItemRow', () => {
  it("shows the item's own name, the USDA match on its own line, and the USDA chip", () => {
    const out = itemRow(rice);
    expect(out).toContain('Steamed rice');
    expect(out).toContain('USDA: Rice, white, cooked');
    expect(out).toMatch(/>USDA</);
    // 130 kcal/100 g × 158 g
    expect(out).toContain('>205<');
    expect(out).toContain('aria-label="Weight of Steamed rice in g"');
    expect(out).toContain('value="158"');
    expect(out).not.toContain('was ');
    expect(out).toContain('Portion: 1 cup');
  });

  it('multiplies by servings', () => {
    const out = itemRow(rice, 2);
    expect(out).toContain('>411<');
    expect(out).toContain('× 2');
  });

  it("explains Claude's estimate and offers to reset an edited weight", () => {
    const out = itemRow(chicken);
    expect(out).toContain("USDA busy — Claude's estimate");
    expect(out).toMatch(/>Est\.</);
    expect(out).toContain('was 120 g');
    expect(out).toContain('Reset');
    expect(out).not.toContain('USDA: ');
  });

  it('a fixed (quick-add) item hides the grams editor', () => {
    const out = itemRow(coffee);
    expect(out).toContain('Quick add');
    expect(out).not.toContain('aria-label="Weight of');
    expect(out).toMatch(/>Manual</);
    expect(out).toContain('>190<');
  });

  it('label products show the Label line and chip', () => {
    const out = itemRow(nutella);
    expect(out).toContain('Label: Nutella · Ferrero');
    expect(out).toMatch(/>Label</);
  });

  it('edits in the user mass unit', () => {
    const out = itemRow(rice, 1, 'oz');
    expect(out).toContain('value="5.6"');
    expect(out).toContain('aria-label="Weight of Steamed rice in oz"');
  });
});

describe('SourceChip', () => {
  it.each<[NutrientSource, string]>([
    ['usda', 'USDA'],
    ['off', 'Label'],
    ['estimate', 'Est.'],
    ['manual', 'Manual'],
  ])('%s → %s', (source, label) => {
    expect(text(h(SourceChip, { source }))).toBe(label);
  });
});

describe('meal states', () => {
  it('analyzing: reading copy and the number of angles', () => {
    const two = render(h(AnalyzingView, { photoUrls: ['blob:a', 'blob:b'], photoCount: 2 }));
    expect(two).toContain('Reading your plate…');
    expect(two).toContain('Judging portions from 2 angles');
    expect(two).toContain('opacity-35');
    expect(render(h(AnalyzingView, { photoUrls: ['blob:a'], photoCount: 1 }))).toContain('Judging portions from 1 angle<');
    const textOnly = render(h(AnalyzingView, { photoUrls: [], photoCount: 0, description: 'two eggs on toast' }));
    expect(textOnly).toContain('Working from your description');
    expect(textOnly).toContain('two eggs on toast');
  });

  it('failed: shows the error, Retry and manual entry', () => {
    const out = render(
      h(MealProblem, { variant: 'failed', error: 'Claude is overloaded — try again shortly.', hasKey: true, onRetry: noop, onAddKey: noop, onManual: noop }),
    );
    expect(out).toContain('Claude is overloaded — try again shortly.');
    expect(out).toContain('>Retry<');
    expect(out).toContain('Enter manually instead');
  });

  it('failed without a key offers the key instead of Retry', () => {
    const out = render(h(MealProblem, { variant: 'failed', error: 'x', hasKey: false, onRetry: noop, onAddKey: noop, onManual: noop }));
    expect(out).not.toContain('>Retry<');
    expect(out).toContain('Add Claude key');
  });

  it('pending without a key', () => {
    const out = render(h(MealProblem, { variant: 'no_key', hasKey: false, onRetry: noop, onAddKey: noop, onManual: noop }));
    expect(out).toContain('Add your Claude key to analyze this');
    expect(out).toContain('Enter manually instead');
  });

  it('analysis notes: scale reference, missing reference, weighed, angles', () => {
    expect(text(h(AnalysisNotes, { notes: '', scaleReference: 'US quarter', angles: 3, isPhoto: true, weighedLabel: null }))).toBe(
      'Scale: US quarterJudged from 3 angles',
    );
    expect(text(h(AnalysisNotes, { notes: '', scaleReference: null, angles: 1, isPhoto: true, weighedLabel: null }))).toBe(
      'No size reference — add a coin or weigh it next time',
    );
    const weighed = text(h(AnalysisNotes, { notes: 'Looks like a bowl.', scaleReference: null, angles: 1, isPhoto: true, weighedLabel: '350 g' }));
    expect(weighed).toContain('You weighed it: 350 g');
    expect(weighed).not.toContain('No size reference');
    expect(text(h(AnalysisNotes, { notes: '', scaleReference: null, angles: 1, isPhoto: false, weighedLabel: null }))).toBe('');
  });

  it('summary: big kcal, macros and confidence', () => {
    const m = meal();
    const out = text(h(MealSummary, { totals: m.totals, confidence: m.confidence }));
    expect(out).toContain('453kcal'); // 205.4 + 247.5
    expect(out).toContain('P 51 · C 45 · F 5.8');
    expect(out).toContain('medium confidence');
  });
});

describe('MealDoneView', () => {
  it('renders a finished meal with its items, notes and the USDA-key banner', () => {
    const out = render(h(MealDoneView, { meal: meal() }), '/nutrition/meal/meal_1');
    expect(out).toContain('Chicken rice bowl');
    expect(out).toContain('Steamed rice');
    expect(out).toContain('USDA: Rice, white, cooked');
    expect(out).toContain('Grilled chicken');
    expect(out).toContain('The rice looks like about a cup.');
    expect(out).toContain('Scale: US quarter');
    expect(out).toContain('Judged from 2 angles');
    expect(out).toContain('Servings');
    expect(out).toContain("USDA's shared key is busy. Add your free key in Food settings for database-accurate numbers.");
    expect(out).toContain('Add food');
    expect(out).toContain('Add barcode item');
    expect(out).toContain('Delete meal');
    expect(out).toContain(`value="${toDateTimeLocal(AT)}"`);
  });

  it('hides Claude notes for a meal Claude never judged, and shows an empty items state', () => {
    const out = render(
      h(MealDoneView, { meal: meal({ confidence: null, notes: '', scaleReference: null, items: [], input: { kind: 'search' }, title: '' }) }),
    );
    expect(out).not.toContain('No size reference');
    expect(out).toContain('No foods in this meal');
    expect(out).not.toContain('shared key is busy');
  });
});

const usdaRice: FoodChoice = {
  id: 'usda:168878',
  name: 'Rice, white, long-grain, regular, cooked',
  source: 'usda',
  fdcId: 168878,
  per100g: per100(130, 2.69, 28.17, 0.28),
  servingG: null,
  dataType: 'SR Legacy',
};

describe('FoodSearchSheet parts', () => {
  it('row: name, data type and the per-100 g line', () => {
    const out = render(h(FoodRow, { food: usdaRice, onPick: noop }));
    expect(out).toContain('Rice, white, long-grain, regular, cooked');
    expect(out).toContain('SR Legacy');
    expect(out).toContain('per 100 g: 130 kcal · P 2.7 · C 28 · F 0.3');
  });

  it('row: brand wins over data type', () => {
    expect(render(h(FoodRow, { food: { ...usdaRice, brand: 'Uncle Ben’s', dataType: 'Branded' }, onPick: noop }))).toContain('Uncle Ben’s');
  });

  it('each result state has its own message', () => {
    expect(text(h(SearchMessage, { kind: 'loading' }))).toContain('Searching…');
    expect(text(h(SearchMessage, { kind: 'start' }))).toContain('Search USDA FoodData Central');
    expect(text(h(SearchMessage, { kind: 'no_matches', query: 'rice bowl' }))).toContain('No matches for “rice bowl”');
    expect(text(h(SearchMessage, { kind: 'rate_limited', demoKey: true }))).toContain(
      "USDA's shared demo key is busy — add your free key in Food settings.",
    );
    expect(text(h(SearchMessage, { kind: 'rate_limited', demoKey: false }))).toContain('USDA rate limit — try again in a minute.');
    const failed = text(h(SearchMessage, { kind: 'failed', onRetry: noop }));
    expect(failed).toContain("Couldn't reach USDA. Check your connection.");
    expect(failed).toContain('Try again');
  });
});

describe('capture', () => {
  it('renders the empty capture screen with Analyze disabled', () => {
    const html = renderToString(h(MemoryRouter, { initialEntries: ['/nutrition/log'] }, h(CapturePage)));
    const out = textOf(html);
    expect(out).toContain('Log food');
    expect(out).toContain('Cancel');
    expect(out).toContain('Take photo');
    expect(out).toContain('From library');
    expect(out).toContain('Put a coin or fork next to the plate so Claude can judge size.');
    expect(out).toContain('Weighed it? An exact weight beats any estimate.');
    expect(out).toContain('Scan a barcode instead');
    expect(out).toContain('Search foods');
    expect(html).toContain('placeholder="What is it? e.g. chicken burrito bowl, no sour cream"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*Analyze<\/button>/s);
    expect(html).toMatch(/accept="image\/\*" capture="environment"/);
    expect(html).toMatch(/accept="image\/\*" multiple=""/);
  });

  it('says which day it logs to', () => {
    const yesterday = shiftDay(dayKey(Date.now()), -1);
    expect(text(h(CapturePage), `/nutrition/log?d=${yesterday}`)).toContain('Logging for Yesterday');
  });

  it('photo tray: thumbnails with remove buttons and the angle tile, until 4', () => {
    const two = render(h(ShotTray, { photoIds: ['m_1', 'm_2'], saving: false, onCamera: noop, onLibrary: noop, onRemove: noop }));
    expect(two).toContain('aria-label="Remove photo 1"');
    expect(two).toContain('aria-label="Remove photo 2"');
    expect(two).toContain('aria-label="Add an angle"');
    expect(two).toContain('Add a side angle — height is where portion guesses go wrong.');
    expect(two).toContain('2/4');
    const four = render(h(ShotTray, { photoIds: ['a', 'b', 'c', 'd'], saving: false, onCamera: noop, onLibrary: noop, onRemove: noop }));
    expect(four).not.toContain('Add an angle');
    expect(four).toContain("That's the maximum");
  });

  it('details panel: weight error replaces the hint', () => {
    const props = { description: '', onDescription: noop, weightText: '0', onWeightText: noop, mu: 'g' as const, onMu: noop };
    expect(text(h(DetailsPanel, { ...props, weightError: 'Enter a weight above 0, or leave it empty.' }))).toContain(
      'Enter a weight above 0, or leave it empty.',
    );
    expect(text(h(DetailsPanel, { ...props, weightError: null }))).toContain('Weighed it?');
  });

  it('parses the weight field', () => {
    expect(parseWeightField('', 'g')).toBeNull();
    expect(parseWeightField('350', 'g')).toBe(350);
    expect(parseWeightField('12,5', 'oz')).toBe(354.4);
    expect(parseWeightField('0', 'g')).toBe('invalid');
    expect(parseWeightField('.', 'g')).toBe('invalid');
  });
});

describe('scan', () => {
  it('renders the photo button and manual entry', () => {
    const html = renderToString(h(MemoryRouter, { initialEntries: ['/nutrition/scan'] }, h(ScanPage)));
    expect(textOf(html)).toContain('Take a photo of the barcode');
    expect(textOf(html)).toContain('Look up');
    expect(html).toMatch(/inputmode="numeric"/i);
  });

  it('product card shows the label numbers and serving', () => {
    const food: FoodChoice = {
      id: 'off:3017620422003',
      name: 'Nutella',
      brand: 'Ferrero',
      source: 'off',
      barcode: '3017620422003',
      per100g: per100(539, 6.3, 57.5, 30.9),
      servingG: 15,
    };
    const out = text(h(ProductCard, { food, code: '3017620422003' }));
    expect(out).toContain('Nutella');
    expect(out).toContain('Ferrero');
    expect(out).toContain('Per 100 g: 539 kcal · P 6.3 · C 58 · F 31');
    expect(out).toContain('Serving on the label: 15 g');
    expect(text(h(ProductCard, { food: { ...food, servingG: null }, code: '1' }))).toContain('No serving size on the label');
  });
});

describe('meal page routing', () => {
  it('renders while the meal loads', () => {
    const html = renderToString(
      h(MemoryRouter, { initialEntries: ['/nutrition/meal/meal_x'] }, h(Routes, null, h(Route, { path: '/nutrition/meal/:id', element: h(MealPage) }))),
    );
    expect(textOf(html)).toContain('Meal');
    expect(html).toContain('animate-spin');
  });
});

describe('helpers', () => {
  it('matched line and lookup notes', () => {
    expect(matchedLine(rice)).toBe('USDA: Rice, white, cooked');
    expect(matchedLine(nutella)).toBe('Label: Nutella · Ferrero');
    expect(matchedLine({ source: 'estimate', matchedName: 'x' })).toBeNull();
    expect(lookupNote({ lookup: 'no_match' })).toBe("No database match — Claude's estimate");
    expect(lookupNote({ lookup: 'failed' })).toBe("USDA unreachable — Claude's estimate");
    expect(lookupNote({ lookup: 'ok' })).toBeNull();
    expect(lookupNote({ lookup: 'skipped' })).toBeNull();
  });

  it('per-100 g line', () => {
    expect(per100Line(per100(130, 2.69, 28.17, 0.28))).toBe('130 kcal · P 2.7 · C 28 · F 0.3');
  });

  it('meal titles fall back to foods, then the description', () => {
    expect(mealDisplayTitle(meal())).toBe('Chicken rice bowl');
    expect(mealDisplayTitle(meal({ title: '' }))).toBe('Steamed rice, Grilled chicken');
    expect(mealDisplayTitle(meal({ title: '', items: [] }))).toBe('chicken rice bowl');
    expect(mealDisplayTitle(meal({ title: '', items: [], input: { kind: 'photo' } }))).toBe('Meal');
  });

  it('quick amounts: label serving and 100 g', () => {
    expect(quickAmounts(37)).toEqual([
      { label: '1 serving (37 g)', grams: 37 },
      { label: '100 g', grams: 100 },
    ]);
    expect(quickAmounts(null)).toEqual([{ label: '100 g', grams: 100 }]);
    expect(quickAmounts(100)).toEqual([{ label: '1 serving (100 g)', grams: 100 }]);
  });

  it('barcode spellings for the offline cache', () => {
    expect(barcodeCandidates('012345678905')).toEqual(['012345678905', '0012345678905']);
    expect(barcodeCandidates('0012345678905')).toEqual(['0012345678905', '012345678905']);
    expect(barcodeCandidates('96385074')).toEqual(['96385074']);
  });

  it('datetime-local round trip in local time', () => {
    expect(toDateTimeLocal(AT)).toBe('2026-10-03T12:30');
    expect(fromDateTimeLocal('2026-10-03T12:30')).toBe(AT);
    expect(fromDateTimeLocal('2026-10-03T12:30:45')).toBe(AT);
    expect(fromDateTimeLocal('')).toBeNull();
    expect(fromDateTimeLocal('junk')).toBeNull();
  });

  it('day labels', () => {
    expect(dayLabel('2026-10-03', '2026-10-03')).toBe('Today');
    expect(dayLabel('2026-10-02', '2026-10-03')).toBe('Yesterday');
    expect(dayLabel('2026-09-29', '2026-10-03')).toBe('Tue, Sep 29');
  });

  it('day params and paths', () => {
    expect(validDay('2026-10-03')).toBe('2026-10-03');
    expect(validDay('2026-02-31')).toBeNull();
    expect(validDay('yesterday')).toBeNull();
    expect(validDay(null)).toBeNull();
    expect(diaryPath()).toBe('/nutrition');
    expect(diaryPath('2026-10-02')).toBe('/nutrition?d=2026-10-02');
    expect(mealPath('meal_1')).toBe('/nutrition/meal/meal_1');
    expect(logPath({ meal: 'meal_1', d: '2026-10-02' })).toBe('/nutrition/log?meal=meal_1&d=2026-10-02');
    expect(scanPath({ meal: null, d: null })).toBe('/nutrition/scan');
  });

  it('weight edits and the USDA-key banner rule', () => {
    expect(gramsEdited(rice)).toBe(false);
    expect(gramsEdited(chicken)).toBe(true);
    expect(gramsEdited(coffee)).toBe(false);
    expect(needsFdcKeyBanner([chicken], null)).toBe(true);
    expect(needsFdcKeyBanner([chicken], 'my-key')).toBe(false);
    expect(needsFdcKeyBanner([rice], null)).toBe(false);
  });
});
