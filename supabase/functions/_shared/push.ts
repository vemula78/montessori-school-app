// Web Push (VAPID, aes128gcm) delivery. The one new dependency of Phase 2: npm:web-push@3 (hand-rolled
// RFC 8291 encryption + ES256 JWTs is ~200 lines of WebCrypto and a known bug farm).
// A subscription answering 404/410, or failing 5 times in a row, is deleted; so is one whose endpoint is not an
// https URL on a known push service (requests never go to internal or arbitrary hosts, never follow redirects,
// and give up after 10 s).

import webpush from 'npm:web-push@3.6.7';
import { inList, rest, restAll } from './db.ts';
import { consentAllows, pushEndpointAllowed, pushMessages } from './notify.js';
import { CONSENT_VERSION } from './domain/commands.js';

const PUB = Deno.env.get('VAPID_PUBLIC_KEY') ?? '';
const PRIV = Deno.env.get('VAPID_PRIVATE_KEY') ?? '';
const SUBJECT = Deno.env.get('VAPID_SUBJECT') ?? '';
// LOCAL TESTS ONLY: exact origins of a mock push endpoint (supabase/.env.local). Never set in a deployment.
const TEST_ORIGINS = (Deno.env.get('PUSH_TEST_ORIGINS') ?? '').split(',').map(s => s.trim()).filter(Boolean);
const configured = Boolean(PUB && PRIV && SUBJECT);
if (configured) webpush.setVapidDetails(SUBJECT, PUB, PRIV);
const MAX_FAILURES = 5;
const TTL_S = 3600;
const TIMEOUT_MS = 10000;

type Msg = { guardianIds: string[]; studentIds: string[]; purposes: string[]; payload: Record<string, string> };
type One = { sent: number; failed: number; deleted: number };
export type PushReport = { messages: number; sent: number; deleted: number; failed: number; rejectedEndpoints: number; skipped: string | null; perMessage: One[] };

export async function deliver(messages: Msg[]): Promise<PushReport> {
  const report: PushReport = { messages: messages.length, sent: 0, deleted: 0, failed: 0, rejectedEndpoints: 0, skipped: null, perMessage: messages.map(() => ({ sent: 0, failed: 0, deleted: 0 })) };
  if (!messages.length) return report;
  if (!configured) { report.skipped = 'VAPID keys not configured'; return report; }
  const gids = [...new Set(messages.flatMap(m => m.guardianIds))];
  // per child and per notice version (finding 7): a sibling's or an old-version consent does not count
  const consents = await restAll(`consents?guardian_id=in.${inList(gids)}&withdrawn_at=is.null&purpose=in.(push,bus_live)&version=eq.${encodeURIComponent(CONSENT_VERSION)}&select=id,guardian_id,student_id,purpose,version&order=id`);
  const links = await restAll(`app_users?guardian_id=in.${inList(gids)}&status=eq.active&select=user_id,guardian_id&order=user_id`);
  const usersOf = new Map<string, string[]>();
  for (const l of links) { if (!usersOf.has(l.guardian_id)) usersOf.set(l.guardian_id, []); usersOf.get(l.guardian_id)!.push(l.user_id); }
  const uids = [...new Set(links.map((l: any) => l.user_id))];
  let subs: any[] = uids.length ? await restAll(`push_subscriptions?user_id=in.${inList(uids as string[])}&select=id,user_id,endpoint,p256dh,auth,failures&order=id`) : [];
  const bad = subs.filter(s => !pushEndpointAllowed(s.endpoint, TEST_ORIGINS));
  for (const s of bad) {
    await rest(`push_subscriptions?id=eq.${s.id}`, { method: 'DELETE' });
    report.rejectedEndpoints++;
    console.error(`push subscription ${s.id} deleted: endpoint is not on a known push service`);
  }
  subs = subs.filter(s => !bad.includes(s));
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const targets = new Map<number, any>();
    for (const g of m.guardianIds) {
      if (!consentAllows(consents, g, m.studentIds || [], m.purposes, CONSENT_VERSION)) continue;
      for (const u of usersOf.get(g) || []) for (const s of subs) if (s.user_id === u) targets.set(s.id, s);
    }
    for (const s of targets.values()) if (!s.deleted) await sendOne(s, m.payload, report, report.perMessage[i]);
  }
  return report;
}

// web-push builds the encrypted request (VAPID JWT + aes128gcm); fetch sends it. (sendNotification() always uses
// node's https.request, which cannot reach the local http:// test endpoint.)
async function post(s: any, payload: Record<string, string>) {
  const d = webpush.generateRequestDetails({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: TTL_S, contentEncoding: 'aes128gcm' });
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(d.headers)) if (k.toLowerCase() !== 'content-length') headers[k] = String(v);
  const res = await fetch(d.endpoint, { method: d.method, headers, body: d.body, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
  await res.body?.cancel();
  if (res.status < 200 || res.status > 299) throw Object.assign(new Error(`push service answered ${res.status}`), { statusCode: res.status });
}

async function sendOne(s: any, payload: Record<string, string>, report: PushReport, one: One) {
  try {
    await post(s, payload);
    report.sent++; one.sent++;
    if (s.failures) { await rest(`push_subscriptions?id=eq.${s.id}`, { method: 'PATCH', body: { failures: 0 } }); s.failures = 0; }
  } catch (e: any) {
    const status = e && e.statusCode;
    if (status === 404 || status === 410 || (s.failures || 0) + 1 >= MAX_FAILURES) {
      await rest(`push_subscriptions?id=eq.${s.id}`, { method: 'DELETE' });
      s.deleted = true;
      report.deleted++; one.deleted++;
    } else {
      s.failures = (s.failures || 0) + 1;
      await rest(`push_subscriptions?id=eq.${s.id}`, { method: 'PATCH', body: { failures: s.failures } });
      report.failed++; one.failed++;
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
