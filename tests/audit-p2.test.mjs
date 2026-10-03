// Reproductions for the Phase 2 audit (AUDIT-P2), backend/domain side. Each test failed before its fix.
// Numbers refer to the audit findings. HTTP/RLS halves live in tests-supabase/audit-p2.test.mjs and
// supabase/tests/rls.test.sql.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSeed } from '../src/seed/seed-data.js';
import { COMMANDS, execute, personaFor, consentScopedPersona, guardSlices, CONSENT_VERSION } from '../src/domain/commands.js';
import * as F from '../src/domain/fees.js';
import * as G from '../src/domain/gateway.js';
import * as I from '../src/domain/import-people.js';
import * as T from '../src/domain/transport.js';
import * as R from '../src/domain/reminders.js';
import { parseCsvObjects } from '../src/domain/csv.js';
import { guardianExport } from '../src/domain/export.js';
import { reconcile } from '../src/domain/reconcile.js';
import { firstRunSql } from '../scripts/first-run-sql.mjs';
import { consentAllows, pushEndpointAllowed, pushMessages } from '../supabase/functions/_shared/notify.js';
import { fetchAllPages } from '../supabase/functions/_shared/paging.js';

const NOW = new Date(Date.UTC(2026, 9, 2, 5, 0, 0));
const seed = () => buildSeed(NOW);
const ctx = (today = '2026-10-02', actor = { role: 'system', id: 'gateway' }) => ({ actor, now: `${today}T05:00:00.000Z`, today });
const adminCtx = () => ctx('2026-10-02', { role: 'admin', id: 'stf-principal' });
const admin = db => personaFor(db, { role: 'admin', staffId: 'stf-principal' });
const openInvoice = db => db.invoices.find(i => i.status === 'issued' && F.invoiceBalance(db, i) > 0);
const order = (db, inv, extra = {}) => ({ id: 'order_P2TEST0000001', studentId: inv.studentId, guardianId: db.students.find(s => s.id === inv.studentId).guardianIds[0], invoiceIds: [inv.id], amountPaise: F.invoiceBalance(db, inv), ...extra });
const captured = (o, extra = {}) => ({ id: 'pay_P2TEST0000001', order_id: o.id, amount: o.amountPaise, status: 'captured', created_at: Math.floor(Date.UTC(2026, 9, 1, 6, 0) / 1000), ...extra });
const gwRefund = (payId, amount, extra = {}) => ({ id: 'rfnd_P2TEST0000001', payment_id: payId, amount, status: 'processed', created_at: Math.floor(Date.UTC(2026, 9, 2, 4, 0) / 1000), ...extra });
const serverDb = () => Object.assign(seed(), { consents: [], invites: [], appUsers: [], erasureRequests: [], importBatches: [], importRows: [], settlementLines: [] });

// ---------------------------------------------------------------- #2 mock payment unreachable in the real app
test('#2 fees.mockOnlinePayment is demo-only (the command function refuses demoOnly commands)', () => {
  assert.equal(COMMANDS['fees.mockOnlinePayment'].demoOnly, true);
  for (const [n, c] of Object.entries(COMMANDS)) if (c.demoOnly) assert.ok(!c.serverOnly, `${n}: demoOnly and serverOnly exclude each other`);
});

// ---------------------------------------------------------------- import: guardian identity (#5, #34), duplicates (#32, #33)
const CH_MAP = { admissionNo: 'adm', firstName: 'fn', lastName: 'ln', dob: 'dob', program: 'prog', guardian1Name: 'g1', guardian1Phone: 'g1p', guardian1Email: 'g1e', guardian2Name: 'g2', guardian2Phone: 'g2p', guardian2Email: 'g2e', status: 'st', route: 'rt', stop: 'stop' };
const row = (line, v) => ({ line, values: { adm: '', fn: '', ln: 'Testwala', dob: '2022-03-05', prog: 'prog-primary-a', g1: '', g1p: '', g1e: '', g2: '', g2p: '', g2e: '', st: '', rt: '', stop: '', ...v } });
const validateChildren = (db, rows) => I.validateRows(db, { kind: 'children', mapping: CH_MAP, rows }, { today: '2026-10-02' });

test('#5 two differently named guardians sharing a phone in one row are a conflict, not one merged guardian', () => {
  const db = seed();
  const rows = [
    row(2, { adm: 'P2-001', fn: 'Asha', g1: 'Rani Testwala', g1p: '90000 00911', g2: 'Ravi Testwala', g2p: '90000 00911' }),
    row(3, { adm: 'P2-002', fn: 'Bela', g1: 'Ravi Testwala', g1p: '90000 00911' }),
  ];
  const v = validateChildren(db, rows);
  assert.equal(v.rows[0].status, 'quarantined', JSON.stringify(v.rows[0]));
  assert.match(v.rows[0].reason, /conflict/);
  const r = I.applyRows(db, { kind: 'children', mapping: CH_MAP, rows }, 'imb-p2', adminCtx());
  const owners = db.guardians.filter(g => g.studentIds.some(id => ['P2-001', 'P2-002'].includes(db.students.find(s => s.id === id)?.admissionNo)));
  assert.ok(owners.every(g => g.studentIds.length === 1), 'no guardian owns both children');
  assert.equal(r.inputRows, r.ok + r.quarantined + r.duplicate);
});

test("#5 a guardian whose phone belongs to one existing guardian and email to another is quarantined", () => {
  const db = seed();
  // two existing guardians who happen to share a name
  db.guardians.push({ id: 'grd-p2a', firstName: 'Rani', lastName: 'Testwala', relation: 'Mother', phone: '+91-90000-00921', email: 'rani.a@example.com', studentIds: [] });
  db.guardians.push({ id: 'grd-p2b', firstName: 'Rani', lastName: 'Testwala', relation: 'Mother', phone: '+91-90000-00922', email: 'rani.b@example.com', studentIds: [] });
  const v = validateChildren(db, [row(2, { adm: 'P2-003', fn: 'Chitra', g1: 'Rani Testwala', g1p: '9000000921', g1e: 'rani.b@example.com' })]);
  assert.equal(v.rows[0].status, 'quarantined');
  assert.match(v.rows[0].reason, /two different guardians/);
});

test('#34 a phone match registers the newly supplied email, so a later email-only sibling row joins the same family', () => {
  const db = seed();
  const rows = [
    row(2, { adm: 'P2-011', fn: 'Asha', g1: 'Rani Testwala', g1p: '90000 00931' }),
    row(3, { adm: 'P2-012', fn: 'Bela', g1: 'Rani Testwala', g1p: '90000 00931', g1e: 'rani.t@example.com' }),
    row(4, { adm: 'P2-013', fn: 'Charu', g1: 'Rani Testwala', g1e: 'rani.t@example.com' }),
  ];
  const v = validateChildren(db, rows);
  assert.deepEqual(v.rows.map(r => r.status), ['ok', 'ok', 'ok']);
  assert.deepEqual(v.guardians, { new: 1, merged: 2 });
  const r = I.applyRows(db, { kind: 'children', mapping: CH_MAP, rows }, 'imb-p2', adminCtx());
  assert.equal(r.created.guardians, 1);
  const g = db.guardians.find(x => x.phone === '+919000000931');
  assert.equal(g.studentIds.length, 3, 'one guardian, three children');
  assert.equal(g.email, 'rani.t@example.com', 'the email first seen on the second row is saved');
});

test('#32 an existing admission number with changed status, transport or guardians is a conflict, not a silent duplicate', () => {
  const db = seed();
  const s = db.students.find(x => x.id === 'stu-01');
  const g = db.guardians.find(x => x.id === 'grd-01');
  const route = db.routes.find(r => r.id === s.routeId);
  const stop = route.stops.find(x => x.id === s.stopId);
  const same = { adm: s.admissionNo, fn: s.firstName, ln: s.lastName, dob: s.dob, prog: s.programId, rt: route.id, stop: stop.name, g1: `${g.firstName} ${g.lastName}`, g1p: g.phone, g1e: g.email, st: 'active' };
  const v = validateChildren(db, [row(2, same), row(3, { ...same, st: 'left' }), row(4, { ...same, rt: '', stop: '' }), row(5, { ...same, g1: 'Other Person', g1p: '90000 00941', g1e: '' })]);
  assert.equal(v.rows[0].status, 'duplicate', v.rows[0].reason);
  // lines 3-5 share the admission number with line 2 inside the file too, so validate them one at a time
  for (const [k, changed] of [['status', { st: 'left' }], ['transport', { rt: '', stop: '' }], ['guardians', { g1: 'Other Person', g1p: '90000 00941', g1e: '' }]]) {
    const one = validateChildren(db, [row(2, { ...same, ...changed })]);
    assert.equal(one.rows[0].status, 'quarantined', `${k}: ${one.rows[0].reason}`);
    assert.match(one.rows[0].reason, new RegExp(`conflict.*${k}`));
  }
});

test('#33 opening balances of the same installment name in two academic years are both imported', () => {
  const db = seed();
  const map = { admissionNo: 'adm', installment: 'ins', dueDate: 'due', outstandingPaise: 'amt' };
  const rows = [
    { line: 2, values: { adm: 'ADM-26-001', ins: 'Term 1', due: '2025-07-10', amt: '1500' } },
    { line: 3, values: { adm: 'ADM-26-001', ins: 'Term 1', due: '2026-07-10', amt: '2500' } },
  ];
  const v = I.validateRows(db, { kind: 'fees', mapping: map, rows }, { today: '2026-10-02' });
  assert.deepEqual(v.rows.map(r => r.status), ['ok', 'ok'], JSON.stringify(v.rows.map(r => r.reason)));
  I.applyRows(db, { kind: 'fees', mapping: map, rows: [rows[0]] }, 'imb-y1', adminCtx());
  const again = I.validateRows(db, { kind: 'fees', mapping: map, rows: [rows[1]] }, { today: '2026-10-02' });
  assert.equal(again.rows[0].status, 'ok', again.rows[0].reason);
});

// ---------------------------------------------------------------- CSV (#23, #24)
test('#23 a row with more fields than headers is flagged as a problem (quarantined), never imported truncated', () => {
  const p = parseCsvObjects('admission_no,amount\nA-1,1,000\n');
  assert.equal(p.rows.length, 1);
  assert.match(p.rows[0].problem || '', /fields but 2 headers/);
  const s = G.parseSettlementCsv('entity_id,amount,fee,tax,credit,settlement_id\npay_X,1,000,0,0,1000,setl_1\n');
  assert.equal(s.lines.length, 0);
  assert.equal(s.rejected.length, 1);
});

test('#24 generated duplicate-header names never collide with literal header names', () => {
  const p = parseCsvObjects('X,X,X (2)\n1,2,3\n');
  assert.equal(new Set(p.headers).size, 3, p.headers.join('|'));
  assert.deepEqual(Object.values(p.rows[0].values).sort(), ['1', '2', '3']);
  assert.equal(p.rows[0].values['X (2)'], '3', 'the literal header keeps its own value');
});

// ---------------------------------------------------------------- settlements (#25, #26, #30, #31)
const SETTLE_HEAD = 'entity_id,type,amount,fee,tax,credit,debit,settlement_id,settlement_utr,settled_at\n';
test('#25 an invalid fee or tax is rejected, not read as zero', () => {
  const s = G.parseSettlementCsv(`${SETTLE_HEAD}pay_A,payment,100.00,oops,nope,100.00,,setl_1,UTR1,2026-10-05\npay_B,payment,100.00,,,100.00,,setl_1,UTR1,2026-10-05\n`);
  assert.deepEqual(s.rejected.map(r => r.line), [2]);
  assert.match(s.rejected[0].reason, /fee or tax/);
  assert.equal(s.lines.length, 1, 'an empty fee/tax cell is still zero');
  assert.equal(s.lines[0].feePaise, 0);
});

function settledFixture() {
  const db = serverDb(); const inv = openInvoice(db); const o = order(db, inv);
  const pay = G.recordGatewayPayment(db, { order: o, payment: captured(o), gatewayMode: 'test' }, ctx()).payment;
  return { db, pay };
}

test('#26 refund lines are checked (debit = amount + fee + tax) and net to bank subtracts refund debits', () => {
  const { db, pay } = settledFixture();
  G.recordGatewayRefund(db, { refund: gwRefund(pay.gatewayPaymentId, 10000) }, ctx());
  const rupees = p => (p / 100).toFixed(2);
  const csv = `${SETTLE_HEAD}${pay.gatewayPaymentId},payment,${rupees(pay.amountPaise)},20.00,3.60,${rupees(pay.amountPaise - 2360)},,setl_1,UTR1,2026-10-05\n`
    + `rfnd_P2TEST0000001,refund,100.00,0,0,,999.00,setl_1,UTR1,2026-10-05\n`;
  const parsed = G.parseSettlementCsv(csv);
  assert.equal(parsed.rejected.length, 0, JSON.stringify(parsed.rejected));
  const rep = G.settlementReport(db, G.mergeSettlementLines([], parsed).added, {});
  assert.equal(rep.totals.identityOk, false, 'a refund debited 999.00 for a 100.00 refund is flagged');
  assert.deepEqual(rep.totals.identityMismatches.map(m => m.entityId), ['rfnd_P2TEST0000001']);
  assert.equal(rep.totals.refundDebitPaise, 99900);
  assert.equal(rep.totals.netPaise, pay.amountPaise - 2360 - 99900, 'net to bank = payment credits − refund debits');
});

test('#30 a line that conflicts with a stored line (same settlement + entity, different figures) is rejected, not a duplicate', () => {
  const a = G.parseSettlementCsv(`${SETTLE_HEAD}pay_A,payment,100.00,2.00,0.36,97.64,,setl_1,UTR1,2026-10-05\n`);
  const stored = G.mergeSettlementLines([], a).added;
  const same = G.mergeSettlementLines(stored, a);
  assert.deepEqual([same.imported, same.duplicate, same.rejected.length], [0, 1, 0]);
  const b = G.parseSettlementCsv(`${SETTLE_HEAD}pay_A,payment,100.00,2.00,0.36,90.00,,setl_1,UTR1,2026-10-05\npay_C,payment,5.00,0,0,5.00,,setl_2,UTR2,2026-10-05\npay_C,payment,6.00,0,0,6.00,,setl_2,UTR2,2026-10-05\n`);
  const m = G.mergeSettlementLines(stored, b);
  assert.equal(m.duplicate, 0);
  assert.equal(m.imported, 0, 'neither conflicting copy of pay_C is imported');
  assert.deepEqual(m.rejected.map(r => r.line).sort(), [2, 3, 4]);
  assert.match(m.rejected.find(r => r.line === 2).reason, /different/);
  assert.equal(m.imported + m.duplicate + m.rejected.length, b.lines.length);
});

test('#30 the settlement import command still reconciles input = imported + duplicate + rejected', () => {
  const db = serverDb();
  const p = admin(db);
  const text = `${SETTLE_HEAD}pay_A,payment,100.00,2.00,0.36,97.64,,setl_1,UTR1,2026-10-05\npay_A,payment,100.00,2.00,0.36,90.00,,setl_1,UTR1,2026-10-05\n`;
  const r = execute('fees.importSettlementCsv', db, [text], adminCtx(), p);
  assert.equal(r.inputRows, 2);
  assert.equal(r.imported + r.duplicate + r.rejected.length, r.inputRows);
  assert.equal(r.imported, 0);
});

test('#31 one payment in two settlements is flagged, not counted as two good matches', () => {
  const { db, pay } = settledFixture();
  const amt = (pay.amountPaise / 100).toFixed(2);
  const lines = G.mergeSettlementLines([], G.parseSettlementCsv(`${SETTLE_HEAD}${pay.gatewayPaymentId},payment,${amt},0,0,${amt},,setl_1,UTR1,2026-10-05\n${pay.gatewayPaymentId},payment,${amt},0,0,${amt},,setl_2,UTR2,2026-10-06\n`)).added;
  const rep = G.settlementReport(db, lines, {});
  assert.ok(rep.totals.amountMismatches >= 1, JSON.stringify(rep.totals));
  assert.ok(rep.rows.every(r => !r.amountMatches));
  assert.match(rep.rows[0].reason, /2 settlement lines/);
});

// ---------------------------------------------------------------- gateway refunds (#16, #17, #18, #19)
test('#16 a pending gateway refund is not booked; the processed event books it', () => {
  const { db, pay } = settledFixture();
  const pending = G.recordGatewayRefund(db, { refund: gwRefund(pay.gatewayPaymentId, 10000, { status: 'pending' }) }, ctx());
  assert.equal(pending.created, false);
  assert.match(pending.skipped, /pending/);
  const mine = () => db.refunds.filter(r => r.reference === 'rfnd_P2TEST0000001');
  assert.equal(mine().length, 0);
  assert.equal(G.recordGatewayRefund(db, { refund: gwRefund(pay.gatewayPaymentId, 10000, { status: 'failed' }) }, ctx()).created, false);
  assert.equal(G.recordGatewayRefund(db, { refund: gwRefund(pay.gatewayPaymentId, 10000) }, ctx()).created, true);
  assert.equal(mine().reduce((s, r) => s + r.amountPaise, 0), 10000);
});

test('#17 a gateway refund recorded by hand is not counted again by its webhook, and vice versa', () => {
  const { db, pay } = settledFixture();
  const inv = pay.allocations[0].invoiceId;
  F.refund(db, { paymentId: pay.id, invoiceId: inv, amountPaise: 10000, mode: 'online', reference: 'rfnd_P2TEST0000001', date: '2026-10-02', reason: 'refunded on the dashboard' }, ctx('2026-10-02', { role: 'accountant', id: 'stf-accountant' }));
  const w = G.recordGatewayRefund(db, { refund: gwRefund(pay.gatewayPaymentId, 10000) }, ctx());
  assert.equal(w.created, false);
  assert.equal(db.refunds.filter(r => r.reference === 'rfnd_P2TEST0000001').length, 1, 'one refund, not two');
  const other = settledFixture();
  G.recordGatewayRefund(other.db, { refund: gwRefund(other.pay.gatewayPaymentId, 10000) }, ctx());
  assert.throws(() => F.refund(other.db, { paymentId: other.pay.id, invoiceId: other.pay.allocations[0].invoiceId, amountPaise: 10000, mode: 'online', reference: 'rfnd_P2TEST0000001', date: '2026-10-02', reason: 'again' }, ctx()), { code: 'VALIDATION' });
});

test('#18 a payment captured by the gateway cannot be cancelled locally (money goes back only by refund)', () => {
  const { db, pay } = settledFixture();
  assert.throws(() => F.cancelPayment(db, pay.id, 'customer asked', ctx('2026-10-02', { role: 'accountant', id: 'stf-accountant' })), { code: 'VALIDATION', message: /refund/ });
  assert.equal(pay.status, 'valid');
});

test('#19 a gateway refund can return credit that was later applied to another invoice', () => {
  const db = serverDb();
  const inv = openInvoice(db);
  const s = db.students.find(x => x.id === inv.studentId);
  F.generateInvoices(db, { academicYearId: 'AY2026-27', programId: s.programId, installmentName: 'Term 3' }, adminCtx());
  const o = order(db, inv);
  const extra = 50000;
  const pay = G.recordGatewayPayment(db, { order: o, payment: captured(o, { amount: o.amountPaise + extra }), gatewayMode: 'test' }, ctx()).payment;
  assert.equal(pay.creditPaise, extra);
  const viaCredit = F.recordPayment(db, { studentId: s.id, mode: 'credit', paidOn: '2026-10-02' }, adminCtx());
  assert.equal(viaCredit.amountPaise, extra);
  const r = G.recordGatewayRefund(db, { refund: gwRefund(pay.gatewayPaymentId, pay.amountPaise) }, ctx());
  assert.equal(r.created, true);
  assert.equal(r.refunds.reduce((x, y) => x + y.amountPaise, 0), pay.amountPaise);
  assert.ok(r.refunds.some(x => x.paymentId === viaCredit.id), 'part comes back from the invoice the credit paid');
  for (const c of reconcile(db).checks) assert.ok(c.ok, `${c.name}: ${JSON.stringify(c.mismatches)}`);
});

// ---------------------------------------------------------------- reminders (#39)
test('#39 a due-day reminder sent on a later catch-up day does not say "due today"', () => {
  const db = seed();
  const inv = openInvoice(db);
  const eff = inv.dueDate;
  const late = R.remindersDue(db, (() => { const d = new Date(`${eff}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 3); return d.toISOString().slice(0, 10); })())
    .find(r => r.invoiceId === inv.id && r.kind === 'due');
  if (late) assert.doesNotMatch(late.text, /today/);
  const txt = R.reminderText(db, inv, 'due', '2026-10-10', 10000, '2026-10-12');
  assert.doesNotMatch(txt, /today/);
  assert.match(txt, /10-Oct-2026/);
  assert.match(R.reminderText(db, inv, 'due', '2026-10-10', 10000, '2026-10-10'), /today/);
});

// ---------------------------------------------------------------- GPS fixes (#44, #45)
function tripFixture() {
  const db = seed();
  const trip = T.startTrip(db, { routeId: 'route-1', direction: 'pickup', simulated: false }, { actor: { role: 'driver', id: 'stf-driver-1' }, now: '2026-10-02T02:00:00.000Z', today: '2026-10-02' });
  const route = db.routes.find(r => r.id === 'route-1');
  const stop = [...route.stops].sort((a, b) => a.seq - b.seq)[1];
  const at = (s, dLat = 0.002) => ({ lat: stop.lat + dLat, lng: stop.lng, accuracy: 8, ts: new Date(Date.UTC(2026, 9, 2, 2, 0, s)).toISOString() });
  return { db, trip, stop, at };
}

test('#44 a retried (duplicate) fix is a no-op: it does not reset the consecutive-fix counters', () => {
  const { db, trip, stop, at } = tripFixture();
  T.recordPosition(db, trip.id, at(10));
  const before = JSON.stringify(trip.tracker);
  assert.equal(T.recordPosition(db, trip.id, at(10)).rejected, 'not newer than the last fix');
  assert.equal(JSON.stringify(trip.tracker), before, 'tracker unchanged by the duplicate');
  const r = T.recordPosition(db, trip.id, at(20));
  assert.ok(r.newEvents.some(e => e.type === 'nearing' && e.stopId === stop.id), 'second consecutive near fix still fires nearing');
});

test('#45 a fix stamped in the future (device clock) is refused against server time and does not block later fixes', () => {
  const { db, trip, at } = tripFixture();
  const sctx = { actor: { role: 'driver', id: 'stf-driver-1' }, now: '2026-10-02T02:00:30.000Z', today: '2026-10-02' };
  const future = { ...at(0), ts: '2026-10-02T09:00:00.000Z' };
  const r = T.recordPosition(db, trip.id, future, sctx);
  assert.match(r.rejected || '', /future/);
  assert.equal(trip.positions.length, 0);
  assert.equal(T.recordPosition(db, trip.id, at(20), sctx).rejected ?? null, null, 'a genuine fix is still accepted');
  const viaCommand = execute('transport.recordPosition', db, [trip.id, { ...at(25), ts: '2026-10-03T00:00:00.000Z' }], sctx, personaFor(db, { role: 'driver', staffId: 'stf-driver-1' }));
  assert.match(viaCommand.rejected || '', /future/);
});

// ---------------------------------------------------------------- first-run (#46, #47)
const FR = { school: { name: 'Example Montessori' }, currentAcademicYearId: 'AY2026-27', academicYears: [{ id: 'AY2026-27', startDate: '2026-06-01', endDate: '2027-05-31' }], programs: [{ id: 'p1', name: 'Primary' }],
  staff: [{ id: 's-admin', firstName: 'Head', role: 'admin', email: 'head@example.com' }, { id: 's-t', firstName: 'Tea', role: 'teacher', email: 'tea@example.com', programIds: ['p1'] }] };
test('#46 first-run refuses a driver without a sign-in email', () => {
  assert.throws(() => firstRunSql({ ...FR, staff: [...FR.staff, { id: 's-d', firstName: 'Dri', role: 'driver' }] }), /s-d: an email is required/);
});
test('#47 first-run links every staff sign-in that already exists (not only the principal), confirmed and password-less only', () => {
  const sql = firstRunSql(FR);
  assert.match(sql, /tea@example\.com/);
  assert.match(sql, /email_confirmed_at is not null/);
  assert.match(sql, /coalesce\(u\.encrypted_password, ''\) = ''/);
});

// ---------------------------------------------------------------- consent on the server (#6, #7)
test('#6 a parent persona on the server covers only children with current app_account consent', () => {
  const db = seed();
  const p = personaFor(db, { role: 'parent', guardianId: 'grd-01' });
  const c = (studentId, purpose, extra = {}) => ({ id: `c-${studentId}-${purpose}`, guardianId: 'grd-01', studentId, purpose, version: CONSENT_VERSION, withdrawnAt: null, ...extra });
  assert.deepEqual(consentScopedPersona(db, p, []).studentIds, []);
  const one = consentScopedPersona(db, p, [c('stu-01', 'app_account'), c('stu-02', 'app_account', { version: 'v0' }), c('stu-02', 'push')]);
  assert.deepEqual(one.studentIds, ['stu-01']);
  assert.deepEqual(one.programIds, ['prog-primary-a']);
  assert.deepEqual(consentScopedPersona(db, p, [c('stu-01', 'app_account', { withdrawnAt: '2026-10-01T00:00:00Z' })]).studentIds, []);
  for (const n of ['consent.give', 'consent.withdraw', 'admin.dataExport', 'auth.redeemInvite']) assert.equal(COMMANDS[n].beforeConsent, true, n);
  assert.ok(!COMMANDS['threads.open'].beforeConsent);
});

test('#7 push delivery needs the purpose for the concerned child at the current notice version', () => {
  const rows = [
    { guardian_id: 'g1', student_id: 's1', purpose: 'push', version: CONSENT_VERSION },
    { guardian_id: 'g1', student_id: 's1', purpose: 'bus_live', version: CONSENT_VERSION },
    { guardian_id: 'g1', student_id: 's2', purpose: 'push', version: 'v0' },
  ];
  assert.equal(consentAllows(rows, 'g1', ['s1'], ['push', 'bus_live'], CONSENT_VERSION), true);
  assert.equal(consentAllows(rows, 'g1', ['s2'], ['push'], CONSENT_VERSION), false, 'old-version consent does not count');
  assert.equal(consentAllows(rows, 'g1', ['s3'], ['push', 'bus_live'], CONSENT_VERSION), false, "a sibling's consent does not cover a new child");
  const db = seed();
  const pay = { id: 'pay-x', studentId: 'stu-03', amountPaise: 100, receiptNumber: 'RCP/x' };
  const m = pushMessages('fees.recordPayment', db, db, pay);
  assert.deepEqual(m[0].studentIds, ['stu-03'], 'every message names the children it concerns');
});

// ---------------------------------------------------------------- invites (#11, coordinator: redeemedUserStatus)
test('#11 an invite locks after 5 wrong dates of birth, whichever accounts tried', () => {
  const db = serverDb();
  db.invites.push({ id: 'inv-code-1', codeHash: 'h', guardianId: 'grd-05', expiresAt: '2026-10-10T00:00:00.000Z', redeemedAt: null, redeemedBy: null, revokedAt: null, failedAttempts: 0 });
  const dob = db.students.find(s => s.id === 'stu-09').dob;
  for (let i = 0; i < 5; i++) {
    const r = execute('auth.redeemInvite', db, ['CODE', '2001-01-01'], { ...adminCtx(), actor: { role: 'user', id: `u${i}` }, userId: `u${i}`, userEmail: `u${i}@example.com`, inviteCodeHash: 'h' }, null);
    assert.ok(r.failure);
  }
  const ok = execute('auth.redeemInvite', db, ['CODE', dob], { ...adminCtx(), actor: { role: 'user', id: 'u9' }, userId: 'u9', userEmail: 'u9@example.com', inviteCodeHash: 'h' }, null);
  assert.ok(ok.failure, 'the right DOB is refused once the invite is locked');
  assert.match(ok.failure.message, /locked/);
  assert.equal(db.appUsers.length, 0);
  const list = execute('admin.invites', db, [], adminCtx(), admin(db));
  assert.equal(list[0].status, 'locked');
});

test('admin.invites reports the redeeming user\'s current status (redeemedUserStatus)', () => {
  const db = serverDb();
  const base = { codeHash: 'x', expiresAt: '2026-10-10T00:00:00.000Z', revokedAt: null, failedAttempts: 0, createdAt: '2026-10-01T00:00:00.000Z' };
  db.invites.push({ ...base, id: 'i1', guardianId: 'grd-01', redeemedAt: '2026-10-01T01:00:00Z', redeemedBy: 'u1' });
  db.invites.push({ ...base, id: 'i2', guardianId: 'grd-02', redeemedAt: '2026-10-01T01:00:00Z', redeemedBy: 'u2' });
  db.invites.push({ ...base, id: 'i3', guardianId: 'grd-03', redeemedAt: '2026-10-01T01:00:00Z', redeemedBy: 'u3' });
  db.invites.push({ ...base, id: 'i4', guardianId: 'grd-04', redeemedAt: null, redeemedBy: null });
  db.appUsers.push({ id: 'u1', role: 'parent', guardianId: 'grd-01', status: 'active' }, { id: 'u2', role: 'parent', guardianId: 'grd-02', status: 'revoked' });
  for (const p of [admin(db), personaFor(db, { role: 'accountant', staffId: 'stf-accountant' })]) {
    const by = Object.fromEntries(execute('admin.invites', db, [], adminCtx(), p).map(i => [i.id, i.redeemedUserStatus]));
    assert.deepEqual(by, { i1: 'active', i2: 'revoked', i3: 'missing', i4: null });
  }
});

// ---------------------------------------------------------------- revision guards across slices (#13)
test('#13 a write to a collection another slice also writes guards that slice too', () => {
  assert.deepEqual(guardSlices('ledger', ['guardians', 'students']), ['account', 'erasure']);
  assert.deepEqual(guardSlices('account', ['guardians', 'invites']), ['erasure', 'ledger']);
  assert.ok(guardSlices('ledger', ['staff']).includes('account'), 'staff role changes move app_users (account)');
  assert.deepEqual(guardSlices('ledger', ['payments', 'invoices']), []);
  assert.deepEqual(guardSlices('messaging', ['messages']), ['erasure']);
});

// ---------------------------------------------------------------- erasure (#8) and access export (#9)
function erasureDb() {
  const db = serverDb();
  db.appUsers.push({ id: 'u-g1', role: 'parent', staffId: null, guardianId: 'grd-01', status: 'active' });
  db.erasureRequests.push({ id: 'era-1', guardianId: 'grd-01', requestedAt: '2026-10-01T00:00:00Z', status: 'open', doneAt: null, doneBy: null });
  db.importBatches.push({ id: 'imb-1', kind: 'children', mapping: { admissionNo: 'Adm', firstName: 'First', guardian1Name: 'Mother', guardian1Phone: 'Mobile', guardian1Email: 'Email', guardian2Name: 'Father' }, status: 'committed' });
  db.importRows.push({ id: 'imb-1#1', batchId: 'imb-1', rowNo: 1, line: 2, values: { Adm: 'ADM-26-001', First: 'Neel', Mother: 'Meena Notrealsen', Mobile: '90000 00201', Email: 'meena.notrealsen1@example.com', Father: 'Someone Else' }, problem: null });
  db.importRows.push({ id: 'imb-1#2', batchId: 'imb-1', rowNo: 2, line: 3, values: { Adm: 'ADM-26-009', First: 'Arjun', Mother: 'Sunita Exampleton', Mobile: '90000 00205', Email: '', Father: '' }, problem: null });
  db.invites.push({ id: 'inv-open', codeHash: 'h', guardianId: 'grd-01', expiresAt: '2026-10-10T00:00:00.000Z', redeemedAt: null, redeemedBy: null, revokedAt: null, failedAttempts: 0 });
  return db;
}

test('#8 erasure scrubs the guardian, their messages, raw import columns and sign-in links, and records what was retained', () => {
  const db = erasureDb();
  const r = execute('people.anonymiseGuardian', db, ['grd-01'], adminCtx(), admin(db));
  const g = db.guardians.find(x => x.id === 'grd-01');
  assert.deepEqual([g.firstName, g.lastName, g.phone, g.email, g.relation], ['Erased-1', '', '', '', '']);
  const own = db.messages.filter(m => m.senderRole === 'parent' && m.senderId === 'grd-01');
  assert.ok(own.length > 0 && own.every(m => /erased/i.test(m.body)), 'messages written by the guardian are erased');
  assert.equal(db.appUsers[0].status, 'revoked');
  assert.deepEqual(r.revokedUserIds, ['u-g1']);
  const row1 = db.importRows.find(x => x.id === 'imb-1#1').values;
  assert.deepEqual([row1.Mother, row1.Mobile, row1.Email], ['', '', '']);
  assert.equal(row1.Father, 'Someone Else', "another guardian's columns are left alone");
  assert.equal(db.importRows.find(x => x.id === 'imb-1#2').values.Mother, 'Sunita Exampleton');
  assert.ok(db.invites[0].revokedAt, 'an open invite for the guardian is revoked');
  const req = db.erasureRequests[0];
  assert.equal(req.status, 'done');
  assert.ok(Array.isArray(req.retained) && req.retained.length >= 2, 'what was kept, and why, is recorded');
  assert.ok(req.erased && req.erased.messages === own.length && req.erased.importRows === 1);
  assert.equal(JSON.stringify(db).includes('meena.notrealsen1@example.com'), false, 'the email appears nowhere in the loaded data');
  assert.equal(COMMANDS['people.anonymiseGuardian'].slice, 'erasure');
});

test('#9 the access export includes transport events, sign-in links, erasure requests, reminders, push devices and import records', () => {
  const db = erasureDb();
  db.remindersSent = [{ invoiceId: db.invoices.find(i => i.studentId === 'stu-01').id, kind: 'due', sentOn: '2026-10-01', text: 'Fee due' }];
  db.pushSubscriptions = [{ userId: 'u-g1', endpoint: 'https://fcm.googleapis.com/fcm/send/abcdef', createdAt: '2026-10-01T00:00:00Z' }];
  db.gatewayOrders = [{ id: 'order_1', studentId: 'stu-01', guardianId: 'grd-01', amountPaise: 100, status: 'paid', createdAt: '2026-10-01T00:00:00Z' }];
  const trip = db.trips[0];
  trip.childEvents.push({ studentId: 'stu-01', stopId: 'route-1-stop-3', type: 'boarded', ts: '2026-10-01T02:10:00.000Z', by: 'stf-driver-1' });
  const x = guardianExport(db, 'grd-01');
  assert.ok(x.transportEvents.length >= 1 && x.transportEvents.every(e => e.studentId === 'stu-01'), 'only own children\'s boarding/drop-off events');
  assert.deepEqual(x.account.map(a => [a.userId, a.status]), [['u-g1', 'active']]);
  assert.equal(x.erasureRequests.length, 1);
  assert.equal(x.reminders.length, 1);
  assert.deepEqual(x.pushDevices, [{ service: 'fcm.googleapis.com', createdAt: '2026-10-01T00:00:00Z' }], 'the device endpoint (a capability URL) is not exported, only its service');
  assert.equal(x.importRecords.length, 1);
  assert.equal(x.importRecords[0].values.Father, '', "the co-parent's columns are not exported to this guardian");
  assert.equal(x.importRecords[0].values.Mother, 'Meena Notrealsen');
  assert.equal(x.paymentOrders.length, 1);
  assert.ok(x.invites.length === 1 && !('codeHash' in x.invites[0]));
  const plain = guardianExport(seed(), 'grd-01');
  for (const k of ['transportEvents', 'account', 'erasureRequests', 'reminders', 'pushDevices', 'importRecords', 'paymentOrders', 'invites']) assert.ok(Array.isArray(plain[k]), `${k} present in the demo export too`);
});

// ---------------------------------------------------------------- push endpoints (#15), paging (#27)
test('#15 push endpoints must be https on a known push service (no internal or arbitrary hosts)', () => {
  for (const ok of ['https://fcm.googleapis.com/fcm/send/abc', 'https://updates.push.services.mozilla.com/wpush/v2/abc', 'https://web.push.apple.com/QAbc', 'https://db5p.notify.windows.com/w/?token=x']) assert.equal(pushEndpointAllowed(ok), true, ok);
  for (const bad of ['http://fcm.googleapis.com/x', 'https://169.254.169.254/latest', 'https://localhost/x', 'https://evil.example.com/push', 'https://fcm.googleapis.com.evil.example/x', 'ftp://fcm.googleapis.com/x', 'not a url', 'https://user:pw@fcm.googleapis.com/x']) assert.equal(pushEndpointAllowed(bad), false, bad);
  assert.equal(pushEndpointAllowed('http://host.lima.internal:54399/push/x', ['http://host.lima.internal:54399']), true, 'an explicitly configured local test origin');
  assert.equal(pushEndpointAllowed('http://host.lima.internal:54400/push/x', ['http://host.lima.internal:54399']), false);
});

test('#27 REST reads are paged until a short page (no silent 1000-row cap)', async () => {
  const all = Array.from({ length: 2345 }, (_, i) => i);
  const calls = [];
  const got = await fetchAllPages(async (offset, limit) => { calls.push([offset, limit]); return all.slice(offset, offset + limit); }, 1000);
  assert.equal(got.length, 2345);
  assert.deepEqual(calls, [[0, 1000], [1000, 1000], [2000, 1000]]);
  assert.equal((await fetchAllPages(async (o, l) => all.slice(0, 1000).slice(o, o + l), 1000)).length, 1000, 'an exactly full last page triggers one more (empty) read');
});

test('#6/#7 the SQL consent version (app.consent_version) equals CONSENT_VERSION', async () => {
  const { readFileSync } = await import('node:fs');
  const sql = readFileSync(new URL('../supabase/migrations/0003_audit_fixes.sql', import.meta.url), 'utf8');
  const m = /create function app\.consent_version\(\)[^$]*\$\$\s*select '([^']+)'::text/.exec(sql);
  assert.ok(m, 'app.consent_version() found');
  assert.equal(m[1], CONSENT_VERSION);
});
