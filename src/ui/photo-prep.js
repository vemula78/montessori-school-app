// Prepare a photo before it is registered or uploaded: decode it, scale the long edge to 1280 px and re-encode as JPEG
// (quality 0.8, then lower until it fits 400 KiB). Drawing to a canvas and re-encoding drops EXIF and GPS by
// construction, and bakes in the camera's rotation. If the browser cannot decode the file (HEIC on an older
// browser, a damaged file) the photo is REFUSED: the original is never uploaded.
// The server checks the bytes again (second line); this is the first.

export const MAX_EDGE = 1280;
export const MAX_BYTES = 400 * 1024;          // equals the bucket limit (tests/phase3-ui.test.mjs checks it against the domain)
export const MAX_SOURCE_BYTES = 40 * 1024 * 1024;
export const QUALITIES = [0.8, 0.7, 0.6, 0.5];

export class PhotoPrepError extends Error {
  constructor(message) { super(message); this.name = 'PhotoPrepError'; this.code = 'PHOTO_REFUSED'; }
}

/** Scale (w, h) so the long edge is at most max; never enlarges. */
export function fitWithin(w, h, max = MAX_EDGE) {
  if (!(w > 0 && h > 0)) throw new PhotoPrepError('The photo has no size');
  const k = Math.min(1, max / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}

/** The browser's decoder and encoder; replaced by a fake in tests. */
export const browserEnv = {
  /** → {width, height, source, close()} using the camera's orientation. */
  async decode(file) {
    if (typeof createImageBitmap === 'function') {
      try {
        const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
        return { width: bmp.width, height: bmp.height, source: bmp, close: () => bmp.close && bmp.close() };
      } catch { /* fall back to an <img> below */ }
    }
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return { width: img.naturalWidth, height: img.naturalHeight, source: img, close() {} };
    } finally { URL.revokeObjectURL(url); }
  },
  /** → Blob (image/jpeg) */
  async encode(decoded, width, height, quality) {
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const g = canvas.getContext('2d');
    g.drawImage(decoded.source, 0, 0, width, height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (!blob || blob.type !== 'image/jpeg') throw new PhotoPrepError('This browser could not make a JPEG from the photo');
    return blob;
  },
};

/**
 * @param {File|Blob} file
 * @returns {Promise<{blob:Blob, width:number, height:number, bytes:number, quality:number}>}
 * @throws {PhotoPrepError} with a message the person can act on
 */
export async function preparePhoto(file, env = browserEnv) {
  if (!file || !(file.size > 0)) throw new PhotoPrepError('Choose a photo first');
  if (file.type && !/^image\//.test(file.type)) throw new PhotoPrepError('That file is not a picture');
  if (file.size > MAX_SOURCE_BYTES) throw new PhotoPrepError('That photo is too large to prepare on this device');
  let decoded;
  try { decoded = await env.decode(file); } catch {
    throw new PhotoPrepError('This browser could not open that photo (for example a HEIC file on an older browser). Take it again as a JPEG, or choose another photo. Nothing was uploaded.');
  }
  try {
    const { width, height } = fitWithin(decoded.width, decoded.height);
    for (const quality of QUALITIES) {
      const blob = await env.encode(decoded, width, height, quality);
      if (blob.size <= MAX_BYTES) return { blob, width, height, bytes: blob.size, quality };
    }
    throw new PhotoPrepError('The photo is still too large after shrinking it; choose a simpler picture');
  } finally { decoded.close(); }
}

/** '212 KB' / '1.2 MB' for the size line shown after preparing. */
export const sizeText = bytes => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
