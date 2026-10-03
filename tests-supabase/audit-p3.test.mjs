// Fix round 3 through the real Edge Functions (local stack, fake data). Runs after audit-p2 and before
// functions.test; payments here use a family no other file uses (grd-12 / stu-15).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { local, signIn, fn, command, rest, rpcAs, http, psql, MOCK } from './helpers.mjs';
import { startMock } from '../scripts/mock-razorpay.mjs';
import { signWebhook } from '../supabase/functions/_shared/razorpay.js';

let mock, admin, acct;
const rand = () => randomBytes(4).toString('hex');
const call = (who, name, args, requestId) => fn('command', { name, args, requestId }, who.token);
const cron = steps => fn('cron-daily', { steps }, null, { 'X-Cron-Secret': local().env.CRON_SECRET });
async function linkedParent(guardianId) {
  const who = await signIn(`p3-${guardianId}-${rand()}@example.com`);
  assert.equal((await rest('POST', 'app_users', { user_id: who.userId, role: 'parent', guardian_id: guardianId, status: 'active' }, 'return=minimal')).status, 201);
  assert.equal((await command(who.token, 'consent.give', { purposes: ['app_account'], version: 'v1' })).status, 200);
  return who;
}

before(async () => {
  mock = await startMock();
  [admin, acct] = await Promise.all(['principal@example.com', 'accountant@example.com'].map(signIn));
  for (const programId of ['prog-toddler', 'prog-primary-a', 'prog-primary-b']) await command(acct.token, 'fees.generateInvoices', { academicYearId: 'AY2026-27', programId, installmentName: 'Term 3' });
});
after(async () => { if (mock) await mock.close(); });

test('N5 /command without a request id is refused with 400', async () => {
  const r = await fn('command', { name: 'admin.invites', args: [] }, admin.token);
  assert.equal(r.status, 400, JSON.stringify(r.data));
});

test('N8 the same request id with different arguments is a 409; N7 a replay after revocation is refused', async () => {
  const who = await linkedParent('grd-13');
  const kid = psql(`select student_id from student_guardians where guardian_id = 'grd-13' limit 1`);
  const id = `p3-${randomUUID()}`;
  const args = [{ studentId: kid, subject: 'Hello', body: 'Fake test message' }];
  assert.equal((await call(who, 'threads.open', args, id)).status, 200);
  assert.equal((await call(who, 'threads.open', args, id)).status, 200, 'a plain repeat is replayed');
  const changed = await call(who, 'threads.open', [{ ...args[0], body: 'Different text' }], id);
  assert.equal(changed.status, 409, JSON.stringify(changed.data));
  await rest('PATCH', `app_users?user_id=eq.${who.userId}`, { status: 'revoked' });
  const replay = await call(who, 'threads.open', args, id);
  assert.equal(replay.status, 403, 'a revoked user gets a refusal, not the stored result');
  assert.equal(psql(`select count(*) from threads where guardian_id = 'grd-13' and doc->>'subject' = 'Hello'`), '1');
});

test('N9 an invite code is never kept with the request id; a replay neither shows it again nor issues another', async () => {
  const id = `p3-${randomUUID()}`;
  const first = await call(admin, 'admin.inviteCode', ['grd-19'], id);
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.match(first.data.result.code, /^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
  assert.equal(psql(`select count(*) from app.command_requests where request_id = '${id}' and result::text like '%${first.data.result.code}%'`), '0', 'no plaintext code stored');
  const invites = psql(`select count(*) from invites where guardian_id = 'grd-19'`);
  const again = await call(admin, 'admin.inviteCode', ['grd-19'], id);
  assert.equal(again.status, 200);
  assert.equal(again.data.result.code, null);
  assert.equal(psql(`select count(*) from invites where guardian_id = 'grd-19'`), invites, 'no new code issued');
});

test('N6 an erasure request is done only after the clean-up; one left in cleanup is finished by cron', async () => {
  assert.equal(psql(`select doc->>'status' from erasure_requests where guardian_id = 'grd-07' limit 1`), 'done', 'the erasure in audit-p2 completed its clean-up');
  const id = `era-p3-${rand()}`;
  await rest('POST', 'erasure_requests', { id, doc: { id, guardianId: 'grd-20', requestedAt: new Date().toISOString(), status: 'cleanup', pendingUserIds: [randomUUID()] } }, 'return=minimal');
  const r = await cron(['erasureCleanup']);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.report.erasureCleanup.done >= 1, JSON.stringify(r.data.report));
  assert.equal(psql(`select doc->>'status' from erasure_requests where id = '${id}'`), 'done');
});

test("#9 the data export carries the family's own stored gateway events", async () => {
  const who = await linkedParent('grd-12');
  const snap = (await rpcAs(acct.token, 'my_snapshot')).data;
  const inv = snap.invoices.find(i => i.studentId === 'stu-15' && i.status !== 'cancelled' && i.status !== 'paid');
  assert.ok(inv, 'an open invoice for stu-15');
  const o = await fn('pay-create-order', { studentId: 'stu-15', invoiceIds: [inv.id] }, who.token);
  assert.equal(o.status, 200, JSON.stringify(o.data));
  const paid = (await http('POST', `${MOCK}/__mock/pay`, { body: { orderId: o.data.orderId } })).data;
  const body = JSON.stringify({ entity: 'event', event: 'payment.captured', payload: { payment: { entity: paid.payment } } });
  const eventId = `evt_p3_${rand()}`;
  const wh = await fetch(`${local().fns}/rzp-webhook`, { method: 'POST', body, headers: { 'Content-Type': 'application/json', 'x-razorpay-event-id': eventId, 'x-razorpay-signature': await signWebhook(new TextEncoder().encode(body), local().env.RAZORPAY_WEBHOOK_SECRET) } });
  assert.equal(wh.status, 200);
  const x = JSON.parse((await command(who.token, 'admin.dataExport', 'grd-12')).data.result);
  assert.deepEqual(x.gatewayEvents.map(e => e.eventId), [eventId]);
  assert.equal(JSON.parse((await command(admin.token, 'admin.dataExport', 'grd-13')).data.result).gatewayEvents.length, 0, "another family's events are not included");
});
