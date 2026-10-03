import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../db';
import { blobToBase64, ImageLoadError, loadImagesForAi, MAX_IMAGE_BASE64_BYTES } from './images';

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

  it('blobToBase64 handles large binary blobs (chunked)', async () => {
    const bytes = new Uint8Array(200_000).map((_, i) => i % 256);
    const b64 = await blobToBase64(new Blob([bytes]));
    expect(Buffer.from(b64, 'base64').equals(Buffer.from(bytes))).toBe(true);
  });
});
