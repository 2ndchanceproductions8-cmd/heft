import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db';
import type { Measurement } from '../types';
import {
  applyHealthImport,
  editedMeasurement,
  HEALTH_IMPORT_SHORTCUT,
  healthTemplateText,
  importShortcutUrl,
  parseHealthDate,
  parseHealthText,
  planHealthImport,
  type HealthPlanOptions,
} from './healthImport';
import { currentBodyweightKg, getSettings, updateSettings } from './settings';
import { exportBackup, importBackup } from './backup';
import { KG_PER_LB } from './units';

// Built from char codes: newer iOS puts U+202F (narrow no-break space) before AM/PM, and some use U+00A0.
const NNBSP = String.fromCharCode(0x202f);
const NBSP = String.fromCharCode(0x00a0);

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = new Date(2026, 9, 5, 9, 0).getTime(); // Mon Oct 5 2026, 9:00 local
const T702 = new Date(2026, 9, 5, 7, 2).getTime();
const LB = (n: number) => n * KG_PER_LB;

const lines = (...l: string[]) => l.join('\n');
const TEMPLATE = lines(
  'heft-health',
  'weight: 184.2 lb',
  'weight date: Oct 5, 2026 at 7:02 AM',
  'body fat: 18.5%',
  'body fat date: Oct 5, 2026 at 7:02 AM',
);

const parse = (text: string, unit: 'kg' | 'lb' = 'lb') => parseHealthText(text, { unit, now: NOW });

function weightOf(text: string, unit: 'kg' | 'lb' = 'lb') {
  const r = parse(lines('heft-health', `weight: ${text}`, 'weight date: Oct 5, 2026 at 7:02 AM'), unit);
  expect(r.errors).toEqual([]);
  expect(r.samples).toHaveLength(1);
  return r.samples[0].value;
}

function fatOf(text: string) {
  const r = parse(lines('heft-health', `body fat: ${text}`, 'body fat date: Oct 5, 2026 at 7:02 AM'));
  expect(r.errors).toEqual([]);
  return r.samples[0].value;
}

describe('parseHealthText: the Shortcut template', () => {
  it('reads weight (lb → kg), body fat and both dates', () => {
    const r = parse(TEMPLATE);
    expect(r.recognized).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.samples).toHaveLength(2);
    const w = r.samples.find((s) => s.kind === 'weight')!;
    const f = r.samples.find((s) => s.kind === 'bodyFat')!;
    expect(w.value).toBeCloseTo(LB(184.2), 9);
    expect(w.at).toBe(T702);
    expect(f).toEqual({ kind: 'bodyFat', value: 18.5, at: T702 });
  });

  it('weight units: lb / lbs / kg / st / stone / st+lb / g, none = the user unit, decimal comma', () => {
    expect(weightOf('184.2 lbs')).toBeCloseTo(LB(184.2), 9);
    expect(weightOf('83.5 kg')).toBeCloseTo(83.5, 9);
    expect(weightOf('83,5 kg')).toBeCloseTo(83.5, 9);
    expect(weightOf('83,5kg')).toBeCloseTo(83.5, 9);
    expect(weightOf('13 st')).toBeCloseTo(13 * 6.35029318, 6);
    expect(weightOf('13.5 stone')).toBeCloseTo(13.5 * 6.35029318, 6);
    expect(weightOf('13 st 2 lb')).toBeCloseTo(13 * 6.35029318 + LB(2), 6);
    expect(weightOf('83500 g')).toBeCloseTo(83.5, 9);
    expect(weightOf('83,500 g')).toBeCloseTo(83.5, 9);
    expect(weightOf('184.2', 'lb')).toBeCloseTo(LB(184.2), 9);
    expect(weightOf('83.5', 'kg')).toBeCloseTo(83.5, 9);
    expect(weightOf('184,2', 'lb')).toBeCloseTo(LB(184.2), 9);
  });

  it('body fat as a percent, a bare number or a fraction', () => {
    expect(fatOf('18.5%')).toBe(18.5);
    expect(fatOf('18.5 %')).toBe(18.5);
    expect(fatOf('18.5')).toBe(18.5);
    expect(fatOf('18,5%')).toBe(18.5);
    expect(fatOf('0.185')).toBe(18.5);
  });

  it('keys are case-insensitive with optional spaces / underscores', () => {
    const r = parse(
      lines(
        'Weight: 83.5 kg',
        'weightDate: 2026-10-05T07:02:00',
        'BODY_FAT: 18.5%',
        'body_fat_date: 10/5/26, 7:02 AM',
      ),
    );
    expect(r.recognized).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.samples.map((s) => [s.kind, s.at])).toEqual([
      ['weight', T702],
      ['bodyFat', T702],
    ]);
    expect(parse(lines('heft-health', 'bodyfat: 18.5', 'BodyFatDate: Oct 5, 2026 at 7:02 AM')).samples).toEqual([
      { kind: 'bodyFat', value: 18.5, at: T702 },
    ]);
  });

  it('a missing date means now', () => {
    const r = parse(lines('heft-health', 'weight: 184.2 lb', 'body fat: 18.5%'));
    expect(r.samples.map((s) => s.at)).toEqual([NOW, NOW]);
  });

  it('an empty template (no samples found) is recognized but has no samples', () => {
    const r = parse(lines('heft-health', 'weight: ', 'weight date: ', 'body fat: ', 'body fat date: '));
    expect(r).toEqual({ recognized: true, samples: [], errors: [], missing: ['weight', 'bodyFat'] });
    expect(parse(healthTemplateText()).recognized).toBe(true);
  });

  it('reads JSON', () => {
    const r = parse(
      JSON.stringify({ weight: '184.2 lb', weightDate: '2026-10-05T07:02:00', bodyFat: 0.185, bodyFatDate: 'Oct 5, 2026 at 7:02 AM' }),
    );
    expect(r.recognized).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.samples.find((s) => s.kind === 'weight')?.value).toBeCloseTo(LB(184.2), 9);
    expect(r.samples.find((s) => s.kind === 'bodyFat')).toEqual({ kind: 'bodyFat', value: 18.5, at: T702 });
    // A bare JSON number uses the user's unit; a list of records keeps each record's own dates.
    const list = parseHealthText(
      JSON.stringify([
        { weight: 83.5, date: '2026-10-04T07:00:00' },
        { weight: 83.1, date: '2026-10-05T07:02:00' },
      ]),
      { unit: 'kg', now: NOW },
    );
    expect(list.samples.map((s) => [s.value, s.at])).toEqual([
      [83.5, new Date(2026, 9, 4, 7, 0).getTime()],
      [83.1, T702],
    ]);
  });

  it('reads plain lists of many samples (repeated keys, or values continued under a key)', () => {
    const repeated = parse(
      lines(
        'heft-health',
        'weight: 184.2 lb',
        'weight date: Oct 5, 2026 at 7:02 AM',
        'weight: 185.0 lb',
        'weight date: Oct 4, 2026 at 6:58 AM',
      ),
    );
    expect(repeated.samples.map((s) => s.at)).toEqual([new Date(2026, 9, 4, 6, 58).getTime(), T702]);

    const continued = parse(
      lines(
        'heft-health',
        'weight: 184.2 lb',
        '185.0 lb',
        '186.4 lb',
        'weight date: Oct 5, 2026 at 7:02 AM',
        'Oct 4, 2026 at 6:58 AM',
        'Oct 3, 2026 at 7:10 AM',
      ),
    );
    expect(continued.errors).toEqual([]);
    expect(continued.samples.map((s) => [Math.round((s.value / KG_PER_LB) * 10) / 10, s.at])).toEqual([
      [186.4, new Date(2026, 9, 3, 7, 10).getTime()],
      [185, new Date(2026, 9, 4, 6, 58).getTime()],
      [184.2, T702],
    ]);
  });

  it('rejects text that is not Heft health data', () => {
    for (const junk of [
      '',
      '   ',
      'Hello world',
      'https://example.com/a?b=c',
      'Meeting at 7:02 AM tomorrow',
      'Date: Oct 5, 2026',
      JSON.stringify({ app: 'heft', version: 2, data: { measurements: [{ id: 'm', bodyweightKg: 80 }] } }),
      '{"foo": 1}',
    ]) {
      expect(parse(junk).recognized, junk).toBe(false);
      expect(parse(junk).samples).toEqual([]);
    }
  });

  it('drops out-of-range and unreadable values with an error', () => {
    const r = parse(
      lines(
        'heft-health',
        'weight: 900 lb', // 408 kg
        'weight date: Oct 5, 2026 at 7:02 AM',
        'body fat: 80%',
        'body fat date: Oct 5, 2026 at 7:02 AM',
      ),
    );
    expect(r.recognized).toBe(true);
    expect(r.samples).toEqual([]);
    expect(r.errors).toHaveLength(2);
    expect(parse(lines('heft-health', 'weight: 15 kg')).samples).toEqual([]);
    expect(parse(lines('heft-health', 'body fat: 0.9')).errors[0]).toMatch(/outside 1/); // 90 %
    expect(parse(lines('heft-health', 'weight: heavy')).errors[0]).toMatch(/Couldn't read the weight/);
    const badDate = parse(lines('heft-health', 'weight: 184.2 lb', 'weight date: someday'));
    expect(badDate.samples).toEqual([]);
    expect(badDate.errors[0]).toMatch(/Couldn't read the date "someday"/);
    expect(parse(lines('heft-health', 'weight: 184.2 lb', 'weight date: Oct 9, 2026 at 7:02 AM')).errors[0]).toMatch(/future/);
  });
});

describe('parseHealthText: values a review found misread', () => {
  it('a % sign is never a fraction: "1%" is one percent', () => {
    expect(fatOf('1%')).toBe(1);
    expect(fatOf('1.0 %')).toBe(1);
    expect(fatOf('0.185')).toBe(18.5); // a bare fraction still is
  });

  it('nutrition text with a bare "Fat:" line is not Heft health data', () => {
    for (const food of [
      lines('Calories: 250', 'Fat: 12g', 'Protein: 20g'),
      lines('Nutrition Facts', 'Serving: 1 cup', 'Fat: 8 g', 'Carbs: 30 g'),
      JSON.stringify({ calories: 250, fat: 12, protein: 20 }),
      'Mass: 2 kg',
    ]) {
      expect(parse(food).recognized, food).toBe(false);
    }
    // A mass unit is never body fat, even after the marker; the generic key still works with the marker.
    expect(parse(lines('heft-health', 'fat: 12 g')).errors[0]).toMatch(/Couldn't read the body fat/);
    expect(parse(lines('heft-health', 'fat: 18.5%')).samples).toEqual([{ kind: 'bodyFat', value: 18.5, at: NOW }]);
    expect(parse(JSON.stringify({ 'heft-health': true, fat: 18.5 })).samples).toEqual([{ kind: 'bodyFat', value: 18.5, at: NOW }]);
  });

  it('reports a line that came back empty (the second Find Health Samples filtering the first)', () => {
    const r = parse(lines('heft-health', 'weight: 184.2 lb', 'weight date: Oct 5, 2026 at 7:02 AM', 'body fat: ', 'body fat date: '));
    expect(r.samples).toHaveLength(1);
    expect(r.errors).toEqual([]);
    expect(r.missing).toEqual(['bodyFat']);
    expect(parse(TEMPLATE).missing).toEqual([]);
    expect(parse(JSON.stringify({ weight: '184.2 lb', bodyFat: '' })).missing).toEqual(['bodyFat']);
  });

  it('shows an out-of-range weight in the user unit', () => {
    expect(parse(lines('heft-health', 'weight: 950 lb')).errors).toEqual(['The weight "950 lb" is outside 44–882 lb']);
    expect(parse(lines('heft-health', 'weight: 450 kg'), 'kg').errors).toEqual(['The weight "450 kg" is outside 20–400 kg']);
  });

  it('keeps both samples when the dates are RFC 2822', () => {
    const rfc = 'Mon, 05 Oct 2026 07:02:00 -0400';
    const r = parse(lines('heft-health', 'weight: 184.2 lb', `weight date: ${rfc}`, 'body fat: 18.5%', `body fat date: ${rfc}`));
    expect(r.errors).toEqual([]);
    expect(r.samples.map((s) => [s.kind, s.at])).toEqual([
      ['weight', Date.UTC(2026, 9, 5, 11, 2)],
      ['bodyFat', Date.UTC(2026, 9, 5, 11, 2)],
    ]);
  });
});

describe('parseHealthDate', () => {
  it('reads RFC 2822 and numeric / GMT offsets after the time', () => {
    expect(parseHealthDate('01 Jun 2016 14:31:46 -0700', NOW)).toBe(Date.UTC(2016, 5, 1, 21, 31, 46));
    expect(parseHealthDate('Wed, 01 Jun 2016 14:31:46 -0700', NOW)).toBe(Date.UTC(2016, 5, 1, 21, 31, 46));
    expect(parseHealthDate('Mon, 5 Oct 2026 07:02:00 -0400', NOW)).toBe(Date.UTC(2026, 9, 5, 11, 2));
    expect(parseHealthDate('5 Oct 2026 11:02:00 +0000', NOW)).toBe(Date.UTC(2026, 9, 5, 11, 2));
    expect(parseHealthDate('5 Oct 2026 11:02:00 GMT', NOW)).toBe(Date.UTC(2026, 9, 5, 11, 2));
    expect(parseHealthDate('Oct 5, 2026 at 7:02 AM GMT-4', NOW)).toBe(Date.UTC(2026, 9, 5, 11, 2));
    expect(parseHealthDate(`Oct 5, 2026 at 7:02${NNBSP}AM UTC+05:30`, NOW)).toBe(Date.UTC(2026, 9, 5, 1, 32));
    expect(parseHealthDate('Feb 30, 2026 07:02:00 -0400', NOW)).toBeNull();
  });

  it('reads ISO 8601 with and without an offset', () => {
    expect(parseHealthDate('2026-10-05T07:02:00', NOW)).toBe(T702);
    expect(parseHealthDate('2026-10-05 07:02', NOW)).toBe(T702);
    expect(parseHealthDate('2026-10-05T11:02:00Z', NOW)).toBe(Date.UTC(2026, 9, 5, 11, 2));
    expect(parseHealthDate('2026-10-05T07:02:00.500-04:00', NOW)).toBe(Date.UTC(2026, 9, 5, 11, 2, 0, 500));
    expect(parseHealthDate('2026-10-05T07:02:00+0530', NOW)).toBe(Date.UTC(2026, 9, 5, 1, 32));
  });

  it('reads the US styles Shortcuts writes, with odd spaces', () => {
    expect(parseHealthDate('Oct 5, 2026 at 7:02 AM', NOW)).toBe(T702);
    expect(parseHealthDate(`Oct 5, 2026 at 7:02${NNBSP}AM`, NOW)).toBe(T702);
    expect(parseHealthDate(`Oct${NBSP}5,${NBSP}2026 at 7:02${NNBSP}AM`, NOW)).toBe(T702);
    expect(parseHealthDate('October 5, 2026 at 7:02 AM', NOW)).toBe(T702);
    expect(parseHealthDate('October 5, 2026, 7:02 AM', NOW)).toBe(T702);
    expect(parseHealthDate('Monday, October 5, 2026 at 7:02:00 AM EDT', NOW)).toBe(T702);
    expect(parseHealthDate(`10/5/26, 7:02${NNBSP}AM`, NOW)).toBe(T702);
    expect(parseHealthDate('10/5/2026 7:02 AM', NOW)).toBe(T702);
    expect(parseHealthDate('5 Oct 2026 at 07:02', NOW)).toBe(T702);
    expect(parseHealthDate('Sept 30, 2026 at 6:05 PM', NOW)).toBe(new Date(2026, 8, 30, 18, 5).getTime());
    expect(parseHealthDate('Oct 5, 2026 at 12:15 AM', NOW)).toBe(new Date(2026, 9, 5, 0, 15).getTime());
    expect(parseHealthDate('Oct 5, 2026 at 12:15 PM', NOW)).toBe(new Date(2026, 9, 5, 12, 15).getTime());
    expect(parseHealthDate('Today at 7:02 AM', NOW)).toBe(T702);
    expect(parseHealthDate('Yesterday at 7:02 PM', NOW)).toBe(new Date(2026, 9, 4, 19, 2).getTime());
    expect(parseHealthDate('Oct 5, 2026', NOW)).toBe(new Date(2026, 9, 5).getTime());
  });

  it('returns null for impossible or unreadable dates', () => {
    for (const bad of ['Feb 30, 2026 at 7:02 AM', '13/25/26, 7:02 AM', 'Oct 5, 2026 at 13:02 PM', 'Oct 5, 2026 at 7:75', 'Smarch 5, 2026', 'soon', '']) {
      expect(parseHealthDate(bad, NOW), bad).toBeNull();
    }
  });
});

describe('shortcut constants', () => {
  it('runs the "Health to Heft" Shortcut without any return URL', () => {
    expect(HEALTH_IMPORT_SHORTCUT).toBe('Health to Heft');
    expect(importShortcutUrl()).toBe('shortcuts://run-shortcut?name=Health%20to%20Heft');
  });
});

// ------------------------------------------------------------------ planning + saving (Dexie)

async function importText(text: string, opts: HealthPlanOptions = {}) {
  const parsed = parse(text);
  const settings = await getSettings();
  const plan = planHealthImport(parsed.samples, await db.measurements.toArray(), settings, opts);
  await applyHealthImport(plan);
  return plan;
}

const weighIn = (date: string, lb: number, fat?: number, fatDate = date) =>
  lines(
    'heft-health',
    `weight: ${lb} lb`,
    `weight date: ${date}`,
    ...(fat == null ? [] : [`body fat: ${fat}%`, `body fat date: ${fatDate}`]),
  );

describe('planHealthImport + applyHealthImport', () => {
  beforeEach(async () => {
    await Promise.all([db.measurements.clear(), db.settings.clear()]);
  });

  it('creates one hk_ row and re-importing is a no-op (same ids, same count)', async () => {
    const first = await importText(TEMPLATE);
    expect(first.add).toHaveLength(1);
    const rows = await db.measurements.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'hk_' + T702, date: T702, healthAt: T702, source: 'health', bodyFatPct: 18.5, photoIds: [] });
    expect(rows[0].bodyweightKg).toBeCloseTo(LB(184.2), 9);

    for (let i = 0; i < 2; i++) {
      const again = await importText(TEMPLATE);
      expect(again.add).toEqual([]);
      expect(again.update).toEqual([]);
      expect(again.skipped).toEqual([{ reason: 'unchanged', at: T702 }]);
    }
    expect((await db.measurements.toArray()).map((m) => m.id)).toEqual(['hk_' + T702]);
    // Even with the watermark ignored nothing is duplicated.
    const all = await importText(TEMPLATE, { reimportAll: true });
    expect(all.add).toEqual([]);
    expect(await db.measurements.count()).toBe(1);
  });

  it('sets the watermark and the import time without touching the profile weight', async () => {
    await updateSettings({ bodyweightKg: 90, bodyweightUpdatedAt: T702 - DAY });
    const before = Date.now();
    await importText(TEMPLATE);
    const s = await getSettings();
    expect(s.healthImportedThrough).toBe(T702);
    expect(s.healthImportedAt).toBeGreaterThanOrEqual(before);
    expect(s.bodyweightKg).toBe(90);
    expect(s.bodyweightUpdatedAt).toBe(T702 - DAY);
    // An older paste never moves the watermark back.
    await importText(weighIn('Oct 1, 2026 at 7:00 AM', 186), { reimportAll: true });
    expect((await getSettings()).healthImportedThrough).toBe(T702);
  });

  it('updates its own row when the values differ (body fat arriving later)', async () => {
    await importText(weighIn('Oct 5, 2026 at 7:02 AM', 184.2));
    expect((await db.measurements.get('hk_' + T702))?.bodyFatPct).toBeNull();
    const plan = await importText(TEMPLATE);
    expect(plan.add).toEqual([]);
    expect(plan.update.map((m) => m.id)).toEqual(['hk_' + T702]);
    expect((await db.measurements.get('hk_' + T702))?.bodyFatPct).toBe(18.5);
    expect(await db.measurements.count()).toBe(1);
  });

  it('a same-day weigh-in typed in Heft wins: the whole day is skipped and counted', async () => {
    const mine: Measurement = { id: 'm1', date: new Date(2026, 9, 5, 6, 30).getTime(), bodyweightKg: 84, photoIds: [] };
    await db.measurements.put(mine);
    const plan = await importText(TEMPLATE);
    expect(plan.add).toEqual([]);
    expect(plan.update).toEqual([]);
    expect(plan.skipped).toEqual([{ reason: 'manual', at: T702 }]);
    expect(await db.measurements.toArray()).toEqual([mine]);
  });

  it('a same-day entry without a body weight (tape measurements) does not block the import', async () => {
    await db.measurements.put({ id: 'tape', date: new Date(2026, 9, 5, 20, 0).getTime(), waistCm: 84, photoIds: [] });
    const plan = await importText(TEMPLATE);
    expect(plan.add.map((m) => m.id)).toEqual(['hk_' + T702]);
  });

  it('a deleted imported row is not resurrected (watermark), unless re-importing everything', async () => {
    await importText(TEMPLATE);
    await db.measurements.delete('hk_' + T702);
    const plan = await importText(TEMPLATE);
    expect(plan.add).toEqual([]);
    expect(plan.skipped).toEqual([{ reason: 'old', at: T702 }]);
    expect(await db.measurements.count()).toBe(0);
    const back = await importText(TEMPLATE, { reimportAll: true });
    expect(back.add.map((m) => m.id)).toEqual(['hk_' + T702]);
  });

  it('an imported row the user edited (source manual) is never overwritten', async () => {
    await importText(TEMPLATE);
    const row = (await db.measurements.get('hk_' + T702))!;
    // What MeasurementSheet saves when the user corrects the weight.
    await db.measurements.put(editedMeasurement(row, { id: row.id, date: row.date, photoIds: [], bodyweightKg: 83 }));
    const edited = (await db.measurements.get(row.id))!;
    expect(edited).toMatchObject({ source: 'manual', healthAt: T702, bodyweightKg: 83, bodyFatPct: 18.5 });

    for (const opts of [{}, { reimportAll: true }]) {
      const plan = await importText(weighIn('Oct 5, 2026 at 7:02 AM', 190, 20), opts);
      expect(plan.add).toEqual([]);
      expect(plan.update).toEqual([]);
      expect(plan.skipped.map((s) => s.reason)).toEqual(['manual']);
    }
    // Even with no weight left on it, the edited row keeps its id to itself.
    await db.measurements.put({ ...edited, bodyweightKg: null, bodyFatPct: null, waistCm: 84 });
    const plan = await importText(TEMPLATE, { reimportAll: true });
    expect(plan.skipped.map((s) => s.reason)).toEqual(['edited']);
    expect((await db.measurements.get(row.id))?.waistCm).toBe(84);
  });

  it('keeps the earliest weigh-in of a day; a later one only fills what is missing', async () => {
    const plan = await importText(
      lines(
        'heft-health',
        'weight: 186 lb',
        'weight date: Oct 5, 2026 at 6:00 PM',
        'weight: 184.2 lb',
        'weight date: Oct 5, 2026 at 7:02 AM',
      ),
    );
    expect(plan.add.map((m) => m.id)).toEqual(['hk_' + T702]);
    expect(plan.add[0].bodyweightKg).toBeCloseTo(LB(184.2), 9);

    const later = await importText(weighIn('Oct 5, 2026 at 6:30 PM', 186.5, 19.2));
    // The evening body fat fills the morning row (it had none); the evening weight is not imported.
    expect(later.update).toHaveLength(1);
    expect(later.update[0]).toMatchObject({ id: 'hk_' + T702, bodyFatPct: 19.2 });
    expect(later.update[0].bodyweightKg).toBeCloseTo(LB(184.2), 9);

    const again = await importText(weighIn('Oct 5, 2026 at 6:45 PM', 186.1, 19.0));
    expect(again.update).toEqual([]);
    expect(again.skipped.map((s) => s.reason)).toEqual(['later']);
    expect(await db.measurements.count()).toBe(1);
  });

  it('attaches body fat measured within 10 minutes, else the day’s earliest; body fat alone makes its own row', async () => {
    const plan = await importText(
      lines(
        'heft-health',
        'weight: 184.2 lb',
        'weight date: Oct 5, 2026 at 7:02 AM',
        'body fat: 17%',
        'body fat date: Oct 5, 2026 at 6:00 AM',
        'body fat: 18.5%',
        'body fat date: Oct 5, 2026 at 7:09 AM',
        'body fat: 19%',
        'body fat date: Oct 4, 2026 at 7:00 AM',
      ),
    );
    expect(plan.add).toHaveLength(2);
    const oct4 = plan.add.find((m) => m.date === new Date(2026, 9, 4, 7, 0).getTime())!;
    expect(oct4).toMatchObject({ bodyweightKg: null, bodyFatPct: 19, source: 'health' });
    expect(plan.add.find((m) => m.id === 'hk_' + T702)?.bodyFatPct).toBe(18.5);

    await db.measurements.clear();
    await db.settings.clear();
    const far = await importText(weighIn('Oct 5, 2026 at 7:02 AM', 184.2, 18, 'Oct 5, 2026 at 9:30 AM'));
    expect(far.add[0].bodyFatPct).toBe(18); // no body fat near the weight: the day's earliest
  });

  it('the newest imported weight feeds calories, but a NEWER hand-typed profile weight still wins', async () => {
    await updateSettings({ bodyweightKg: 90, bodyweightUpdatedAt: T702 - DAY });
    await importText(TEMPLATE);
    expect(await currentBodyweightKg()).toBeCloseTo(LB(184.2), 9);
    await updateSettings({ bodyweightKg: 80, bodyweightUpdatedAt: T702 + HOUR });
    expect(await currentBodyweightKg()).toBe(80);
    // A later weigh-in imported afterwards wins again.
    await importText(weighIn('Oct 6, 2026 at 7:00 AM', 183));
    expect(await currentBodyweightKg()).toBeCloseTo(LB(183), 9);
  });

  it('a weigh-in skipped for your own entry never moves the watermark: delete yours and the scale’s comes in', async () => {
    await db.measurements.put({ id: 'm1', date: new Date(2026, 9, 5, 6, 30).getTime(), bodyweightKg: 84, photoIds: [] });
    const plan = await importText(TEMPLATE);
    expect(plan.skipped.map((s) => s.reason)).toEqual(['manual']);
    expect(plan.importedThrough).toBeNull();
    // The "Done" of that nothing-new preview writes nothing.
    expect(await getSettings()).toMatchObject({ healthImportedThrough: null, healthImportedAt: null });

    await db.measurements.delete('m1');
    const again = await importText(TEMPLATE);
    expect(again.skipped).toEqual([]);
    expect(again.add.map((m) => m.id)).toEqual(['hk_' + T702]);
    expect((await getSettings()).healthImportedThrough).toBe(T702);
  });

  it('a later same-day weigh-in that is skipped does not move the watermark ("Last import")', async () => {
    await importText(TEMPLATE);
    const importedAt = (await getSettings()).healthImportedAt;
    const later = await importText(weighIn('Oct 5, 2026 at 6:00 PM', 186, 19));
    expect(later.skipped.map((s) => s.reason)).toEqual(['later']);
    expect(later.importedThrough).toBeNull();
    expect(await getSettings()).toMatchObject({ healthImportedThrough: T702, healthImportedAt: importedAt });
  });

  it('a weight timed a minute before its body fat joins the body-fat-only row instead of being called deleted', async () => {
    const T701 = T702 - MIN;
    // Paste 1: the latest Weight is still yesterday's, the latest Body Fat is this morning's.
    const first = await importText(weighIn('Oct 4, 2026 at 7:00 AM', 185, 18.5, 'Oct 5, 2026 at 7:02 AM'));
    expect(first.add.map((m) => m.id).sort()).toEqual(['hk_' + new Date(2026, 9, 4, 7, 0).getTime(), 'hk_' + T702].sort());
    expect((await getSettings()).healthImportedThrough).toBe(T702);

    // Paste 2: this morning's weight has reached Health, timed in the minute before its body fat.
    const today = weighIn('Oct 5, 2026 at 7:01 AM', 184.2, 18.5, 'Oct 5, 2026 at 7:02 AM');
    const second = await importText(today);
    expect(second.skipped).toEqual([]);
    expect(second.add).toEqual([]);
    expect(second.update).toHaveLength(1);
    const row = (await db.measurements.get('hk_' + T702))!;
    expect(row).toMatchObject({ date: T701, healthAt: T701, bodyFatPct: 18.5, source: 'health' });
    expect(row.bodyweightKg).toBeCloseTo(LB(184.2), 9);
    expect(await db.measurements.count()).toBe(2);
    expect(await currentBodyweightKg()).toBeCloseTo(LB(184.2), 9);

    const third = await importText(today);
    expect(third.update).toEqual([]);
    expect(third.skipped.map((s) => s.reason)).toEqual(['unchanged']);
  });

  it('two imported rows on one local day (after a time-zone change): samples refresh their own row only', async () => {
    const A = new Date(2026, 9, 5, 0, 30).getTime();
    const B = new Date(2026, 9, 5, 7, 0).getTime();
    await db.measurements.bulkPut([
      { id: 'hk_' + A, date: A, healthAt: A, source: 'health', bodyweightKg: 84, bodyFatPct: null, photoIds: [] },
      { id: 'hk_' + B, date: B, healthAt: B, source: 'health', bodyweightKg: 83.5, bodyFatPct: 18.5, photoIds: [] },
    ]);
    await updateSettings({ healthImportedThrough: B });
    const plan = await importText(
      lines('heft-health', 'weight: 83.5 kg', 'weight date: Oct 5, 2026 at 7:00 AM', 'body fat: 18.5%', 'body fat date: Oct 5, 2026 at 7:00 AM'),
    );
    expect(plan.update).toEqual([]);
    expect(plan.skipped).toEqual([{ reason: 'unchanged', at: B }]);
    expect((await db.measurements.get('hk_' + A))?.bodyFatPct).toBeNull();
  });
});

describe('editedMeasurement (MeasurementSheet save)', () => {
  const row: Measurement & { futureField?: string } = {
    id: 'hk_1',
    date: T702,
    bodyweightKg: 83.55,
    bodyFatPct: 18.5,
    photoIds: [],
    source: 'health',
    healthAt: T702,
    futureField: 'kept',
  };

  it('starts from the stored row: source, healthAt and unknown fields survive', () => {
    const saved = editedMeasurement(row, { id: row.id, date: row.date, photoIds: ['p1'], bodyweightKg: 83.55, notes: 'fasted' });
    expect(saved).toMatchObject({ healthAt: T702, futureField: 'kept', photoIds: ['p1'], notes: 'fasted', bodyFatPct: 18.5 });
    expect(saved.source).toBe('manual'); // the user edited an imported row: it's theirs now
    expect(editedMeasurement(row, { id: row.id, date: row.date, photoIds: [] }, false).source).toBe('health');
  });

  it('a new entry has no source (= manual) and a manual row stays manual', () => {
    expect(editedMeasurement(null, { id: 'n', date: 1, photoIds: [], bodyweightKg: 80 }).source).toBeUndefined();
    const manual: Measurement = { id: 'm', date: 1, photoIds: [], bodyweightKg: 80 };
    expect(editedMeasurement(manual, { id: 'm', date: 1, photoIds: [], bodyweightKg: 81 })).toEqual({ ...manual, bodyweightKg: 81 });
  });
});

describe('backup round-trip', () => {
  beforeEach(async () => {
    await db.transaction('rw', db.tables, async () => {
      await Promise.all(db.tables.map((t) => t.clear()));
    });
  });

  it('keeps source / healthAt on rows and the settings watermark', async () => {
    await importText(TEMPLATE);
    const before = await db.measurements.toArray();
    const settingsBefore = await getSettings();
    const text = await (await exportBackup()).text();
    await db.transaction('rw', db.tables, async () => {
      await Promise.all(db.tables.map((t) => t.clear()));
    });
    await importBackup(text);
    expect(await db.measurements.toArray()).toEqual(before);
    expect((await db.measurements.get('hk_' + T702))).toMatchObject({ source: 'health', healthAt: T702 });
    const s = await getSettings();
    expect(s.healthImportedThrough).toBe(T702);
    expect(s.healthImportedAt).toBe(settingsBefore.healthImportedAt);
    // The restored watermark still stops a deleted row from coming back.
    await db.measurements.delete('hk_' + T702);
    expect((await importText(TEMPLATE)).skipped.map((x) => x.reason)).toEqual(['old']);
  });
});
