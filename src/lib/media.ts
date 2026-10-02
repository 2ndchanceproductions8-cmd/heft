import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import type { Exercise } from '../types';
import { uid } from './ids';

/**
 * Store a user photo (camera or library). Downscales to `maxDim` and re-encodes as JPEG so a 12MP phone
 * photo becomes ~150KB in IndexedDB. Returns the media id.
 */
export async function saveImageFile(file: Blob, maxDim = 1280): Promise<string> {
  let blob: Blob = file;
  let width: number | undefined;
  let height: number | undefined;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
    width = Math.round(bmp.width * scale);
    height = Math.round(bmp.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d')!.drawImage(bmp, 0, 0, width, height);
    bmp.close?.();
    blob = await new Promise<Blob>((res, rej) =>
      canvas.toBlob((b) => (b ? res(b) : rej(new Error('encode failed'))), 'image/jpeg', 0.82),
    );
  } catch {
    // Fall back to storing the original file (e.g. HEIC on a browser that can't decode it).
  }
  const id = 'm_' + uid();
  await db.media.add({ id, blob, type: blob.type || 'image/jpeg', createdAt: Date.now(), width, height });
  return id;
}

export async function deleteMedia(ids: string[]): Promise<void> {
  if (ids.length) await db.media.bulkDelete(ids);
}

/** Object URL for a stored photo (revoked automatically). */
export function useMediaUrl(id: string | null | undefined): string | null {
  const media = useLiveQuery(() => (id ? db.media.get(id) : undefined), [id]);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!media) {
      setUrl(null);
      return;
    }
    const u = URL.createObjectURL(media.blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [media]);
  return url;
}

/** Object URLs for several stored photos, in order (missing ids are skipped). */
export function useMediaUrls(ids: string[] | null | undefined): string[] {
  const key = (ids ?? []).join(',');
  const items = useLiveQuery(() => (ids?.length ? db.media.bulkGet(ids) : []), [key]);
  const [urls, setUrls] = useState<string[]>([]);
  useEffect(() => {
    const list = (items ?? []).filter(Boolean).map((m) => URL.createObjectURL(m!.blob));
    setUrls(list);
    return () => list.forEach((u) => URL.revokeObjectURL(u));
  }, [items]);
  return urls;
}

/** The pictures to show for an exercise: the user's own photos if any, otherwise the catalog frames. */
export function useExerciseImages(ex: Exercise | null | undefined): string[] {
  const photos = useMediaUrls(ex?.photoIds);
  if (!ex) return [];
  return ex.photoIds.length ? photos : ex.images;
}
