import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSeed } from '../src/seed/seed-data.js';
import { createApi } from '../src/api/index.js';
import { memoryBackend } from '../src/store/storage.js';
import { COMMANDS, SLICES, execute, personaFor, revKey } from '../src/domain/commands.js';
import { dateInZone } from '../src/domain/dates.js';
import * as F from '../src/domain/fees.js';
import * as G from '../src/domain/gateway.js';
import * as R from '../src/domain/reminders.js';
import { reconcile } from '../src/domain/reconcile.js';
import { validateDb } from '../src/domain/validate.js';
import { simulationPlan } from '../src/domain/sim.js';
import * as Rz from '../supabase/functions/_shared/razorpay.js';
import { diffChanges, isEmptyChange } from '../supabase/functions/_shared/slices.js';
import { pushMessages } from '../supabase/functions/_shared/notify.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const NOW = new Date(Date.UTC(2026, 9, 2, 5, 0, 0));
const ctx = (today = '2026-10-02', actor = { role: 'system', id: 'gateway' }) => ({ actor, now: `${today}T05:00:00.000Z`, today });
const seed = () => buildSeed(NOW);
const openInvoice = db => db.invoices.find(i => i.status === 'issued' && F.invoiceBalance(db, i) > 0);
const order = (db, inv, extra = {}) => ({ id: 'order_TEST000000001', studentId: inv.studentId, guardianId: db.students.find(s => s.id === inv.studentId).guardianIds[0], invoiceIds: [inv.id], amountPaise: F.invoiceBalance(db, inv), ...extra });
const captured = (o, extra = {}) => ({ id: 'pay_TEST000000001', order_id: o.id, amount: o.amountPaise, status: 'captured', created_at: Math.floor(Date.UTC(2026, 9, 1, 6, 0) / 1000), ...extra });

// ---------------------------------------------------------------- registry
test('every Phase 1 write is a registry command with a slice the server can load and guard', () => {
  const phase1Writes = ['notices.send', 'notices.markRead', 'notices.acknowledge', 'threads.open', 'threads.reply', 'threads.markRead', 'threads.close',
    'calendar.create', 'calendar.update', 'calendar.remove', 'calendar.importHolidays', 'transport.startTrip', 'transport.endTrip', 'transport.recordPosition',
    'transport.markChild', 'fees.saveStructure', 'fees.generateInvoices', 'fees.addConcession', 'fees.removeConcession', 'fees.applyLateFee', 'fees.waiveLateFee',
    'fees.cancelInvoice', 'fees.recordPayment', 'fees.cancelPayment', 'fees.refund', 'fees.mockOnlinePayment', 'attendance.mark', 'diary.add', 'diary.markRead'];
  for (const n of phase1Writes) assert.ok(COMMANDS[n] && !COMMANDS[n].serverOnly, `${n} runs in both modes`);
  for (const [n, c] of Object.entries(COMMANDS)) {
    assert.ok(SLICES[c.slice], `${n}: slice ${c.slice} exists`);
    assert.equal(typeof c.authorize, 'function', `${n}: authorize`);
    assert.equal(typeof c.run, 'function', `${n}: run`);
    for (const w of SLICES[c.slice].writes) if (!['school', 'counters'].includes(w)) assert.ok(SLICES[c.slice].reads.includes(w) || ['importRows', 'erasureRequests', 'settlementLines'].includes(w), `${c.slice} writes ${w} it also loads`);
  }
  const db = seed();
  db.trips[0].routeId = 'route-1';
  assert.equal(revKey('transport.recordPosition', db, [db.trips[0].id]), 'transport:route-1', 'transport rev is per route');
  assert.equal(revKey('fees.recordPayment', db, [{}]), 'ledger');
});

test('server persona comes from the link row, and authorize runs before any change (parent cannot record a payment)', () => {
  const db = seed();
  const parent = personaFor(db, { role: 'parent', guardianId: 'grd-02' });
  assert.deepEqual(parent.studentIds, ['stu-03', 'stu-04']);
  const before = JSON.stringify(db);
  assert.throws(() => execute('fees.recordPayment', db, [{ studentId: 'stu-03', amountPaise: 100, mode: 'cash', paidOn: '2026-10-02' }], ctx('2026-10-02', { role: 'parent', id: 'grd-02' }), parent), { code: 'NOT_ALLOWED' });
  assert.equal(JSON.stringify(db), before, 'nothing changed');
  assert.equal(personaFor(db, { role: 'teacher', staffId: 'stf-principal' }), null, 'a link whose role disagrees with the staff row is no persona');
  assert.throws(() => execute('notices.send', db, [{}], ctx(), null), { code: 'NOT_ALLOWED' }, 'unlinked user');
  assert.throws(() => execute('fees.recordGatewayPayment', db, [{}], ctx(), personaFor(db, { role: 'admin', staffId: 'stf-principal' })), { code: 'NOT_ALLOWED' }, 'gateway step is system-only');
});

// ---------------------------------------------------------------- dates / gateway ledger
test('IST business dates: a capture at 20:30Z is paid on the next IST day (Deno runs in UTC)', () => {
  assert.equal(dateInZone(Date.UTC(2026, 9, 2, 20, 30), 330), '2026-10-03');
  assert.equal(dateInZone(Date.UTC(2026, 9, 2, 18, 29), 330), '2026-10-02');
  assert.equal(G.gatewayDate(Date.UTC(2026, 9, 2, 20, 30) / 1000), '2026-10-03');
  const db = seed(); const inv = openInvoice(db); const o = order(db, inv);
  const r = G.recordGatewayPayment(db, { order: o, payment: captured(o, { created_at: Date.UTC(2026, 9, 1, 20, 30) / 1000 }), gatewayMode: 'test' }, ctx('2026-10-02'));
  assert.equal(r.payment.paidOn, '2026-10-02');
});

test('recordGatewayPayment is idempotent (verify + webhook + status) and the receipt says TEST MODE', () => {
  const db = seed(); const inv = openInvoice(db); const o = order(db, inv); const p = captured(o);
  const a = G.recordGatewayPayment(db, { order: o, payment: p, gatewayMode: 'test' }, ctx());
  const b = G.recordGatewayPayment(db, { order: o, payment: p, gatewayMode: 'test' }, ctx());
  assert.equal(a.created, true); assert.equal(b.created, false);
  assert.equal(b.payment.id, a.payment.id);
  assert.equal(db.payments.filter(x => x.gatewayPaymentId === p.id).length, 1);
  assert.equal(a.payment.mode, 'online'); assert.equal(a.payment.reference, p.id); assert.equal(a.status, 'paid');
  const rv = F.receiptView(db, a.payment.id);
  assert.equal(rv.isTestMode, true); assert.equal(rv.isMock, false);
  assert.equal(F.invoiceBalance(db, inv), 0);
  assert.ok(reconcile(db).checks.every(c => c.ok));
  assert.equal(validateDb(db).filter(v => v.severity !== 'warning').length, 0);
});

test('allocation is recomputed at capture: an invoice paid meanwhile is skipped and the money becomes credit; a mismatch is recorded and flagged', () => {
  const db = seed(); const inv = openInvoice(db); const o = order(db, inv);
  F.recordPayment(db, { studentId: inv.studentId, amountPaise: F.invoiceBalance(db, inv), mode: 'cash', paidOn: '2026-10-02' }, ctx('2026-10-02', { role: 'accountant', id: 'stf-accountant' }));
  const r = G.recordGatewayPayment(db, { order: o, payment: captured(o), gatewayMode: 'test' }, ctx());
  assert.deepEqual(r.payment.allocations, []);
  assert.equal(r.payment.creditPaise, o.amountPaise);
  const db2 = seed(); const inv2 = openInvoice(db2); const o2 = order(db2, inv2);
  const m = G.recordGatewayPayment(db2, { order: o2, payment: captured(o2, { amount: o2.amountPaise + 5000 }), gatewayMode: 'test' }, ctx());
  assert.equal(m.status, 'amount_mismatch');
  assert.equal(m.payment.creditPaise, 5000);
  assert.ok(db2.auditLog.some(x => x.action === 'amountMismatch'));
  assert.ok(reconcile(db2).checks.every(c => c.ok));
});

test('order amount: computed from balances; a client amount can only lower it (≥ ₹100); oldest due first', () => {
  const db = seed();
  const inv = openInvoice(db);
  const bal = F.invoiceBalance(db, inv);
  assert.equal(G.orderAmount(db, { studentId: inv.studentId, invoiceIds: [inv.id], amountPaise: bal * 10 }).amountPaise, bal);
  assert.equal(G.orderAmount(db, { studentId: inv.studentId, invoiceIds: [inv.id], amountPaise: 20000 }).amountPaise, 20000);
  assert.throws(() => G.orderAmount(db, { studentId: inv.studentId, invoiceIds: [inv.id], amountPaise: 9999 }), { code: 'INVALID_AMOUNT' });
  const other = db.invoices.find(i => i.studentId !== inv.studentId);
  assert.throws(() => G.orderAmount(db, { studentId: inv.studentId, invoiceIds: [other.id] }), { code: 'VALIDATION' }, "another child's invoice is never payable here");
});

test('gateway refund: split across allocations largest first then credit; out-of-order refund is pending; idempotent', () => {
  const db = seed(); const inv = openInvoice(db); const o = order(db, inv);
  const pending = G.recordGatewayRefund(db, { refund: { id: 'rfnd_TEST00000001', status: 'processed', payment_id: 'pay_TEST000000001', amount: 1000, created_at: NOW.getTime() / 1000 } }, ctx());
  assert.equal(pending.pending, true);
  G.recordGatewayPayment(db, { order: o, payment: captured(o, { amount: o.amountPaise + 3000 }), gatewayMode: 'test' }, ctx());
  const amount = o.amountPaise + 2000; // all of the allocation + 2000 of the 3000 credit
  const r = G.recordGatewayRefund(db, { refund: { id: 'rfnd_TEST00000001', status: 'processed', payment_id: 'pay_TEST000000001', amount, created_at: NOW.getTime() / 1000 } }, ctx());
  assert.equal(r.created, true);
  assert.deepEqual(r.refunds.map(x => [x.invoiceId, x.amountPaise, x.gatewayRefundPart]), [[inv.id, o.amountPaise, 0], [null, 2000, 1]]);
  assert.equal(G.recordGatewayRefund(db, { refund: { id: 'rfnd_TEST00000001', status: 'processed', payment_id: 'pay_TEST000000001', amount, created_at: 0 } }, ctx()).created, false);
  assert.throws(() => G.recordGatewayRefund(db, { refund: { id: 'rfnd_TEST00000002', status: 'processed', payment_id: 'pay_TEST000000001', amount: 5000, created_at: NOW.getTime() / 1000 } }, ctx()), { code: 'INVALID_AMOUNT' });
  assert.ok(reconcile(db).checks.every(c => c.ok));
  assert.equal(validateDb(db).filter(v => v.severity !== 'warning').length, 0);
});

// ---------------------------------------------------------------- Razorpay signatures
test('Razorpay HMAC: valid, tampered and wrong-secret signatures; constant-time compare; key/mode guard', async () => {
  const secret = 'local-test-secret';
  const sig = await Rz.signPayment('order_A', 'pay_B', secret);
  assert.equal(await Rz.verifyPaymentSignature({ orderId: 'order_A', paymentId: 'pay_B', signature: sig }, secret), true);
  assert.equal(await Rz.verifyPaymentSignature({ orderId: 'order_A', paymentId: 'pay_C', signature: sig }, secret), false, 'tampered payload');
  assert.equal(await Rz.verifyPaymentSignature({ orderId: 'order_A', paymentId: 'pay_B', signature: sig }, 'other'), false, 'wrong secret');
  const body = new TextEncoder().encode('{"event":"payment.captured"}');
  const ws = await Rz.signWebhook(body, 'whsec');
  assert.equal(await Rz.verifyWebhookSignature(body, ws, 'whsec'), true);
  assert.equal(await Rz.verifyWebhookSignature(new TextEncoder().encode('{"event":"payment.captured" }'), ws, 'whsec'), false, 'one byte changed');
  assert.equal(await Rz.verifyWebhookSignature(body, null, 'whsec'), false);
  assert.equal(Rz.timingSafeEqual('abc', 'abc'), true);
  assert.equal(Rz.timingSafeEqual('abc', 'abd'), false);
  assert.equal(Rz.timingSafeEqual('abc', 'abcd'), false);
  assert.equal(Rz.checkKeyMode('rzp_test_XXXXXXXXXXXXXX', 'test'), 'test');
  assert.throws(() => Rz.checkKeyMode('rzp_live_XXXXXXXXXXXXXX', 'test'), /disagree/);
  assert.throws(() => Rz.checkKeyMode('rzp_test_XXXXXXXXXXXXXX', 'live'), /disagree/);
});

// ---------------------------------------------------------------- settlements
test('settlement CSV: parse, idempotent merge, report with unmatched rows on both sides and the gross = net + fee + tax identity', () => {
  const db = seed(); const inv = openInvoice(db); const o = order(db, inv);
  const p = G.recordGatewayPayment(db, { order: o, payment: captured(o), gatewayMode: 'test' }, ctx()).payment;
  const gross = (o.amountPaise / 100).toFixed(2);
  const fee = 200, tax = 36; // paise
  const net = ((o.amountPaise - fee - tax) / 100).toFixed(2);
  const csv = `entity_id,type,debit,credit,amount,currency,fee,tax,settlement_id,settlement_utr,settled_at\r\n`
    + `pay_TEST000000001,payment,0,${net},${gross},INR,2.00,0.36,setl_A,UTR0001,2026-10-05 10:21:33\r\n`
    + `pay_UNKNOWN000001,payment,0,98.00,100.00,INR,2.00,0.00,setl_A,UTR0001,2026-10-05 10:21:33\r\n`
    + `pay_BAD,payment,0,1,notanumber,INR,0,0,setl_A,UTR0001,\r\n`;
  const parsed = G.parseSettlementCsv(csv);
  assert.equal(parsed.inputRows, 3);
  assert.equal(parsed.lines.length + parsed.rejected.length, parsed.inputRows);
  assert.equal(parsed.rejected[0].line, 4);
  const m1 = G.mergeSettlementLines([], parsed);
  const m2 = G.mergeSettlementLines(m1.added, parsed);
  assert.deepEqual([m1.imported, m1.duplicate, m2.imported, m2.duplicate], [2, 0, 0, 2]);
  const rep = G.settlementReport(db, m1.added, {});
  assert.equal(rep.rows.length, 1);
  assert.equal(rep.rows[0].receiptNumber, p.receiptNumber);
  assert.equal(rep.rows[0].settledOn, '2026-10-05');
  assert.equal(rep.rows[0].amountMatches, true);
  assert.equal(rep.unmatchedSettlement.length, 1);
  assert.equal(rep.unmatchedSettlement[0].entityId, 'pay_UNKNOWN000001');
  assert.equal(rep.totals.identityOk, true);
  assert.equal(rep.totals.grossPaise, rep.totals.netPaise + rep.totals.feePaise + rep.totals.taxPaise);
  const none = G.settlementReport(db, [], {});
  assert.equal(none.unmatchedLedger.length, 1, 'a captured payment not yet settled is listed');
});

// ---------------------------------------------------------------- reminders / late fees
test('reminders at T−3, due, +7, +14 of the effective due date; deduped; a missed day is caught up once', () => {
  const db = seed();
  const inv = db.invoices.find(i => i.installmentName === 'Term 2' && i.status === 'issued');
  const eff = '2026-10-15'; // Term 2 due 15-Oct-2026 (a Thursday, a working day)
  const at = d => R.remindersDue(db, d).filter(r => r.invoiceId === inv.id).map(r => r.kind);
  assert.deepEqual(at('2026-10-11'), []);
  assert.deepEqual(at('2026-10-12'), ['T-3']);
  assert.deepEqual(at(eff), ['due']);
  assert.deepEqual(at('2026-10-22'), ['+7']);
  assert.deepEqual(at('2026-10-29'), ['+14']);
  assert.deepEqual(at('2026-11-10'), [], 'not sent weeks late');
  assert.deepEqual(R.remindersDue(db, '2026-10-12', new Set([`${inv.id}|T-3`])).filter(r => r.invoiceId === inv.id), [], 'deduped');
  assert.deepEqual(at('2026-10-13'), ['T-3'], 'a missed day still sends the stage once');
  const lf = R.lateFeesDueList(db, '2026-11-10');
  assert.ok(lf.length > 0 && lf.every(x => x.lateFeePaise > 0));
  assert.ok(db.invoices.every(i => !i.lines.some(l => l.appliedOn)), 'nothing applied automatically');
});

// ---------------------------------------------------------------- server diff + push messages (pure parts of the edge functions)
test('diffChanges sends only changed docs, new audit rows, new positions and counters; refuses writes outside the slice', () => {
  const db = seed();
  const before = structuredClone(db);
  const p = personaFor(db, { role: 'accountant', staffId: 'stf-accountant' });
  const inv = openInvoice(db);
  execute('fees.recordPayment', db, [{ studentId: inv.studentId, amountPaise: 10000, mode: 'cash', paidOn: '2026-10-02' }], ctx('2026-10-02', { role: 'accountant', id: 'stf-accountant' }), p);
  const ch = diffChanges(before, db, SLICES.ledger.writes);
  assert.equal(ch.upserts.payments.length, 1);
  assert.deepEqual(ch.upserts.invoices.map(i => i.id), [inv.id]);
  assert.equal(ch.audit.length, 1);
  assert.equal(ch.counters.receipt['AY2026-27'], before.counters.receipt['AY2026-27'] + 1);
  assert.ok(!ch.upserts.students && !ch.upserts.guardians);
  assert.equal(isEmptyChange(diffChanges(db, structuredClone(db), SLICES.ledger.writes)), true);
  const t = structuredClone(db);
  t.notices.push({ id: 'x' });
  assert.throws(() => diffChanges(db, t, SLICES.ledger.writes), /may not write/);
  const u = structuredClone(db);
  u.invoices.pop();
  assert.throws(() => diffChanges(db, u, SLICES.ledger.writes), /never deleted/);
  // transport: new fixes become position rows, the trip doc is sent without positions
  const d2 = seed();
  const drv = personaFor(d2, { role: 'driver', staffId: 'stf-driver-1' });
  const trip = execute('transport.startTrip', d2, [{ routeId: 'route-1', direction: 'pickup' }], ctx('2026-10-02', { role: 'driver', id: 'stf-driver-1' }), drv);
  const b2 = structuredClone(d2);
  execute('transport.recordPosition', d2, [trip.id, { lat: 12.8935, lng: 77.604, accuracy: 8, ts: '2026-10-02T05:00:01.000Z' }], ctx(), drv);
  const ch2 = diffChanges(b2, d2, SLICES.transport.writes);
  assert.equal(ch2.positions.length, 1);
  assert.equal(ch2.upserts.trips[0].positions, undefined);
});

test('push messages: stop events go to guardians of children at that stop; payments to the payer family; important notices', () => {
  const db = seed();
  const drv = personaFor(db, { role: 'driver', staffId: 'stf-driver-1' });
  const c = (ms) => ({ actor: { role: 'driver', id: 'stf-driver-1' }, now: new Date(ms).toISOString(), today: '2026-10-02' });
  let ms = Date.UTC(2026, 9, 2, 1, 40);
  const trip = execute('transport.startTrip', db, [{ routeId: 'route-1', direction: 'pickup', simulated: true }], c(ms), drv);
  const msgs = [];
  for (const pt of simulationPlan(db.routes[0], { speedKmph: 20, tickMs: 1000 })) {
    ms += pt.dtMs || 1000;
    const before = structuredClone(db);
    const r = execute('transport.recordPosition', db, [trip.id, { lat: pt.lat, lng: pt.lng, accuracy: pt.accuracy, ts: new Date(ms).toISOString() }], c(ms), drv);
    msgs.push(...pushMessages('transport.recordPosition', before, db, r));
  }
  const nearing = msgs.filter(m => /nearing/.test(m.payload.body));
  assert.ok(nearing.length >= 3);
  const stop2 = msgs.find(m => m.payload.body.includes('Lotus Park Gate') && /nearing/.test(m.payload.body));
  assert.ok(stop2.guardianIds.includes('grd-02'), 'parent of the child at that stop');
  assert.ok(!stop2.guardianIds.includes('grd-05'), 'a route-2 family is not told');
  assert.deepEqual(stop2.purposes, ['push', 'bus_live']);
  const inv = openInvoice(db);
  const pay = F.recordPayment(db, { studentId: inv.studentId, amountPaise: 10000, mode: 'cash', paidOn: '2026-10-02' }, ctx('2026-10-02', { role: 'accountant', id: 'stf-accountant' }));
  const pm = pushMessages('fees.recordPayment', db, db, pay);
  assert.equal(pm.length, 1);
  assert.match(pm[0].payload.body, /receipt RCP\//);
});

// ---------------------------------------------------------------- demo api: new namespaces + live trip feed
async function demo() {
  let t = Date.UTC(2026, 9, 2, 2, 0, 0);
  const api = createApi({ backend: memoryBackend(), sessionBackend: memoryBackend(), seedFn: seed, clock: () => new Date(t += 1000) });
  await api.ready();
  return api;
}

test('demo mode: real-app namespaces answer with demo values or NOT_ALLOWED; late fees batch works', async () => {
  const api = await demo();
  assert.equal(api.mode, 'demo');
  assert.deepEqual(await api.auth.status(), { state: 'demo', email: null });
  api.session.set('persona-grd-02');
  const cs = await api.consent.status();
  assert.equal(cs.version, 'v1');
  assert.equal(cs.purposes.app_account.given, true);
  assert.equal(await api.push.vapidPublicKey(), null);
  assert.deepEqual(await api.push.list(), []);
  for (const fnName of ['createGatewayOrder', 'verifyGatewayPayment', 'gatewayOrderStatus', 'importSettlementCsv', 'settlementReport']) {
    await assert.rejects(api.fees[fnName]({}), e => e.code === 'NOT_ALLOWED' && /real app/.test(e.message), fnName);
  }
  await assert.rejects(api.auth.signInWithOtp('a@example.com'), { code: 'NOT_ALLOWED' });
  await assert.rejects(api.consent.give({ purposes: ['app_account'], version: 'v1' }), { code: 'NOT_ALLOWED' });
  assert.ok(Array.isArray(await api.reminders.list()));
  api.session.set('persona-stf-accountant');
  const due = await api.fees.lateFeesDueList();
  const r = await api.fees.applyLateFees({ invoiceIds: [...due.slice(0, 2).map(x => x.invoiceId), 'inv-missing'] });
  assert.equal(r.applied.length, Math.min(2, due.length));
  assert.deepEqual(r.skipped.map(s => s.invoiceId), ['inv-missing']);
  await assert.rejects(api.admin.inviteCode('grd-01'), { code: 'NOT_ALLOWED' });
  api.session.set('persona-stf-principal');
  const exp = JSON.parse(await api.admin.dataExport('grd-02'));
  assert.deepEqual(exp.children.map(c => c.id), ['stu-03', 'stu-04']);
  assert.ok(exp.invoices.every(i => ['stu-03', 'stu-04'].includes(i.studentId)));
});

test('demo subscribeTrip: the route-1 parent gets positions and trip events as the driver records fixes; a route-2 parent cannot subscribe', async () => {
  const api = await demo();
  api.session.set('persona-grd-02'); // Aarav, route 1
  const got = [];
  const unsub = api.transport.subscribeTrip('route-1', ev => got.push(ev));
  api.session.set('persona-grd-05');
  assert.throws(() => api.transport.subscribeTrip('route-1', () => {}), { code: 'NOT_ALLOWED' });
  api.session.set('persona-stf-driver-1');
  const trip = await api.transport.startTrip({ routeId: 'route-1', direction: 'pickup', simulated: true });
  let ms = Date.parse(trip.startedAt);
  const plan = simulationPlan((await api.transport.route('route-1')), { speedKmph: 20, tickMs: 1000 }).slice(0, 80);
  for (const pt of plan) { ms += 1000; await api.transport.recordPosition(trip.id, { lat: pt.lat, lng: pt.lng, accuracy: pt.accuracy, ts: new Date(ms).toISOString() }); }
  unsub();
  const positions = got.filter(e => e.type === 'position');
  const trips = got.filter(e => e.type === 'trip');
  assert.ok(positions.length > 10, `positions delivered (${positions.length})`);
  assert.ok(trips.length >= 1 && trips[0].trip.id === trip.id && trips[0].trip.positions === undefined);
  assert.ok(trips.some(e => e.trip.stopEvents.some(s => s.type === 'nearing')), 'nearing reached the parent');
  assert.ok(trips.every(e => e.trip.stopEvents.every(s => s.stopId === 'route-1-stop-2')), "only the parent's own stop");
  const n = got.length;
  await api.transport.recordPosition(trip.id, { lat: 12.9, lng: 77.6, accuracy: 8, ts: new Date(ms + 5000).toISOString() });
  assert.equal(got.length, n, 'nothing after unsubscribe');
});

// ---------------------------------------------------------------- mode binding (failure mode 28)
function walk(dir, out = []) {
  for (const n of readdirSync(dir)) { const p = join(dir, n); if (statSync(p).isDirectory()) walk(p, out); else if (p.endsWith('.js') || p.endsWith('.html')) out.push(p); }
  return out;
}
test('the demo can never point at real data: no app config or Supabase URL in the demo entry or the screens; remote.js only via config', () => {
  const files = [join(root, 'index.html'), ...walk(join(root, 'src/ui'))];
  for (const f of files) {
    const s = readFileSync(f, 'utf8');
    assert.ok(!s.includes('__APP_CONFIG__'), `${f} must not read the app config`);
    assert.ok(!/supabase\.co|127\.0\.0\.1:54321/.test(s), `${f} must not name a Supabase URL`);
    assert.ok(!/remote\.js|vendor\/supabase/.test(s), `${f} must not import the remote api or supabase-js`);
  }
  const idx = readFileSync(join(root, 'src/api/index.js'), 'utf8');
  assert.equal((idx.match(/import\(['"]\.\/remote\.js['"]\)/g) || []).length, 1, 'remote.js is imported in exactly one place');
  assert.match(idx, /APP_CONFIG\s*\n?\s*\?\s*await \(await import\('\.\/remote\.js'\)\)/);
  assert.ok(!/^import .*remote\.js/m.test(idx), 'never a static import');
});

// ---------------------------------------------------------------- account commands (server-only; run here on a plain Db)
const accountDb = () => { const db = seed(); db.consents = []; db.invites = []; db.appUsers = []; db.erasureRequests = []; return db; };
test('DPDP access: a parent may export their OWN data (audited); not another guardian\'s; the principal may export anyone', () => {
  const db = accountDb();
  const parent = personaFor(db, { role: 'parent', guardianId: 'grd-02' });
  const out = execute('admin.dataExport', db, ['grd-02'], ctx('2026-10-02', { role: 'parent', id: 'grd-02' }), parent);
  assert.deepEqual(JSON.parse(out).children.map(c => c.id), ['stu-03', 'stu-04']);
  assert.ok(db.auditLog.some(a => a.action === 'dataExport' && a.entityId === 'grd-02' && a.actorRole === 'parent'));
  assert.throws(() => execute('admin.dataExport', db, ['grd-01'], ctx('2026-10-02', { role: 'parent', id: 'grd-02' }), parent), { code: 'NOT_ALLOWED' });
  const admin = personaFor(db, { role: 'admin', staffId: 'stf-principal' });
  assert.ok(execute('admin.dataExport', db, ['grd-01'], ctx('2026-10-02', { role: 'admin', id: 'stf-principal' }), admin).length > 10);
  const teacher = personaFor(db, { role: 'teacher', staffId: 'stf-teacher-pa' });
  assert.throws(() => execute('admin.dataExport', db, ['grd-01'], ctx(), teacher), { code: 'NOT_ALLOWED' });
});

test('consent.give: app_account is required only until it is given; optional purposes can be added later; textHash is stored', () => {
  const db = accountDb();
  const p = personaFor(db, { role: 'parent', guardianId: 'grd-02' });
  const c = ctx('2026-10-02', { role: 'parent', id: 'grd-02' });
  assert.throws(() => execute('consent.give', db, [{ purposes: ['bus_live'], version: 'v1' }], c, p), /app account purpose is required/);
  const hash = 'a'.repeat(64);
  execute('consent.give', db, [{ purposes: ['app_account'], version: 'v1', textHash: hash }], c, p);
  const st = execute('consent.give', db, [{ purposes: ['bus_live'], version: 'v1', textHash: hash }], c, p);
  assert.equal(st.purposes.app_account.given, true);
  assert.equal(st.purposes.bus_live.given, true);
  assert.equal(st.purposes.push.given, false);
  assert.ok(db.consents.every(x => x.textHash === hash));
  assert.throws(() => execute('consent.give', db, [{ purposes: ['push'], version: 'v1', textHash: 'not-a-hash' }], c, p), /SHA-256/);
  execute('consent.withdraw', db, ['app_account'], c, p);
  assert.throws(() => execute('consent.give', db, [{ purposes: ['push'], version: 'v1' }], c, p), /app account purpose is required/, 'after withdrawal it is required again');
});
