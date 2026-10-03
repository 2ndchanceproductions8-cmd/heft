import type { FoodChoice, LookupStatus } from './types';

// CONTRACT STUB (foundation). The engine builder replaces the bodies; the exported names, parameter and
// return types below are fixed — other features compile against them.

export type UsdaStatus = 'ok' | 'rate_limited' | 'failed';

export interface UsdaSearchResult {
  status: UsdaStatus;
  foods: FoodChoice[];
  /** True when the request used USDA's shared DEMO_KEY (no personal key saved). */
  demoKey: boolean;
}

/** Ranked USDA FoodData Central search (GET only, no custom headers → no CORS preflight). */
export async function searchFoods(_query: string, _opts: { pageSize?: number; signal?: AbortSignal } = {}): Promise<UsdaSearchResult> {
  throw new Error('not implemented: usda.searchFoods');
}

/** Best single USDA match for Claude's fdc_query. */
export async function bestMatch(_query: string, _signal?: AbortSignal): Promise<{ status: LookupStatus; choice: FoodChoice | null; demoKey: boolean }> {
  throw new Error('not implemented: usda.bestMatch');
}
