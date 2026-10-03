/*
 * "Don't reload under me" registry. lib/pwa.tsx applies a waiting app update when the app goes to the
 * background on a tab page; anything that would be lost by that reload — an open bottom sheet with a form,
 * a Claude analysis in flight — marks itself busy here. Tiny and dependency-free on purpose: pwa.tsx is in
 * the main bundle and must not pull feature code in.
 */

const busy = new Set<string>();

export function markBusy(key: string): void {
  busy.add(key);
}

export function clearBusy(key: string): void {
  busy.delete(key);
}

export function isBusy(): boolean {
  return busy.size > 0;
}
