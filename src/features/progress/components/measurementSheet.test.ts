// What the measurement sheet's Save writes (measurementFromForm), without a DOM: which edits make an Apple Health row
// the user's own, and that Save builds on the row as stored at save time, not the snapshot the sheet opened with.
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import type { Measurement } from '../../../types';
import * as settings from '../../../lib/settings';
import { initialValues, measurementFromForm, newestWeighIn, type MeasurementForm } from './MeasurementSheet';

const T702 = new Date(2026, 9, 5, 7, 2).getTime();
const T705 = new Date(2026, 9, 5, 7, 5).getTime();

const imported: Measurement = {
  id: 'hk_' + T702,
  date: T702,
  bodyweightKg: 83.55,
  bodyFatPct: 18.5,
  photoIds: [],
  source: 'health',
  healthAt: T702,
};

/** The form for `entry` as it opened, with `edit` applied on top. */
function form(entry: Measurement, edit: Partial<MeasurementForm> = {}): MeasurementForm {
  const initial = initialValues(entry, 'kg');
  return {
    initial,
    values: initial,
    parsed: {},
    dateStr: '2026-10-05',
    date: entry.date,
    notes: entry.notes ?? '',
    photoIds: entry.photoIds,
    ...edit,
  };
}

describe('measurementFromForm (MeasurementSheet save)', () => {
  it('a note, a photo or a tape measure keeps an imported row imported, with its values exactly', () => {
    const noted = measurementFromForm(imported, imported, form(imported, { notes: 'fasted' }), 'kg');
    expect(noted).toMatchObject({ source: 'health', healthAt: T702, bodyweightKg: 83.55, bodyFatPct: 18.5, notes: 'fasted', date: T702 });

    const photo = measurementFromForm(imported, imported, form(imported, { photoIds: ['p1'] }), 'kg');
    expect(photo).toMatchObject({ source: 'health', photoIds: ['p1'], bodyweightKg: 83.55 });

    const f = form(imported);
    const taped = measurementFromForm(imported, imported, { ...f, values: { ...f.initial, waistCm: '84' }, parsed: { waistCm: 84 } }, 'kg');
    expect(taped).toMatchObject({ source: 'health', waistCm: 84, bodyweightKg: 83.55 });
  });

  it('changing the weight, the body fat or the day makes it the user’s own', () => {
    const f = form(imported);
    const weight = measurementFromForm(imported, imported, { ...f, values: { ...f.initial, weight: '83' }, parsed: { weight: 83 } }, 'kg');
    expect(weight).toMatchObject({ source: 'manual', bodyweightKg: 83, healthAt: T702 });

    const fat = measurementFromForm(imported, imported, { ...f, values: { ...f.initial, bodyFat: '19' }, parsed: { bodyFat: 19 } }, 'kg');
    expect(fat).toMatchObject({ source: 'manual', bodyFatPct: 19 });

    const T_DAY_BEFORE = new Date(2026, 9, 4, 7, 2).getTime();
    const moved = measurementFromForm(imported, imported, { ...f, dateStr: '2026-10-04', date: T_DAY_BEFORE }, 'kg');
    expect(moved).toMatchObject({ source: 'manual', date: T_DAY_BEFORE });
  });

  it('builds on the stored row: a weight joined on while the sheet was open survives a note-only save', () => {
    // The sheet opened on a body-fat-only row; the automatic sync then joined the 7:05 weight onto it.
    const fatOnly: Measurement = { ...imported, bodyweightKg: null };
    const joined: Measurement = { ...fatOnly, date: T705, bodyweightKg: 84.1, healthAt: T705 };
    const saved = measurementFromForm(fatOnly, joined, form(fatOnly, { notes: 'after coffee' }), 'kg');
    const noTape = { waistCm: null, chestCm: null, armCm: null, thighCm: null, hipsCm: null, neckCm: null };
    expect(saved).toEqual({ ...joined, ...noTape, notes: 'after coffee' });
    expect(saved.source).toBe('health'); // not frozen: later weigh-ins still join and the day rule still applies
  });

  it('a new entry is the user’s own (no source) with what was typed', () => {
    const blank = initialValues(null, 'kg');
    const saved = measurementFromForm(
      null,
      null,
      { initial: blank, values: { ...blank, weight: '80' }, parsed: { weight: 80 }, dateStr: '2026-10-05', date: T702, notes: '', photoIds: [] },
      'kg',
    );
    expect(saved).toMatchObject({ date: T702, bodyweightKg: 80, bodyFatPct: null });
    expect(saved.source).toBeUndefined();
  });

  it('uses the one newest-weigh-in rule from lib/settings', () => {
    expect(newestWeighIn).toBe(settings.newestWeighIn);
  });
});
