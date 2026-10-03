// CONTRACT STUB (foundation). The engine builder replaces the bodies; signatures are fixed.

/** Thrown when a picked file can't be decoded as an image (e.g. HEIC on a browser that can't read it). */
export class PhotoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PhotoError';
  }
}

/**
 * Save a meal photo to db.media as a JPEG at most 1568 px on the long edge (Claude's sweet spot). Unlike
 * lib/media.saveImageFile it NEVER stores an undecodable original: it throws PhotoError instead, so nothing
 * Anthropic can't read is ever sent.
 */
export async function saveMealPhoto(_file: Blob): Promise<string> {
  throw new Error('not implemented: photos.saveMealPhoto');
}
