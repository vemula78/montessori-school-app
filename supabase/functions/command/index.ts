// POST /command {name, args} → {result}. Every write of the app (and the server-side reads that need data the
// caller's RLS cannot see, e.g. import previews) runs here: load slice → authorize → domain → persist (rev check).

import { body, coded, serve } from '../_shared/http.ts';
import { caller } from '../_shared/authz.ts';
import { runCommand } from '../_shared/persist.ts';
import { fanOut } from '../_shared/push.ts';
import { COMMANDS } from '../_shared/domain/commands.js';

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
const normaliseCode = (c: unknown) => String(c ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
async function sha256Hex(s: string) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  return Array.from(d, b => b.toString(16).padStart(2, '0')).join('');
}
function newInviteCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  const raw = Array.from(bytes, b => ALPHABET[b % ALPHABET.length]).join(''); // 31^10 ≈ 8·10^14
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

serve(async (req) => {
  const who = await caller(req);
  const { name, args = [] } = await body(req);
  if (typeof name !== 'string' || !(COMMANDS as any)[name]) throw coded('NOT_FOUND', `Unknown command: ${name}`);
  const extra: { ctx?: Record<string, unknown>; hints?: Record<string, unknown> } = {};
  if (name === 'admin.inviteCode') {
    const code = newInviteCode();
    extra.ctx = { inviteCode: code, inviteCodeHash: await sha256Hex(normaliseCode(code)) };
  }
  if (name === 'auth.redeemInvite') {
    if (who.kind !== 'user' || !who.user.email) throw coded('UNAUTHENTICATED', 'Sign in with your email first');
    extra.ctx = { inviteCodeHash: await sha256Hex(normaliseCode(args[0])) };
    extra.hints = { auditRedeemFailedBy: who.user.id };
  }
  const run = await runCommand(name, args, who, extra);
  await fanOut(name, run);
  return { result: run.result };
});
