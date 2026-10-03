// CONTRACT STUB (foundation). The engine builder replaces the bodies; signatures are fixed.

/**
 * Digits-only, validated EAN-13 / EAN-8 / UPC-A / UPC-E code, or null when it isn't a plausible product
 * code. UPC-A (12) is returned as-is; lookups try the EAN-13 form (leading 0) too.
 */
export function normalizeBarcode(_raw: string): string | null {
  throw new Error('not implemented: barcode.normalizeBarcode');
}

/** Read a product barcode from a photo (native BarcodeDetector, else the zxing-wasm ponyfill). null = none found. */
export async function decodeBarcodeFromImage(_image: Blob): Promise<string | null> {
  throw new Error('not implemented: barcode.decodeBarcodeFromImage');
}
