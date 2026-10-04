// What the server reads from an uploaded photo before it becomes visible (pure; node-testable). The browser already
// re-encoded the picture on a canvas (which carries no camera or location metadata); this is the second line:
// JPEG magic, no metadata segments, image size from the frame header, file size. Nothing is decoded or re-encoded.
// Refused: not a JPEG (SOI), APP1 (EXIF or XMP: camera, time, GPS), APP13 (IPTC: captions, places), a missing frame
// header, a file cut short, a COM comment segment (free text). Allowed: APP0 (JFIF), other APPn (ICC colour profiles).

const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
const ascii = (b, i, n) => String.fromCharCode(...b.subarray(i, i + n));

/**
 * @param {Uint8Array} bytes
 * @returns {{mime:string|null, bytes:number, width:number|null, height:number|null, hasExif:boolean, hasXmp:boolean, reason:string|null}}
 *   reason null = acceptable as far as the bytes go (size limits are checked by domain/photos.js objectProblem)
 */
export function inspectJpeg(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const out = { mime: null, bytes: b.length, width: null, height: null, hasExif: false, hasXmp: false, reason: null };
  let iptc = false, comment = false;
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) { out.reason = 'not a JPEG image'; return out; }
  out.mime = 'image/jpeg';
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) { out.reason = 'damaged JPEG (bad segment marker)'; return out; }
    let m = b[i + 1];
    while (m === 0xff && i + 2 < b.length) { i++; m = b[i + 1]; } // fill bytes
    if (m === 0xd9 || m === 0xda) break; // end of image / start of scan: the metadata segments are all before it
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; } // markers without a length
    if (i + 4 > b.length) { out.reason = 'damaged JPEG (cut short)'; return out; }
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2 || i + 2 + len > b.length) { out.reason = 'damaged JPEG (cut short)'; return out; }
    const seg = i + 4;
    if (m === 0xe1) {
      if (ascii(b, seg, 6) === 'Exif\0\0') out.hasExif = true;
      else if (ascii(b, seg, 28) === 'http://ns.adobe.com/xap/1.0/') out.hasXmp = true;
      else out.hasXmp = true; // any other APP1 payload is metadata as well
    }
    if (m === 0xed) iptc = true;
    if (m === 0xfe) comment = true;
    if (SOF.has(m) && len >= 7) { out.height = (b[seg + 1] << 8) | b[seg + 2]; out.width = (b[seg + 3] << 8) | b[seg + 4]; }
    i += 2 + len;
  }
  if (out.hasExif || out.hasXmp) out.reason = 'the file carries camera/location metadata (EXIF/XMP)';
  else if (iptc) out.reason = 'the file carries IPTC metadata (captions, places)';
  else if (comment) out.reason = 'the file carries a comment';
  else if (out.width === null) out.reason = 'damaged JPEG (no frame header)';
  return out;
}
