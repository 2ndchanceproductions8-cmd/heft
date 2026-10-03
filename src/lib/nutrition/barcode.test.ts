import { afterAll, describe, expect, it } from 'vitest';
import { decodeBarcodeFromImage, expandUpcE, gs1CheckDigit, normalizeBarcode } from './barcode';

describe('normalizeBarcode', () => {
  it('accepts EAN-13 / UPC-A / EAN-8 with a valid check digit, digits only', () => {
    expect(normalizeBarcode('3017624010701')).toBe('3017624010701'); // Nutella EAN-13
    expect(normalizeBarcode('036000291452')).toBe('036000291452'); // UPC-A stays 12 digits
    expect(normalizeBarcode(' 0 36000-29145 2 ')).toBe('036000291452');
    expect(normalizeBarcode('96385074')).toBe('96385074'); // EAN-8
    expect(normalizeBarcode('96385074', 'ean_8')).toBe('96385074');
  });

  it('rejects bad check digits, wrong lengths and junk', () => {
    expect(normalizeBarcode('3017624010702')).toBeNull();
    expect(normalizeBarcode('036000291453')).toBeNull();
    expect(normalizeBarcode('96385075')).toBeNull();
    expect(normalizeBarcode('12345')).toBeNull();
    expect(normalizeBarcode('12345678901234')).toBeNull(); // GTIN-14 (cases, not products)
    expect(normalizeBarcode('hello')).toBeNull();
    expect(normalizeBarcode('')).toBeNull();
  });

  it('expands UPC-E to UPC-A (all four expansion rules) and checks the UPC-A check digit', () => {
    expect(expandUpcE('04252614')).toBe('042100005264'); // last digit 0–2
    expect(normalizeBarcode('04252614')).toBe('042100005264');
    expect(normalizeBarcode('04252614', 'upc_e')).toBe('042100005264');
    // UPC-E's check digit IS the expanded UPC-A's, so build each case from the expected UPC-A body.
    const upcE = (six: string, upcABody: string) => '0' + six + gs1CheckDigit(upcABody);
    const upcA = (body: string) => body + gs1CheckDigit(body);
    expect(expandUpcE(upcE('123453', '01230000045'))).toBe(upcA('01230000045')); // last 3 → d1d2d3 00000 d4d5
    expect(expandUpcE(upcE('123454', '01234000005'))).toBe(upcA('01234000005')); // last 4 → d1..d4 00000 d5
    expect(expandUpcE(upcE('123457', '01234500007'))).toBe(upcA('01234500007')); // last 5–9 → d1..d5 0000 last
    expect(expandUpcE('04252615')).toBeNull(); // wrong check digit
    expect(expandUpcE('24252614')).toBeNull(); // number system must be 0/1
  });

  it('computes GS1 check digits', () => {
    expect(gs1CheckDigit('301762401070')).toBe(1);
    expect(gs1CheckDigit('03600029145')).toBe(2);
    expect(gs1CheckDigit('9638507')).toBe(4);
  });
});

describe('decodeBarcodeFromImage (native BarcodeDetector path, no wasm in tests)', () => {
  const g = globalThis as Record<string, unknown>;
  const saved = { BarcodeDetector: g.BarcodeDetector, createImageBitmap: g.createImageBitmap, OffscreenCanvas: g.OffscreenCanvas };
  const seen: unknown[] = [];
  let answers: { rawValue: string; format: string }[][] = [];
  class FakeDetector {
    static async getSupportedFormats() {
      return ['qr_code', 'ean_13', 'ean_8', 'upc_a', 'upc_e'];
    }
    constructor(public opts: { formats?: string[] }) {}
    async detect(src: unknown) {
      seen.push(src);
      return answers.shift() ?? [];
    }
  }
  class FakeCanvas {
    constructor(
      public width: number,
      public height: number,
    ) {}
    getContext() {
      return { drawImage: () => undefined };
    }
  }
  g.BarcodeDetector = FakeDetector;
  g.OffscreenCanvas = FakeCanvas;
  g.createImageBitmap = async (b: Blob) => {
    if (b.type === 'image/heic') throw new Error('cannot decode');
    return { width: 4032, height: 3024, close: () => undefined };
  };
  afterAll(() => Object.assign(g, saved));

  it('returns the normalized code of the first valid barcode', async () => {
    answers = [[{ rawValue: 'not-a-code', format: 'ean_13' }, { rawValue: '04252614', format: 'upc_e' }]];
    expect(await decodeBarcodeFromImage(new Blob(['x'], { type: 'image/jpeg' }))).toBe('042100005264');
  });

  it('retries once on a copy downscaled to 1280 px', async () => {
    seen.length = 0;
    answers = [[], [{ rawValue: '3017624010701', format: 'ean_13' }]];
    expect(await decodeBarcodeFromImage(new Blob(['x'], { type: 'image/jpeg' }))).toBe('3017624010701');
    expect(seen).toHaveLength(2);
    expect(seen[1]).toMatchObject({ width: 1280, height: 960 });
  });

  it('null when nothing is found or the image cannot be decoded', async () => {
    answers = [[], []];
    expect(await decodeBarcodeFromImage(new Blob(['x'], { type: 'image/jpeg' }))).toBeNull();
    expect(await decodeBarcodeFromImage(new Blob(['x'], { type: 'image/heic' }))).toBeNull();
  });
});
