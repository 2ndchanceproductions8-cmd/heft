/*
 * Product barcodes: validation (EAN-13 / EAN-8 / UPC-A / UPC-E) and decoding from a photo.
 *
 * Decoding uses the native BarcodeDetector when the browser has one that reads EAN-13 (Chrome on Android, some
 * Safari builds); otherwise the zxing-wasm ponyfill. The ponyfill and its wasm are loaded LAZILY (only when a
 * photo is decoded) and the wasm is SELF-HOSTED: Vite's `?url` import emits it into the build (the service
 * worker precaches *.wasm), so a scan works offline and never fetches code from a CDN.
 */

export type BarcodeFormatHint = 'ean_13' | 'ean_8' | 'upc_a' | 'upc_e' | string;

const DIGITS_ONLY = /^\d+$/;

/** GS1 check digit of the data digits (everything but the check digit): weights 3,1,3,1… from the right. */
export function gs1CheckDigit(data: string): number {
  let sum = 0;
  for (let i = data.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += Number(data[i]) * w;
  return (10 - (sum % 10)) % 10;
}

function validGs1(code: string): boolean {
  return DIGITS_ONLY.test(code) && gs1CheckDigit(code.slice(0, -1)) === Number(code[code.length - 1]);
}

/** UPC-E (8 digits, number system 0/1) → its 12-digit UPC-A, or null when the check digit doesn't match. */
export function expandUpcE(code: string): string | null {
  if (!/^[01]\d{7}$/.test(code)) return null;
  const ns = code[0];
  const d = code.slice(1, 7);
  const check = code[7];
  const last = d[5];
  let body: string; // manufacturer (5) + product (5)
  if (last <= '2') body = d[0] + d[1] + last + '0000' + d[2] + d[3] + d[4];
  else if (last === '3') body = d[0] + d[1] + d[2] + '00000' + d[3] + d[4];
  else if (last === '4') body = d[0] + d[1] + d[2] + d[3] + '00000' + d[4];
  else body = d.slice(0, 5) + '0000' + last;
  const upcA = ns + body + check;
  return validGs1(upcA) ? upcA : null;
}

/**
 * Digits-only, validated EAN-13 / EAN-8 / UPC-A / UPC-E code, or null when it isn't a plausible product
 * code. UPC-A (12) is returned as-is; lookups try the EAN-13 form (leading 0) too. A UPC-E is returned
 * expanded to its UPC-A. An 8-digit code with no format hint is read as UPC-E when it starts with 0/1 and
 * expands validly (common on small US packs), else as EAN-8.
 */
export function normalizeBarcode(raw: string, format?: BarcodeFormatHint): string | null {
  const code = (raw ?? '').replace(/\D/g, '');
  switch (code.length) {
    case 13:
    case 12:
      return validGs1(code) ? code : null;
    case 8:
      if (format === 'ean_8') return validGs1(code) ? code : null;
      if (format === 'upc_e') return expandUpcE(code);
      return expandUpcE(code) ?? (validGs1(code) ? code : null);
    default:
      return null;
  }
}

// ------------------------------------------------------------------ decoding

const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e'] as const;
/** Second pass: a downscaled copy (huge camera frames sometimes decode better smaller). */
const RETRY_MAX_DIM = 1280;

interface Detected {
  rawValue: string;
  format: string;
}
interface Detector {
  detect(source: ImageBitmap | HTMLCanvasElement | OffscreenCanvas): Promise<Detected[]>;
}
interface NativeDetectorCtor {
  new (opts?: { formats?: string[] }): Detector;
  getSupportedFormats?: () => Promise<string[]>;
}

let detectorPromise: Promise<Detector> | null = null;

async function createDetector(): Promise<Detector> {
  const Native = (globalThis as { BarcodeDetector?: NativeDetectorCtor }).BarcodeDetector;
  if (Native?.getSupportedFormats) {
    try {
      const supported = await Native.getSupportedFormats();
      if (supported.includes('ean_13')) return new Native({ formats: FORMATS.filter((f) => supported.includes(f)) });
    } catch {
      /* fall through to the ponyfill */
    }
  }
  const [{ BarcodeDetector, prepareZXingModule }, { default: wasmUrl }] = await Promise.all([
    import('barcode-detector/ponyfill'),
    import('zxing-wasm/reader/zxing_reader.wasm?url'),
  ]);
  prepareZXingModule({
    overrides: {
      locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? wasmUrl : prefix + path),
    },
  });
  return new BarcodeDetector({ formats: [...FORMATS] }) as unknown as Detector;
}

function getDetector(): Promise<Detector> {
  if (!detectorPromise) {
    detectorPromise = createDetector().catch((e) => {
      detectorPromise = null; // e.g. offline before the decoder chunk was cached: try again next time
      throw e;
    });
  }
  return detectorPromise;
}

function firstValid(found: Detected[]): string | null {
  for (const b of found) {
    const code = normalizeBarcode(b.rawValue, b.format);
    if (code) return code;
  }
  return null;
}

function downscaled(bmp: ImageBitmap): HTMLCanvasElement | OffscreenCanvas | null {
  const scale = Math.min(1, RETRY_MAX_DIM / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const canvas: HTMLCanvasElement | OffscreenCanvas =
    typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) return null;
  ctx.drawImage(bmp, 0, 0, w, h);
  return canvas;
}

/**
 * Read a product barcode from a photo (native BarcodeDetector, else the zxing-wasm ponyfill). null = none
 * found (or the photo can't be decoded). Throws only when the barcode reader itself can't be loaded.
 */
export async function decodeBarcodeFromImage(image: Blob): Promise<string | null> {
  const detector = await getDetector();
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(image);
  } catch {
    return null; // not an image this browser can decode (e.g. HEIC outside Safari)
  }
  try {
    try {
      const code = firstValid(await detector.detect(bmp));
      if (code) return code;
    } catch {
      /* try the downscaled copy */
    }
    const canvas = downscaled(bmp);
    if (!canvas) return null;
    try {
      return firstValid(await detector.detect(canvas));
    } catch {
      return null;
    }
  } finally {
    bmp.close?.();
  }
}
