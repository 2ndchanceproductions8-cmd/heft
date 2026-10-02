import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db';
import { currentBodyweightKg, getSettings, pickBodyweightKg, updateSettings } from './settings';

const DAY = 86_400_000;

describe('body weight for calories: profile vs weigh-ins, newest wins', () => {
  beforeEach(async () => {
    await Promise.all([db.settings.clear(), db.measurements.clear()]);
  });

  it('keeps a newer profile weight over a back-dated weigh-in', async () => {
    await updateSettings({ bodyweightKg: 80 }); // manual profile edit, stamped now
    const t = (await getSettings()).bodyweightUpdatedAt!;
    expect(t).toBeGreaterThan(0);
    await db.measurements.add({ id: 'old', date: t - 90 * DAY, bodyweightKg: 90, photoIds: [] });
    expect(await currentBodyweightKg()).toBe(80);

    // The measurement sheet copying that weigh-in into the profile must not overwrite the newer value.
    await updateSettings({ bodyweightKg: 90 });
    const s = await getSettings();
    expect(s.bodyweightKg).toBe(80);
    expect(s.bodyweightUpdatedAt).toBe(t);
    expect(await currentBodyweightKg()).toBe(80);

    // A weigh-in dated after the profile edit wins.
    await db.measurements.add({ id: 'new', date: t + DAY, bodyweightKg: 78, photoIds: [] });
    expect(await currentBodyweightKg()).toBe(78);
    // ...and deleting it falls back to the profile again (not to a copied value).
    await db.measurements.delete('new');
    expect(await currentBodyweightKg()).toBe(80);
  });

  it('lets the newest weigh-in win for settings saved before timestamps existed', async () => {
    await db.settings.put({ ...(await getSettings()), bodyweightKg: 85, bodyweightUpdatedAt: undefined });
    await db.measurements.add({ id: 'm', date: 1, bodyweightKg: 82, photoIds: [] });
    expect(await currentBodyweightKg()).toBe(82);
  });

  it('a manual edit equal to the newest weigh-in is harmless, a different value is stamped', async () => {
    await db.measurements.add({ id: 'm', date: Date.now() - DAY, bodyweightKg: 82, photoIds: [] });
    await updateSettings({ bodyweightKg: 82 });
    expect(await currentBodyweightKg()).toBe(82);
    await updateSettings({ bodyweightKg: 84 });
    expect((await getSettings()).bodyweightKg).toBe(84);
    expect(await currentBodyweightKg()).toBe(84);
  });

  it('an explicit timestamp is kept as given', async () => {
    await db.measurements.add({ id: 'm', date: 5_000, bodyweightKg: 82, photoIds: [] });
    await updateSettings({ bodyweightKg: 82, bodyweightUpdatedAt: 10_000 });
    const s = await getSettings();
    expect(s.bodyweightKg).toBe(82);
    expect(s.bodyweightUpdatedAt).toBe(10_000);
  });

  it('pickBodyweightKg falls back to whichever source exists', () => {
    expect(pickBodyweightKg({ bodyweightKg: null, bodyweightUpdatedAt: null }, null)).toBeNull();
    expect(pickBodyweightKg({ bodyweightKg: 80, bodyweightUpdatedAt: 5 }, null)).toBe(80);
    expect(pickBodyweightKg({ bodyweightKg: null, bodyweightUpdatedAt: null }, { date: 1, bodyweightKg: 90 })).toBe(90);
    expect(pickBodyweightKg({ bodyweightKg: 80, bodyweightUpdatedAt: 5 }, { date: 5, bodyweightKg: 90 })).toBe(90);
    expect(pickBodyweightKg({ bodyweightKg: 80, bodyweightUpdatedAt: 6 }, { date: 5, bodyweightKg: 90 })).toBe(80);
  });
});
