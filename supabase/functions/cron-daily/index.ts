// POST /cron-daily (header X-Cron-Secret; verify_jwt=false). Called by pg_cron at 08:00 IST via pg_net.
// Steps, each counted in the response (nothing silently skipped):
//   1. fee reminders (T−3, due day, +7, +14 of the effective due date), deduped by reminders_sent, pushed to
//      guardians with push consent; the in-app list reads reminders_sent
//   2. late fees due today (computed only: never applied automatically)
//   3. retry gateway events with result error/pending (we own retries)
//   4. end trips still active after 3 hours; count active trips with no fix for 20 minutes (stale)
//   5. prune trip positions older than 30 days
//   6. count expired, unredeemed invites (they already fail redemption on expiry)

import { CORS, errorResponse, json, coded } from '../_shared/http.ts';
import { rest, rpc } from '../_shared/db.ts';
import { runCommand } from '../_shared/persist.ts';
import { system } from '../_shared/authz.ts';
import { deliver } from '../_shared/push.ts';
import { settleEvent } from '../_shared/gateway.ts';
import { timingSafeEqual } from '../_shared/razorpay.js';
import { SLICES } from '../_shared/domain/commands.js';
import { remindersDue, lateFeesDueList } from '../_shared/domain/reminders.js';
import { dateInZone, IST_OFFSET_MIN } from '../_shared/domain/dates.js';
import { byId } from '../_shared/domain/people.js';

const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? '';
const TRIP_MAX_MS = 3 * 3600_000, STALE_MS = 20 * 60_000, POSITIONS_DAYS = 30, MAX_EVENT_ATTEMPTS = 10;

async function step<T>(report: Record<string, unknown>, name: string, fn: () => Promise<T>) {
  try { report[name] = await fn(); } catch (e: any) { report[name] = { error: String(e?.message || e).slice(0, 300) }; console.error(`cron-daily ${name}:`, e?.message); }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  try {
    if (!CRON_SECRET) throw coded('NOT_ALLOWED', 'CRON_SECRET is not configured');
    if (!timingSafeEqual(req.headers.get('x-cron-secret') || '', CRON_SECRET)) throw coded('UNAUTHENTICATED', 'Bad cron secret');
    const nowMs = Date.now();
    const today = dateInZone(nowMs, IST_OFFSET_MIN);
    const report: Record<string, unknown> = { today };

    await step(report, 'reminders', async () => {
      const { db } = await rpc('load_slice', { p_collections: SLICES.ledger.reads, p_hints: {} });
      const sentRows = await rest('reminders_sent?select=invoice_id,kind');
      const sent = new Set(sentRows.map((r: any) => `${r.invoice_id}|${r.kind}`));
      const due = remindersDue(db, today, sent);
      if (due.length) {
        await rest('reminders_sent?on_conflict=invoice_id,kind', { method: 'POST', prefer: 'resolution=ignore-duplicates,return=minimal',
          body: due.map((r: any) => ({ invoice_id: r.invoiceId, kind: r.kind, sent_on: today, text: r.text })) });
      }
      const messages = due.map((r: any) => ({ guardianIds: byId(db.students, r.studentId)?.guardianIds || [], purposes: ['push'],
        payload: { title: 'Fee reminder', body: r.text, url: '#/parent/fees', tag: `rem-${r.invoiceId}-${r.kind}` } })).filter((m: any) => m.guardianIds.length);
      const push = await deliver(messages);
      const lateFees = lateFeesDueList(db, today);
      return { invoicesChecked: db.invoices.length, remindersRecorded: due.length, byKind: due.reduce((a: any, r: any) => ({ ...a, [r.kind]: (a[r.kind] || 0) + 1 }), {}),
        push, lateFeesDue: { invoices: lateFees.length, totalPaise: lateFees.reduce((s: number, x: any) => s + x.lateFeePaise, 0) } };
    });

    await step(report, 'gatewayRetries', async () => {
      const rows = await rest(`gateway_events?result=in.(error,pending)&attempts=lt.${MAX_EVENT_ATTEMPTS}&select=*&order=received_at`);
      const out: Record<string, number> = { candidates: rows.length };
      for (const row of rows) { const r = await settleEvent(row); out[r.result] = (out[r.result] || 0) + 1; }
      return out;
    });

    await step(report, 'trips', async () => {
      const active = await rest('trips?status=eq.active&select=id,doc');
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

    await step(report, 'positionsPruned', async () => {
      const cutoff = new Date(nowMs - POSITIONS_DAYS * 86400_000).toISOString();
      const gone = await rest(`trip_positions?ts=lt.${encodeURIComponent(cutoff)}&select=id`, { method: 'DELETE', prefer: 'return=representation' });
      return { olderThan: cutoff, deleted: gone.length };
    });

    await step(report, 'invites', async () => {
      const rows = await rest('invites?select=doc');
      const now = new Date(nowMs).toISOString();
      const open = rows.filter((r: any) => !r.doc.redeemedAt && !r.doc.revokedAt);
      return { open: open.filter((r: any) => r.doc.expiresAt >= now).length, expiredUnredeemed: open.filter((r: any) => r.doc.expiresAt < now).length };
    });

    return json({ ok: true, report });
  } catch (e) {
    return errorResponse(e);
  }
});
