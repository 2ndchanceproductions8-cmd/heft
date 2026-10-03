import { db } from '../../db';
import type { AnalyzeImage } from './foodAi';

/*
 * Meal photos → the base64 image blocks Claude receives. Anthropic accepts JPEG / PNG / WebP / GIF up to 5 MB
 * each; meal photos are saved as ≤ 2048 px JPEGs that photos.ts has already checked against this same limit
 * (fitsClaudeImageLimit; a real 2048×1536 q0.85 photo is ~1-2 MB as base64), so in practice these checks only
 * catch media that came from elsewhere (an old backup, a hand-edited row).
 */

export const MAX_AI_IMAGES = 4;
/** Anthropic's per-image limit, measured on the base64 string. */
export const MAX_IMAGE_BASE64_BYTES = 5 * 1024 * 1024;

/** Length of the base64 encoding of `bytes` bytes (padded, as blobToBase64 produces). */
export function base64Length(bytes: number): number {
  return 4 * Math.ceil(bytes / 3);
}

/** A blob of this many bytes is within Claude's per-image limit once base64-encoded. */
export function fitsClaudeImageLimit(bytes: number): boolean {
  return base64Length(bytes) <= MAX_IMAGE_BASE64_BYTES;
}

const ALLOWED: ReadonlySet<string> = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

/** A photo that can't be sent to Claude; the message is written for the user. */
export class ImageLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageLoadError';
  }
}

/** base64 of a blob, no data: prefix (chunked so a large photo can't overflow String.fromCharCode). */
export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

function mediaTypeOf(type: string | undefined): string {
  const t = (type ?? '').toLowerCase().split(';')[0].trim();
  return t === 'image/jpg' ? 'image/jpeg' : t;
}

/**
 * Load up to 4 of a meal's photos (in order) for Claude. Missing media rows are skipped. Throws
 * ImageLoadError for a photo in a format Claude can't read or one over the 5 MB limit.
 */
export async function loadImagesForAi(photoIds: string[]): Promise<AnalyzeImage[]> {
  const rows = (await db.media.bulkGet(photoIds)).filter((m) => m != null);
  const out: AnalyzeImage[] = [];
  for (const m of rows.slice(0, MAX_AI_IMAGES)) {
    const mediaType = mediaTypeOf(m.type || m.blob.type);
    if (!ALLOWED.has(mediaType)) {
      throw new ImageLoadError(`One photo is in a format Claude can't read (${mediaType || 'unknown'}). Delete it and retake it with the camera.`);
    }
    const data = await blobToBase64(m.blob);
    if (data.length > MAX_IMAGE_BASE64_BYTES) {
      throw new ImageLoadError('One photo is larger than the 5 MB Claude accepts. Delete it and retake it with the camera.');
    }
    out.push({ data, mediaType: mediaType as AnalyzeImage['mediaType'] });
  }
  return out;
}
