import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db';
import type { Measurement } from '../types';
import { deleteMeasurement, editedMeasurement, healthSampleAt } from './measurements';

const T702 = new Date(2026, 9, 5, 7, 2).getTime();

describe('deleteMeasurement', () => {
  beforeEach(async () => {
    await Promise.all([db.measurements.clear(), db.settings.clear(), db.media.clear()]);
  });

  it('removes the row and its photos, and leaves other rows alone', async () => {
    await db.media.put({ id: 'p1', blob: new Blob(['x']), type: 'image/jpeg', createdAt: 0 });
    await db.measurements.bulkPut([
      { id: 'm1', date: T702, bodyweightKg: 84, photoIds: ['p1'] },
      { id: 'm2', date: T702 + 1, bodyweightKg: 83, photoIds: [] },
    ]);
    await deleteMeasurement((await db.measurements.get('m1'))!);
    expect((await db.measurements.toArray()).map((m) => m.id)).toEqual(['m2']);
    expect(await db.media.count()).toBe(0);
  });

  it('an old Apple Health row deletes like any other (no tombstone in Settings)', async () => {
    await db.measurements.put({ id: 'hk_' + T702, date: T702, bodyweightKg: 84, photoIds: [], source: 'health', healthAt: T702 });
    await deleteMeasurement((await db.measurements.get('hk_' + T702))!);
    expect(await db.measurements.count()).toBe(0);
    expect(await db.settings.count()).toBe(0);
  });
});

describe('healthSampleAt', () => {
  it('reads healthAt, else the hk_ id, else null', () => {
    expect(healthSampleAt({ id: 'x', healthAt: T702, source: 'manual' })).toBe(T702);
    expect(healthSampleAt({ id: 'hk_' + T702 + '_2' })).toBe(T702);
    expect(healthSampleAt({ id: 'm1' })).toBeNull();
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
