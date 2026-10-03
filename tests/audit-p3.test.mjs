// Fix round 3 (re-audit of the Phase 2 fixes), domain side. HTTP/RLS halves: tests-supabase/audit-p3.test.mjs,
// supabase/tests/rls.test.sql ("fix round 3").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSeed } from '../src/seed/seed-data.js';
import { COMMANDS, execute, personaFor } from '../src/domain/commands.js';
import * as F from '../src/domain/fees.js';
import * as G from '../src/domain/gateway.js';
import { guardianExport } from '../src/domain/export.js';
import { reconcile } from '../src/domain/reconcile.js';

const NOW = new Date(Date.UTC(2026, 9, 2, 5, 0, 0));
const ctx = (actor = { role: 'system', id: 'gateway' }) => ({ actor, now: '2026-10-02T05:00:00.000Z', today: '2026-10-02' });
const ACCT = { role: 'accountant', id: 'stf-accountant' };
const serverDb = () => Object.assign(buildSeed(NOW), { consents: [], invites: [], appUsers: [], erasureRequests: [], importBatches: [], importRows: [], settlementLines: [] });
const admin = db => personaFor(db, { role: 'admin', staffId: 'stf-principal' });

function settled() {
  const db = serverDb();
  const inv = db.invoices.find(i => i.status === 'issued' && F.invoiceBalance(db, i) > 0);
  const o = { id: 'order_P3', studentId: inv.studentId, guardianId: null, invoiceIds: [inv.id], amountPaise: F.invoiceBalance(db, inv) };
  const pay = G.recordGatewayPayment(db, { order: o, payment: { id: 'pay_P3', order_id: o.id, amount: o.amountPaise, status: 'captured', created_at: Math.floor(Date.UTC(2026, 9, 1, 6) / 1000) }, gatewayMode: 'test' }, ctx()).payment;
  const manual = amountPaise => F.refund(db, { paymentId: pay.id, invoiceId: inv.id, amountPaise, mode: 'online', reference: 'rfnd_P3', date: '2026-10-02', reason: 'refunded on the dashboard' }, ctx(ACCT));
  const hook = amount => G.recordGatewayRefund(db, { refund: { id: 'rfnd_P3', payment_id: 'pay_P3', amount, status: 'processed', created_at: Math.floor(Date.UTC(2026, 9, 2, 4) / 1000) } }, ctx());
  const total = () => db.refunds.filter(r => r.gatewayRefundId === 'rfnd_P3').reduce((s, r) => s + r.amountPaise, 0);
  return { db, pay, manual, hook, total };
}

test('N4 a manual refund for part of a gateway refund: the webhook books the remainder; the manual row is tied to the gateway id', () => {
  const f = settled();
  const m = f.manual(2000);
  assert.equal(m.gatewayRefundId, 'rfnd_P3', 'settlement matching sees the manual row');
  const r = f.hook(10000);
  assert.equal(r.created, true);
  assert.equal(r.refunds.reduce((s, x) => s + x.amountPaise, 0), 8000, 'only the remainder is booked');
  assert.equal(f.total(), 10000);
  assert.equal(f.hook(10000).created, false, 'idempotent afterwards');
  assert.equal(f.total(), 10000);
  for (const c of reconcile(f.db).checks) assert.ok(c.ok, c.name);
  const rep = G.settlementReport(f.db, [{ line: 2, type: 'refund', entityId: 'rfnd_P3', settlementId: 's1', utr: null, settledOn: null, grossPaise: 10000, feePaise: 0, taxPaise: 0, netPaise: 10000 }], {});
  assert.equal(rep.rows[0].ledgerPaise, 10000, 'manual + webhook rows match the settled refund');
});

test('N4 a manual refund larger than the gateway refund is flagged, never booked again', () => {
  const f = settled();
  f.manual(12000);
  const r = f.hook(10000);
  assert.equal(r.created, false);
  assert.match(r.mismatch || '', /more than/);
  assert.equal(f.total(), 12000);
  assert.ok(f.db.auditLog.some(a => a.action === 'gatewayRefundMismatch'));
});

test('N6 erasure leaves the request in cleanup until the server steps succeed; a failure is recorded and retried', () => {
  const db = serverDb();
  db.appUsers.push({ id: 'u-g1', role: 'parent', guardianId: 'grd-01', status: 'active' });
  const r = execute('people.anonymiseGuardian', db, ['grd-01'], ctx({ role: 'admin', id: 'stf-principal' }), admin(db));
  const req = db.erasureRequests.find(x => x.guardianId === 'grd-01');
  assert.ok(req, 'a request is recorded even when none was open');
  assert.equal(req.status, 'cleanup');
  assert.deepEqual(req.pendingUserIds, ['u-g1']);
  assert.deepEqual(r.revokedUserIds, ['u-g1']);
  const sys = { role: 'system', id: 'system', staffId: null, guardianId: null, studentIds: [], programIds: [], routeIds: [] };
  execute('people.finishErasure', db, ['grd-01', { errors: ['could not delete sign-in (500)'] }], ctx(), sys);
  assert.equal(req.status, 'cleanup');
  assert.match(req.lastError, /500/);
  assert.equal(req.cleanupAttempts, 1);
  execute('people.finishErasure', db, ['grd-01', { errors: [] }], ctx(), sys);
  assert.equal(req.status, 'done');
  assert.ok(req.doneAt);
  assert.throws(() => execute('people.finishErasure', db, ['grd-01', { errors: [] }], ctx(), admin(db)), { code: 'NOT_ALLOWED' }, 'system only');
});

test('N9 the stored copy of an invite-code result never holds the code', () => {
  const store = COMMANDS['admin.inviteCode'].storedResult;
  assert.equal(typeof store, 'function');
  const kept = store({ code: 'ABCDE-FGHJK', expiresAt: '2026-10-16T00:00:00.000Z' });
  assert.equal(JSON.stringify(kept).includes('ABCDE'), false);
  assert.equal(kept.code, null);
  assert.equal(kept.expiresAt, '2026-10-16T00:00:00.000Z');
});

test('#9 the export includes the family\'s own stored gateway events (payments by this guardian only)', () => {
  const db = serverDb();
  db.gatewayOrders = [{ id: 'order_A', studentId: 'stu-01', guardianId: 'grd-01' }, { id: 'order_B', studentId: 'stu-03', guardianId: 'grd-02' }];
  db.gatewayEvents = [
    { eventId: 'e1', event: 'payment.captured', receivedAt: '2026-10-01T00:00:00Z', payload: { payload: { payment: { entity: { id: 'pay_A', order_id: 'order_A', email: null } } } } },
    { eventId: 'e2', event: 'payment.captured', receivedAt: '2026-10-01T00:00:00Z', payload: { payload: { payment: { entity: { id: 'pay_B', order_id: 'order_B' } } } } },
  ];
  const x = guardianExport(db, 'grd-01');
  assert.deepEqual(x.gatewayEvents.map(e => e.eventId), ['e1']);
  assert.deepEqual(guardianExport(buildSeed(NOW), 'grd-01').gatewayEvents, []);
});
