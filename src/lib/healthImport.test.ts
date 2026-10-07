import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db';
import type { Measurement, Settings } from '../types';
import {
  applyHealthImport,
  deleteMeasurement,
  editedMeasurement,
  groupWeighIns,
  HEALTH_IMPORT_SHORTCUT,
  HEALTH_PASTE_INPUT,
  healthTemplateText,
  importShortcutUrl,
  parseHealthDate,
  parseHealthText,
  planHealthImport,
  type HealthPlanOptions,
  type HealthSample,
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

  it('a value without a date is dropped with an error (never dated now: every sync would add it again)', () => {
    const r = parse(lines('heft-health', 'weight: 184.2 lb', 'body fat: 18.5%'));
    expect(r.recognized).toBe(true);
    expect(r.samples).toEqual([]);
    expect(r.errors).toEqual(['The weight "184.2 lb" has no date', 'The body fat "18.5%" has no date']);
    // Date lines that came back empty are no dates either.
    const blank = parse(lines('heft-health', 'weight: 184.2 lb', 'weight date: ', 'body fat: 18.5%', 'body fat date: '));
    expect(blank.samples).toEqual([]);
    expect(blank.errors.filter((e) => e.includes('has no date'))).toHaveLength(2);
  });

  it('values and dates that are lists of different lengths are not paired', () => {
    const r = parse(
      lines(
        'heft-health',
        'weight: 184.2 lb',
        '185.0 lb',
        '186.4 lb',
        'weight date: Oct 5, 2026 at 7:02 AM',
        'Oct 4, 2026 at 6:58 AM',
        'body fat: 18.5%',
        'body fat date: Oct 5, 2026 at 7:02 AM',
      ),
    );
    expect(r.errors).toEqual(['3 weight values but 2 dates']);
    expect(r.samples).toEqual([{ kind: 'bodyFat', value: 18.5, at: T702 }]);
  });

  it("a JSON sample record's start date is its date (its end date doesn't make the lists uneven)", () => {
    const r = parseHealthText(
      JSON.stringify({
        type: 'HKQuantityTypeIdentifierBodyMass',
        value: 83.5,
        unit: 'kg',
        startDate: '2026-10-05T07:02:00',
        endDate: '2026-10-05T07:02:30',
      }),
      { unit: 'lb', now: NOW },
    );
    expect(r.errors).toEqual([]);
    expect(r.samples).toEqual([{ kind: 'weight', value: 83.5, at: T702 }]);
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
    expect(parse(lines('heft-health', 'fat: 18.5%', 'date: Oct 5, 2026 at 7:02 AM')).samples).toEqual([
      { kind: 'bodyFat', value: 18.5, at: T702 },
    ]);
    expect(parse(JSON.stringify({ 'heft-health': true, fat: 18.5, fatDate: '2026-10-05T07:02:00' })).samples).toEqual([
      { kind: 'bodyFat', value: 18.5, at: T702 },
    ]);
  });

  it('an odd post (deeply nested JSON, a huge number) returns quickly with short errors', () => {
    for (const depth of [2000, 32000]) {
      const nested = '{"app":"heft-health","weight":' + '['.repeat(depth) + ']'.repeat(depth) + '}';
      const r = parse(nested);
      expect(r.recognized).toBe(true);
      expect(r.samples).toEqual([]);
    }
    const huge = '1'.repeat(60000);
    for (const text of [
      'heft-health\nweight: ' + huge,
      'heft-health\nweight' + ' '.repeat(60000) + 'x',
      JSON.stringify({ app: 'heft-health', weight: huge, weightDate: '2026-10-05T07:02:00' }),
      JSON.stringify({ app: 'heft-health', weight: '184.2 lb', weightDate: huge }),
    ]) {
      const start = performance.now();
      const r = parse(text);
      expect(performance.now() - start).toBeLessThan(250); // unguarded: seconds on a phone
      expect(r.recognized).toBe(true);
      expect(r.samples).toEqual([]);
      for (const e of r.errors) expect(e.length).toBeLessThan(200);
    }
    expect(parse(JSON.stringify({ app: 'heft-health', weight: huge, weightDate: '2026-10-05T07:02:00' })).errors).toEqual([
      `Couldn't read the weight "${'1'.repeat(40)}"`,
    ]);
    // The Shortcut's own text is read as before.
    expect(parse(TEMPLATE).samples).toEqual([
      { kind: 'weight', value: LB(184.2), at: T702 },
      { kind: 'bodyFat', value: 18.5, at: T702 },
    ]);
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
  it('runs the "Health to Heft" Shortcut without any return URL, telling it to copy for a paste', () => {
    expect(HEALTH_IMPORT_SHORTCUT).toBe('Health to Heft');
    expect(HEALTH_PASTE_INPUT).toBe('paste');
    expect(importShortcutUrl()).toBe('shortcuts://run-shortcut?name=Health%20to%20Heft&input=text&text=paste');
  });
});

// ------------------------------------------------------------------ planning + saving (Dexie)

async function importText(text: string, opts: HealthPlanOptions = {}, now = NOW) {
  const parsed = parseHealthText(text, { unit: 'lb', now });
  expect(parsed.errors).toEqual([]);
  const plan = planHealthImport(parsed.samples, await db.measurements.toArray(), await getSettings(), opts);
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

/** Local Oct `d` 2026 at h:m. */
const at = (h: number, m: number, d = 5) => new Date(2026, 9, d, h, m).getTime();
const ids = async () => (await db.measurements.toArray()).map((m) => m.id).sort();

describe('groupWeighIns', () => {
  const w = (t: number, value = 83): HealthSample => ({ kind: 'weight', value, at: t });
  const f = (t: number, value = 18): HealthSample => ({ kind: 'bodyFat', value, at: t });

  it('every weight is a weigh-in; body fat joins the NEAREST weight within 10 minutes; a reading left over stands alone', () => {
    const samples = [w(at(7, 0)), w(at(7, 5)), f(at(7, 4)), f(at(7, 40)), w(at(9, 0)), f(at(9, 0)), f(at(9, 12))];
    expect(groupWeighIns(samples)).toEqual([
      { at: at(7, 0), weight: w(at(7, 0)) },
      { at: at(7, 5), weight: w(at(7, 5)), bodyFat: f(at(7, 4)) },
      { at: at(7, 40), bodyFat: f(at(7, 40)) },
      { at: at(9, 0), weight: w(at(9, 0)), bodyFat: f(at(9, 0)) },
      { at: at(9, 12), bodyFat: f(at(9, 12)) },
    ]);
  });

  it('keeps one sample per instant and drops broken ones', () => {
    expect(groupWeighIns([w(at(7, 0), 83), w(at(7, 0), 90), w(NaN), f(at(7, 0), Infinity)])).toEqual([
      { at: at(7, 0), weight: w(at(7, 0), 83) },
    ]);
  });
});

describe('planHealthImport + applyHealthImport', () => {
  beforeEach(async () => {
    await Promise.all([db.measurements.clear(), db.settings.clear(), db.media.clear()]);
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
    expect(await ids()).toEqual(['hk_' + T702]);
    // Bringing deleted weigh-ins back duplicates nothing either.
    const all = await importText(TEMPLATE, { reimportAll: true });
    expect(all.add).toEqual([]);
    expect(all.clearDeleted).toEqual([]);
    expect(await db.measurements.count()).toBe(1);
  });

  it('records the newest sample and the import time without touching the profile weight', async () => {
    await updateSettings({ bodyweightKg: 90, bodyweightUpdatedAt: T702 - DAY });
    const before = Date.now();
    await importText(TEMPLATE);
    const s = await getSettings();
    expect(s.healthImportedThrough).toBe(T702);
    expect(s.healthImportedAt).toBeGreaterThanOrEqual(before);
    expect(s.bodyweightKg).toBe(90);
    expect(s.bodyweightUpdatedAt).toBe(T702 - DAY);
    // An older weigh-in comes in (it is new to Heft) but never moves the newest sample back.
    const older = await importText(weighIn('Oct 1, 2026 at 7:00 AM', 186));
    expect(older.add.map((m) => m.id)).toEqual(['hk_' + at(7, 0, 1)]);
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
    // A paste whose body fat line came back empty never clears the body fat Heft has.
    const empty = await importText(lines(weighIn('Oct 5, 2026 at 7:02 AM', 184.2), 'body fat: ', 'body fat date: '));
    expect(empty.skipped).toEqual([{ reason: 'unchanged', at: T702 }]);
    expect((await db.measurements.get('hk_' + T702))?.bodyFatPct).toBe(18.5);
  });

  it('two weigh-ins the same day are two rows (a bad reading and the re-weigh, and the evening one)', async () => {
    const text = lines(
      'heft-health',
      'weight: 186.0 lb',
      '184.2 lb',
      '190.4 lb',
      'weight date: Oct 5, 2026 at 6:30 PM',
      'Oct 5, 2026 at 7:06 AM',
      'Oct 5, 2026 at 7:02 AM',
      'body fat: 18.9%',
      '18.5%',
      '22.1%',
      'body fat date: Oct 5, 2026 at 6:30 PM',
      'Oct 5, 2026 at 7:06 AM',
      'Oct 5, 2026 at 7:02 AM',
    );
    const plan = await importText(text, {}, at(20, 0));
    expect(plan.add.map((m) => [m.id, m.bodyFatPct])).toEqual([
      ['hk_' + T702, 22.1],
      ['hk_' + at(7, 6), 18.5],
      ['hk_' + at(18, 30), 18.9],
    ]);
    expect(plan.add[0].bodyweightKg).toBeCloseTo(LB(190.4), 9);
    expect(plan.importedThrough).toBe(at(18, 30));
    expect(await db.measurements.count()).toBe(3);

    const again = await importText(text, {}, at(20, 0));
    expect(again.add).toEqual([]);
    expect(again.update).toEqual([]);
    expect(again.skipped.map((s) => s.reason)).toEqual(['unchanged', 'unchanged', 'unchanged']);
  });

  it('a weigh-in typed in Heft the same day blocks nothing and is never touched', async () => {
    const mine: Measurement = { id: 'm1', date: at(6, 30), bodyweightKg: 84, bodyFatPct: 20, photoIds: [] };
    const tape: Measurement = { id: 'tape', date: at(20, 0), waistCm: 84, photoIds: [] };
    await db.measurements.bulkPut([mine, tape]);
    const plan = await importText(TEMPLATE);
    expect(plan.add.map((m) => m.id)).toEqual(['hk_' + T702]);
    expect(plan.update).toEqual([]);
    expect(plan.skipped).toEqual([]);
    expect(await db.measurements.get('m1')).toEqual(mine);
    expect(await db.measurements.get('tape')).toEqual(tape);
  });

  it('a deleted weigh-in never comes back', async () => {
    await importText(TEMPLATE);
    await deleteMeasurement((await db.measurements.get('hk_' + T702))!);
    expect(await db.measurements.count()).toBe(0);
    expect((await getSettings()).healthDeleted).toEqual([T702]);
    const settingsBefore = await db.settings.get('settings');

    const plan = await importText(TEMPLATE);
    expect(plan.add).toEqual([]);
    expect(plan.skipped).toEqual([{ reason: 'deleted', at: T702 }]);
    expect(await db.measurements.count()).toBe(0);
    // Nothing-new imports leave the settings alone.
    expect(await db.settings.get('settings')).toEqual(settingsBefore);
  });

  it('"Bring deleted weigh-ins back" restores them and lifts only their tombstones', async () => {
    const oct4 = weighIn('Oct 4, 2026 at 7:00 AM', 185, 18.9);
    await importText(oct4);
    await importText(TEMPLATE);
    for (const m of await db.measurements.toArray()) await deleteMeasurement(m);
    expect((await getSettings()).healthDeleted).toEqual([at(7, 0, 4), T702]);

    const preview = await importText(TEMPLATE, { reimportAll: true });
    expect(preview.add.map((m) => m.id)).toEqual(['hk_' + T702]);
    expect(preview.clearDeleted).toEqual([T702]);
    expect(await ids()).toEqual(['hk_' + T702]);
    // Oct 4 wasn't in that paste: it stays deleted.
    expect((await getSettings()).healthDeleted).toEqual([at(7, 0, 4)]);
    expect((await importText(TEMPLATE)).skipped).toEqual([{ reason: 'unchanged', at: T702 }]);
    expect((await importText(oct4)).skipped).toEqual([{ reason: 'deleted', at: at(7, 0, 4) }]);
  });

  it('a re-weigh minutes after a deleted bad reading still comes in; the bad one stays out', async () => {
    const bad = weighIn('Oct 5, 2026 at 7:02 AM', 192.6, 23.5);
    await importText(bad);
    await deleteMeasurement((await db.measurements.get('hk_' + T702))!);
    // The next sync sends both: the bad reading (still in Apple Health) and the re-weigh 4 minutes later.
    const both = lines(
      'heft-health',
      'weight: 184.2 lb',
      '192.6 lb',
      'weight date: Oct 5, 2026 at 7:06 AM',
      'Oct 5, 2026 at 7:02 AM',
      'body fat: 18.5%',
      '23.5%',
      'body fat date: Oct 5, 2026 at 7:06 AM',
      'Oct 5, 2026 at 7:02 AM',
    );
    const plan = await importText(both);
    expect(plan.skipped).toEqual([{ reason: 'deleted', at: T702 }]);
    expect(plan.add.map((m) => m.id)).toEqual(['hk_' + at(7, 6)]);
    expect(await ids()).toEqual(['hk_' + at(7, 6)]);
    expect(await currentBodyweightKg()).toBeCloseTo(LB(184.2), 9);

    // Both already in Heft when the bad one is deleted: same result, nothing else moves.
    await db.measurements.clear();
    await db.settings.clear();
    await importText(both);
    await deleteMeasurement((await db.measurements.get('hk_' + T702))!);
    const again = await importText(both);
    expect(again.skipped).toEqual([
      { reason: 'deleted', at: T702 },
      { reason: 'unchanged', at: at(7, 6) },
    ]);
    expect(again.add).toEqual([]);
    expect(again.update).toEqual([]);
  });

  it('a re-weigh minutes after a deleted bad reading comes in when the bad one is gone from Apple Health too', async () => {
    await importText(weighIn('Oct 5, 2026 at 7:02 AM', 192.6, 23.5));
    await deleteMeasurement((await db.measurements.get('hk_' + T702))!);
    // The bad 7:02 reading was also deleted in Hume / Apple Health: the next sync has only the re-weigh.
    const reweigh = weighIn('Oct 5, 2026 at 7:06 AM', 184.2, 18.5);
    const plan = await importText(reweigh);
    expect(plan.add.map((m) => m.id)).toEqual(['hk_' + at(7, 6)]);
    expect(plan.skipped).toEqual([]);
    expect(await ids()).toEqual(['hk_' + at(7, 6)]);
    // Every later sync too.
    expect((await importText(reweigh)).skipped).toEqual([{ reason: 'unchanged', at: at(7, 6) }]);
    expect((await getSettings()).healthDeleted).toEqual([T702]);
  });

  it("a deleted weigh-in's body fat arriving alone stays out; the re-weigh beside it comes in", async () => {
    await importText(weighIn('Oct 5, 2026 at 7:02 AM', 192.6, 23.5));
    await deleteMeasurement((await db.measurements.get('hk_' + T702))!);
    // Only the bad reading's weight was deleted from Apple Health: its 7:02 body fat comes alone.
    const plan = await importText(
      lines(
        'heft-health',
        'weight: 184.2 lb',
        'weight date: Oct 5, 2026 at 7:06 AM',
        'body fat: 18.5%',
        '23.5%',
        'body fat date: Oct 5, 2026 at 7:06 AM',
        'Oct 5, 2026 at 7:02 AM',
      ),
    );
    expect(plan.skipped).toEqual([{ reason: 'deleted', at: T702 }]);
    expect(plan.add.map((m) => [m.id, m.bodyFatPct])).toEqual([['hk_' + at(7, 6), 18.5]]);
    expect(await ids()).toEqual(['hk_' + at(7, 6)]);
  });

  it("a weigh-in's body fat paired with an earlier weight moves to its own weight when that syncs", async () => {
    // 7:00: a weight with no body fat. 7:05: the next weigh-in's body fat reaches Apple Health before its weight.
    await importText(weighIn('Oct 5, 2026 at 7:00 AM', 184.2));
    const early = await importText(weighIn('Oct 5, 2026 at 7:00 AM', 184.2, 19.4, 'Oct 5, 2026 at 7:05 AM'));
    expect(early.update.map((m) => [m.id, m.bodyFatPct])).toEqual([['hk_' + at(7, 0), 19.4]]);
    // The 7:05 weight is in: the body fat is its, and leaves the 7:00 row.
    const both = lines(
      'heft-health',
      'weight: 184.2 lb',
      '183.9 lb',
      'weight date: Oct 5, 2026 at 7:00 AM',
      'Oct 5, 2026 at 7:05 AM',
      'body fat: 19.4%',
      'body fat date: Oct 5, 2026 at 7:05 AM',
    );
    const plan = await importText(both);
    expect(plan.add.map((m) => [m.id, m.bodyFatPct])).toEqual([['hk_' + at(7, 5), 19.4]]);
    expect(plan.update.map((m) => [m.id, m.bodyFatPct])).toEqual([['hk_' + at(7, 0), null]]);
    expect((await db.measurements.get('hk_' + at(7, 0)))?.bodyFatPct).toBeNull();
    expect((await db.measurements.get('hk_' + at(7, 0)))?.bodyweightKg).toBeCloseTo(LB(184.2), 9);
    const own = (await db.measurements.get('hk_' + at(7, 5)))!;
    expect(own.bodyFatPct).toBe(19.4);
    expect(own.bodyweightKg).toBeCloseTo(LB(183.9), 9);
    // Settled: the next sync changes nothing.
    const again = await importText(both);
    expect(again.update).toEqual([]);
    expect(again.add).toEqual([]);
    expect(again.skipped.map((s) => s.reason)).toEqual(['unchanged', 'unchanged']);
  });

  it("a deleted weigh-in never takes over another weigh-in's body-fat-only row", async () => {
    // A 7:00 weight with the 6:57 body fat, and the 7:05 body fat on its own.
    await importText(
      lines(
        'heft-health',
        'weight: 83.4 kg',
        'weight date: Oct 5, 2026 at 7:00 AM',
        'body fat: 19%',
        '18.5%',
        'body fat date: Oct 5, 2026 at 6:57 AM',
        'Oct 5, 2026 at 7:05 AM',
      ),
    );
    expect(await ids()).toEqual(['hk_' + at(7, 0), 'hk_' + at(7, 5)]);
    await deleteMeasurement((await db.measurements.get('hk_' + at(7, 0)))!);
    const has834 = async () => (await db.measurements.toArray()).some((m) => m.bodyweightKg != null && Math.abs(m.bodyweightKg - 83.4) < 1e-6);

    // A 6:57 weight syncs and takes the 6:57 body fat; the deleted 7:00 weight now pairs with the 7:05 body fat.
    const sync = [
      'heft-health',
      'weight: 81.9 kg',
      '83.4 kg',
      'weight date: Oct 5, 2026 at 6:57 AM',
      'Oct 5, 2026 at 7:00 AM',
      'body fat: 19%',
      '18.5%',
      'body fat date: Oct 5, 2026 at 6:57 AM',
      'Oct 5, 2026 at 7:05 AM',
    ];
    const plan = await importText(lines(...sync));
    expect(plan.skipped).toEqual([{ reason: 'deleted', at: at(7, 0) }]);
    expect(plan.update).toEqual([]);
    expect(plan.add.map((m) => m.id)).toEqual(['hk_' + at(6, 57)]);
    expect(await has834()).toBe(false);
    expect(await db.measurements.get('hk_' + at(7, 5))).toMatchObject({ bodyweightKg: null, bodyFatPct: 18.5, healthAt: at(7, 5) });

    // The 7:05 weight syncs: it joins its body fat's row.
    const withWeight = lines(
      'heft-health',
      'weight: 81.9 kg',
      '83.4 kg',
      '82.0 kg',
      'weight date: Oct 5, 2026 at 6:57 AM',
      'Oct 5, 2026 at 7:00 AM',
      'Oct 5, 2026 at 7:05 AM',
      'body fat: 19%',
      '18.5%',
      'body fat date: Oct 5, 2026 at 6:57 AM',
      'Oct 5, 2026 at 7:05 AM',
    );
    const joined = await importText(withWeight);
    expect(joined.add).toEqual([]);
    expect(joined.update.map((m) => m.id)).toEqual(['hk_' + at(7, 5)]);
    expect(await has834()).toBe(false);
    expect(await ids()).toEqual(['hk_' + at(6, 57), 'hk_' + at(7, 5)]);
    expect(await db.measurements.get('hk_' + at(7, 5))).toMatchObject({ bodyweightKg: 82, bodyFatPct: 18.5, healthAt: at(7, 5) });
  });

  it('an imported row the user edited is never overwritten, and deleting it sticks too', async () => {
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
      expect(plan.skipped).toEqual([{ reason: 'edited', at: T702 }]);
    }
    // Even with no weight left on it, the edited row keeps its weigh-in to itself.
    await db.measurements.put({ ...edited, bodyweightKg: null, bodyFatPct: null, waistCm: 84 });
    expect((await importText(TEMPLATE, { reimportAll: true })).skipped.map((s) => s.reason)).toEqual(['edited']);
    expect(await db.measurements.get(row.id)).toMatchObject({ waistCm: 84, bodyweightKg: null });

    await deleteMeasurement((await db.measurements.get(row.id))!);
    expect((await importText(TEMPLATE)).skipped).toEqual([{ reason: 'deleted', at: T702 }]);
  });

  it('a weight that reaches Apple Health after its body fat joins the body-fat-only row', async () => {
    const T701 = T702 - MIN;
    // Paste 1: the newest Weight is still yesterday's, the newest Body Fat is this morning's.
    const first = await importText(weighIn('Oct 4, 2026 at 7:00 AM', 185, 18.5, 'Oct 5, 2026 at 7:02 AM'));
    expect(first.add.map((m) => [m.id, m.bodyweightKg == null, m.bodyFatPct])).toEqual([
      ['hk_' + at(7, 0, 4), false, null],
      ['hk_' + T702, true, 18.5],
    ]);

    // Paste 2: this morning's weight is in, timed in the minute before its body fat.
    const today = weighIn('Oct 5, 2026 at 7:01 AM', 184.2, 18.5, 'Oct 5, 2026 at 7:02 AM');
    const second = await importText(today);
    expect(second.skipped).toEqual([]);
    expect(second.add).toEqual([]);
    expect(second.update.map((m) => m.id)).toEqual(['hk_' + T702]);
    const row = (await db.measurements.get('hk_' + T702))!;
    expect(row).toMatchObject({ date: T701, healthAt: T701, bodyFatPct: 18.5, source: 'health' });
    expect(row.bodyweightKg).toBeCloseTo(LB(184.2), 9);
    expect(await db.measurements.count()).toBe(2);
    expect(await currentBodyweightKg()).toBeCloseTo(LB(184.2), 9);

    expect((await importText(today)).skipped).toEqual([{ reason: 'unchanged', at: T701 }]);
    // Deleted, the joined weigh-in stays deleted (by its weight's time and by its body fat's).
    await deleteMeasurement(row);
    expect((await getSettings()).healthDeleted).toEqual([T701]);
    expect((await importText(today)).skipped).toEqual([{ reason: 'deleted', at: T701 }]);
    expect((await importText(weighIn('Oct 4, 2026 at 7:00 AM', 185, 18.5, 'Oct 5, 2026 at 7:02 AM'))).skipped).toEqual([
      { reason: 'unchanged', at: at(7, 0, 4) },
      { reason: 'deleted', at: T702 },
    ]);
  });

  it('the other half of a weigh-in joins its row only when they agree; another weight is its own row', async () => {
    await importText(weighIn('Oct 5, 2026 at 7:02 AM', 184.2));
    // Only the body fat this time (timed 3 minutes later): it fills the weight's row.
    const fat = await importText(lines('heft-health', 'body fat: 18.5%', 'body fat date: Oct 5, 2026 at 7:05 AM'));
    expect(fat.add).toEqual([]);
    expect(fat.update.map((m) => [m.id, m.date, m.bodyFatPct])).toEqual([['hk_' + T702, T702, 18.5]]);
    // A different weight 4 minutes later, its first weigh-in not in the paste: a second row, the first one untouched.
    const reweigh = await importText(weighIn('Oct 5, 2026 at 7:06 AM', 183.8));
    expect(reweigh.update).toEqual([]);
    expect(reweigh.add.map((m) => m.id)).toEqual(['hk_' + at(7, 6)]);
    expect((await db.measurements.get('hk_' + T702))?.bodyweightKg).toBeCloseTo(LB(184.2), 9);
  });

  it('body fat pairs with the nearest weight within 10 minutes; a reading left over is its own row', async () => {
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
    expect(plan.add.map((m) => [m.id, m.bodyweightKg == null, m.bodyFatPct])).toEqual([
      ['hk_' + at(7, 0, 4), true, 19],
      ['hk_' + at(6, 0), true, 17],
      ['hk_' + T702, false, 18.5],
    ]);

    await db.measurements.clear();
    const far = await importText(weighIn('Oct 5, 2026 at 7:02 AM', 184.2, 18, 'Oct 5, 2026 at 9:30 AM'), {}, at(10, 0));
    expect(far.add.map((m) => [m.id, m.bodyFatPct])).toEqual([
      ['hk_' + T702, null],
      ['hk_' + at(9, 30), 18],
    ]);
  });

  it("thirty days of the Shortcut's text (values continued under their keys) make one row per weigh-in", async () => {
    // As the Shortcut writes it: newest first, ISO 8601 with the phone's offset, body fat a second after the weight
    // on odd days, and a re-weigh 4 minutes after the morning one every week.
    const iso = (ms: number, offsetMin = -420) => {
      const d = new Date(ms + offsetMin * MIN);
      const p = (n: number) => String(n).padStart(2, '0');
      const o = Math.abs(offsetMin);
      return (
        `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:` +
        `${p(d.getUTCSeconds())}${offsetMin < 0 ? '-' : '+'}${p(Math.floor(o / 60))}:${p(o % 60)}`
      );
    };
    const base = Date.UTC(2026, 9, 6, 14, 2, 11); // Oct 6, 07:02:11 -07:00
    const readings: { at: number; lb: number; fat: number; fatAt: number }[] = [];
    for (let i = 0; i < 30; i++) {
      const morning = base - i * DAY + (i % 4) * MIN;
      readings.push({ at: morning, lb: 184.2 + i * 0.1, fat: 19.4 + (i % 3) * 0.1, fatAt: morning + (i % 2) * 1000 });
      if (i % 7 === 3) readings.push({ at: morning + 4 * MIN, lb: 183.9 + i * 0.1, fat: 19.1, fatAt: morning + 4 * MIN });
    }
    readings.sort((a, b) => b.at - a.at);
    const col = (key: string, values: string[]) => [`${key}: ${values[0]}`, ...values.slice(1)];
    const text = lines(
      'heft-health',
      ...col('weight', readings.map((r) => `${r.lb.toFixed(1)} lb`)),
      ...col('weight date', readings.map((r) => iso(r.at))),
      ...col('body fat', readings.map((r) => `${r.fat.toFixed(1)}%`)),
      ...col('body fat date', readings.map((r) => iso(r.fatAt))),
    );
    expect(text.split('\n').slice(0, 3)).toEqual(['heft-health', 'weight: 184.2 lb', '184.3 lb']);
    expect(readings).toHaveLength(34); // 30 mornings + 4 re-weighs

    const now = base + 2 * HOUR;
    expect(parseHealthText(text, { unit: 'lb', now }).samples).toHaveLength(68);
    const plan = await importText(text, {}, now);
    expect(plan.add).toHaveLength(34);
    expect(plan.update).toEqual([]);
    expect(plan.skipped).toEqual([]);
    expect(plan.importedThrough).toBe(base);
    const rows = await db.measurements.toArray();
    expect(rows).toHaveLength(34);
    expect(new Set(rows.map((m) => m.id)).size).toBe(34);
    expect(rows.map((m) => m.healthAt).sort()).toEqual(readings.map((r) => r.at).sort());
    for (const r of readings) {
      const row = rows.find((m) => m.healthAt === r.at)!;
      expect(row.bodyweightKg).toBeCloseTo(LB(Number(r.lb.toFixed(1))), 9);
      expect(row.bodyFatPct).toBe(Number(r.fat.toFixed(1)));
      expect(row).toMatchObject({ id: 'hk_' + r.at, date: r.at, source: 'health' });
    }

    // The next sync sends the same 30 days: nothing changes.
    const again = await importText(text, {}, now);
    expect(again.add).toEqual([]);
    expect(again.update).toEqual([]);
    expect(again.skipped).toHaveLength(34);
    expect(again.skipped.every((s) => s.reason === 'unchanged')).toBe(true);
    // Delete two (the newest, and the bad reading before a re-weigh): only those two are held back next time.
    await deleteMeasurement(rows.find((m) => m.healthAt === readings[0].at)!);
    const reweighDay = readings.find((r, i) => readings[i + 1] && r.at - readings[i + 1].at === 4 * MIN)!;
    await deleteMeasurement(rows.find((m) => m.healthAt === reweighDay.at - 4 * MIN)!);
    const third = await importText(text, {}, now);
    expect(third.add).toEqual([]);
    expect(third.skipped.filter((s) => s.reason === 'deleted').map((s) => s.at).sort()).toEqual(
      [readings[0].at, reweighDay.at - 4 * MIN].sort(),
    );
    expect(third.skipped.filter((s) => s.reason === 'unchanged')).toHaveLength(32);
  });

  it('rows imported before every weigh-in had its own row are recognised, not duplicated', async () => {
    const oct4 = at(7, 0, 4);
    // What the one-row-per-day import left: the day's first weigh-in, a body-fat-only day, and the watermark.
    await db.measurements.bulkPut([
      { id: 'hk_' + T702, date: T702, healthAt: T702, source: 'health', bodyweightKg: LB(184.2), bodyFatPct: 18.5, photoIds: [] },
      { id: 'hk_' + oct4, date: oct4, healthAt: oct4, source: 'health', bodyweightKg: null, bodyFatPct: 19, photoIds: [] },
    ]);
    const old: Partial<Settings> = { ...(await getSettings()), healthImportedThrough: T702 };
    delete old.healthDeleted; // settings saved before deletes were remembered
    await db.settings.put(old as Settings);
    const plan = await importText(
      lines(
        'heft-health',
        'weight: 186 lb',
        '184.2 lb',
        '185.5 lb',
        'weight date: Oct 5, 2026 at 6:30 PM',
        'Oct 5, 2026 at 7:02 AM',
        'Oct 3, 2026 at 7:10 AM',
        'body fat: 18.5%',
        '19%',
        'body fat date: Oct 5, 2026 at 7:02 AM',
        'Oct 4, 2026 at 7:00 AM',
      ),
      {},
      at(20, 0),
    );
    expect(plan.update).toEqual([]);
    expect(plan.skipped).toEqual([
      { reason: 'unchanged', at: oct4 },
      { reason: 'unchanged', at: T702 },
    ]);
    // The weigh-ins the old import never brought in (the evening one, a day before its watermark) come in now.
    expect(plan.add.map((m) => m.id)).toEqual(['hk_' + at(7, 10, 3), 'hk_' + at(18, 30)]);
    expect(await db.measurements.count()).toBe(4);
  });

  it('two imported rows on one local day (after a time-zone change): each answers only to its own samples', async () => {
    const A = at(0, 30);
    const B = at(7, 0);
    await db.measurements.bulkPut([
      { id: 'hk_' + A, date: A, healthAt: A, source: 'health', bodyweightKg: 84, bodyFatPct: null, photoIds: [] },
      { id: 'hk_' + B, date: B, healthAt: B, source: 'health', bodyweightKg: 83.5, bodyFatPct: 18.5, photoIds: [] },
    ]);
    const plan = await importText(
      lines('heft-health', 'weight: 83.5 kg', 'weight date: Oct 5, 2026 at 7:00 AM', 'body fat: 18.5%', 'body fat date: Oct 5, 2026 at 7:00 AM'),
    );
    expect(plan.update).toEqual([]);
    expect(plan.add).toEqual([]);
    expect(plan.skipped).toEqual([{ reason: 'unchanged', at: B }]);
    expect((await db.measurements.get('hk_' + A))?.bodyFatPct).toBeNull();
  });

  it('the newest imported weight feeds calories, but a NEWER hand-typed profile weight still wins', async () => {
    await updateSettings({ bodyweightKg: 90, bodyweightUpdatedAt: T702 - DAY });
    await importText(TEMPLATE);
    expect(await currentBodyweightKg()).toBeCloseTo(LB(184.2), 9);
    await updateSettings({ bodyweightKg: 80, bodyweightUpdatedAt: T702 + HOUR });
    expect(await currentBodyweightKg()).toBe(80);
    // A later weigh-in imported afterwards wins again.
    await importText(weighIn('Oct 6, 2026 at 7:00 AM', 183), {}, at(9, 0, 6));
    expect(await currentBodyweightKg()).toBeCloseTo(LB(183), 9);
  });

  it('a plan that writes nothing leaves the settings alone', async () => {
    await db.measurements.put({ id: 'hk_' + T702, date: T702, healthAt: T702, source: 'manual', bodyweightKg: 83, photoIds: [] });
    const plan = await importText(TEMPLATE);
    expect(plan.skipped.map((s) => s.reason)).toEqual(['edited']);
    expect(plan.importedThrough).toBeNull();
    // The "Done" of that nothing-new preview writes no settings row at all.
    expect(await db.settings.get('settings')).toBeUndefined();
  });

  it('applying checks the database again: an entry deleted or edited after the preview is left alone', async () => {
    await importText(weighIn('Oct 5, 2026 at 7:02 AM', 184.2));
    const plan = () =>
      Promise.all([db.measurements.toArray(), getSettings()]).then(([rows, s]) =>
        planHealthImport(parse(TEMPLATE).samples, rows, s),
      );

    // Edited while the preview was open: the edit stays.
    const p1 = await plan();
    expect(p1.update.map((m) => m.id)).toEqual(['hk_' + T702]);
    const row = (await db.measurements.get('hk_' + T702))!;
    await db.measurements.put(editedMeasurement(row, { id: row.id, date: row.date, photoIds: [], bodyweightKg: 83 }));
    expect(await applyHealthImport(p1)).toEqual({ added: 0, updated: 0 });
    expect(await db.measurements.get(row.id)).toMatchObject({ source: 'manual', bodyweightKg: 83, bodyFatPct: null });

    // Deleted while the preview was open: it stays deleted.
    await db.measurements.put(row);
    const p2 = await plan();
    await deleteMeasurement(row);
    expect(await applyHealthImport(p2)).toEqual({ added: 0, updated: 0 });
    expect(await db.measurements.count()).toBe(0);

    // A new weigh-in the automatic sync brought in and the user deleted while the preview was open: stays deleted.
    await db.settings.clear();
    const p3 = await plan();
    expect(p3.add.map((m) => m.id)).toEqual(['hk_' + T702]);
    await applyHealthImport(p3);
    await deleteMeasurement((await db.measurements.get('hk_' + T702))!);
    expect(await applyHealthImport(p3)).toEqual({ added: 0, updated: 0 });
    expect(await db.measurements.count()).toBe(0);
  });

  it('a paste preview applied after the automatic sync saved the same weigh-in neither counts it nor clears it', async () => {
    const p = planHealthImport(parse(weighIn('Oct 5, 2026 at 7:02 AM', 184.2)).samples, [], await getSettings());
    expect(p.add.map((m) => [m.id, m.bodyFatPct])).toEqual([['hk_' + T702, null]]);
    // While the preview is open, the automatic sync saves the weigh-in with its body fat.
    await importText(TEMPLATE);
    await updateSettings({ healthImportedAt: 1 });
    const settingsBefore = await db.settings.get('settings');
    expect(await applyHealthImport(p)).toEqual({ added: 0, updated: 0 });
    expect(await db.measurements.get('hk_' + T702)).toMatchObject({ bodyFatPct: 18.5, source: 'health' });
    expect(await db.measurements.count()).toBe(1);
    expect(await db.settings.get('settings')).toEqual(settingsBefore);

    // A stale preview that brings something new fills it in (an update, never an add).
    await db.measurements.update('hk_' + T702, { bodyFatPct: null });
    const withFat = planHealthImport(parse(TEMPLATE).samples, [], await getSettings());
    expect(await applyHealthImport(withFat)).toEqual({ added: 0, updated: 1 });
    expect((await db.measurements.get('hk_' + T702))?.bodyFatPct).toBe(18.5);
    expect(await db.measurements.count()).toBe(1);
  });
});

describe('deleteMeasurement', () => {
  beforeEach(async () => {
    await Promise.all([db.measurements.clear(), db.settings.clear(), db.media.clear()]);
  });

  it('removes the row and its photos and remembers an Apple Health sample; a later import skips it', async () => {
    await importText(TEMPLATE);
    await db.media.put({ id: 'p1', blob: new Blob(['x']), type: 'image/jpeg', createdAt: 0 });
    await db.measurements.update('hk_' + T702, { photoIds: ['p1'] });
    await deleteMeasurement((await db.measurements.get('hk_' + T702))!);
    expect(await db.measurements.count()).toBe(0);
    expect(await db.media.count()).toBe(0);
    expect((await getSettings()).healthDeleted).toEqual([T702]);
    expect((await importText(TEMPLATE)).skipped).toEqual([{ reason: 'deleted', at: T702 }]);
    expect(await db.measurements.count()).toBe(0);
  });

  it('a row typed in Heft leaves no tombstone', async () => {
    await db.measurements.put({ id: 'm1', date: T702, bodyweightKg: 84, photoIds: [] });
    await deleteMeasurement((await db.measurements.get('m1'))!);
    expect(await db.measurements.count()).toBe(0);
    expect((await getSettings()).healthDeleted).toEqual([]);
    expect((await importText(TEMPLATE)).add.map((m) => m.id)).toEqual(['hk_' + T702]);
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

  it('keeps source / healthAt on rows and the deleted weigh-ins', async () => {
    await importText(weighIn('Oct 4, 2026 at 7:00 AM', 185, 18.9));
    await importText(TEMPLATE);
    await deleteMeasurement((await db.measurements.get('hk_' + at(7, 0, 4)))!);
    const before = await db.measurements.toArray();
    const settingsBefore = await getSettings();
    const text = await (await exportBackup()).text();
    await db.transaction('rw', db.tables, async () => {
      await Promise.all(db.tables.map((t) => t.clear()));
    });
    await importBackup(text);
    expect(await db.measurements.toArray()).toEqual(before);
    expect(await db.measurements.get('hk_' + T702)).toMatchObject({ source: 'health', healthAt: T702 });
    const s = await getSettings();
    expect(s.healthImportedThrough).toBe(T702);
    expect(s.healthImportedAt).toBe(settingsBefore.healthImportedAt);
    expect(s.healthDeleted).toEqual([at(7, 0, 4)]);
    // The restored tombstone still keeps the deleted weigh-in out.
    expect((await importText(weighIn('Oct 4, 2026 at 7:00 AM', 185, 18.9))).skipped).toEqual([{ reason: 'deleted', at: at(7, 0, 4) }]);
  });
});
