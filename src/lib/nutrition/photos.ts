import { db } from '../../db';
import { uid } from '../ids';
import { fitsClaudeImageLimit } from './images';
import { updateMeal } from './store';

/*
 * Meal photos in db.media. Unlike lib/media.saveImageFile (which keeps an undecodable original as a
 * fallback), a meal photo is ALWAYS a JPEG this browser decoded and re-encoded — so nothing Anthropic can't
 * read is ever stored or sent.
 */

/**
 * Long edge of a saved meal photo. claude-opus-5-5 reads images up to 2576 px on the long edge (high-res
 * vision, about w×h/750 tokens, at most ~4,800 per image), so pixels above 1568 are NOT free any more, but
 * they are used: 2048 keeps a coin or a fork legible for the prompt's scale procedure in a whole-plate shot,
 * at ~1.7× the image tokens of 1568 (2048×1536 ≈ 4,200 tokens ≈ $0.017 an image at $4/MTok, vs ≈ 2,460).
 */
export const MEAL_PHOTO_MAX_DIM = 2048;
export const MEAL_PHOTO_QUALITY = 0.85;
/**
 * Encodes to try in order until one fits Claude's 5 MB-of-base64 limit (images.ts). Measured 2026-10-03 with
 * libjpeg at q85: a 2048×1536 photo with heavy sensor noise is ~1.3 MB (1.8 MB as base64), so the first rung
 * is what every real photo gets; only a pathological frame (pure RGB noise, 4:4:4 chroma: 5.0 MB → 6.6 MB
 * base64) steps down, and 1568 px fits even that.
 */
const SAVE_LADDER: readonly (readonly [maxDim: number, quality: number])[] = [
  [MEAL_PHOTO_MAX_DIM, MEAL_PHOTO_QUALITY],
  [1568, MEAL_PHOTO_QUALITY],
  [1568, 0.7],
  [1024, 0.7],
];
/** After analysis only one small photo is kept (it goes into the JSON backup). */
export const KEPT_PHOTO_MAX_DIM = 640;
export const KEPT_PHOTO_QUALITY = 0.8;

const UNREADABLE = "Can't read this photo. Use the camera, or pick a JPEG or PNG.";
const TOO_LARGE = 'This photo is too large to send to Claude. Retake it with the camera.';

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
 * Save a meal photo to db.media as a JPEG at most MEAL_PHOTO_MAX_DIM (2048) px on the long edge, small
 * enough for Claude's 5 MB limit (SAVE_LADDER). Unlike lib/media.saveImageFile it NEVER stores an undecodable
 * original: it throws PhotoError instead, so nothing Anthropic can't read is ever sent.
 */
export async function saveMealPhoto(file: Blob): Promise<string> {
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    throw new PhotoError(UNREADABLE);
  }
  let enc: Encoded | null = null;
  try {
    for (const [maxDim, quality] of SAVE_LADDER) {
      enc = await encodeJpeg(bmp, maxDim, quality);
      if (fitsClaudeImageLimit(enc.blob.size)) break;
    }
  } catch {
    throw new PhotoError(UNREADABLE);
  } finally {
    bmp.close?.();
  }
  if (!enc || !fitsClaudeImageLimit(enc.blob.size)) throw new PhotoError(TOO_LARGE);
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
