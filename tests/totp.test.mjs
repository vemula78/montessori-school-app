// RFC 6238 TOTP (src/api/totp.js): the standard test vectors, base32, drift window, and the otpauth URI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { totp, base32Encode, base32Decode, randomSecret, otpauthUri, verifyTotp, secondsLeft } from '../src/api/totp.js';

// RFC 6238 appendix B: ASCII secret "12345678901234567890", SHA-1, 8 digits.
const RFC_SECRET = base32Encode(new TextEncoder().encode('12345678901234567890'));
const VECTORS = [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']];

test('RFC 6238 SHA-1 vectors (8 digits) and their 6-digit truncations', async () => {
  for (const [t, code] of VECTORS) {
    assert.equal(await totp(RFC_SECRET, t * 1000, { digits: 8 }), code, `T=${t}`);
    assert.equal(await totp(RFC_SECRET, t * 1000), code.slice(-6), `T=${t} (6 digits)`);
  }
});

test('base32 round-trips, ignores case, spaces and padding, and refuses other characters', () => {
  assert.equal(RFC_SECRET, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.deepEqual(base32Decode('gezd gnbv-GY3TQOJQ===='), base32Decode('GEZDGNBVGY3TQOJQ'));
  const bytes = Uint8Array.from([0, 1, 2, 250, 251, 255, 7]);
  assert.deepEqual(base32Decode(base32Encode(bytes)), bytes);
  assert.throws(() => base32Decode('ABC1'), /base32/);
  assert.throws(() => base32Decode(''), /Empty/);
});

test('randomSecret is 32 base32 characters and different each time; its codes are six digits', async () => {
  const a = randomSecret(), b = randomSecret();
  assert.match(a, /^[A-Z2-7]{32}$/);
  assert.notEqual(a, b);
  assert.match(await totp(a), /^\d{6}$/);
});

test('verifyTotp accepts the current step and one either side, refuses further drift and malformed input', async () => {
  const t = 1700000000000;
  const now = await totp(RFC_SECRET, t);
  assert.equal(await verifyTotp(RFC_SECRET, now, t), true);
  assert.equal(await verifyTotp(RFC_SECRET, await totp(RFC_SECRET, t - 30000), t), true);
  assert.equal(await verifyTotp(RFC_SECRET, await totp(RFC_SECRET, t + 30000), t), true);
  assert.equal(await verifyTotp(RFC_SECRET, await totp(RFC_SECRET, t + 90000), t), false);
  assert.equal(await verifyTotp(RFC_SECRET, '12345', t), false);
  assert.equal(await verifyTotp(RFC_SECRET, 'abcdef', t), false);
  assert.equal(secondsLeft(59000), 1);
  assert.equal(secondsLeft(60000), 30);
});

test('otpauthUri carries secret, issuer and the SHA-1 / 6 / 30 parameters, URL-encoded', () => {
  const u = new URL(otpauthUri({ secret: 'ABCDEFGH', account: 'principal@example.com', issuer: 'Kinfolk Montessori School' }));
  assert.equal(u.protocol, 'otpauth:');
  assert.equal(u.host, 'totp');
  assert.equal(decodeURIComponent(u.pathname), '/Kinfolk Montessori School:principal@example.com');
  assert.equal(u.searchParams.get('secret'), 'ABCDEFGH');
  assert.equal(u.searchParams.get('issuer'), 'Kinfolk Montessori School');
  assert.equal(u.searchParams.get('digits'), '6');
  assert.equal(u.searchParams.get('period'), '30');
});
