import { db } from '../../db';
import { uid } from '../ids';
import { updateMeal } from './store';

/*
 * Meal photos in db.media. Unlike lib/media.saveImageFile (which keeps an undecodable original as a
 * fallback), a meal photo is ALWAYS a JPEG this browser decoded and re-encoded — so nothing Anthropic can't
 * read is ever stored or sent.
 */

/** Claude's sweet spot: larger images are downscaled server-side anyway (and cost the same tokens). */
export const MEAL_PHOTO_MAX_DIM = 1568;
export const MEAL_PHOTO_QUALITY = 0.85;
/** After analysis only one small photo is kept (it goes into the JSON backup). */
export const KEPT_PHOTO_MAX_DIM = 640;
export const KEPT_PHOTO_QUALITY = 0.8;

const UNREADABLE = "Can't read this photo. Use the camera, or pick a JPEG or PNG.";

/** Thrown when a picked file can't be decoded as an image (e.g. HEIC on a browser that can't read it). */
export class PhotoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PhotoError';
  }
}

interface Encoded {
  blob: Blob;
  width: number;
  height: number;
}

/** Draw `bmp` at most `maxDim` px on the long edge and encode it as JPEG. Throws when encoding fails. */
async function encodeJpeg(bmp: ImageBitmap, maxDim: number, quality: number): Promise<Encoded> {
  const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
  const width = Math.max(1, Math.round(bmp.width * scale));
  const height = Math.max(1, Math.round(bmp.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d canvas');
  ctx.drawImage(bmp, 0, 0, width, height);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b && b.size > 0 ? resolve(b) : reject(new Error('encode failed'))), 'image/jpeg', quality),
  );
  return { blob, width, height };
}

/**
 * Save a meal photo to db.media as a JPEG at most 1568 px on the long edge (Claude's sweet spot). Unlike
 * lib/media.saveImageFile it NEVER stores an undecodable original: it throws PhotoError instead, so nothing
 * Anthropic can't read is ever sent.
 */
export async function saveMealPhoto(file: Blob): Promise<string> {
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    throw new PhotoError(UNREADABLE);
  }
  let enc: Encoded;
  try {
    enc = await encodeJpeg(bmp, MEAL_PHOTO_MAX_DIM, MEAL_PHOTO_QUALITY);
  } catch {
    throw new PhotoError(UNREADABLE);
  } finally {
    bmp.close?.();
  }
  const id = 'm_' + uid();
  await db.media.add({ id, blob: enc.blob, type: 'image/jpeg', createdAt: Date.now(), width: enc.width, height: enc.height });
  return id;
}

/**
 * After a successful analysis: keep ONLY the first photo, re-encoded at ≤ 640 px (JPEG 0.8, same id, blob
 * replaced), and delete the rest — the meal keeps a thumbnail while JSON backups stay small. Returns the
 * photo ids the meal should now reference. If the photo can't be decoded or re-encoded, nothing is touched
 * and the original ids are returned.
 */
export async function shrinkMealPhotos(photoIds: string[]): Promise<string[]> {
  if (!photoIds.length) return [];
  const rows = await db.media.bulkGet(photoIds);
  const firstIdx = rows.findIndex(Boolean);
  if (firstIdx < 0) return []; // every referenced photo is already gone
  const first = rows[firstIdx]!;
  const rest = photoIds.filter((_id, i) => i !== firstIdx && rows[i]);

  let replacement: Encoded | null = null;
  const alreadySmall =
    first.type === 'image/jpeg' && first.width != null && first.height != null && Math.max(first.width, first.height) <= KEPT_PHOTO_MAX_DIM;
  if (!alreadySmall) {
    let bmp: ImageBitmap | null = null;
    try {
      bmp = await createImageBitmap(first.blob);
      replacement = await encodeJpeg(bmp, KEPT_PHOTO_MAX_DIM, KEPT_PHOTO_QUALITY);
    } catch {
      return photoIds; // leave everything as it was
    } finally {
      bmp?.close?.();
    }
  }

  await db.transaction('rw', db.media, async () => {
    if (replacement) {
      await db.media.update(first.id, {
        blob: replacement.blob,
        type: 'image/jpeg',
        width: replacement.width,
        height: replacement.height,
      });
    }
    if (rest.length) await db.media.bulkDelete(rest);
  });
  return [first.id];
}

/**
 * Best effort, never throws: once a meal is final ('done'), keep just one small photo (shrinkMealPhotos) and
 * point the meal at it. Call after EVERY transition of a photo meal to 'done' — analysis, "Enter manually",
 * a draft folded into a search or barcode entry — so no path leaves full-size photos in every backup.
 * Idempotent: an already-shrunk single photo is left alone.
 */
export async function finishMealPhotos(mealId: string): Promise<void> {
  try {
    const m = await db.meals.get(mealId);
    if (!m || m.status !== 'done' || !m.photoIds.length) return;
    const kept = await shrinkMealPhotos(m.photoIds);
    const same = kept.length === m.photoIds.length && kept.every((id, i) => id === m.photoIds[i]);
    if (!same) await updateMeal(mealId, { photoIds: kept }, { force: true });
  } catch {
    /* keep the photos as they are */
  }
}
