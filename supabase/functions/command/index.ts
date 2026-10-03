// POST /command {name, args, requestId} → {result}. Every write of the app (and the server-side reads that need
// data the caller's RLS cannot see, e.g. import previews) runs here: load slice → authorize → domain → persist
// (rev check). requestId (required; client-made, one per user action): a repeat of a committed request returns the
// stored result.

import { body, coded, serve } from '../_shared/http.ts';
import { caller } from '../_shared/authz.ts';
import { runCommand } from '../_shared/persist.ts';
import { fanOut } from '../_shared/push.ts';
import { finishErasure } from '../_shared/erasure.ts';
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
  const { name, args = [], requestId } = await body(req);
  if (typeof name !== 'string' || !(COMMANDS as any)[name]) throw coded('NOT_FOUND', `Unknown command: ${name}`);
  // every call names its request (one id per user action; the browser retries with the same id), so a repeated
  // request can never write twice
  if (requestId == null || requestId === '') throw coded('BAD_REQUEST', 'requestId is required');
  // demo-only commands (the mock online payment) never run on the server: money moves only through the gateway
  if ((COMMANDS as any)[name].demoOnly) throw coded('NOT_ALLOWED', 'This action exists only in the demo; online payments go through the payment gateway');
  const extra: { ctx?: Record<string, unknown>; hints?: Record<string, unknown>; requestId?: unknown } = { requestId };
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
  if (!run.replayed) await fanOut(name, run);
  if (name === 'people.anonymiseGuardian' && run.result) {
    return { result: { ...run.result, server: await finishErasure(run.result.guardianId, run.result.revokedUserIds || []) } };
  }
  return { result: run.result };
});
