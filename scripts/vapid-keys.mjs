#!/usr/bin/env node
// Generate a VAPID key pair for Web Push (P-256). Public key → app/config.js (vapidPublicKey) and the
// VAPID_PUBLIC_KEY secret; private key → the VAPID_PRIVATE_KEY secret ONLY (never commit it).
//   node scripts/vapid-keys.mjs          print both, base64url
//   node scripts/vapid-keys.mjs --env    print as KEY=value lines

import { generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export function vapidKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pub = publicKey.export({ format: 'jwk' });
  const priv = privateKey.export({ format: 'jwk' });
  const b64u = buf => Buffer.from(buf).toString('base64url');
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(pub.x, 'base64url'), Buffer.from(pub.y, 'base64url')]);
  return { publicKey: b64u(raw), privateKey: priv.d };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const k = vapidKeys();
  if (process.argv.includes('--env')) console.log(`VAPID_PUBLIC_KEY=${k.publicKey}\nVAPID_PRIVATE_KEY=${k.privateKey}`);
  else console.log(`public  (app/config.js vapidPublicKey, and VAPID_PUBLIC_KEY): ${k.publicKey}\nprivate (VAPID_PRIVATE_KEY secret only; never commit):     ${k.privateKey}`);
}
