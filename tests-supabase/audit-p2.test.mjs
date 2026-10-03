// Phase 2 audit fixes, through the real Edge Functions and PostgREST (local stack, fake data only).
// Needs: supabase start (+ db reset), supabase functions serve --env-file supabase/.env.local. Starts its own mock
// gateway on 54399. Run: npm run test:supabase. Runs before functions.test.mjs on the same data: payments here use
// children that file does not (stu-05..08), so its open invoices are left alone.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import { local, signIn, fn, command, rest, rpcAs, restAs, http, psql, MOCK } from './helpers.mjs';
import { startMock } from '../scripts/mock-razorpay.mjs';
import { signWebhook } from '../supabase/functions/_shared/razorpay.js';

let mock, acct, admin, parentBus;
const env = () => local().env;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand = () => randomBytes(4).toString('hex');
const today = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10); // IST
const snapshot = async who => (await rpcAs(who.token, 'my_snapshot')).data;
const balanceOf = async (who, invoiceId) => {
  const s = await snapshot(who);
  const inv = s.invoices.find(i => i.id === invoiceId);
  const paid = s.payments.filter(p => p.status === 'valid').flatMap(p => p.allocations).filter(a => a.invoiceId === invoiceId).reduce((x, a) => x + a.amountPaise, 0);
  const refunded = s.refunds.filter(r => r.invoiceId === invoiceId).reduce((x, r) => x + r.amountPaise, 0);
  return inv.lines.reduce((x, l) => x + l.amountPaise, 0) - inv.concessions.reduce((x, c) => x + c.amountPaise, 0) - paid + refunded;
};
const openInvoiceOf = async (who, studentId) => {
  const s = await snapshot(who);
  for (const i of s.invoices.filter(x => x.studentId === studentId && x.status !== 'cancelled')) if (await balanceOf(who, i.id) > 0) return i;
  return null;
};
async function webhook(event, payload, eventId = `evt_${randomBytes(7).toString('hex')}`) {
  const body = JSON.stringify({ entity: 'event', event, payload, created_at: Math.floor(Date.now() / 1000) });
  const sig = await signWebhook(new TextEncoder().encode(body), env().RAZORPAY_WEBHOOK_SECRET);
  const res = await fetch(`${local().fns}/rzp-webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': sig, 'x-razorpay-event-id': eventId }, body });
  return { status: res.status, data: await res.json(), eventId };
}
async function paidOrder(who, studentId) {
  const inv = await openInvoiceOf(who, studentId);
  assert.ok(inv, `an open invoice for ${studentId}`);
  const o = await fn('pay-create-order', { studentId, invoiceIds: [inv.id] }, who.token);
  assert.equal(o.status, 200, JSON.stringify(o.data));
  const paid = (await http('POST', `${MOCK}/__mock/pay`, { body: { orderId: o.data.orderId } })).data;
  return { orderId: o.data.orderId, invoice: inv, payment: paid.payment, signature: paid.signature };
}
function subscription(path) {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { endpoint: `${env().RAZORPAY_API_BASE}${path}`, p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') };
}
const subscribe = (who, s) => http('POST', `${local().url}/rest/v1/push_subscriptions`, { body: s, headers: { apikey: local().anon, Authorization: `Bearer ${who.token}` } });
const cron = steps => fn('cron-daily', steps ? { steps } : {}, null, { 'X-Cron-Secret': env().CRON_SECRET });
/** A fresh sign-in linked (as a redeemed invite would) to a guardian; consent given through the command. */
async function linkedParent(guardianId, purposes = ['app_account']) {
  const who = await signIn(`p2-${guardianId}-${rand()}@example.com`);
  const r = await rest('POST', 'app_users', { user_id: who.userId, role: 'parent', guardian_id: guardianId, status: 'active' }, 'return=minimal');
  assert.equal(r.status, 201, JSON.stringify(r.data));
  if (purposes.length) { const c = await command(who.token, 'consent.give', { purposes, version: 'v1' }); assert.equal(c.status, 200, JSON.stringify(c.data)); }
  return who;
}

before(async () => {
  mock = await startMock();
  [acct, admin, parentBus] = await Promise.all(['accountant@example.com', 'principal@example.com', 'parent-bus@example.com'].map(signIn));
  for (const [programId, installmentName] of [['prog-primary-a', 'Term 2'], ['prog-primary-a', 'Term 3'], ['prog-toddler', 'Term 3']]) {
    const r = await command(acct.token, 'fees.generateInvoices', { academicYearId: 'AY2026-27', programId, installmentName });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
});
after(async () => { if (mock) await mock.close(); });

// ---------------------------------------------------------------- blockers
test('#1 a password sign-up for a staff email gets no session and no role; confirming the mailbox links it and voids that password', async () => {
  const L = local();
  const email = 'teacher-toddler@example.com'; // a staff contact with no sign-in yet
  const password = `Chosen-${rand()}-Pw1!`;
  const up = await http('POST', `${L.url}/auth/v1/signup`, { body: { email, password }, headers: { apikey: L.anon } });
  assert.equal(up.status, 200, JSON.stringify(up.data));
  assert.ok(!up.data.access_token, 'no session before the mailbox is confirmed');
  const uid = up.data.id || up.data.user?.id;
  assert.equal(psql(`select count(*) from public.app_users where user_id = '${uid}'`), '0', 'no staff role for an unconfirmed mailbox');
  const login = await http('POST', `${L.url}/auth/v1/token?grant_type=password`, { body: { email, password }, headers: { apikey: L.anon } });
  assert.notEqual(login.status, 200, 'cannot sign in with the password before confirmation');
  // the real owner proves the mailbox (simulated by the admin API setting email_confirmed_at)
  const conf = await http('PUT', `${L.url}/auth/v1/admin/users/${uid}`, { body: { email_confirm: true }, headers: { apikey: L.service, Authorization: `Bearer ${L.service}` } });
  assert.equal(conf.status, 200, JSON.stringify(conf.data));
  assert.equal(psql(`select role from public.app_users where user_id = '${uid}'`), 'teacher', 'linked once confirmed');
  const after = await http('POST', `${L.url}/auth/v1/token?grant_type=password`, { body: { email, password }, headers: { apikey: L.anon } });
  assert.notEqual(after.status, 200, 'the password chosen before confirmation does not work');
});

test('#2 a parent calling fees.mockOnlinePayment directly is refused and the balance is unchanged', async () => {
  const inv = await openInvoiceOf(parentBus, 'stu-04');
  assert.ok(inv);
  const before = await balanceOf(parentBus, inv.id);
  const mocks = psql(`select count(*) from payments where doc->>'mode' = 'online-mock'`);
  const r = await command(parentBus.token, 'fees.mockOnlinePayment', { studentId: 'stu-04', invoiceIds: [inv.id] });
  assert.equal(r.status, 403, JSON.stringify(r.data));
  assert.equal(r.data.error.code, 'NOT_ALLOWED');
  assert.equal(await balanceOf(parentBus, inv.id), before, 'balance unchanged');
  assert.equal(psql(`select count(*) from payments where doc->>'mode' = 'online-mock'`), mocks, 'no receipt issued');
});

// ---------------------------------------------------------------- consent and links
test('#6 before app_account consent a linked parent gets no child data and no parent command; after it, both work', async () => {
  const who = await signIn(`p2-noconsent-${rand()}@example.com`);
  await rest('POST', 'app_users', { user_id: who.userId, role: 'parent', guardian_id: 'grd-08', status: 'active' }, 'return=minimal');
  const s = await snapshot(who);
  assert.equal(s.status, 'active');
  assert.ok(s.students.length > 0, 'the consent screen can list the children');
  assert.deepEqual([s.invoices.length, s.payments.length, s.threads.length, s.attendance.length], [0, 0, 0, 0]);
  const kid = s.students[0].id;
  const inv = (await snapshot(acct)).invoices.find(i => i.studentId === kid);
  const blocked = await fn('pay-create-order', { studentId: kid, invoiceIds: [inv.id] }, who.token);
  assert.equal(blocked.status, 403);
  assert.match(blocked.data.error.message, /privacy notice/);
  const t = await command(who.token, 'threads.open', { studentId: kid, subject: 'Hello', body: 'Fake test message' });
  assert.equal(t.status, 403);
  assert.equal((await command(who.token, 'consent.give', { purposes: ['app_account'], version: 'v1' })).status, 200);
  assert.ok((await snapshot(who)).invoices.length > 0);
  assert.equal((await command(who.token, 'threads.open', { studentId: kid, subject: 'Hello', body: 'Fake test message' })).status, 200);
});

test('#12 two simultaneous redemptions by one unlinked sign-in link it once, never twice', async () => {
  const codes = [];
  for (const gid of ['grd-11', 'grd-21']) {
    const r = await command(admin.token, 'admin.inviteCode', gid);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    codes.push({ gid, code: r.data.result.code, dob: psql(`select s.doc->>'dob' from students s join student_guardians sg on sg.student_id = s.id where sg.guardian_id = '${gid}' limit 1`) });
  }
  const who = await signIn(`p2-race-${rand()}@example.com`);
  const rs = await Promise.all(codes.map(c => command(who.token, 'auth.redeemInvite', c.code, c.dob)));
  assert.deepEqual(rs.map(r => r.status).sort(), [200, 422], JSON.stringify(rs.map(r => r.data)));
  const won = codes[rs.findIndex(r => r.status === 200)];
  assert.equal(psql(`select guardian_id from app_users where user_id = '${who.userId}'`), won.gid);
  assert.equal(psql(`select count(*) from invites where doc->>'redeemedBy' = '${who.userId}'`), '1', 'only one invite is consumed');
});

// ---------------------------------------------------------------- requests and orders
test('#20 a repeated request id returns the first result and records nothing twice; another user cannot reuse it', async () => {
  const requestId = `p2-req-${rand()}${rand()}`;
  const ref = `P2-REQ-${rand()}`;
  const args = [{ studentId: 'stu-14', amountPaise: 100, mode: 'cash', reference: ref, paidOn: today() }];
  const [a, b] = await Promise.all([fn('command', { name: 'fees.recordPayment', args, requestId }, acct.token), fn('command', { name: 'fees.recordPayment', args, requestId }, acct.token)]);
  assert.equal(a.status, 200, JSON.stringify(a.data)); assert.equal(b.status, 200, JSON.stringify(b.data));
  const c = await fn('command', { name: 'fees.recordPayment', args, requestId }, acct.token);
  assert.equal(c.data.result.receiptNumber, a.data.result.receiptNumber);
  assert.equal(b.data.result.receiptNumber, a.data.result.receiptNumber);
  assert.equal(psql(`select count(*) from payments where doc->>'reference' = '${ref}'`), '1', 'one payment for one request');
  const other = await fn('command', { name: 'fees.recordPayment', args, requestId }, admin.token);
  assert.equal(other.status, 422);
});

test('#22 every order gets its own gateway receipt (the gateway refuses a reused one)', async () => {
  const inv = await openInvoiceOf(acct, 'stu-09');
  const o1 = await fn('pay-create-order', { studentId: 'stu-09', invoiceIds: [inv.id] }, acct.token);
  const o2 = await fn('pay-create-order', { studentId: 'stu-09', invoiceIds: [inv.id] }, acct.token);
  assert.equal(o1.status, 200, JSON.stringify(o1.data)); assert.equal(o2.status, 200, JSON.stringify(o2.data));
  const r1 = mock.orders.get(o1.data.orderId).receipt, r2 = mock.orders.get(o2.data.orderId).receipt;
  assert.notEqual(r1, r2);
  assert.ok(r1.length <= 40 && r2.length <= 40);
});

test('#42 twelve simultaneous order requests from one sign-in: exactly ten get through', async () => {
  const who = await linkedParent('grd-05');
  const inv = await openInvoiceOf(acct, 'stu-09');
  const rs = await Promise.all(Array.from({ length: 12 }, () => fn('pay-create-order', { studentId: 'stu-09', invoiceIds: [inv.id] }, who.token)));
  const by = rs.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] || 0) + 1 }), {});
  assert.deepEqual(by, { 200: 10, 429: 2 }, JSON.stringify(rs.filter(r => r.status !== 200).map(r => r.data)));
});

// ---------------------------------------------------------------- gateway events and refunds
test('#16 a pending refund event books nothing; the processed event books it once', async () => {
  const p = await paidOrder(acct, 'stu-06');
  assert.equal((await webhook('payment.captured', { payment: { entity: p.payment } })).data.result, 'ok');
  const rf = (await http('POST', `${MOCK}/__mock/refund`, { body: { paymentId: p.payment.id, amount: 5000, status: 'pending' } })).data;
  const created = await webhook('refund.created', { refund: { entity: rf } });
  assert.equal(created.data.result, 'ignored');
  assert.equal((await rest('GET', `refunds?gateway_refund_id=eq.${rf.id}&select=id`)).data.length, 0, 'nothing booked while pending');
  const failed = await webhook('refund.failed', { refund: { entity: { ...rf, status: 'failed' } } });
  assert.equal(failed.data.result, 'ignored');
  const processed = await webhook('refund.processed', { refund: { entity: { ...rf, status: 'processed' } } });
  assert.equal(processed.data.result, 'ok');
  const rows = (await rest('GET', `refunds?gateway_refund_id=eq.${rf.id}&select=doc`)).data;
  assert.equal(rows.reduce((s, r) => s + r.doc.amountPaise, 0), 5000);
});

test('#18 the accountant cannot cancel a payment captured by the gateway', async () => {
  const p = await paidOrder(acct, 'stu-08');
  const v = await fn('pay-verify', { orderId: p.orderId, razorpayPaymentId: p.payment.id, razorpaySignature: p.signature }, acct.token);
  assert.equal(v.status, 200, JSON.stringify(v.data));
  const c = await command(acct.token, 'fees.cancelPayment', v.data.id, 'customer asked');
  assert.equal(c.status, 422);
  assert.match(c.data.error.message, /refund/);
  assert.equal(psql(`select status from payments where id = '${v.data.id}'`), 'valid');
});

test('#21 an event stored but never processed is processed by its redelivery and by cron', async () => {
  const stranded = async studentId => {
    const p = await paidOrder(acct, studentId);
    const eventId = `evt_p2_${rand()}`;
    const payload = { entity: 'event', event: 'payment.captured', payload: { payment: { entity: p.payment } } };
    const ins = await rest('POST', 'gateway_events', { event_id: eventId, event: 'payment.captured', payload, result: 'received', received_at: new Date(Date.now() - 3600_000).toISOString() }, 'return=minimal');
    assert.equal(ins.status, 201, JSON.stringify(ins.data));
    return { p, eventId };
  };
  const a = await stranded('stu-05');
  const redelivered = await webhook('payment.captured', { payment: { entity: a.p.payment } }, a.eventId);
  assert.equal(redelivered.data.duplicate, true);
  assert.equal(redelivered.data.result, 'ok');
  assert.equal((await rest('GET', `payments?gateway_payment_id=eq.${a.p.payment.id}&select=id`)).data.length, 1);
  const b = await stranded('stu-07');
  const r = await cron(['gatewayRetries']);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.report.gatewayRetries.stranded >= 1, JSON.stringify(r.data.report));
  assert.equal((await rest('GET', `gateway_events?event_id=eq.${b.eventId}&select=result`)).data[0].result, 'ok');
  assert.equal((await rest('GET', `payments?gateway_payment_id=eq.${b.p.payment.id}&select=id`)).data.length, 1);
});

// ---------------------------------------------------------------- push
test('#15 a push subscription on an internal or unknown host is never contacted and is removed', async () => {
  const bad = [{ endpoint: 'https://169.254.169.254/latest/meta-data', p256dh: subscription('/x').p256dh, auth: randomBytes(16).toString('base64url') },
    { endpoint: `https://evil-${rand()}.example.com/push`, p256dh: subscription('/x').p256dh, auth: randomBytes(16).toString('base64url') }];
  const good = subscription(`/push/p2ok-${rand()}`);
  for (const s of [...bad, good]) assert.equal((await subscribe(parentBus, s)).status, 201);
  const before = mock.pushLog.length;
  const pay = await command(acct.token, 'fees.recordPayment', { studentId: 'stu-03', amountPaise: 100, mode: 'cash', paidOn: today() });
  assert.equal(pay.status, 200, JSON.stringify(pay.data));
  for (let i = 0; i < 30 && !mock.pushLog.slice(before).some(h => good.endpoint.endsWith(h.path)); i++) await sleep(100);
  assert.ok(mock.pushLog.slice(before).some(h => good.endpoint.endsWith(h.path)), 'the push service endpoint still gets it');
  const left = (await rest('GET', `push_subscriptions?endpoint=in.(${[...bad, good].map(s => `"${s.endpoint}"`).join(',')})&select=endpoint`)).data.map(r => r.endpoint);
  assert.deepEqual(left, [good.endpoint], 'internal/unknown endpoints were deleted');
  await rest('DELETE', `push_subscriptions?endpoint=eq.${encodeURIComponent(good.endpoint)}`);
});

test('#7 push consent for one child does not cover a sibling', async () => {
  const good = subscription(`/push/p2sib-${rand()}`);
  assert.equal((await subscribe(parentBus, good)).status, 201);
  const row = 'cns-seed-grd-02-stu-04-push';
  const doc = JSON.parse(psql(`select doc::text from consents where id = '${row}'`));
  await rest('PATCH', `consents?id=eq.${row}`, { doc: { ...doc, withdrawnAt: new Date().toISOString() } });
  try {
    const before = mock.pushLog.length;
    await command(acct.token, 'fees.recordPayment', { studentId: 'stu-04', amountPaise: 100, mode: 'cash', paidOn: today() });
    await sleep(800);
    assert.equal(mock.pushLog.slice(before).filter(h => good.endpoint.endsWith(h.path)).length, 0, 'no push about the child without push consent');
    await command(acct.token, 'fees.recordPayment', { studentId: 'stu-03', amountPaise: 100, mode: 'cash', paidOn: today() });
    for (let i = 0; i < 30 && !mock.pushLog.slice(before).some(h => good.endpoint.endsWith(h.path)); i++) await sleep(100);
    assert.equal(mock.pushLog.slice(before).filter(h => good.endpoint.endsWith(h.path)).length, 1, 'the consented child still gets one');
  } finally {
    await rest('PATCH', `consents?id=eq.${row}`, { doc });
    await rest('DELETE', `push_subscriptions?endpoint=eq.${encodeURIComponent(good.endpoint)}`);
  }
});

test('#28 reminders: a failed push is retried by the next run; two simultaneous runs send each reminder once', async () => {
  // an opening balance due today for a child whose guardian has push consent, so a reminder is due now
  const opening = async () => {
    const ins = `P2 reminder ${rand()}`;
    const st = await command(acct.token, 'import.stage', { kind: 'fees', mapping: { admissionNo: 'adm', installment: 'ins', dueDate: 'due', outstandingPaise: 'amt' },
      rows: [{ line: 2, values: { adm: 'ADM-26-003', ins, due: today(), amt: '123' } }] });
    assert.equal(st.status, 200, JSON.stringify(st.data));
    const cm = await command(acct.token, 'import.commit', st.data.result.batchId);
    assert.equal(cm.status, 200, JSON.stringify(cm.data));
    return psql(`select id from invoices where doc->>'installmentName' = 'Opening balance — ${ins}'`);
  };
  const rowOf = id => psql(`select status || '|' || attempts from reminders_sent where invoice_id = '${id}'`);
  let r = await cron(['reminders']); // settle whatever is already due, so the runs below concern only our invoices
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const inv1 = await opening();
  const failing = subscription(`/push/fail/p2-${rand()}`);
  assert.equal((await subscribe(parentBus, failing)).status, 201);
  r = await cron(['reminders']);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const rep = r.data.report.reminders;
  assert.equal(rep.claimed + rep.claimedElsewhere, rep.due, JSON.stringify(rep));
  assert.equal(rep.sent + rep.failed, rep.claimed);
  assert.equal(rowOf(inv1), 'failed|1', 'not marked sent when the push failed');
  await rest('DELETE', `push_subscriptions?endpoint=eq.${encodeURIComponent(failing.endpoint)}`);
  const ok = subscription(`/push/p2rem-${rand()}`);
  assert.equal((await subscribe(parentBus, ok)).status, 201);
  const before = mock.pushLog.length;
  r = await cron(['reminders']);
  assert.equal(rowOf(inv1), 'sent|2', 'retried and sent by the next run');
  assert.ok(mock.pushLog.slice(before).some(h => ok.endpoint.endsWith(h.path)), 'the retried reminder reached the device');
  // two runs at once: the new reminder is claimed by exactly one of them
  const inv2 = await opening();
  const [x, y] = await Promise.all([cron(['reminders']), cron(['reminders'])]);
  assert.equal(x.status, 200); assert.equal(y.status, 200);
  assert.equal(rowOf(inv2), 'sent|1', 'claimed once, sent once');
  assert.equal(x.data.report.reminders.claimed + y.data.report.reminders.claimed, 1, JSON.stringify([x.data.report.reminders, y.data.report.reminders]));
  await rest('DELETE', `push_subscriptions?endpoint=eq.${encodeURIComponent(ok.endpoint)}`);
});

test('#38 cron can run the stale-trip step alone (the 15-minute job)', async () => {
  const r = await cron(['trips']);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.report.steps, ['trips']);
  assert.ok(r.data.report.trips && !r.data.report.trips.error);
  assert.equal(r.data.report.reminders, undefined);
  assert.equal((await cron(['nope'])).status, 422);
});

// ---------------------------------------------------------------- erasure and access
test('#8 erasure deletes the sign-in, its push devices and payer details in stored gateway events', async () => {
  const who = await linkedParent('grd-07');
  assert.equal((await subscribe(who, subscription(`/push/p2erase-${rand()}`))).status, 201);
  const orderId = `order_P2ERASE${rand()}`;
  await rest('POST', 'gateway_orders', { id: orderId, student_id: 'stu-10', guardian_id: 'grd-07', invoice_ids: [], amount_paise: 100, balances_snapshot: [], status: 'created', mode: 'test', created_by: who.userId }, 'return=minimal');
  const eventId = `evt_p2erase_${rand()}`;
  await rest('POST', 'gateway_events', { event_id: eventId, event: 'payment.failed', result: 'ok',
    payload: { event: 'payment.failed', payload: { payment: { entity: { id: `pay_P2E${rand()}`, order_id: orderId, email: 'payer@example.com', contact: '+919000000999', status: 'failed' } } } } }, 'return=minimal');
  const r = await command(admin.token, 'people.anonymiseGuardian', 'grd-07');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual([r.data.result.server.authUsersDeleted, r.data.result.server.gatewayEventsScrubbed, r.data.result.server.errors.length], [1, 1, 0], JSON.stringify(r.data.result.server));
  const L = local();
  assert.equal((await http('GET', `${L.url}/auth/v1/admin/users/${who.userId}`, { headers: { apikey: L.service, Authorization: `Bearer ${L.service}` } })).status, 404, 'the sign-in is gone');
  assert.equal(psql(`select count(*) from app_users where user_id = '${who.userId}'`), '0');
  assert.equal(psql(`select count(*) from push_subscriptions where user_id = '${who.userId}'`), '0');
  const ev = (await rest('GET', `gateway_events?event_id=eq.${eventId}&select=payload`)).data[0].payload.payload.payment.entity;
  assert.deepEqual([ev.email, ev.contact], [null, null]);
  const g = (await rest('GET', 'guardians?id=eq.grd-07&select=doc')).data[0].doc;
  assert.match(g.firstName, /^Erased-\d+$/); assert.equal(g.email, ''); assert.equal(g.phone, '');
});

test('#9 the access export carries the child\'s own trip events and the sign-in links', async () => {
  const r = await command(admin.token, 'admin.dataExport', 'grd-02');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const x = JSON.parse(r.data.result);
  assert.ok(x.transportEvents.length > 0 && x.transportEvents.every(e => e.studentId === 'stu-03'), JSON.stringify(x.transportEvents));
  assert.ok(x.account.some(a => a.userId === parentBus.userId && a.status === 'active'));
  for (const k of ['invites', 'erasureRequests', 'reminders', 'pushDevices', 'paymentOrders', 'importRecords']) assert.ok(Array.isArray(x[k]), k);
  assert.equal(JSON.stringify(x).includes('/push/'), false, 'device endpoints are not exported');
});
