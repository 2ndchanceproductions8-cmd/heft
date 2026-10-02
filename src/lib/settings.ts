import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import type { Measurement, Settings } from '../types';

export const DEFAULT_SETTINGS: Settings = {
  id: 'settings',
  unit: 'lb',
  distanceUnit: 'mi',
  bodyweightKg: null,
  bodyweightUpdatedAt: null,
  heightCm: null,
  sex: null,
  birthYear: null,
  defaultRestSec: 90,
  restTimerSound: true,
  restTimerVibrate: true,
  keepAwake: true,
  theme: 'dark',
  weekStartsOn: 0,
  previousValues: 'any',
  showRpe: false,
  barKg: 20.411656, // 45 lb
};

/** Current settings (defaults until the DB answers — never undefined). */
export function useSettings(): Settings {
  const s = useLiveQuery(() => db.settings.get('settings'), []);
  return s ? { ...DEFAULT_SETTINGS, ...s } : DEFAULT_SETTINGS;
}

export async function getSettings(): Promise<Settings> {
  const s = await db.settings.get('settings');
  return s ? { ...DEFAULT_SETTINGS, ...s } : DEFAULT_SETTINGS;
}

/**
 * Merge a patch into the settings row.
 *
 * `bodyweightKg` is the user's MANUAL profile value, stamped with `bodyweightUpdatedAt` so it can be
 * compared with dated weigh-ins (see `currentBodyweightKg`). A patch that sets `bodyweightKg` without its
 * own `bodyweightUpdatedAt` is treated as a manual edit and stamped now — except when it merely copies the
 * newest weigh-in's value into the profile: that copy is ignored, because `currentBodyweightKg` already
 * reads weigh-ins directly, and letting it through would let a back-dated weigh-in overwrite a newer
 * profile weight.
 */
export async function updateSettings(patch: Partial<Omit<Settings, 'id'>>): Promise<void> {
  await db.transaction('rw', db.settings, db.measurements, async () => {
    const cur = await getSettings();
    const next: Settings = { ...cur, ...patch, id: 'settings' };
    if ('bodyweightKg' in patch && !('bodyweightUpdatedAt' in patch)) {
      const latest = await newestWeighIn();
      const kg = patch.bodyweightKg;
      const copiesWeighIn = kg != null && latest?.bodyweightKg != null && Math.abs(latest.bodyweightKg - kg) < 1e-6;
      if (copiesWeighIn) {
        next.bodyweightKg = cur.bodyweightKg;
        next.bodyweightUpdatedAt = cur.bodyweightUpdatedAt ?? null;
      } else {
        next.bodyweightUpdatedAt = Date.now();
      }
    }
    await db.settings.put(next);
  });
}

/** The newest measurement that has a body weight. */
export function newestWeighIn(): Promise<Measurement | undefined> {
  return db.measurements
    .orderBy('date')
    .reverse()
    .filter((m) => !!m.bodyweightKg)
    .first();
}

/**
 * Pick the body weight for calories from the profile and the newest weigh-in: whichever was set more
 * recently (a weigh-in wins ties and older settings without a timestamp, as before timestamps existed).
 */
export function pickBodyweightKg(
  settings: Pick<Settings, 'bodyweightKg' | 'bodyweightUpdatedAt'>,
  latest: Pick<Measurement, 'date' | 'bodyweightKg'> | null | undefined,
): number | null {
  if (latest?.bodyweightKg && (settings.bodyweightKg == null || latest.date >= (settings.bodyweightUpdatedAt ?? 0))) {
    return latest.bodyweightKg;
  }
  return settings.bodyweightKg ?? latest?.bodyweightKg ?? null;
}

/** Body weight to use for calories: the profile value or the newest weigh-in, whichever is newer. */
export async function currentBodyweightKg(): Promise<number | null> {
  const [settings, latest] = await Promise.all([getSettings(), newestWeighIn()]);
  return pickBodyweightKg(settings, latest);
}

export function useBodyweightKg(): number | null {
  const v = useLiveQuery(() => currentBodyweightKg(), []);
  return v ?? null;
}
