import type { FoodChoice } from './types';

// CONTRACT STUB (foundation). The engine builder replaces the body; the signature is fixed.

export type OffStatus = 'ok' | 'not_found' | 'unavailable';

/** Open Food Facts product lookup. `not_found` = OFF answered "no such product"; `unavailable` = network/HTTP failure. */
export async function lookupBarcode(_code: string, _signal?: AbortSignal): Promise<{ status: OffStatus; food: FoodChoice | null }> {
  throw new Error('not implemented: off.lookupBarcode');
}
