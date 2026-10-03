import 'fake-indexeddb/auto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../db';
import { runAnalysis } from './analyze';
import { MAX_IMAGE_BASE64_BYTES } from './images';
import { finishMealPhotos, MEAL_PHOTO_MAX_DIM, PhotoError, saveMealPhoto, shrinkMealPhotos } from './photos';
import { createMeal } from './store';

/*
 * Node has no canvas or image decoder, so createImageBitmap and document.createElement('canvas') are faked:
 * a "bitmap" carries the size encoded in the blob's text ("img 4032x3024"), and the fake canvas encodes
 * "jpeg <w>x<h> q<quality>" so the tests can see what was drawn and how (`encodedBytes` pads the blob to a
 * chosen size, to stand in for a JPEG that comes out large).
 */

const g = globalThis as Record<string, unknown>;
const saved = { createImageBitmap: g.createImageBitmap, document: g.document };
let encodeFails = false;
let encodedBytes: ((w: number, h: number, q: number) => number) | null = null;

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
      if (encodeFails) return cb(null);
      const label = `jpeg ${this.width}x${this.height} q${q}`;
      const size = encodedBytes?.(this.width, this.height, q) ?? 0;
      cb(new Blob(size > label.length ? [label, new Uint8Array(size - label.length)] : [label], { type }));
    },
  }),
};
afterAll(() => Object.assign(g, saved));

beforeEach(async () => {
  encodeFails = false;
  encodedBytes = null;
  await db.media.clear();
});

describe('saveMealPhoto', () => {
  it('stores a JPEG at most 2048 px on the long edge (q 0.85): Opus 5.5 reads up to 2576 px', async () => {
    expect(MEAL_PHOTO_MAX_DIM).toBe(2048);
    const id = await saveMealPhoto(new Blob(['img 4032x3024'], { type: 'image/heic' }));
    expect(id).toMatch(/^m_/);
    const m = (await db.media.get(id))!;
    expect(m).toMatchObject({ type: 'image/jpeg', width: 2048, height: 1536 });
    expect(await m.blob.text()).toBe('jpeg 2048x1536 q0.85');
    expect(m.createdAt).toBeGreaterThan(0);
  });

  it('a heavy-noise 2048 px JPEG (1.34 MB measured at q85) is kept at 2048: well inside the 5 MB base64 guard', async () => {
    encodedBytes = (w) => (w === 2048 ? 1_340_000 : 100);
    const m = (await db.media.get(await saveMealPhoto(new Blob(['img 4032x3024']))))!;
    expect(m).toMatchObject({ width: 2048, height: 1536 });
    expect(m.blob.size).toBe(1_340_000);
  });

  it('an encode too big for Claude (base64 over 5 MB) steps down to 1568 px, then lower quality', async () => {
    const maxRaw = (MAX_IMAGE_BASE64_BYTES / 4) * 3; // 3,932,160 bytes → exactly 5 MiB of base64
    encodedBytes = (w) => (w === 2048 ? 4_980_000 : 2_920_000); // pure-noise 4:4:4 at q85, measured
    let m = (await db.media.get(await saveMealPhoto(new Blob(['img 4032x3024']))))!;
    expect(m).toMatchObject({ width: 1568, height: 1176 });
    expect(await m.blob.slice(0, 20).text()).toBe('jpeg 1568x1176 q0.85');

    const tried: string[] = [];
    encodedBytes = (w, _h, q) => {
      tried.push(`${w}@${q}`);
      return w === 1024 ? 900_000 : maxRaw + 1;
    };
    m = (await db.media.get(await saveMealPhoto(new Blob(['img 4032x3024']))))!;
    expect(m).toMatchObject({ width: 1024, height: 768 });
    expect(tried).toEqual(['2048@0.85', '1568@0.85', '1568@0.7', '1024@0.7']);

    encodedBytes = (w) => (w === 2048 ? maxRaw : 100); // exactly at the limit still fits
    m = (await db.media.get(await saveMealPhoto(new Blob(['img 4032x3024']))))!;
    expect(m.width).toBe(2048);

    encodedBytes = () => maxRaw + 1; // nothing fits → refuse rather than store what Claude would reject
    const before = await db.media.count();
    await expect(saveMealPhoto(new Blob(['img 4032x3024']))).rejects.toThrow('This photo is too large to send to Claude.');
    expect(await db.media.count()).toBe(before);
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

describe('finishMealPhotos: the one shrink path for a finished photo meal', () => {
  const add = (id: string, text = 'jpeg 2048x1536') =>
    db.media.add({ id, blob: new Blob([text], { type: 'image/jpeg' }), type: 'image/jpeg', createdAt: 1, width: 2048, height: 1536 });

  beforeEach(async () => {
    await db.meals.clear();
    await db.aiSpend.clear();
  });

  it('a done meal keeps one ≤ 640 px photo; the others are deleted and unreferenced; a second call writes nothing', async () => {
    for (const id of ['a', 'b', 'c']) await add(id);
    const meal = await createMeal({ input: { kind: 'photo' }, photoIds: ['a', 'b', 'c'], status: 'done' });
    await finishMealPhotos(meal.id);
    expect((await db.meals.get(meal.id))!.photoIds).toEqual(['a']);
    expect(await (await db.media.get('a'))!.blob.text()).toBe('jpeg 640x480 q0.8');
    expect(await db.media.count()).toBe(1);

    await db.meals.update(meal.id, { updatedAt: 1 });
    await finishMealPhotos(meal.id);
    expect((await db.meals.get(meal.id))!.updatedAt).toBe(1); // idempotent: already one small photo
  });

  it('leaves unfinished meals alone (draft / pending / analyzing / failed keep every photo for Retry)', async () => {
    for (const status of ['draft', 'pending', 'analyzing', 'failed'] as const) {
      await db.media.clear();
      await add('p1');
      await add('p2');
      const meal = await createMeal({ input: { kind: 'photo' }, photoIds: ['p1', 'p2'], status });
      await finishMealPhotos(meal.id);
      expect((await db.meals.get(meal.id))!.photoIds).toEqual(['p1', 'p2']);
      expect(await (await db.media.get('p1'))!.blob.text()).toBe('jpeg 2048x1536');
      expect(await db.media.count()).toBe(2);
    }
  });

  it('never throws: a missing meal, an undecodable photo (kept as is), photos already gone (references dropped)', async () => {
    await expect(finishMealPhotos('meal_nope')).resolves.toBeUndefined();

    await add('bad', 'corrupt');
    await add('ok2');
    const meal = await createMeal({ input: { kind: 'photo' }, photoIds: ['bad', 'ok2'], status: 'done' });
    await expect(finishMealPhotos(meal.id)).resolves.toBeUndefined();
    expect((await db.meals.get(meal.id))!.photoIds).toEqual(['bad', 'ok2']);

    const gone = await createMeal({ input: { kind: 'photo' }, photoIds: ['x1', 'x2'], status: 'done' });
    await finishMealPhotos(gone.id);
    expect((await db.meals.get(gone.id))!.photoIds).toEqual([]);
  });

  it('runAnalysis finishes through it: after a successful run the meal keeps one 640 px photo; a failed run keeps all', async () => {
    await add('r1');
    await add('r2');
    const per100g = { kcal: 130, proteinG: 2.7, carbsG: 28, fatG: 0.3, fiberG: 0.4, sugarG: 0.1, sodiumMg: 1 };
    const result = {
      isFood: true,
      items: [{ name: 'Rice', fdcQuery: 'rice, white, cooked', portion: '1 cup', weightG: 180, estimate: { kcal: 230, proteinG: 4, carbsG: 50, fatG: 0.5, fiberG: 0.6, sugarG: 0.1, sodiumMg: 2 } }],
      confidence: 'medium' as const,
      scaleReference: 'fork',
      notes: '',
      calls: [{ model: 'claude-opus-5-5', inputTokens: 1000, outputTokens: 200, costUsd: 0.008, ok: true }],
    };
    const deps = {
      getApiKey: () => 'test-key',
      loadImages: async (ids: string[]) => ids.map(() => ({ data: 'AAAA', mediaType: 'image/jpeg' as const })),
      analyzeMeal: vi.fn(async () => result),
      groundItems: async () => ({
        items: [{ id: 'it_r', name: 'Rice', portion: '1 cup', grams: 180, baselineGrams: 180, per100g, fixed: null, source: 'usda' as const, lookup: 'ok' as const }],
        anyRateLimited: false,
        demoKey: true,
      }),
    };
    const meal = await createMeal({ input: { kind: 'photo' }, photoIds: ['r1', 'r2'], status: 'pending' });
    await runAnalysis(meal.id, deps); // no finishPhotos injected: the real finishMealPhotos runs
    const m = (await db.meals.get(meal.id))!;
    expect(m.status).toBe('done');
    expect(m.photoIds).toEqual(['r1']);
    expect(await (await db.media.get('r1'))!.blob.text()).toBe('jpeg 640x480 q0.8');
    expect(await db.media.get('r2')).toBeUndefined();

    await add('f1');
    await add('f2');
    const failing = await createMeal({ input: { kind: 'photo' }, photoIds: ['f1', 'f2'], status: 'pending' });
    await runAnalysis(failing.id, { ...deps, analyzeMeal: vi.fn(async () => ({ ...result, isFood: false, items: [] })) });
    expect((await db.meals.get(failing.id))!).toMatchObject({ status: 'failed', photoIds: ['f1', 'f2'] });
    expect(await (await db.media.get('f1'))!.blob.text()).toBe('jpeg 2048x1536');
  });
});
