import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../db';
import { base64Length, blobToBase64, fitsClaudeImageLimit, ImageLoadError, loadImagesForAi, MAX_IMAGE_BASE64_BYTES } from './images';

const put = (id: string, bytes: Uint8Array | string, type: string) =>
  db.media.add({ id, blob: new Blob([bytes as BlobPart], { type }), type, createdAt: 1 });

beforeEach(async () => {
  await db.media.clear();
});

describe('loadImagesForAi', () => {
  it('base64 without a data: prefix, in photo order, max 4, missing rows skipped', async () => {
    await put('m1', 'one', 'image/jpeg');
    await put('m2', 'two', 'image/png');
    await put('m3', 'three', 'image/webp');
    await put('m4', 'four', 'image/gif');
    await put('m5', 'five', 'image/jpeg');
    const imgs = await loadImagesForAi(['m2', 'gone', 'm1', 'm3', 'm4', 'm5']);
    expect(imgs).toEqual([
      { data: btoa('two'), mediaType: 'image/png' },
      { data: btoa('one'), mediaType: 'image/jpeg' },
      { data: btoa('three'), mediaType: 'image/webp' },
      { data: btoa('four'), mediaType: 'image/gif' },
    ]);
    expect(imgs[0].data.startsWith('data:')).toBe(false);
    expect(await loadImagesForAi([])).toEqual([]);
  });

  it('normalizes image/jpg and rejects formats Claude cannot read', async () => {
    await put('j', 'x', 'image/jpg');
    expect((await loadImagesForAi(['j']))[0].mediaType).toBe('image/jpeg');
    await put('h', 'x', 'image/heic');
    await expect(loadImagesForAi(['h'])).rejects.toBeInstanceOf(ImageLoadError);
    await expect(loadImagesForAi(['h'])).rejects.toThrow(/format Claude can't read \(image\/heic\)/);
  });

  it('rejects an image whose base64 exceeds 5 MB', async () => {
    const raw = Math.ceil((MAX_IMAGE_BASE64_BYTES * 3) / 4) + 3; // base64 grows by 4/3
    await put('big', new Uint8Array(raw), 'image/jpeg');
    await expect(loadImagesForAi(['big'])).rejects.toThrow(/larger than the 5 MB/);
  });

  it('fitsClaudeImageLimit (used by photos.ts before saving) matches the guard here, to the byte', async () => {
    const maxRaw = (MAX_IMAGE_BASE64_BYTES / 4) * 3; // 3,932,160 bytes
    expect(base64Length(maxRaw)).toBe(MAX_IMAGE_BASE64_BYTES);
    expect(base64Length(1)).toBe(4);
    expect(fitsClaudeImageLimit(maxRaw)).toBe(true);
    expect(fitsClaudeImageLimit(maxRaw + 1)).toBe(false);
    await put('edge', new Uint8Array(maxRaw), 'image/jpeg');
    expect((await loadImagesForAi(['edge']))[0].data).toHaveLength(MAX_IMAGE_BASE64_BYTES);
    await put('over', new Uint8Array(maxRaw + 1), 'image/jpeg');
    await expect(loadImagesForAi(['over'])).rejects.toThrow(/larger than the 5 MB/);
    // 2048×1536 at q 0.85 (libjpeg, measured 2026-10-03): 1.34 MB with heavy sensor noise, 2.38 MB for pure
    // noise with 4:2:0 chroma, so a 2048 px meal photo is far inside the limit
    for (const bytes of [1_340_000, 2_380_000]) expect(fitsClaudeImageLimit(bytes)).toBe(true);
  });

  it('blobToBase64 handles large binary blobs (chunked)', async () => {
    const bytes = new Uint8Array(200_000).map((_, i) => i % 256);
    const b64 = await blobToBase64(new Blob([bytes]));
    expect(Buffer.from(b64, 'base64').equals(Buffer.from(bytes))).toBe(true);
  });
});
