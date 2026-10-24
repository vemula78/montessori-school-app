// POST /cron-daily (header X-Cron-Secret; verify_jwt=false). Called by pg_cron at 08:00 IST via pg_net, and every
// 15 minutes with body {"steps":["trips","photosCleanup"]} (stale trips, photo clean-up). Steps, each counted in the response (nothing
// silently skipped; every list is read page by page, never cut at the API's 1000-row cap):
//   1. fee reminders (T−3, due day, +7, +14 of the effective due date): claimed atomically in reminders_sent (a
//      concurrent run gets nothing to send), pushed to guardians with push consent for that child, then marked sent
//      — or failed, and retried by the next run; the in-app list reads reminders_sent
//   2. late fees due today (computed only: never applied automatically)
//   3. retry gateway events with result error/pending, and events left 'received' by an interrupted run
//   4. end trips still active after 3 hours; end a forgotten trip whose route is finished (last stop left, every child
//      marked: a drop 30 minutes after its last stop or with no fix for 20 minutes, a pickup 60 minutes after its last
//      stop) so it stops publishing the driver's location; count active trips with no fix for 20 minutes (stale), and
//      those of them with children not marked (staleWithUnmarked: a child may still be on the bus)
//   5. prune trip positions older than 30 days
//   6. count expired, unredeemed invites (they already fail redemption on expiry)
//   7. prune command request ids (7 days) and order attempts (2 days)
//   8. retry erasure clean-up (sign-in deletion, gateway scrubbing) for requests still in 'cleanup'
//   9. photosConsentSweep: every child with live photos whose photo consent no longer holds → those photos deleting
//  10. retention: what school.retention makes due today (counted per category even when nothing is decided); photos
//      expire, other rows are deleted — only for categories whose period is set; every row re-checked by the command
//  11. photosCleanup: delete the objects of 'deleting' rows (→ deleted/expired), reject uploads abandoned for 2 hours,
//      delete objects of closed rows at once and objects without a row (or with a pending one) after 2 hours
//  12. signInEventsPruned: sign-in activity older than 90 days is deleted (data minimisation)
// Every step runs; the answer is HTTP 500 {ok:false, failedSteps, report} if any step threw, if a privacy step (photo
// consent sweep, retention, photo cleanup, erasure clean-up) reports errors[] / failed > 0, or if gateway events reached
// the retry cap in the last 7 days (failedStepsOf, _shared/cron.js). A failed push in the reminders step is routine
// (phones go offline) and is retried by the next run, so it is counted in the report, not failed. Reminders claimed
// while the VAPID keys are missing stay 'failed' (retried once push works), never 'sent' without a push.
// The full daily run (no steps in the body) leaves its result where the principal sees it: one audit row
// (admin.noteNightlyRun; the principal's home lists a failed run, or none for 26 hours), and, if the function secret
// HEALTHCHECK_URL is set, a ping to that dead-man check (`/fail` when the run failed) so someone is emailed even when
// the job never runs. The ping carries the failed step names only.

import { CORS, errorResponse, json, coded } from '../_shared/http.ts';
import { rest, restAll, restCount, rpc } from '../_shared/db.ts';
import { runCommand } from '../_shared/persist.ts';
import { system } from '../_shared/authz.ts';
import { deliver } from '../_shared/push.ts';
import { settleEvent } from '../_shared/gateway.ts';
import { finishErasure } from '../_shared/erasure.ts';
import { timingSafeEqual } from '../_shared/razorpay.js';
import { SLICES, COMMANDS } from '../_shared/domain/commands.js';
import { retentionPlan } from '../_shared/domain/retention.js';
import { cleanupDeleting, sweepPhotos } from '../_shared/photos.ts';
import { remindersDue, lateFeesDueList } from '../_shared/domain/reminders.js';
import { dateInZone, IST_OFFSET_MIN } from '../_shared/domain/dates.js';
import { byId } from '../_shared/domain/people.js';
import { failedStepsOf, reminderStatus, healthcheckUrl } from '../_shared/cron.js';

const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? '';
const HEALTHCHECK_URL = Deno.env.get('HEALTHCHECK_URL') ?? '';
const TRIP_MAX_MS = 3 * 3600_000, STALE_MS = 20 * 60_000, POSITIONS_DAYS = 30, SIGN_IN_DAYS = 90, MAX_EVENT_ATTEMPTS = 10, STRANDED_MS = 10 * 60_000;
const ALL_STEPS = ['reminders', 'gatewayRetries', 'trips', 'positionsPruned', 'invites', 'requestLogsPruned', 'erasureCleanup', 'photosConsentSweep', 'retention', 'photosCleanup', 'signInEventsPruned'];

async function step<T>(report: Record<string, unknown>, only: Set<string>, name: string, fn: () => Promise<T>) {
  if (!only.has(name)) return;
  try { report[name] = await fn(); } catch (e: any) { report[name] = { error: String(e?.message || e).slice(0, 300) }; console.error(`cron-daily ${name}:`, e?.message); }
}

/** The dead-man check (optional): never fails the run; the step names are the only data sent. */
async function ping(ok: boolean, failedSteps: string[]) {
  const url = healthcheckUrl(HEALTHCHECK_URL, ok);
  if (!url) return HEALTHCHECK_URL ? 'HEALTHCHECK_URL is not an https address' : null;
  try {
    const res = await fetch(url, { method: 'POST', body: failedSteps.join(','), redirect: 'manual', signal: AbortSignal.timeout(10000) });
    await res.body?.cancel();
    return res.status;
  } catch (e: any) { return `error: ${String(e?.message || e).slice(0, 200)}`; }
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
        payload: { title: 'Fee reminder', body: r.text, url: `#/fees/invoice/${r.invoiceId}`, tag: `rem-${r.invoiceId}-${r.kind}` } }));
      let push: any = null, outcome: any[];
      try {
        push = await deliver(messages);
        // sent = every subscribed device took it (or nobody has push for this child: the in-app list is the reminder);
        // any transient failure, or no push keys yet → failed, retried next run
        outcome = toSend.map((r: any, i: number) => ({ invoiceId: r.invoiceId, kind: r.kind, claimToken: tokenOf(r),
          ...reminderStatus(push.perMessage[i], push.skipped), pushSent: push.perMessage[i].sent }));
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
      // events that reached the cap are never retried again: a payment or refund a person must settle by hand
      const weekAgo = new Date(nowMs - 7 * 86400_000).toISOString();
      out.gaveUp = (await restAll(`gateway_events?attempts=gte.${MAX_EVENT_ATTEMPTS}&result=in.(error,pending,received)&received_at=gt.${encodeURIComponent(`"${weekAgo}"`)}&select=event_id&order=event_id`)).length;
      return out;
    });

    await step(report, only, 'trips', async () => {
      const active = await restAll('trips?status=eq.active&select=id,doc&order=id');
      let ended = 0, finished = 0, stale = 0, staleWithUnmarked = 0;
      for (const t of active) {
        if (nowMs - Date.parse(t.doc.startedAt) > TRIP_MAX_MS) {
          await runCommand('transport.autoEndTrip', [t.id, 'still running 3 hours after it started'], system('cron-daily'));
          ended++;
          continue;
        }
        const r = (await runCommand('transport.autoEndIfFinished', [t.id], system('cron-daily'))).result;
        if (r.ended) { finished++; continue; }
        const last = await rest(`trip_positions?trip_id=eq.${encodeURIComponent(t.id)}&select=ts&order=ts.desc&limit=1`);
        if (!last.length || nowMs - Date.parse(last[0].ts) > STALE_MS) { stale++; if (r.unmarked) staleWithUnmarked++; }
      }
      return { active: active.length, ended, finished, stale, staleWithUnmarked };
    });

    await step(report, only, 'positionsPruned', async () => {
      const cutoff = new Date(nowMs - POSITIONS_DAYS * 86400_000).toISOString();
      const deleted = await restCount(`trip_positions?ts=lt.${encodeURIComponent(cutoff)}`, { method: 'DELETE' });
      return { olderThan: cutoff, deleted };
    });

    await step(report, only, 'signInEventsPruned', async () => {
      const cutoff = new Date(nowMs - SIGN_IN_DAYS * 86400_000).toISOString();
      const deleted = await restCount(`sign_in_events?at=lt.${encodeURIComponent(cutoff)}`, { method: 'DELETE' });
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
      // one bad request or one failing guardian must not starve the rest: each is handled and counted on its own
      const byGuardian = new Map<string, Set<string>>();
      let done = 0, failed = 0;
      const errors: string[] = [];
      for (const d of open) {
        if (typeof d.guardianId !== 'string' || !Array.isArray(d.pendingUserIds || [])) { failed++; errors.push(`${d.id}: malformed request`); continue; }
        if (!byGuardian.has(d.guardianId)) byGuardian.set(d.guardianId, new Set());
        for (const u of d.pendingUserIds || []) byGuardian.get(d.guardianId)!.add(u);
      }
      for (const [gid, users] of byGuardian) {
        try { const r = await finishErasure(gid, [...users]); if (r.requestDone) done++; else failed++; }
        catch (e: any) { failed++; errors.push(`${gid}: ${String(e?.message || e).slice(0, 200)}`); }
      }
      return { pending: open.length, done, failed, ...(errors.length ? { errors } : {}) };
    });

    await step(report, only, 'photosConsentSweep', async () => (await runCommand('photos.consentSweep', [], system('cron-daily'))).result);

    await step(report, only, 'retention', async () => {
      const { db } = await rpc('load_slice', { p_collections: SLICES.retention.reads, p_hints: (COMMANDS as any)['retention.purge'].load([]) });
      const plan = retentionPlan(db, today);
      const expire = [...new Set(Object.values(plan.categories).flatMap((c: any) => c.expire))];
      const deletes: Record<string, string[]> = {};
      for (const c of Object.values(plan.categories) as any[]) for (const [col, keys] of Object.entries(c.deletes)) deletes[col] = [...new Set([...(deletes[col] || []), ...(keys as string[])])];
      const due = Object.fromEntries(Object.entries(plan.categories).map(([k, c]: [string, any]) => [k, { months: c.months, students: c.students.length, due: c.due }]));
      const purged = expire.length || Object.keys(deletes).length
        ? (await runCommand('retention.purge', [{ expire, deletes }], system('cron-daily'))).result
        : { requested: 0, expired: 0, deleted: {}, skipped: 0 };
      return { asOf: today, leftWithoutDate: plan.leftWithoutDate.length, due, purged };
    });

    await step(report, only, 'photosCleanup', async () => ({ ...(await cleanupDeleting(null)), ...(await sweepPhotos(nowMs)) }));

    // every step ran; any failure makes the whole run a failure the scheduler can see (audit C6)
    // a step failed if it threw, or if it reports errors or a failure count without throwing (audit R3)
    const failedSteps: string[] = failedStepsOf(report, ALL_STEPS.filter(k => only.has(k)));
    if (asked === null) {
      try { await runCommand('admin.noteNightlyRun', [{ ok: !failedSteps.length, failedSteps }], system('cron-daily')); report.recorded = true; }
      catch (e: any) { report.recorded = { error: String(e?.message || e).slice(0, 300) }; failedSteps.push('recordResult'); console.error('cron-daily recordResult:', e?.message); }
      report.healthcheck = await ping(!failedSteps.length, failedSteps);
    }
    if (failedSteps.length) return json({ ok: false, failedSteps, report }, 500);
    return json({ ok: true, report });
  } catch (e) {
    return errorResponse(e);
  }
});
