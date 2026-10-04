// RFC 6238 time-based one-time codes (HMAC-SHA1, 30 s step, 6 digits) over WebCrypto. Pure: no DOM, no network,
// no storage. Runs in browsers and in Node 20+ through globalThis.crypto. Used by the demo's two-step sign-in and by
// the backend tests to act as the authenticator app.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32 → bytes. Spaces, dashes, "=" padding and case are ignored; any other character throws. */
export function base32Decode(text) {
  const clean = String(text ?? '').toUpperCase().replace(/[\s=-]+/g, '');
  if (!clean) throw new Error('Empty secret');
  const out = [];
  let bits = 0, acc = 0;
  for (const ch of clean) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) throw new Error('Not a base32 secret');
    acc = (acc << 5) | v; bits += 5;
    if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); acc &= (1 << bits) - 1; }
  }
  return Uint8Array.from(out);
}

export function base32Encode(bytes) {
  let out = '', bits = 0, acc = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b; bits += 8;
    while (bits >= 5) { bits -= 5; out += ALPHABET[(acc >> bits) & 31]; acc &= (1 << bits) - 1; }
  }
  if (bits > 0) out += ALPHABET[(acc << (5 - bits)) & 31];
  return out;
}

/** A new random secret: 20 bytes (160 bits, the SHA-1 block recommendation) as base32 (32 characters). */
export function randomSecret(bytes = 20) {
  return base32Encode(globalThis.crypto.getRandomValues(new Uint8Array(bytes)));
}

/** The code for `secretBase32` at `timeMs` (default now): a zero-padded string of `digits` digits. */
export async function totp(secretBase32, timeMs = Date.now(), { digits = 6, step = 30 } = {}) {
  const counter = Math.floor(timeMs / 1000 / step);
  const msg = new Uint8Array(8);
  new DataView(msg.buffer).setBigUint64(0, BigInt(counter));
  const key = await globalThis.crypto.subtle.importKey('raw', base32Decode(secretBase32), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const h = new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', key, msg));
  const o = h[h.length - 1] & 0x0f;
  const bin = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

/** Seconds until the current code changes (1..step). */
export const secondsLeft = (timeMs = Date.now(), step = 30) => step - (Math.floor(timeMs / 1000) % step);

/** True when `code` is the code for the current step or one step either side (clock drift), compared in constant shape. */
export async function verifyTotp(secretBase32, code, timeMs = Date.now(), { window = 1, digits = 6, step = 30 } = {}) {
  const given = String(code ?? '').replace(/\s+/g, '');
  if (!new RegExp(`^\\d{${digits}}$`).test(given)) return false;
  let ok = false;
  for (let w = -window; w <= window; w++) if ((await totp(secretBase32, timeMs + w * step * 1000, { digits, step })) === given) ok = true;
  return ok;
}

/** The otpauth:// URI an authenticator app understands (shown as text in this app; no QR library). */
export function otpauthUri({ secret, account, issuer }) {
  const label = issuer ? `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}` : encodeURIComponent(account);
  const q = new URLSearchParams({ secret, ...(issuer ? { issuer } : {}), algorithm: 'SHA1', digits: '6', period: '30' });
  return `otpauth://totp/${label}?${q.toString()}`;
}
