import { db } from '../db';
import type { Measurement } from '../types';

/*
 * Saving and deleting a measurement (Measurements' sheet, Today's weigh-ins sheet). Weigh-ins are typed in; rows
 * imported from Apple Health before the Hume sync was removed (2026-10-10, source 'health', id "hk_<ms>") stay as
 * they are and behave like any other row.
 */

/**
 * A user's save of a measurement. Starts from the stored row so fields the form doesn't show (source, healthAt,
 * anything newer) survive; an EDITED imported row becomes the user's own ('manual').
 */
export function editedMeasurement(
  entry: Measurement | null,
  changes: Pick<Measurement, 'id' | 'date' | 'photoIds'> & Partial<Measurement>,
  edited = true,
): Measurement {
  const rec: Measurement = { ...(entry ?? {}), ...changes };
  if (edited && entry?.source === 'health') rec.source = 'manual';
  return rec;
}

/** The Apple Health sample an old imported row came from (also once edited), else null. */
export function healthSampleAt(m: Pick<Measurement, 'id' | 'healthAt' | 'source'>): number | null {
  if (m.healthAt != null && Number.isFinite(m.healthAt)) return m.healthAt;
  // "hk_<ms>", or "hk_<ms>_2" when two weigh-ins shared a millisecond.
  const fromId = /^hk_(\d+)(?:_\d+)?$/.exec(m.id);
  return fromId ? Number(fromId[1]) : null;
}

/** THE way to delete a measurement: the row and its photos, in one transaction. */
export async function deleteMeasurement(entry: Pick<Measurement, 'id' | 'photoIds'>): Promise<void> {
  await db.transaction('rw', db.measurements, db.media, async () => {
    await db.measurements.delete(entry.id);
    if (entry.photoIds?.length) await db.media.bulkDelete(entry.photoIds);
  });
}
