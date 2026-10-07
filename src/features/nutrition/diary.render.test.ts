// Server-render tests for the Food Diary and Food settings (no DOM library: effects don't run and live
// queries return undefined, so presentational parts are rendered with plain props).
import 'fake-indexeddb/auto';
import { createElement as h, type ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../db';
import { atForDay, emptyTotals, recomputeMeal } from '../../lib/nutrition/math';
import { createMeal } from '../../lib/nutrition/store';
import { computeTargets } from '../../lib/nutrition/targets';
import type { Meal, MealItem, Targets } from '../../lib/nutrition/types';
import { DiaryContent, DiaryPage } from './DiaryPage';
import { NutritionSettingsPage } from './NutritionSettingsPage';
import { dayLabel, dayQuery, diaryTitle, isDayKey, parseDiaryDay } from './diary/day';
import { mealHref, MealRowView, rowActionLabel, rowState, runRowAction } from './diary/MealRow';
import { otherDayUnfinished, UNFINISHED_MAX, UnfinishedRowView } from './diary/UnfinishedMeals';
import { buildQuickAdd, parseQuickAdd } from './diary/QuickAddSheet';
import { joinFields, TargetsSummary } from './diary/TargetsSummary';
import { TrainingLine } from './diary/TrainingLine';
import { bodyweightSource } from './settings/data';
import { BodySection } from './settings/BodySection';
import { signedKcal } from './settings/PlanSection';
import { GITHUB_KEY_IN_USDA, spendLine, UsdaKeySection, usdaKeyProblem } from './settings/KeysSection';
import { TargetsCard } from './settings/TargetsCard';
import { DEFAULT_SETTINGS } from '../../lib/settings';

// The analysis engine is another module's job; rows only need "is it running in this session?".
const engine = vi.hoisted(() => ({ running: new Set<string>(), runs: [] as string[] }));
vi.mock('../../lib/nutrition/analyze', () => ({
  runAnalysis: async (id: string) => {
    engine.runs.push(id);
  },
  isAnalysisRunning: (id: string) => engine.running.has(id),
  analysisInterrupted: (m: { id: string; status: string }) => m.status === 'analyzing' && !engine.running.has(m.id),
  useAnalysisRunning: (id: string | null | undefined) => (id ? engine.running.has(id) : false),
}));

/** Visible text of the rendered markup (tags stripped), plus the raw HTML for attribute checks. */
function render(el: ReactElement, url = '/nutrition'): string {
  const html = renderToString(h(MemoryRouter, { initialEntries: [url] }, el));
  const text = html
    .replace(/<!-- -->/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'");
  return `${text}\n${html}`;
}

const AT = new Date(2026, 9, 3, 12, 30).getTime();
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
const meal = (p: Partial<Meal> = {}): Meal =>
  recomputeMeal({
    id: 'meal_1',
    at: AT,
    day: '',
    title: 'Chicken lunch',
    status: 'done',
    statusAt: AT,
    error: null,
    input: { kind: 'photo' },
    photoIds: [],
    serves: 1,
    items: [item()],
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

const BODY = { sex: 'male' as const, age: 32, heightCm: 178, weightKg: 80 };
const TARGETS: Targets = computeTargets(
  { activity: 'moderate', goal: 'maintain', pace: 'steady', kcalOverride: 2000, proteinOverride: null },
  BODY,
);
const noop = () => {};
const content = (props: Partial<Parameters<typeof DiaryContent>[0]>) =>
  render(h(DiaryContent, { meals: [], targets: { targets: TARGETS, missing: [] }, burn: { activeKcal: 0, workouts: 0 }, onLog: noop, onSettings: noop, ...props }));

beforeEach(() => {
  engine.running.clear();
  engine.runs.length = 0;
});

describe('diary day helpers', () => {
  const today = '2026-10-03';
  it('reads ?d=, falling back to today for junk and future days', () => {
    expect(parseDiaryDay(null, today)).toBe(today);
    expect(parseDiaryDay('2026-09-29', today)).toBe('2026-09-29');
    expect(parseDiaryDay('2026-10-04', today)).toBe(today);
    expect(parseDiaryDay('2026-02-31', today)).toBe(today);
    expect(parseDiaryDay('yesterday', today)).toBe(today);
    expect(isDayKey('2026-02-28')).toBe(true);
  });
  it('labels days', () => {
    expect(diaryTitle(today, today)).toBe('Food');
    expect(diaryTitle('2026-10-02', today)).toBe('Yesterday');
    expect(diaryTitle('2026-09-29', today)).toBe('Tue, Sep 29');
    expect(dayLabel('2025-12-31', today)).toBe('Wed, Dec 31, 2025');
    expect(dayQuery(today, today)).toBe('');
    expect(dayQuery('2026-09-29', today)).toBe('?d=2026-09-29');
  });
});

describe('Diary renders', () => {
  it('the page shows its loading state (live queries pending)', () => {
    const html = render(h(DiaryPage));
    expect(html).toContain('Food');
    expect(html).toContain('aria-label="Food settings"');
    expect(html).toContain('aria-label="Next day"');
    expect(html).not.toContain('>Today</button>'); // no "Today" chip on today
  });

  it('a past day shows its label and a Today chip', () => {
    const html = render(h(DiaryPage), '/nutrition?d=2020-01-06');
    expect(html).toContain('Mon, Jan 6, 2020');
    expect(html).toContain('>Today</button>');
  });

  it('an empty day', () => {
    const html = content({ meals: [] });
    expect(html).toContain('Nothing logged');
    expect(html).toContain('Log food');
    expect(html).toContain('2,000'); // full budget left
    expect(html).toContain('left');
  });

  it('a done meal with targets missing: eaten totals + the setup prompt', () => {
    const html = content({ meals: [meal()], targets: { targets: null, missing: ['sex', 'birthYear', 'heightCm'] } });
    expect(html).toContain('Chicken lunch');
    expect(html).toContain('12:30 PM');
    expect(html).toContain('330 kcal'); // 200 g × 165 kcal/100 g
    expect(html).toContain('P 62 · C 0 · F 7.2');
    expect(html).toContain('medium confidence');
    expect(html).toContain('kcal eaten');
    expect(html).toContain('Add your sex, birth year and height to get a calorie and macro target.');
    expect(html).toContain('Set up targets');
    expect(html).not.toContain('Only analyzed meals count');
  });

  it('a pending row shows Analyze and no kcal, and does not count', () => {
    const pending = meal({ id: 'meal_p', title: 'Pasta', status: 'pending', confidence: null });
    const html = content({ meals: [pending] });
    expect(html).toContain('Waiting to analyze');
    expect(html).toContain('Analyze');
    expect(html).not.toContain('330 kcal');
    expect(html).toContain('2,000'); // nothing eaten yet
    expect(html).toContain('Only analyzed meals count toward your totals.');
  });

  it('a failed row shows the error and Retry', () => {
    const failed = meal({ id: 'meal_f', status: 'failed', error: 'Claude is overloaded — try again in a minute.' });
    const html = content({ meals: [failed] });
    expect(html).toContain('Claude is overloaded — try again in a minute.');
    expect(html).toContain('Retry');
    expect(html).toContain('text-danger');
    expect(html).not.toContain('330 kcal');
  });

  it('an analyzing row: spinner while running here, Retry once interrupted', () => {
    const a = meal({ id: 'meal_a', status: 'analyzing' });
    engine.running.add('meal_a');
    expect(content({ meals: [a] })).toContain('Analyzing…');
    engine.running.clear();
    const html = content({ meals: [a] });
    expect(html).toContain('The analysis was interrupted.');
    expect(html).toContain('Retry');
  });

  it('a draft row asks to continue and links back to the capture screen', () => {
    const d = meal({ id: 'meal_d', status: 'draft', title: '' });
    const html = content({ meals: [d] });
    expect(html).toContain('Untitled meal');
    expect(html).toContain('Unfinished — tap to continue');
    expect(mealHref(d, '2026-10-03')).toBe('/nutrition/log?meal=meal_d');
    expect(mealHref(meal(), '2026-10-03')).toBe('/nutrition/meal/meal_1');
  });

  it('U9: a draft from another day resumes with &d= so it keeps logging on that day', () => {
    const past = meal({ id: 'meal_d', status: 'draft', at: new Date(2026, 9, 1, 19, 0).getTime(), day: '' });
    expect(past.day).toBe('2026-10-01');
    expect(mealHref(past, '2026-10-03')).toBe('/nutrition/log?meal=meal_d&d=2026-10-01');
    // Non-drafts open the meal page whatever their day.
    expect(mealHref({ ...past, status: 'failed' }, '2026-10-03')).toBe('/nutrition/meal/meal_d');
  });

  it('U5: Retry starts the analysis when a Claude key is saved, then opens the meal; without a key it only opens it', () => {
    const failed = meal({ id: 'meal_f', status: 'failed', error: 'x' });
    const went: string[] = [];
    runRowAction(failed, 'failed', (to) => went.push(to), { hasKey: true });
    expect(engine.runs).toEqual(['meal_f']);
    expect(went).toEqual(['/nutrition/meal/meal_f']);

    runRowAction(failed, 'failed', (to) => went.push(to), { hasKey: false });
    expect(engine.runs).toEqual(['meal_f']); // no second run
    expect(went).toEqual(['/nutrition/meal/meal_f', '/nutrition/meal/meal_f']);

    // Analyze (pending) never starts a run from the Diary: the meal page does, once, when a key is saved.
    runRowAction(meal({ id: 'meal_p', status: 'pending' }), 'pending', (to) => went.push(to), { hasKey: true });
    expect(engine.runs).toEqual(['meal_f']);
    expect(went[2]).toBe('/nutrition/meal/meal_p');
    expect(rowActionLabel('failed')).toBe('Retry');
    expect(rowActionLabel('pending')).toBe('Analyze');
    expect(rowActionLabel('draft')).toBe('Continue');
    expect(rowActionLabel('done')).toBeNull();
  });

  it('over target shows the danger "over" text', () => {
    const big = meal({ items: [item({ grams: 1400 })] }); // 2,310 kcal vs 2,000
    const html = content({ meals: [big] });
    expect(html).toContain('aria-label="310 kcal over"');
    expect(html).toMatch(/text-danger[^"]*">over</);
    expect(html).toContain('2,310');
  });

  it('TargetsSummary loading', () => {
    const html = render(h(TargetsSummary, { totals: undefined, targets: null, missing: [], loading: true, onSetup: noop }));
    expect(html).toContain('animate-spin');
  });

  it('workout burn is display-only', () => {
    const html = render(h(TrainingLine, { burn: { activeKcal: 312, workouts: 1 }, hasTarget: true, onSettings: noop }));
    expect(html).toContain('Workouts: 312 kcal active · already in your target');
    expect(html).not.toMatch(/\+\s*312/);
    expect(render(h(TrainingLine, { burn: { activeKcal: 0, workouts: 0 }, hasTarget: true, onSettings: noop }))).not.toContain('Workouts');
    // Remaining ignores the burn entirely.
    const withBurn = content({ meals: [meal()], burn: { activeKcal: 500, workouts: 1 } });
    expect(withBurn).toContain('aria-label="1,670 kcal left"');
  });

  it('U8: with no target set, the workout line is just the number (nothing to be "in")', () => {
    const line = render(h(TrainingLine, { burn: { activeKcal: 312, workouts: 1 }, hasTarget: false, onSettings: noop }));
    expect(line).toContain('Workouts: 312 kcal active');
    expect(line).not.toContain('already in your target');
    // The Diary wires it from the targets: missing body fields → no target → no claim.
    const noTarget = content({ meals: [], targets: { targets: null, missing: ['sex'] }, burn: { activeKcal: 312, workouts: 1 } });
    expect(noTarget).toContain('Workouts: 312 kcal active');
    expect(noTarget).not.toContain('already in your target');
    expect(content({ meals: [], burn: { activeKcal: 312, workouts: 1 } })).toContain('Workouts: 312 kcal active · already in your target');
  });

  it('U10: unfinished meals from other days get their own section with Continue / Analyze / Retry', () => {
    const today = '2026-10-03';
    const at = (d: number) => new Date(2026, 9, d, 12, 0).getTime();
    const draft = meal({ id: 'meal_d', status: 'draft', title: '', at: at(2), day: '', input: { kind: 'photo', description: 'leftover curry' }, photoIds: ['m_1'] });
    const pending = meal({ id: 'meal_p', status: 'pending', title: 'Pasta', at: at(1), day: '' });
    const failed = meal({ id: 'meal_f', status: 'failed', title: 'Burrito', at: new Date(2026, 8, 29, 12).getTime(), day: '', error: 'x' });
    const interrupted = meal({ id: 'meal_i', status: 'analyzing', title: 'Soup', at: at(2), day: '' });
    const html = content({ meals: [], unfinished: [draft, pending, failed, interrupted], today });
    expect(html).toContain('Unfinished on other days');
    expect(html).toContain('leftover curry'); // an untitled draft shows what was typed
    expect(html).toContain('Yesterday · Unfinished');
    expect(html).toContain('>Continue<');
    expect(html).toContain('Thu, Oct 1 · Not analyzed');
    expect(html).toContain('>Analyze<');
    expect(html).toContain("Tue, Sep 29 · Couldn't analyze");
    expect((html.match(/>Retry</g) ?? []).length).toBe(2); // failed + interrupted
    // Nothing unfinished elsewhere: no section.
    expect(content({ meals: [], unfinished: [], today })).not.toContain('Unfinished on other days');
    // Still running here: a spinner, no button.
    engine.running.add('meal_i');
    const running = render(h(UnfinishedRowView, { meal: interrupted, state: 'analyzing', today, onOpen: noop, onAction: noop }));
    expect(running).toContain('Analyzing…');
    expect(running).not.toContain('>Retry<');
  });

  it('U10: only meals from days other than the one shown, and at most 5 rows', () => {
    const on = (day: string, id: string, status: Meal['status'] = 'pending') => ({ ...meal({ id, status }), day });
    const all = [on('2026-10-03', 'a'), on('2026-10-02', 'b'), on('2026-10-01', 'c', 'draft'), on('2026-10-03', 'd', 'failed')];
    expect(otherDayUnfinished(all, '2026-10-03').map((m) => m.id)).toEqual(['b', 'c']);
    expect(otherDayUnfinished(all, '2026-10-02').map((m) => m.id)).toEqual(['a', 'c', 'd']);
    expect(otherDayUnfinished(undefined, '2026-10-03')).toEqual([]);
    const many = Array.from({ length: UNFINISHED_MAX + 2 }, (_, i) => on('2026-09-01', `m${i}`));
    const html = content({ meals: [], unfinished: many, today: '2026-10-03' });
    expect((html.match(/>Analyze</g) ?? []).length).toBe(UNFINISHED_MAX);
    expect(html).toContain('2 more unfinished meals');
  });

  it('row states', () => {
    expect(rowState({ status: 'analyzing' }, true)).toBe('failed');
    expect(rowState({ status: 'analyzing' }, false)).toBe('analyzing');
    expect(rowState({ status: 'done' }, false)).toBe('done');
    const html = render(h(MealRowView, { meal: meal({ input: { kind: 'barcode' } }), thumbUrl: 'blob:x', state: 'done', onOpen: noop, onAction: noop }));
    expect(html).toContain('src="blob:x"');
  });

  it('joins missing body fields', () => {
    expect(joinFields(['bodyweight'])).toBe('body weight');
    expect(joinFields(['sex', 'bodyweight'])).toBe('sex and body weight');
  });
});

describe('Quick add', () => {
  it('validates the form', () => {
    const base = { name: '', kcal: '', protein: '', carbs: '', fat: '' };
    expect(parseQuickAdd(base)).toEqual({ ok: false, error: null });
    expect(parseQuickAdd({ ...base, kcal: '0' }).ok).toBe(false);
    expect(parseQuickAdd({ ...base, kcal: '250', fat: '2000' })).toMatchObject({ ok: false });
    expect(parseQuickAdd({ ...base, kcal: '250,5', protein: '20' })).toEqual({
      ok: true,
      values: { name: '', kcal: 250.5, proteinG: 20, carbsG: null, fatG: null },
    });
  });

  it('saves a fixed, done meal that counts toward the day', async () => {
    await db.meals.clear();
    const at = atForDay('2026-10-02', AT); // yesterday at the current time of day
    const saved = await createMeal(buildQuickAdd({ name: '  Protein bar ', kcal: 210, proteinG: 20, carbsG: null, fatG: 7 }, at));
    const row = await db.meals.get(saved.id);
    expect(row?.day).toBe('2026-10-02');
    expect(row?.status).toBe('done');
    expect(row?.input.kind).toBe('quick');
    expect(row?.title).toBe('Protein bar');
    expect(row?.items[0]).toMatchObject({ grams: null, per100g: null, source: 'manual' });
    expect(row?.totals).toMatchObject({ kcal: 210, proteinG: 20, carbsG: 0, fatG: 7 });
    const untitled = buildQuickAdd({ name: '', kcal: 100, proteinG: null, carbsG: null, fatG: null }, at);
    expect(untitled.title).toBe('Quick add');
  });
});

describe('Food settings renders', () => {
  it('with no keys: demo-key notice, key copy, links and attribution', () => {
    const html = render(h(NutritionSettingsPage), '/nutrition/settings');
    expect(html).toContain('Food settings');
    expect(html).toContain("Using USDA's shared demo key — limited to about 10 lookups an hour. Add your free key for database-accurate numbers.");
    // U13: says where the key really is, without claiming isolation.
    expect(html).toContain(
      "Your key is stored in this app on this phone — never in backups or in Heft's code. Use a separate key from a spend-limited workspace used only for Heft.",
    );
    expect(html).not.toContain('nowhere else');
    expect(html).toContain('href="https://console.anthropic.com/settings/keys"');
    expect(html).toContain('href="https://fdc.nal.usda.gov/api-key-signup.html"');
    expect(html).toContain('rel="noopener"');
    expect(html).toContain('type="password"');
    expect(html.toLowerCase()).toContain('autocomplete="off"');
    expect(html.toLowerCase()).toContain('spellcheck="false"');
    expect(html).toContain('Nutrition data: USDA FoodData Central (public domain) · Open Food Facts (ODbL).');
    expect(html).not.toContain('Saved key');
  });

  it('body rows in the user unit, with the weigh-in source', () => {
    const settings = { ...DEFAULT_SETTINGS, unit: 'lb' as const, sex: 'male' as const, birthYear: 1994, heightCm: 177.8, bodyweightKg: null };
    const latest = { id: 'm1', date: new Date(2026, 8, 30).getTime(), bodyweightKg: 81.6466266, photoIds: [] };
    const html = render(h(BodySection, { settings, bodyweightKg: 81.6466266, latest, now: AT }));
    expect(html).toContain('Age 32');
    expect(html).toContain('value="5"'); // ft
    expect(html).toContain('value="10"'); // in
    expect(html).toContain('value="180"'); // lb
    expect(html).toContain('From weigh-in, Sep 30');
    const metric = render(h(BodySection, { settings: { ...settings, unit: 'kg' as const, sex: null }, bodyweightKg: 80, latest: null, now: AT }));
    expect(metric).toContain('value="178"');
    expect(metric).toContain('cm');
    expect(metric).toContain('Not set'); // sex
  });

  it('body weight source mirrors pickBodyweightKg', () => {
    const w = { date: 1000, bodyweightKg: 80 };
    expect(bodyweightSource({ bodyweightKg: null, bodyweightUpdatedAt: null }, w)).toBe('weighin');
    expect(bodyweightSource({ bodyweightKg: 82, bodyweightUpdatedAt: 2000 }, w)).toBe('profile');
    expect(bodyweightSource({ bodyweightKg: 82, bodyweightUpdatedAt: 500 }, w)).toBe('weighin');
    expect(bodyweightSource({ bodyweightKg: null, bodyweightUpdatedAt: null }, null)).toBe('none');
  });

  it('targets card: numbers, overrides and the missing-body prompt', () => {
    const auto = computeTargets({ activity: 'moderate', goal: 'maintain', pace: 'steady', kcalOverride: null, proteinOverride: null }, BODY);
    const html = render(h(TargetsCard, { targets: TARGETS, auto, missing: [], profile: { kcalOverride: 2000, proteinOverride: null } }));
    expect(html).toContain('BMR');
    expect(html).toContain(auto.bmr.toLocaleString());
    expect(html).toContain('Maintenance');
    expect(html).toContain(auto.tdee.toLocaleString());
    expect(html).toContain('2,000');
    expect(html).toContain('Use automatic'); // kcal is overridden
    expect(html).toContain(`placeholder="${auto.proteinG}"`); // protein blank = automatic
    const missing = render(h(TargetsCard, { targets: null, auto: null, missing: ['bodyweight'], profile: { kcalOverride: null, proteinOverride: null } }));
    expect(missing).toContain('Add your body weight under Body');
  });

  it('U11: the USDA field refuses a Claude key (USDA puts its key in the URL) and the demo key', () => {
    const claude = 'sk-ant-test-not-a-real-key-0000000000';
    expect(usdaKeyProblem(claude)).toBe("That's your Claude key — paste it in the Claude field.");
    expect(usdaKeyProblem(`  ${claude} `)).toBe("That's your Claude key — paste it in the Claude field.");
    expect(usdaKeyProblem('DEMO_KEY')).toBe("That's the shared demo key — paste your own key");
    // ...and the GitHub key for the Hume inbox (often still on the clipboard from Settings → Apple Health).
    expect(GITHUB_KEY_IN_USDA).toBe("That's your GitHub key — paste it in Settings → Apple Health.");
    expect(usdaKeyProblem('github_pat_TEST')).toBe(GITHUB_KEY_IN_USDA);
    expect(usdaKeyProblem('Bearer github_pat_TEST')).toBe(GITHUB_KEY_IN_USDA);
    expect(usdaKeyProblem(' ghp_TESTTESTTESTTESTTEST ')).toBe(GITHUB_KEY_IN_USDA);
    expect(usdaKeyProblem('a1B2c3D4e5F6g7H8i9J0')).toBeNull();
    expect(usdaKeyProblem('')).toBeNull();
    // A Claude key saved there before this check is flagged (it is never sent: fdcKeyOrDemo skips it).
    const html = render(h(UsdaKeySection, { saved: claude }));
    expect(html).toContain('This is your Claude key, not a USDA key.');
    expect(html).toContain('Forget key');
    expect(render(h(UsdaKeySection, { saved: 'a1B2c3D4e5F6g7H8i9J0' }))).not.toContain('This is your Claude key');
  });

  it('copy helpers', () => {
    expect(signedKcal(-400)).toBe('−400');
    expect(signedKcal(250)).toBe('+250');
    expect(spendLine({ costUsd: 0.4234, calls: 7 })).toBe('This month: $0.42 across 7 analyses');
    expect(spendLine({ costUsd: 0.05, calls: 1 })).toBe('This month: $0.05 across 1 analysis');
  });
});
