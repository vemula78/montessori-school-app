// What the server reads from an uploaded photo before it becomes visible (pure; node-testable). The browser already
// re-encoded the picture on a canvas (which carries no camera or location metadata); this is the second line, and it is
// strict because uploads are always canvas re-encodes. Nothing is decoded or re-encoded; the WHOLE file is walked:
// marker segments, and after every start of scan (SOS) its entropy-coded data (FF00 stuffing and RST0–7 are data) up
// to the next marker — so a progressive or multi-scan file cannot hide metadata between scans.
// Refused: not a JPEG (SOI); APP1 (EXIF/XMP: camera, time, GPS); any other APP1–APP15 (IPTC, vendor data, profiles);
// COM (free text); APP0 that is not JFIF or comes after the frame header; a missing frame header; a scan with no data;
// a file cut short; anything but zero padding after the end-of-image marker (EOI), which must be the last marker.
// Allowed between scans: DHT, DQT, DRI, DAC, SOF, SOS (and DNL/EXP).

const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
const TABLES = new Set([0xc4, 0xcc, 0xdb, 0xdd, 0xdc, 0xdf]); // DHT, DAC, DQT, DRI, DNL, EXP
const ascii = (b, i, n) => String.fromCharCode(...b.subarray(i, i + n));

/**
 * @param {Uint8Array} bytes
 * @returns {{mime:string|null, bytes:number, width:number|null, height:number|null, hasExif:boolean, hasXmp:boolean, reason:string|null}}
 *   reason null = acceptable as far as the bytes go (size limits are checked by domain/photos.js objectProblem)
 */
export function inspectJpeg(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const out = { mime: null, bytes: b.length, width: null, height: null, hasExif: false, hasXmp: false, reason: null };
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) { out.reason = 'not a JPEG image'; return out; }
  out.mime = 'image/jpeg';
  const refuse = r => { if (!out.reason) out.reason = r; };
  let i = 2, scans = 0, ended = false;
  while (i < b.length) {
    if (b[i] !== 0xff || i + 1 >= b.length) { refuse('damaged JPEG (cut short: no end of image)'); break; }
    let m = b[i + 1];
    while (m === 0xff && i + 2 < b.length) { i++; m = b[i + 1]; } // fill bytes
    if (m === 0xd9) { ended = true; i += 2; break; }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; } // stand-alone markers
    if (i + 4 > b.length) { refuse('damaged JPEG (cut short)'); break; }
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2 || i + 2 + len > b.length) { refuse('damaged JPEG (cut short)'); break; }
    const seg = i + 4;
    if (m === 0xe1) {
      if (ascii(b, seg, 6) === 'Exif\0\0') out.hasExif = true; else out.hasXmp = true; // XMP or any other APP1 payload
    } else if (m === 0xe0) {
      if (ascii(b, seg, 5) !== 'JFIF\0' || out.width !== null) refuse('the file carries metadata (APP0 that is not the JFIF header)');
    } else if (m >= 0xe2 && m <= 0xef) refuse('the file carries metadata (APP segment)');
    else if (m === 0xfe) refuse('the file carries a comment');
    else if (SOF.has(m)) { if (len >= 7) { out.height = (b[seg + 1] << 8) | b[seg + 2]; out.width = (b[seg + 3] << 8) | b[seg + 4]; } }
    else if (m !== 0xda && !TABLES.has(m)) refuse(`unexpected JPEG segment 0x${m.toString(16)}`);
    i += 2 + len;
    if (m === 0xda) {
      // entropy-coded data: runs until a marker that is neither stuffing (FF00) nor a restart (FFD0–FFD7)
      const start = i;
      while (i + 1 < b.length && !(b[i] === 0xff && b[i + 1] !== 0x00 && !(b[i + 1] >= 0xd0 && b[i + 1] <= 0xd7))) i++;
      if (i + 1 >= b.length) { refuse('damaged JPEG (cut short: no end of image)'); i = b.length; break; }
      if (i === start) refuse('damaged JPEG (no image data)');
      scans++;
    }
  }
  if (ended) {
    for (let k = i; k < b.length; k++) if (b[k] !== 0) { refuse('the file has data after the end of image'); break; }
  } else refuse('damaged JPEG (cut short: no end of image)');
  if (out.hasExif || out.hasXmp) out.reason = 'the file carries camera/location metadata (EXIF/XMP)';
  else if (!out.reason && out.width === null) out.reason = 'damaged JPEG (no frame header)';
  else if (!out.reason && !scans) out.reason = 'damaged JPEG (no image data)';
  return out;
}
