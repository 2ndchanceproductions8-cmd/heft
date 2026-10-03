import { useLiveQuery } from 'dexie-react-hooks';
import { toast } from '../../../components/ui';
import { newestWeighIn } from '../../../lib/settings';
import { getNutritionProfile, loadTargets, updateNutritionProfile, type TargetsState } from '../../../lib/nutrition/store';
import type { NutritionProfile } from '../../../lib/nutrition/types';
import type { Measurement, Settings } from '../../../types';

export interface FoodSettingsData extends TargetsState {
  /** Newest weigh-in with a body weight (null = none). */
  latest: Measurement | null;
}

/**
 * Everything Food settings shows, in ONE live read (Heft settings, newest weigh-in, nutrition profile and the
 * targets computed from them), so the body rows and the targets card can never disagree. undefined = loading.
 */
export function useFoodSettingsData(): FoodSettingsData | undefined {
  return useLiveQuery(async () => {
    const [ts, latest] = await Promise.all([loadTargets(), newestWeighIn()]);
    return { ...ts, latest: latest ?? null };
  }, []);
}

/**
 * Where the body weight in use comes from, mirroring lib/settings.ts pickBodyweightKg: the newest weigh-in
 * when it is at least as new as the hand-typed profile value (or there is no profile value).
 */
export function bodyweightSource(
  s: Pick<Settings, 'bodyweightKg' | 'bodyweightUpdatedAt'>,
  latest: Pick<Measurement, 'date' | 'bodyweightKg'> | null,
): 'weighin' | 'profile' | 'none' {
  if (latest?.bodyweightKg && (s.bodyweightKg == null || latest.date >= (s.bodyweightUpdatedAt ?? 0))) return 'weighin';
  if (s.bodyweightKg != null) return 'profile';
  return latest?.bodyweightKg ? 'weighin' : 'none';
}

/** Write the nutrition profile; the first save also stamps setupDoneAt (targets confirmed). */
export async function saveProfile(patch: Partial<Omit<NutritionProfile, 'id' | 'setupDoneAt'>>): Promise<void> {
  const cur = await getNutritionProfile();
  await updateNutritionProfile({ ...patch, setupDoneAt: cur.setupDoneAt ?? Date.now() });
}

/** Error toast for a failed settings write. */
export function saveFailed(e: unknown): void {
  toast(`Couldn't save: ${(e as Error)?.message || 'unknown error'}`, 'error');
}
