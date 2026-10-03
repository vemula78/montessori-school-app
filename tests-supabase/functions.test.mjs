// Edge Function HTTP tests. Needs: supabase start; supabase functions serve --env-file supabase/.env.local
// (the mock gateway is started by this file on port 54399). Run: npm run test:supabase
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import { local, signIn, fn, command, rest, rpcAs, restAs, http, psql, MOCK } from './helpers.mjs';
import { startMock } from '../scripts/mock-razorpay.mjs';
import { signWebhook } from '../supabase/functions/_shared/razorpay.js';

let mock, acct, parentBus, parentSib, admin;
const env = () => local().env;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const mockFromDocker = path => `${env().RAZORPAY_API_BASE}${path}`; // what the edge runtime can reach

before(async () => {
  mock = await startMock();
  [acct, parentBus, parentSib, admin] = await Promise.all(['accountant@example.com', 'parent-bus@example.com', 'parent-siblings@example.com', 'principal@example.com'].map(signIn));
  // open invoices to pay (the seed has Term 1/2 paid for these children); generateInvoices is idempotent
  for (const [programId, installmentName] of [['prog-primary-a', 'Term 2'], ['prog-primary-a', 'Term 3'], ['prog-toddler', 'Term 3']]) {
    const r = await command(acct.token, 'fees.generateInvoices', { academicYearId: 'AY2026-27', programId, installmentName });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
});
after(async () => { if (mock) await mock.close(); });

const snapshot = async who => (await rpcAs(who.token, 'my_snapshot')).data;
const openInvoiceOf = (snap, studentId) => snap.invoices.find(i => i.studentId === studentId && i.status !== 'cancelled' && i.status !== 'paid');
async function webhook(event, payload, { secret = env().RAZORPAY_WEBHOOK_SECRET, eventId = `evt_${randomBytes(7).toString('hex')}`, tamper = false } = {}) {
  const body = JSON.stringify({ entity: 'event', event, payload, created_at: Math.floor(Date.now() / 1000) });
  const sig = await signWebhook(new TextEncoder().encode(body), secret);
  const sent = tamper ? body.replace('"amount":', '"amount": ') : body;
  const res = await fetch(`${local().fns}/rzp-webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': sig, 'x-razorpay-event-id': eventId }, body: sent });
  return { status: res.status, data: await res.json(), eventId };
}
async function newOrder(who, studentId, extra = {}) {
  const inv = openInvoiceOf(await snapshot(who), studentId);
  assert.ok(inv, `an open invoice for ${studentId}`);
  const r = await fn('pay-create-order', { studentId, invoiceIds: [inv.id], ...extra }, who.token);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return { ...r.data, invoice: inv };
}

test('command: a parent calling fees.recordPayment → NOT_ALLOWED; unauthenticated → 401', async () => {
  const r = await command(parentBus.token, 'fees.recordPayment', { studentId: 'stu-03', amountPaise: 10000, mode: 'cash', paidOn: '2026-10-02' });
  assert.equal(r.status, 403);
  assert.equal(r.data.error.code, 'NOT_ALLOWED');
  const u = await fn('command', { name: 'notices.send', args: [{}] }, null);
  assert.equal(u.status, 401);
});

test('pay-create-order: amount comes from the balance (client amount above it ignored); another family\'s child → NOT_ALLOWED', async () => {
  const snap = await snapshot(parentBus);
  const inv = openInvoiceOf(snap, 'stu-03') || openInvoiceOf(snap, 'stu-04');
  const sid = inv.studentId;
  const r = await fn('pay-create-order', { studentId: sid, invoiceIds: [inv.id], amountPaise: 99999999 }, parentBus.token);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.mode, 'test');
  assert.match(r.data.keyId, /^rzp_test_/);
  assert.ok(r.data.amountPaise > 0 && r.data.amountPaise < 99999999);
  assert.equal(r.data.amountPaise, mock.orders.get(r.data.orderId).amount, 'the gateway order carries the server amount');
  const other = await fn('pay-create-order', { studentId: 'stu-01', invoiceIds: [inv.id] }, parentBus.token);
  assert.equal(other.status, 403);
  assert.equal(other.data.error.code, 'NOT_ALLOWED');
});

test('checkout → pay-verify records once (TEST MODE receipt); verify again and pay-status are no-ops', async () => {
  const o = await newOrder(parentBus, 'stu-04');
  const paid = await http('POST', `${MOCK}/__mock/pay`, { body: { orderId: o.orderId } });
  const bad = await fn('pay-verify', { orderId: o.orderId, razorpayPaymentId: paid.data.payment.id, razorpaySignature: '0'.repeat(64) }, parentBus.token);
  assert.equal(bad.status, 403, 'forged signature refused');
  const v = await fn('pay-verify', { orderId: o.orderId, razorpayPaymentId: paid.data.payment.id, razorpaySignature: paid.data.signature }, parentBus.token);
  assert.equal(v.status, 200, JSON.stringify(v.data));
  assert.equal(v.data.mode, 'online'); assert.equal(v.data.gatewayMode, 'test'); assert.equal(v.data.gatewayPaymentId, paid.data.payment.id);
  const again = await fn('pay-verify', { orderId: o.orderId, razorpayPaymentId: paid.data.payment.id, razorpaySignature: paid.data.signature }, parentBus.token);
  assert.equal(again.data.id, v.data.id);
  const st = await fn('pay-status', { orderId: o.orderId }, parentBus.token);
  assert.equal(st.data.status, 'paid'); assert.equal(st.data.payment.id, v.data.id);
  const rows = (await rest('GET', `payments?gateway_payment_id=eq.${paid.data.payment.id}&select=id`)).data;
  assert.equal(rows.length, 1, 'exactly one ledger payment');
});

test('browser closed before verify: pay-status fetches the captured payment and records it', async () => {
  const o = await newOrder(parentBus, 'stu-03');
  const paid = await http('POST', `${MOCK}/__mock/pay`, { body: { orderId: o.orderId } });
  const st = await fn('pay-status', { orderId: o.orderId }, parentBus.token);
  assert.equal(st.status, 200, JSON.stringify(st.data));
  assert.ok(['paid', 'amount_mismatch'].includes(st.data.status));
  assert.equal(st.data.payment.gatewayPaymentId, paid.data.payment.id);
});

test('webhook: valid → 200 + event + payment; tampered → 401; replay → 200 and still one payment', async () => {
  const o = await newOrder(acct, 'stu-09');
  const paid = await http('POST', `${MOCK}/__mock/pay`, { body: { orderId: o.orderId } });
  const payload = { payment: { entity: paid.data.payment } };
  const t = await webhook('payment.captured', payload, { tamper: true });
  assert.equal(t.status, 401);
  const wrong = await webhook('payment.captured', payload, { secret: 'not-the-secret' });
  assert.equal(wrong.status, 401);
  const w = await webhook('payment.captured', payload);
  assert.equal(w.status, 200, JSON.stringify(w.data));
  assert.equal(w.data.result, 'ok');
  const r = await webhook('payment.captured', payload, { eventId: w.eventId });
  assert.equal(r.status, 200); assert.equal(r.data.duplicate, true);
  const again = await webhook('order.paid', payload); // a different event for the same capture
  assert.equal(again.data.result, 'ok');
  const rows = (await rest('GET', `payments?gateway_payment_id=eq.${paid.data.payment.id}&select=id`)).data;
  assert.equal(rows.length, 1);
  const ev = (await rest('GET', `gateway_events?event_id=eq.${w.eventId}&select=result`)).data;
  assert.deepEqual(ev, [{ result: 'ok' }]);
  const order = (await rest('GET', `gateway_orders?id=eq.${o.orderId}&select=status,payment_id`)).data[0];
  assert.equal(order.status, 'paid');
});

test('webhook: a refund that arrives before its capture is stored pending, then processed when the capture lands', async () => {
  const o = await newOrder(acct, 'stu-09');
  const paid = (await http('POST', `${MOCK}/__mock/pay`, { body: { orderId: o.orderId } })).data.payment;
  const rf = (await http('POST', `${MOCK}/__mock/refund`, { body: { paymentId: paid.id, amount: Math.min(5000, paid.amount) } })).data;
  const early = await webhook('refund.processed', { refund: { entity: rf } });
  assert.equal(early.data.result, 'pending');
  const failed = await webhook('payment.failed', { payment: { entity: { ...paid, status: 'failed', error_description: 'late failure' } } });
  assert.equal(failed.data.result, 'ok');
  const cap = await webhook('payment.captured', { payment: { entity: paid } });
  assert.equal(cap.data.result, 'ok');
  const ev = (await rest('GET', `gateway_events?event_id=eq.${early.eventId}&select=result`)).data[0];
  assert.equal(ev.result, 'ok', 'the pending refund was processed after the capture');
  const refunds = (await rest('GET', `refunds?gateway_refund_id=eq.${rf.id}&select=doc`)).data;
  assert.equal(refunds.reduce((s, r) => s + r.doc.amountPaise, 0), rf.amount);
  const order = (await rest('GET', `gateway_orders?id=eq.${o.orderId}&select=status`)).data[0];
  assert.equal(order.status, 'paid', 'a failure event after the capture changes nothing');
  const dup = await webhook('refund.created', { refund: { entity: rf } });
  assert.equal(dup.data.result, 'ok');
  assert.equal((await rest('GET', `refunds?gateway_refund_id=eq.${rf.id}&select=id`)).data.length, refunds.length, 'refund recorded once');
});

test('20 parallel fees.recordPayment → 20 distinct, contiguous receipt numbers (closes deferred #1)', async () => {
  const runs = await Promise.all(Array.from({ length: 20 }, () => command(acct.token, 'fees.recordPayment', { studentId: 'stu-14', amountPaise: 100, mode: 'cash', paidOn: '2026-10-02' })));
  const bad = runs.filter(r => r.status !== 200);
  assert.equal(bad.length, 0, JSON.stringify(bad.map(b => b.data)));
  const nums = runs.map(r => r.data.result.receiptNumber);
  assert.equal(new Set(nums).size, 20, 'distinct');
  const n = nums.map(x => Number(x.split('/')[2])).sort((a, b) => a - b);
  assert.equal(n[19] - n[0], 19, `contiguous ${n[0]}..${n[19]}`);
  const gaps = psql(`select count(*) from (select substring(receipt_number from '\\d+$')::int n from payments where receipt_number like 'RCP/26-27/%') x
    where n > 1 and not exists (select 1 from payments p where p.receipt_number = 'RCP/26-27/' || lpad((x.n - 1)::text, 4, '0'))`);
  assert.equal(gaps, '0', 'no gap anywhere in the year');
  const counter = psql(`select n from counters where kind = 'receipt' and academic_year_id = 'AY2026-27'`);
  const max = psql(`select max(substring(receipt_number from '\\d+$')::int) from payments where receipt_number like 'RCP/26-27/%'`);
  assert.equal(counter, max, 'counter equals the highest number issued');
});

function fakeSubscription(path) {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { endpoint: mockFromDocker(path), keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
}

test('web push: VAPID aes128gcm delivery with TTL to a consenting parent; a 410 subscription is deleted', async () => {
  const ok = fakeSubscription(`/push/ok-${randomBytes(4).toString('hex')}`);
  const gone = fakeSubscription(`/push/gone/${randomBytes(4).toString('hex')}`);
  for (const s of [ok, gone]) {
    const r = await http('POST', `${local().url}/rest/v1/push_subscriptions`, { body: { endpoint: s.endpoint, p256dh: s.keys.p256dh, auth: s.keys.auth }, headers: { apikey: local().anon, Authorization: `Bearer ${parentBus.token}` } });
    assert.equal(r.status, 201, JSON.stringify(r.data));
  }
  const mine = await restAs(parentBus.token, 'push_subscriptions?select=endpoint');
  assert.equal(mine.data.filter(x => x.endpoint === ok.endpoint || x.endpoint === gone.endpoint).length, 2);
  const others = await restAs(parentSib.token, 'push_subscriptions?select=endpoint');
  assert.equal(others.data.length, 0, "another parent cannot read them");
  const before = mock.pushLog.length;
  const pay = await command(acct.token, 'fees.recordPayment', { studentId: 'stu-03', amountPaise: 100, mode: 'cash', paidOn: '2026-10-02' });
  assert.equal(pay.status, 200, JSON.stringify(pay.data));
  for (let i = 0; i < 20 && mock.pushLog.length < before + 2; i++) await sleep(100);
  const hits = mock.pushLog.slice(before);
  const okHit = hits.find(h => ok.endpoint.endsWith(h.path));
  assert.ok(okHit, 'delivered to the subscription');
  assert.match(okHit.headers.authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
  assert.equal(okHit.headers['content-encoding'], 'aes128gcm');
  assert.equal(okHit.headers.ttl, '3600');
  assert.ok(okHit.bytes > 0);
  const left = (await rest('GET', `push_subscriptions?endpoint=in.("${ok.endpoint}","${gone.endpoint}")&select=endpoint`)).data.map(r => r.endpoint);
  assert.deepEqual(left, [ok.endpoint], 'the 410 subscription was deleted');
  // a parent without push consent gets nothing
  const sib = fakeSubscription(`/push/sib-${randomBytes(4).toString('hex')}`);
  await http('POST', `${local().url}/rest/v1/push_subscriptions`, { body: { endpoint: sib.endpoint, p256dh: sib.keys.p256dh, auth: sib.keys.auth }, headers: { apikey: local().anon, Authorization: `Bearer ${parentSib.token}` } });
  const b2 = mock.pushLog.length;
  await command(acct.token, 'fees.recordPayment', { studentId: 'stu-01', amountPaise: 100, mode: 'cash', paidOn: '2026-10-02' });
  await sleep(500);
  assert.equal(mock.pushLog.slice(b2).filter(h => sib.endpoint.endsWith(h.path)).length, 0, 'no push without push consent');
  await rest('DELETE', `push_subscriptions?endpoint=in.("${ok.endpoint}","${sib.endpoint}")`);
});

test('invite → redeem with child DOB → consent; wrong DOB and reuse are refused and audited', async () => {
  const inv = await command(admin.token, 'admin.inviteCode', 'grd-05');
  assert.equal(inv.status, 200, JSON.stringify(inv.data));
  assert.match(inv.data.result.code, /^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
  assert.equal(psql(`select count(*) from invites where doc->>'codeHash' is not null and doc::text like '%${inv.data.result.code}%'`), '0', 'the plain code is never stored');
  const newbie = await signIn(`invitee-${randomBytes(3).toString('hex')}@example.com`);
  assert.equal((await rpcAs(newbie.token, 'my_snapshot')).data.status, 'unlinked');
  const wrong = await command(newbie.token, 'auth.redeemInvite', inv.data.result.code, '2001-01-01');
  assert.equal(wrong.status, 422); assert.match(wrong.data.error.message, /date of birth/);
  const dob = psql(`select doc->>'dob' from students where id = 'stu-09'`);
  const ok = await command(newbie.token, 'auth.redeemInvite', inv.data.result.code.toLowerCase().replace('-', ' '), dob);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.deepEqual(ok.data.result.children.map(c => c.id), ['stu-09']);
  const reuse = await command((await signIn(`invitee2-${randomBytes(3).toString('hex')}@example.com`)).token, 'auth.redeemInvite', inv.data.result.code, dob);
  assert.equal(reuse.status, 422); assert.match(reuse.data.error.message, /already been used/);
  const snap = (await rpcAs(newbie.token, 'my_snapshot')).data;
  assert.equal(snap.status, 'active'); assert.deepEqual(snap.students.map(s => s.id), ['stu-09']);
  const c = await command(newbie.token, 'consent.give', { purposes: ['app_account', 'bus_live'], version: 'v1' });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  assert.equal(c.data.result.purposes.bus_live.given, true);
  const ev = psql(`select doc->'evidence'->>'method' from consents where guardian_id = 'grd-05' and purpose = 'app_account' limit 1`);
  assert.equal(ev, 'invite_code+child_dob+email_otp');
  assert.ok(Number(psql(`select count(*) from audit_log where entity = 'invite' and doc->>'action' = 'redeemFailed'`)) >= 2, 'failed attempts audited');
});

test('cron-daily: secret required; runs every step and reports counts', async () => {
  const no = await fn('cron-daily', {}, null);
  assert.equal(no.status, 401);
  const r = await fn('cron-daily', {}, null, { 'X-Cron-Secret': env().CRON_SECRET });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const rep = r.data.report;
  for (const k of ['reminders', 'gatewayRetries', 'trips', 'positionsPruned', 'invites']) assert.ok(rep[k] && !rep[k].error, `${k}: ${JSON.stringify(rep[k])}`);
  assert.ok(rep.reminders.invoicesChecked > 0);
  const again = await fn('cron-daily', {}, null, { 'X-Cron-Secret': env().CRON_SECRET });
  assert.equal(again.data.report.reminders.remindersRecorded, 0, 'reminders are deduped');
});
