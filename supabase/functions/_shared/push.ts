// Web Push (VAPID, aes128gcm) delivery. The one new dependency of Phase 2: npm:web-push@3 (hand-rolled
// RFC 8291 encryption + ES256 JWTs is ~200 lines of WebCrypto and a known bug farm).
// A subscription answering 404/410, or failing 5 times in a row, is deleted.

import webpush from 'npm:web-push@3.6.7';
import { inList, rest } from './db.ts';
import { pushMessages } from './notify.js';

const PUB = Deno.env.get('VAPID_PUBLIC_KEY') ?? '';
const PRIV = Deno.env.get('VAPID_PRIVATE_KEY') ?? '';
const SUBJECT = Deno.env.get('VAPID_SUBJECT') ?? '';
const configured = Boolean(PUB && PRIV && SUBJECT);
if (configured) webpush.setVapidDetails(SUBJECT, PUB, PRIV);
const MAX_FAILURES = 5;
const TTL_S = 3600;

type Msg = { guardianIds: string[]; purposes: string[]; payload: Record<string, string> };
export type PushReport = { messages: number; sent: number; deleted: number; failed: number; skipped: string | null };

export async function deliver(messages: Msg[]): Promise<PushReport> {
  const report: PushReport = { messages: messages.length, sent: 0, deleted: 0, failed: 0, skipped: null };
  if (!messages.length) return report;
  if (!configured) { report.skipped = 'VAPID keys not configured'; return report; }
  const gids = [...new Set(messages.flatMap(m => m.guardianIds))];
  const consents = await rest(`consents?guardian_id=in.${inList(gids)}&withdrawn_at=is.null&purpose=in.(push,bus_live)&select=guardian_id,purpose`);
  const has = new Map<string, Set<string>>();
  for (const c of consents) { if (!has.has(c.guardian_id)) has.set(c.guardian_id, new Set()); has.get(c.guardian_id)!.add(c.purpose); }
  const links = await rest(`app_users?guardian_id=in.${inList(gids)}&status=eq.active&select=user_id,guardian_id`);
  const usersOf = new Map<string, string[]>();
  for (const l of links) { if (!usersOf.has(l.guardian_id)) usersOf.set(l.guardian_id, []); usersOf.get(l.guardian_id)!.push(l.user_id); }
  const uids = [...new Set(links.map((l: any) => l.user_id))];
  const subs = uids.length ? await rest(`push_subscriptions?user_id=in.${inList(uids as string[])}&select=id,user_id,endpoint,p256dh,auth,failures`) : [];
  for (const m of messages) {
    const targets = new Map<number, any>();
    for (const g of m.guardianIds) {
      if (!m.purposes.every(p => has.get(g)?.has(p))) continue;
      for (const u of usersOf.get(g) || []) for (const s of subs) if (s.user_id === u) targets.set(s.id, s);
    }
    for (const s of targets.values()) await sendOne(s, m.payload, report);
  }
  return report;
}

// web-push builds the encrypted request (VAPID JWT + aes128gcm); fetch sends it. (sendNotification() always uses
// node's https.request, which cannot reach the local http:// test endpoint.)
async function post(s: any, payload: Record<string, string>) {
  const d = webpush.generateRequestDetails({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: TTL_S, contentEncoding: 'aes128gcm' });
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(d.headers)) if (k.toLowerCase() !== 'content-length') headers[k] = String(v);
  const res = await fetch(d.endpoint, { method: d.method, headers, body: d.body });
  await res.body?.cancel();
  if (res.status < 200 || res.status > 299) throw Object.assign(new Error(`push service answered ${res.status}`), { statusCode: res.status });
}

async function sendOne(s: any, payload: Record<string, string>, report: PushReport) {
  try {
    await post(s, payload);
    report.sent++;
    if (s.failures) await rest(`push_subscriptions?id=eq.${s.id}`, { method: 'PATCH', body: { failures: 0 } });
  } catch (e: any) {
    const status = e && e.statusCode;
    if (status === 404 || status === 410 || (s.failures || 0) + 1 >= MAX_FAILURES) {
      await rest(`push_subscriptions?id=eq.${s.id}`, { method: 'DELETE' });
      report.deleted++;
    } else {
      await rest(`push_subscriptions?id=eq.${s.id}`, { method: 'PATCH', body: { failures: (s.failures || 0) + 1 } });
      report.failed++;
    }
    console.error(`push to subscription ${s.id} failed (${status ?? 'network'})`);
  }
}

/** Best effort after a commit: a push failure never fails the command that was already saved. */
export async function fanOut(name: string, run: { before: any; after: any; result: any }): Promise<PushReport | null> {
  try {
    return await deliver(pushMessages(name, run.before, run.after, run.result));
  } catch (e: any) {
    console.error('push fan-out failed:', e && e.message);
    return null;
  }
}
