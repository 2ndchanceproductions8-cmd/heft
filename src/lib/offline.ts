import { CATALOG, assetUrl } from './exercises';

/** Must match the runtimeCaching cacheName in vite.config.ts so the service worker serves these. */
export const IMAGE_CACHE = 'exercise-images';

export function allExerciseImageUrls(): string[] {
  const urls = new Set<string>();
  for (const e of CATALOG) for (const p of e.images) urls.add(new URL(assetUrl(p), location.href).href);
  return [...urls];
}

export async function countCachedExerciseImages(): Promise<{ cached: number; total: number }> {
  const urls = allExerciseImageUrls();
  if (!('caches' in window)) return { cached: 0, total: urls.length };
  const cache = await caches.open(IMAGE_CACHE);
  const keys = new Set((await cache.keys()).map((r) => r.url));
  return { cached: urls.filter((u) => keys.has(u)).length, total: urls.length };
}

/**
 * Download every exercise image into the offline cache (≈34 MB) so the whole library works with no
 * signal at the gym. Skips images already cached. Safe to call repeatedly.
 */
export async function precacheExerciseImages(
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<{ done: number; failed: number; total: number }> {
  if (!('caches' in window)) throw new Error('This browser does not support offline caching');
  const cache = await caches.open(IMAGE_CACHE);
  const have = new Set((await cache.keys()).map((r) => r.url));
  const urls = allExerciseImageUrls();
  const todo = urls.filter((u) => !have.has(u));
  let done = urls.length - todo.length;
  let failed = 0;
  onProgress?.(done, urls.length);
  let i = 0;
  const worker = async () => {
    while (i < todo.length) {
      if (signal?.aborted) return;
      const url = todo[i++];
      try {
        const res = await fetch(url, { signal });
        if (res.ok) await cache.put(url, res);
        else failed++;
      } catch {
        if (signal?.aborted) return;
        failed++;
      }
      done++;
      onProgress?.(done, urls.length);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return { done, failed, total: urls.length };
}
