// POST /cron-daily (header X-Cron-Secret; verify_jwt=false). Called by pg_cron at 08:00 IST via pg_net, and every
// 15 minutes with body {"steps":["trips"]} (stale-trip cleanup only). Steps, each counted in the response (nothing
// silently skipped; every list is read page by page, never cut at the API's 1000-row cap):
//   1. fee reminders (T−3, due day, +7, +14 of the effective due date): claimed atomically in reminders_sent (a
//      concurrent run gets nothing to send), pushed to guardians with push consent for that child, then marked sent
//      — or failed, and retried by the next run; the in-app list reads reminders_sent
//   2. late fees due today (computed only: never applied automatically)
//   3. retry gateway events with result error/pending, and events left 'received' by an interrupted run
//   4. end trips still active after 3 hours; count active trips with no fix for 20 minutes (stale)
//   5. prune trip positions older than 30 days
//   6. count expired, unredeemed invites (they already fail redemption on expiry)
//   7. prune command request ids (7 days) and order attempts (2 days)
//   8. retry erasure clean-up (sign-in deletion, gateway scrubbing) for requests still in 'cleanup'

import { CORS, errorResponse, json, coded } from '../_shared/http.ts';
import { rest, restAll, restCount, rpc } from '../_shared/db.ts';
import { runCommand } from '../_shared/persist.ts';
import { system } from '../_shared/authz.ts';
import { deliver } from '../_shared/push.ts';
import { settleEvent } from '../_shared/gateway.ts';
import { finishErasure } from '../_shared/erasure.ts';
import { timingSafeEqual } from '../_shared/razorpay.js';
import { SLICES } from '../_shared/domain/commands.js';
import { remindersDue, lateFeesDueList } from '../_shared/domain/reminders.js';
import { dateInZone, IST_OFFSET_MIN } from '../_shared/domain/dates.js';
import { byId } from '../_shared/domain/people.js';

const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? '';
const TRIP_MAX_MS = 3 * 3600_000, STALE_MS = 20 * 60_000, POSITIONS_DAYS = 30, MAX_EVENT_ATTEMPTS = 10, STRANDED_MS = 10 * 60_000;
const ALL_STEPS = ['reminders', 'gatewayRetries', 'trips', 'positionsPruned', 'invites', 'requestLogsPruned', 'erasureCleanup'];

async function step<T>(report: Record<string, unknown>, only: Set<string>, name: string, fn: () => Promise<T>) {
  if (!only.has(name)) return;
  try { report[name] = await fn(); } catch (e: any) { report[name] = { error: String(e?.message || e).slice(0, 300) }; console.error(`cron-daily ${name}:`, e?.message); }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  try {
    if (!CRON_SECRET) throw coded('NOT_ALLOWED', 'CRON_SECRET is not configured');
    if (!timingSafeEqual(req.headers.get('x-cron-secret') || '', CRON_SECRET)) throw coded('UNAUTHENTICATED', 'Bad cron secret');
    let asked: unknown = null;
    try { asked = (await req.json())?.steps ?? null; } catch { /* empty body: every step */ }
    if (asked !== null && (!Array.isArray(asked) || asked.some(s => !ALL_STEPS.includes(s)))) throw coded('VALIDATION', `steps must be some of ${ALL_STEPS.join(', ')}`);
    const only = new Set<string>((asked as string[] | null) ?? ALL_STEPS);
    const nowMs = Date.now();
    const today = dateInZone(nowMs, IST_OFFSET_MIN);
    const report: Record<string, unknown> = { today, steps: [...only] };

    await step(report, only, 'reminders', async () => {
      const { db } = await rpc('load_slice', { p_collections: SLICES.ledger.reads, p_hints: {} });
      // only rows actually sent are settled; failed ones and abandoned claims come back as due and are re-claimed
      const sentRows = await restAll('reminders_sent?status=eq.sent&select=invoice_id,kind&order=invoice_id,kind');
      const sent = new Set(sentRows.map((r: any) => `${r.invoice_id}|${r.kind}`));
      const due = remindersDue(db, today, sent);
      const claimed: any[] = due.length ? await rpc('claim_reminders', { p_rows: due.map((r: any) => ({ invoiceId: r.invoiceId, kind: r.kind, sentOn: today, text: r.text })) }) : [];
      const mine = new Set(claimed.map((r: any) => `${r.invoice_id}|${r.kind}`));
      // the claim token: finish_reminders changes only this run's claim (not one another run has taken over)
      const tokens = new Map(claimed.map((r: any) => [`${r.invoice_id}|${r.kind}`, r.claim_token]));
      const tokenOf = (r: any) => tokens.get(`${r.invoiceId}|${r.kind}`);
      const toSend = due.filter((r: any) => mine.has(`${r.invoiceId}|${r.kind}`));
      const messages = toSend.map((r: any) => ({ guardianIds: byId(db.students, r.studentId)?.guardianIds || [], studentIds: [r.studentId], purposes: ['push'],
        payload: { title: 'Fee reminder', body: r.text, url: '#/parent/fees', tag: `rem-${r.invoiceId}-${r.kind}` } }));
      let push: any = null, outcome: any[];
      try {
        push = await deliver(messages);
        // sent = every subscribed device took it (or nobody has push for this child: the in-app list is the reminder);
        // any transient failure → failed, retried next run
        outcome = toSend.map((r: any, i: number) => ({ invoiceId: r.invoiceId, kind: r.kind, claimToken: tokenOf(r), status: push.perMessage[i].failed ? 'failed' : 'sent',
          pushSent: push.perMessage[i].sent, error: push.perMessage[i].failed ? `${push.perMessage[i].failed} device(s) failed` : null }));
      } catch (e: any) {
        outcome = toSend.map((r: any) => ({ invoiceId: r.invoiceId, kind: r.kind, claimToken: tokenOf(r), status: 'failed', pushSent: 0, error: String(e?.message || e).slice(0, 300) }));
      }
      const finished = toSend.length ? await rpc('finish_reminders', { p_rows: outcome }) : 0;
      const lateFees = lateFeesDueList(db, today);
      return { invoicesChecked: db.invoices.length, due: due.length, claimed: toSend.length, claimedElsewhere: due.length - toSend.length,
        sent: outcome.filter(o => o.status === 'sent').length, failed: outcome.filter(o => o.status === 'failed').length, finished,
        byKind: toSend.reduce((a: any, r: any) => ({ ...a, [r.kind]: (a[r.kind] || 0) + 1 }), {}),
        push, lateFeesDue: { invoices: lateFees.length, totalPaise: lateFees.reduce((s: number, x: any) => s + x.lateFeePaise, 0) } };
    });

    await step(report, only, 'gatewayRetries', async () => {
      const strandedBefore = new Date(nowMs - STRANDED_MS).toISOString();
      const rows = await restAll(`gateway_events?attempts=lt.${MAX_EVENT_ATTEMPTS}&or=(result.in.(error,pending),and(result.eq.received,received_at.lt.${encodeURIComponent(`"${strandedBefore}"`)}))&select=*&order=received_at,event_id`);
      const out: Record<string, number> = { candidates: rows.length, stranded: rows.filter((r: any) => r.result === 'received').length };
      for (const row of rows) { const r = await settleEvent(row); out[r.result] = (out[r.result] || 0) + 1; }
      return out;
    });

    await step(report, only, 'trips', async () => {
      const active = await restAll('trips?status=eq.active&select=id,doc&order=id');
      let ended = 0, stale = 0;
      for (const t of active) {
        if (nowMs - Date.parse(t.doc.startedAt) > TRIP_MAX_MS) {
          await runCommand('transport.autoEndTrip', [t.id, 'still running 3 hours after it started'], system('cron-daily'));
          ended++;
          continue;
        }
        const last = await rest(`trip_positions?trip_id=eq.${encodeURIComponent(t.id)}&select=ts&order=ts.desc&limit=1`);
        if (!last.length || nowMs - Date.parse(last[0].ts) > STALE_MS) stale++;
      }
      return { active: active.length, ended, stale };
    });

    await step(report, only, 'positionsPruned', async () => {
      const cutoff = new Date(nowMs - POSITIONS_DAYS * 86400_000).toISOString();
      const deleted = await restCount(`trip_positions?ts=lt.${encodeURIComponent(cutoff)}`, { method: 'DELETE' });
      return { olderThan: cutoff, deleted };
    });

    await step(report, only, 'invites', async () => {
      const rows = await restAll('invites?select=doc&order=id');
      const now = new Date(nowMs).toISOString();
      const open = rows.filter((r: any) => !r.doc.redeemedAt && !r.doc.revokedAt);
      return { open: open.filter((r: any) => r.doc.expiresAt >= now).length, expiredUnredeemed: open.filter((r: any) => r.doc.expiresAt < now).length };
    });

    await step(report, only, 'requestLogsPruned', () => rpc('prune_request_logs', {}));

    await step(report, only, 'erasureCleanup', async () => {
      const open = (await restAll('erasure_requests?select=doc&order=id')).map((r: any) => r.doc).filter((d: any) => d.status === 'cleanup');
      const byGuardian = new Map<string, Set<string>>();
      for (const d of open) { if (!byGuardian.has(d.guardianId)) byGuardian.set(d.guardianId, new Set()); for (const u of d.pendingUserIds || []) byGuardian.get(d.guardianId)!.add(u); }
      let done = 0, failed = 0;
      for (const [gid, users] of byGuardian) { const r = await finishErasure(gid, [...users]); if (r.requestDone) done++; else failed++; }
      return { pending: byGuardian.size, done, failed };
    });

    return json({ ok: true, report });
  } catch (e) {
    return errorResponse(e);
  }
});
