// Uploaded files the school keeps privately (staff signatures, notice attachments): what the bytes are, checked on the
// server from the bytes themselves (never from the browser's word), and the limits per kind. Pure; the command function
// reads the upload, sniffs it here and passes the verdict to the domain as ctx.fileInfo = {path, mime, bytes, sha256,
// width?, height?}. A file the checks refuse is never stored.

/** 'application/pdf' | 'image/png' | 'image/jpeg' | null from the first bytes (magic numbers). */
export function sniffMime(bytes) {
  if (!bytes || bytes.length < 8) return null;
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d) return 'application/pdf'; // %PDF-
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  return null;
}

/** {width, height} from a PNG's IHDR chunk, or null. */
export function pngSize(bytes) {
  if (sniffMime(bytes) !== 'image/png' || bytes.length < 24) return null;
  const u32 = o => ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0;
  if (String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]) !== 'IHDR') return null;
  return { width: u32(16), height: u32(20) };
}

export const EXTENSION = { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg' };

/**
 * Why a received file is not acceptable for this kind, or null. info: {mime, bytes, hasExif?, hasXmp?, width?, height?}
 * as the server read it; rules: {mimes, maxBytes, maxEdge?}.
 */
export function fileProblem(info, { mimes, maxBytes, maxEdge = null }) {
  if (!info || typeof info !== 'object') return 'the file was not checked';
  if (!mimes.includes(info.mime)) return `only ${mimes.map(m => EXTENSION[m].toUpperCase()).join(', ')} files can be added`;
  if (!Number.isSafeInteger(info.bytes) || info.bytes <= 0) return 'the file is empty';
  if (info.bytes > maxBytes) return `the file is larger than ${maxBytes >= 1024 * 1024 ? `${maxBytes / 1024 / 1024} MB` : `${Math.round(maxBytes / 1024)} KB`}`;
  if (info.mime === 'image/jpeg' && (info.hasExif || info.hasXmp)) return 'the image carries camera or location details (EXIF/XMP); save it again as PNG';
  if (maxEdge && Number.isSafeInteger(info.width) && Number.isSafeInteger(info.height) && (info.width > maxEdge || info.height > maxEdge)) return `the image is larger than ${maxEdge} px on a side`;
  return null;
}

const FILE_NAME_MAX = 100;
/** A display name for an attachment: no path, no control characters, at most 100 characters. */
export function cleanFileName(name, mime) {
  let n = String(name ?? '').split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!n) n = `file.${EXTENSION[mime] || 'bin'}`;
  return n.length > FILE_NAME_MAX ? n.slice(0, FILE_NAME_MAX) : n;
}
