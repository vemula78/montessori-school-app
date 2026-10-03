// POST /command {name, args, requestId?} → {result}. Every write of the app (and the server-side reads that need
// data the caller's RLS cannot see, e.g. import previews) runs here: load slice → authorize → domain → persist
// (rev check). requestId (client-made, per user action): a repeat of a committed request returns the stored result.

import { body, coded, serve } from '../_shared/http.ts';
import { caller } from '../_shared/authz.ts';
import { runCommand } from '../_shared/persist.ts';
import { fanOut } from '../_shared/push.ts';
import { deleteAuthUser, rest, restAll } from '../_shared/db.ts';
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

// payer details Razorpay puts in payment/refund entities; scrubbed from stored webhook payloads on erasure
const PAYER_FIELDS = ['email', 'contact', 'vpa', 'card', 'bank_account', 'notes', 'customer_id', 'token_id', 'upi'];

/**
 * Erasure steps outside the domain transaction (people.anonymiseGuardian has already revoked the links, so access is
 * gone even if one of these fails; re-running the command retries them). Reported, never silent.
 */
async function eraseServerSide(guardianId: string, userIds: string[]) {
  const out = { authUsersDeleted: 0, gatewayEventsScrubbed: 0, errors: [] as string[] };
  for (const id of userIds) {
    try { await deleteAuthUser(id); out.authUsersDeleted++; } catch (e: any) { out.errors.push(String(e?.message || e)); }
  }
  try {
    const orders = new Set((await restAll(`gateway_orders?guardian_id=eq.${encodeURIComponent(guardianId)}&select=id&order=id`)).map((o: any) => o.id));
    if (orders.size) {
      const pays = new Set((await restAll('payments?gateway_payment_id=not.is.null&select=gateway_payment_id,doc->>gatewayOrderId&order=id'))
        .filter((p: any) => orders.has(p.gatewayOrderId)).map((p: any) => p.gateway_payment_id));
      for (const ev of await restAll('gateway_events?select=event_id,payload&order=event_id')) {
        const ent = ev.payload?.payload?.payment?.entity || ev.payload?.payload?.refund?.entity;
        if (!ent || !(orders.has(ent.order_id) || pays.has(ent.payment_id) || pays.has(ent.id))) continue;
        const scrub = (x: any) => { if (x && typeof x === 'object') for (const f of PAYER_FIELDS) if (f in x) x[f] = null; };
        scrub(ev.payload?.payload?.payment?.entity); scrub(ev.payload?.payload?.refund?.entity);
        await rest(`gateway_events?event_id=eq.${encodeURIComponent(ev.event_id)}`, { method: 'PATCH', body: { payload: ev.payload } });
        out.gatewayEventsScrubbed++;
      }
    }
  } catch (e: any) { out.errors.push(String(e?.message || e)); }
  return out;
}

serve(async (req) => {
  const who = await caller(req);
  const { name, args = [], requestId } = await body(req);
  if (typeof name !== 'string' || !(COMMANDS as any)[name]) throw coded('NOT_FOUND', `Unknown command: ${name}`);
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
    return { result: { ...run.result, server: await eraseServerSide(run.result.guardianId, run.result.revokedUserIds || []) } };
  }
  return { result: run.result };
});
