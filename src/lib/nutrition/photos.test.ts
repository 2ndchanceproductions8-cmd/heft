import 'fake-indexeddb/auto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../db';
import { PhotoError, saveMealPhoto, shrinkMealPhotos } from './photos';

/*
 * Node has no canvas or image decoder, so createImageBitmap and document.createElement('canvas') are faked:
 * a "bitmap" carries the size encoded in the blob's text ("img 4032x3024"), and the fake canvas encodes
 * "jpeg <w>x<h> q<quality>" so the tests can see what was drawn and how.
 */

const g = globalThis as Record<string, unknown>;
const saved = { createImageBitmap: g.createImageBitmap, document: g.document };
let encodeFails = false;

g.createImageBitmap = async (b: Blob) => {
  const m = /(?:img|jpeg) (\d+)x(\d+)/.exec(await b.text());
  if (!m) throw new Error('InvalidStateError: cannot decode');
  return { width: Number(m[1]), height: Number(m[2]), close: () => undefined };
};
g.document = {
  createElement: () => ({
    width: 0,
    height: 0,
    getContext() {
      return { drawImage: () => undefined };
    },
    toBlob(this: { width: number; height: number }, cb: (b: Blob | null) => void, type: string, q: number) {
      cb(encodeFails ? null : new Blob([`jpeg ${this.width}x${this.height} q${q}`], { type }));
    },
  }),
};
afterAll(() => Object.assign(g, saved));

beforeEach(async () => {
  encodeFails = false;
  await db.media.clear();
});

describe('saveMealPhoto', () => {
  it('stores a JPEG at most 1568 px on the long edge (q 0.85)', async () => {
    const id = await saveMealPhoto(new Blob(['img 4032x3024'], { type: 'image/heic' }));
    expect(id).toMatch(/^m_/);
    const m = (await db.media.get(id))!;
    expect(m).toMatchObject({ type: 'image/jpeg', width: 1568, height: 1176 });
    expect(await m.blob.text()).toBe('jpeg 1568x1176 q0.85');
    expect(m.createdAt).toBeGreaterThan(0);
  });

  it('never upscales a small photo', async () => {
    const id = await saveMealPhoto(new Blob(['img 800x600'], { type: 'image/png' }));
    expect(await (await db.media.get(id))!.blob.text()).toBe('jpeg 800x600 q0.85');
  });

  it('throws PhotoError (and stores nothing) when the photo cannot be decoded or encoded', async () => {
    await expect(saveMealPhoto(new Blob(['garbage'], { type: 'image/heic' }))).rejects.toThrow(PhotoError);
    await expect(saveMealPhoto(new Blob(['garbage']))).rejects.toThrow("Can't read this photo. Use the camera, or pick a JPEG or PNG.");
    encodeFails = true;
    await expect(saveMealPhoto(new Blob(['img 100x100']))).rejects.toThrow(PhotoError);
    expect(await db.media.count()).toBe(0);
  });
});

describe('shrinkMealPhotos', () => {
  const add = (id: string, text: string, width?: number, height?: number) =>
    db.media.add({ id, blob: new Blob([text], { type: 'image/jpeg' }), type: 'image/jpeg', createdAt: 1, width, height });

  it('keeps only the first photo, re-encoded at ≤ 640 px (q 0.8, same id), and deletes the rest', async () => {
    await add('a', 'jpeg 1568x1176', 1568, 1176);
    await add('b', 'jpeg 1568x1176', 1568, 1176);
    await add('c', 'jpeg 1176x1568', 1176, 1568);
    expect(await shrinkMealPhotos(['a', 'b', 'c'])).toEqual(['a']);
    const a = (await db.media.get('a'))!;
    expect(a).toMatchObject({ width: 640, height: 480, type: 'image/jpeg' });
    expect(await a.blob.text()).toBe('jpeg 640x480 q0.8');
    expect(await db.media.bulkGet(['b', 'c'])).toEqual([undefined, undefined]);
  });

  it('a photo already ≤ 640 px is kept as is', async () => {
    await add('s', 'jpeg 640x480', 640, 480);
    await add('t', 'jpeg 640x480', 640, 480);
    expect(await shrinkMealPhotos(['s', 't'])).toEqual(['s']);
    expect(await (await db.media.get('s'))!.blob.text()).toBe('jpeg 640x480');
  });

  it('on a decode failure nothing is touched', async () => {
    await add('x', 'corrupt', 1568, 1176);
    await add('y', 'jpeg 1568x1176', 1568, 1176);
    expect(await shrinkMealPhotos(['x', 'y'])).toEqual(['x', 'y']);
    expect(await db.media.count()).toBe(2);
    expect(await (await db.media.get('x'))!.blob.text()).toBe('corrupt');
  });

  it('skips ids whose media is gone; no photos → []', async () => {
    await add('b', 'jpeg 1568x1176', 1568, 1176);
    expect(await shrinkMealPhotos(['gone', 'b'])).toEqual(['b']);
    expect(await shrinkMealPhotos([])).toEqual([]);
    expect(await shrinkMealPhotos(['nope'])).toEqual([]);
  });
});
