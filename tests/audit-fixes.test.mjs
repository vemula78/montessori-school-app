// Reproductions for the Phase 4 audit findings (one test per finding number).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyDb } from '../src/store/schema.js';
import { Storage, memoryBackend, DB_KEY } from '../src/store/storage.js';
import * as API from '../src/api/index.js';
const { createApi } = API;
import * as F from '../src/domain/fees.js';
import { reconcile } from '../src/domain/reconcile.js';
import { validateDb } from '../src/domain/validate.js';
import { previewHolidayCsv, importHolidays, parseCsv } from '../src/domain/holiday-csv.js';
import { listEvents, nextWorkingDay } from '../src/domain/calendar.js';
import { tsToMs, addDays } from '../src/domain/dates.js';
import * as T from '../src/domain/transport.js';
import { simulationPlan } from '../src/domain/sim.js';

const ctx = (today = '2026-10-20', role = 'accountant', id = 'stf-acc') => ({ actor: { role, id }, now: `${today}T05:00:00.000Z`, today });
const clock = () => new Date(Date.UTC(2026, 9, 20, 5, 0, 0));
const quota = () => { const e = new Error('full'); e.name = 'QuotaExceededError'; throw e; };

// ---------------- fee fixture (same shape as fees.test.mjs) ----------------
function fixture() {
  const db = createEmptyDb();
  db.school = { ...db.school, name: 'Fixture School (Demo)', phone: '+91-90000-00001', currentAcademicYearId: 'AY2026-27',
    lateFeeRule: { graceDays: 5, mode: 'perDay', amountPaise: 1000, capPaise: 20000, shiftDueToWorkingDay: true } };
  db.academicYears.push(
    { id: 'AY2025-26', label: '2025-26', startDate: '2025-06-01', endDate: '2026-05-31' },
    { id: 'AY2026-27', label: '2026-27', startDate: '2026-06-01', endDate: '2027-05-31' },
  );
  db.programs.push({ id: 'P1', name: 'Primary A', ageRange: '3-6', teacherIds: [] }, { id: 'P2', name: 'Primary B', ageRange: '3-6', teacherIds: [] });
  db.feeHeads.push(
    { id: 'H-TUI', name: 'Tuition', kind: 'tuition' }, { id: 'H-TRN', name: 'Transport', kind: 'transport' },
    { id: 'H-MAT', name: 'Materials', kind: 'materials' }, { id: 'H-LATE', name: 'Late fee', kind: 'lateFee' },
  );
  db.staff.push({ id: 'stf-acc', firstName: 'Ava', lastName: 'Demoson', role: 'accountant', programIds: [], phone: '+91-90000-00001' },
    { id: 'stf-drv', firstName: 'Dev', lastName: 'Testwala', role: 'driver', programIds: [], phone: '+91-90000-00002' });
  db.routes.push({ id: 'R1', name: 'Route 1', busNo: 'DEMO-1', driverId: 'stf-drv', attendantId: null, transportFeePaise: 300000,
    stops: [{ id: 'S1', name: 'Stop One', lat: 12.97, lng: 77.75, seq: 1, scheduledPickup: '07:30', scheduledDrop: '13:30' }], path: null });
  const g = (id, studentIds) => ({ id, firstName: 'G', lastName: 'Sampleraj', relation: 'mother', phone: '+91-90000-00100', email: `${id}@example.com`, studentIds });
  db.guardians.push(g('G1', ['A', 'B']), g('G2', ['C']));
  const s = (id, programId, dob, guardianIds, extra = {}) => ({ id, firstName: id, lastName: 'Sampleraj', dob, programId, admissionNo: `ADM-${id}`,
    status: 'active', guardianIds, routeId: null, stopId: null, feeCategory: 'regular', healthNotes: null, ...extra });
  db.students.push(s('A', 'P1', '2021-03-01', ['G1']), s('B', 'P2', '2022-05-01', ['G1']), s('C', 'P1', '2021-08-01', ['G2'], { routeId: 'R1', stopId: 'S1' }));
  const inst = [
    { name: 'Term 1', dueDate: '2026-06-15', lines: [{ headId: 'H-TUI', amountPaise: 2500000 }, { headId: 'H-MAT', amountPaise: 300000 }] },
    { name: 'Term 2', dueDate: '2026-10-02', lines: [{ headId: 'H-TUI', amountPaise: 2500000 }] },
  ];
  db.feeStructures.push({ id: 'FS1', academicYearId: 'AY2026-27', programId: 'P1', siblingDiscountBp: 1000, installments: inst },
    { id: 'FS2', academicYearId: 'AY2026-27', programId: 'P2', siblingDiscountBp: 1000, installments: inst });
  db.calendarEvents.push({ id: 'E1', academicYearId: 'AY2026-27', type: 'holiday', title: 'Sample holiday', startDate: '2026-10-02', endDate: '2026-10-02', programIds: [], description: '', source: 'manual', importBatchId: null });
  return db;
}
function withInvoices() {
  const db = fixture();
  for (const p of ['P1', 'P2']) for (const t of ['Term 1', 'Term 2']) F.generateInvoices(db, { academicYearId: 'AY2026-27', programId: p, installmentName: t }, ctx('2026-06-01'));
  return db;
}
const inv = (db, studentId, term) => db.invoices.find(i => i.studentId === studentId && i.installmentName === term && i.status !== 'cancelled');
const errors = v => v.filter(x => x.severity !== 'warning');

// ---------------- api fixture for scoping ----------------
// PA: K1 (G-SIB, bus stop S1), K4 (G-LEFT, status left). PB: K2 (G-SIB), K3 (G-OTH, bus stop S2). Teacher TA teaches PA only.
function apiFixture() {
  const db = createEmptyDb();
  db.school = { ...db.school, name: 'Fixture School (Demo)', phone: '+91-90000-00001', currentAcademicYearId: 'AY2026-27' };
  db.academicYears.push({ id: 'AY2026-27', label: '2026-27', startDate: '2026-06-01', endDate: '2027-05-31' });
  db.programs.push({ id: 'PA', name: 'Primary A', ageRange: '3-6', teacherIds: ['TA'] }, { id: 'PB', name: 'Primary B', ageRange: '3-6', teacherIds: [] });
  db.staff.push({ id: 'ADM', firstName: 'Ada', lastName: 'Placeholdar', role: 'admin', programIds: [], phone: '+91-90000-00001' },
    { id: 'TA', firstName: 'Tia', lastName: 'Mockherjee', role: 'teacher', programIds: ['PA'], phone: '+91-90000-00002' },
    { id: 'ACC', firstName: 'Ash', lastName: 'Demoson', role: 'accountant', programIds: [], phone: '+91-90000-00003' },
    { id: 'DRV', firstName: 'Dev', lastName: 'Testwala', role: 'driver', programIds: [], phone: '+91-90000-00004' });
  const g = (id, studentIds) => ({ id, firstName: id, lastName: 'Sampleraj', relation: 'parent', phone: '+91-90000-00100', email: `${id}@example.com`, studentIds });
  db.guardians.push(g('G-SIB', ['K1', 'K2']), g('G-OTH', ['K3']), g('G-LEFT', ['K4']));
  const s = (id, programId, guardianIds, extra = {}) => ({ id, firstName: id, lastName: 'Sampleraj', dob: '2022-01-01', programId, admissionNo: id, status: 'active', guardianIds, routeId: null, stopId: null, feeCategory: 'regular', healthNotes: null, ...extra });
  db.students.push(s('K1', 'PA', ['G-SIB'], { routeId: 'R1', stopId: 'S1' }), s('K2', 'PB', ['G-SIB']), s('K3', 'PB', ['G-OTH'], { routeId: 'R1', stopId: 'S2' }), s('K4', 'PA', ['G-LEFT'], { status: 'left' }));
  db.routes.push({ id: 'R1', name: 'Route 1', busNo: 'DEMO-1', driverId: 'DRV', attendantId: null, transportFeePaise: 100000, path: null, stops: [
    { id: 'S1', name: 'Stop One', lat: 12.970, lng: 77.750, seq: 1, scheduledPickup: '07:30', scheduledDrop: '13:30' },
    { id: 'S2', name: 'Stop Two', lat: 12.980, lng: 77.750, seq: 2, scheduledPickup: '07:40', scheduledDrop: '13:20' }] });
  db.feeHeads.push({ id: 'H-TUI', name: 'Tuition', kind: 'tuition' });
  db.invoices.push({ id: 'INV-K4', number: 'INV/26-27/0001', studentId: 'K4', academicYearId: 'AY2026-27', installmentName: 'Term 1', issueDate: '2026-06-01', dueDate: '2026-06-15',
    lines: [{ id: 'l1', headId: 'H-TUI', description: 'Tuition', amountPaise: 100000 }], concessions: [], status: 'issued', cancelReason: null, createdAt: '2026-06-01T05:00:00.000Z' });
  db.counters.invoice['AY2026-27'] = 1;
  const ev = (id, programIds) => ({ id, academicYearId: 'AY2026-27', type: 'event', title: id, startDate: '2026-11-02', endDate: '2026-11-02', programIds, description: '', source: 'manual', importBatchId: null });
  db.calendarEvents.push(ev('school-wide', []), ev('pa-only', ['PA']), ev('pb-only', ['PB']));
  return db;
}
async function makeApi(seedFn = apiFixture, backend = memoryBackend()) {
  let t = Date.UTC(2026, 9, 20, 2, 0, 0);
  const api = createApi({ backend, sessionBackend: memoryBackend(), seedFn, clock: () => new Date(t += 1000) });
  await api.ready();
  return { api, as: id => api.session.set(`persona-${id}`), backend };
}

// =============================== storage ===============================

test('#2 quota failure is not applied; retrying records exactly one payment', () => {
  const be = memoryBackend();
  const s = new Storage({ backend: be, seedFn: withInvoices, clock });
  s.load();
  const real = be.setItem;
  be.setItem = quota;
  const pay = d => F.recordPayment(d, { studentId: 'A', amountPaise: 1000, mode: 'cash', paidOn: '2026-06-10' }, ctx());
  assert.throws(() => s.commit(pay), { code: 'STORAGE_QUOTA' });
  assert.equal(s.db.payments.length, 0);
  be.setItem = real;
  s.commit(pay);
  const stored = JSON.parse(be.getItem(DB_KEY));
  assert.equal(stored.payments.length, 1);
  assert.equal(stored.counters.receipt['AY2026-27'], 1);
});

test('#3 a tab recovering from a quota failure does not overwrite another tab\'s commit', () => {
  const be = memoryBackend();
  const a = new Storage({ backend: be, seedFn: withInvoices, clock });
  const b = new Storage({ backend: be, seedFn: withInvoices, clock });
  a.load(); b.load();
  const real = be.setItem;
  be.setItem = quota;
  assert.throws(() => a.commit(d => { d.school.address = 'from A'; }), { code: 'STORAGE_QUOTA' });
  be.setItem = real;
  b.commit(d => { d.school.phone = '+91-90000-00777'; });
  a.commit(d => { d.school.address = 'from A again'; });
  const stored = JSON.parse(be.getItem(DB_KEY));
  assert.equal(stored.school.phone, '+91-90000-00777');
  assert.equal(stored.school.address, 'from A again');
});

test('#4 a delayed (older) storage event never regresses the loaded revision', () => {
  const be = memoryBackend();
  const t1 = new Storage({ backend: be, seedFn: withInvoices, clock });
  const t2 = new Storage({ backend: be, seedFn: withInvoices, clock });
  t1.load(); t2.load();
  t1.commit(d => { d.school.address = 'v1'; });
  const v1 = be.getItem(DB_KEY);
  t1.commit(d => { d.school.address = 'v2'; });
  t2.handleExternalChange(be.getItem(DB_KEY));
  t2.handleExternalChange(v1); // arrives late
  assert.equal(t2.db.rev, 2);
  assert.equal(t2.db.school.address, 'v2');
});

test('#5 reset/import from a stale tab gets a higher revision that other tabs accept', () => {
  const be = memoryBackend();
  const t1 = new Storage({ backend: be, seedFn: withInvoices, clock });
  const stale = new Storage({ backend: be, seedFn: withInvoices, clock });
  t1.load(); stale.load();
  for (let i = 0; i < 3; i++) t1.commit(d => { d.school.address = `edit ${i}`; });
  stale.resetToSeed(ctx('2026-10-20', 'admin', 'ADM'));
  const stored = JSON.parse(be.getItem(DB_KEY));
  assert.ok(stored.rev > 3, `rev ${stored.rev}`);
  t1.handleExternalChange(be.getItem(DB_KEY));
  assert.equal(t1.db.school.address, '');
  const dump = t1.exportJson();
  for (let i = 0; i < 2; i++) t1.commit(d => { d.school.address = `later ${i}`; });
  stale.importJson(dump, ctx('2026-10-20', 'admin', 'ADM'));
  assert.ok(JSON.parse(be.getItem(DB_KEY)).rev > stored.rev + 2);
});

test('#6 a full localStorage is still used (read probe only); unusable storage is reported, not silent', () => {
  const store = new Map([[DB_KEY, '{"existing":true}']]);
  const fullLs = { getItem: k => store.get(k) ?? null, setItem: quota, removeItem: () => {} };
  const ok = API.pickBackend({ localStorage: fullLs }, 'localStorage');
  assert.equal(ok.backend, fullLs);
  assert.equal(ok.persistent, true);
  const blocked = API.pickBackend({ get localStorage() { const e = new Error('denied'); e.name = 'SecurityError'; throw e; } }, 'localStorage');
  assert.equal(blocked.persistent, false);
  assert.match(blocked.reason, /SecurityError/);
});

test('#7 structurally invalid JSON is treated as corrupt, not ok', () => {
  const be = memoryBackend();
  be.setItem(DB_KEY, '{"schemaVersion":1,"rev":0}');
  const s = new Storage({ backend: be, seedFn: withInvoices, clock });
  assert.equal(s.load().status, 'corrupt');
});

test('#8 import refuses a document with integrity errors', () => {
  const be = memoryBackend();
  const s = new Storage({ backend: be, seedFn: withInvoices, clock });
  s.load();
  const bad = withInvoices();
  F.recordPayment(bad, { studentId: 'A', amountPaise: 1000, mode: 'cash', paidOn: '2026-06-10' }, ctx());
  F.recordPayment(bad, { studentId: 'A', amountPaise: 1000, mode: 'cash', paidOn: '2026-06-10' }, ctx());
  bad.payments[1].receiptNumber = bad.payments[0].receiptNumber;
  assert.throws(() => s.importJson(JSON.stringify(bad), ctx()), { code: 'VALIDATION' });
  assert.equal(s.db.payments.length, 0);
});

test('#9 validateDb returns violations for malformed records instead of throwing', () => {
  const db = withInvoices();
  db.students.push(null);
  db.invoices[0].lines = 'oops';
  db.payments.push({ id: 'p-x', allocations: [null] });
  let v;
  assert.doesNotThrow(() => { v = validateDb(db); });
  assert.ok(v.some(x => x.code === 'MALFORMED'), JSON.stringify(v.slice(0, 5)));
});

test('#10 validateDb checks payment dates/AY, credit funding, positive amounts and rule values', () => {
  const base = withInvoices();
  F.recordPayment(base, { studentId: 'A', amountPaise: 1000, mode: 'cash', paidOn: '2026-06-10' }, ctx());
  const codes = mutate => { const d = structuredClone(base); mutate(d); return errors(validateDb(d)).map(x => x.code); };
  assert.ok(codes(d => { d.payments[0].paidOn = '2025-07-01'; }).length > 0, 'paidOn in another AY than the receipt');
  assert.ok(codes(d => { d.payments[0].paidOn = 'yesterday'; }).length > 0, 'invalid paidOn');
  assert.ok(codes(d => { d.payments[0].mode = 'credit'; }).length > 0, 'unfunded credit payment');
  assert.ok(codes(d => { d.payments[0].amountPaise = 0; d.payments[0].allocations[0].amountPaise = 0; }).length > 0, 'zero payment');
  assert.ok(codes(d => { d.school.lateFeeRule.amountPaise = -5; }).length > 0, 'negative late-fee amount');
  assert.ok(codes(d => { d.school.lateFeeRule.graceDays = -1; }).length > 0, 'negative grace days');
  assert.ok(codes(d => { d.invoices[0].status = 'weird'; }).length > 0, 'unknown invoice status');
  assert.ok(codes(d => { d.payments[0].status = 'weird'; }).length > 0, 'unknown payment status');
});

test('#11 counters ahead of the highest number, and numbers in the wrong AY, are violations', () => {
  const db = withInvoices();
  db.counters.receipt['AY2026-27'] = 50;
  assert.ok(errors(validateDb(db)).some(v => v.code === 'COUNTER_AHEAD'));
  const db2 = withInvoices();
  db2.invoices[0].number = 'INV/25-26/0001';
  assert.ok(errors(validateDb(db2)).length > 0);
});

test('#12 a cleared store is not resurrected from another tab\'s memory', () => {
  const be = memoryBackend();
  const t1 = new Storage({ backend: be, seedFn: withInvoices, clock });
  t1.load();
  be.removeItem(DB_KEY);
  assert.throws(() => t1.commit(d => { d.school.address = 'x'; }), { code: 'STORAGE_CORRUPT' });
  assert.equal(be.getItem(DB_KEY), null);
  const t2 = new Storage({ backend: be, seedFn: withInvoices, clock });
  be.setItem(DB_KEY, JSON.stringify(withInvoices()));
  t2.load();
  be.removeItem(DB_KEY);
  t2.handleExternalChange(null);
  assert.equal(t2.status, 'missing');
});

test('#13 corruption after startup is signalled to subscribers with a status', async () => {
  const be = memoryBackend();
  const s = new Storage({ backend: be, seedFn: withInvoices, clock });
  s.load();
  let got = null;
  s.subscribe((db, info) => { got = { db, info }; });
  be.setItem(DB_KEY, '{broken');
  s.handleExternalChange('{broken');
  assert.equal(got.db, null);
  assert.equal(got.info.status, 'corrupt');
  // and through the api
  const { api, backend } = await makeApi();
  let apiGot = null;
  api.subscribe((db, info) => { apiGot = info; });
  backend.setItem(DB_KEY, '{broken');
  api._storage().handleExternalChange('{broken');
  assert.equal(apiGot.status, 'corrupt');
});

test('#14 two corrupt blobs preserved in the same millisecond keep both copies', () => {
  const be = memoryBackend();
  const s = new Storage({ backend: be, seedFn: withInvoices, clock });
  be.setItem(DB_KEY, 'first-bad');
  s.load();
  const k1 = s.corruptKey;
  be.setItem(DB_KEY, 'second-bad');
  s.load();
  assert.notEqual(s.corruptKey, k1);
  assert.equal(be.getItem(k1), 'first-bad');
  assert.equal(be.getItem(s.corruptKey), 'second-bad');
});

// =============================== fees ===============================

/** A pays T1 in full and T2 except ₹10, plus ₹100 extra → credit 10000, debt 1000. */
function creditOverDebt() {
  const db = withInvoices();
  const t1 = inv(db, 'A', 'Term 1'), t2 = inv(db, 'A', 'Term 2');
  const p = F.recordPayment(db, { studentId: 'A', amountPaise: 2800000 + 2499000 + 10000, mode: 'cash', paidOn: '2026-06-10',
    allocations: [{ invoiceId: t1.id, amountPaise: 2800000 }, { invoiceId: t2.id, amountPaise: 2499000 }] }, ctx());
  return { db, t2, p };
}

test('#15 credit transfers are excluded from externally received money', () => {
  const { db } = creditOverDebt();
  F.recordPayment(db, { studentId: 'A', mode: 'credit', paidOn: '2026-06-12' }, ctx());
  const r = reconcile(db);
  assert.equal(r.school.externalReceivedPaise, 2800000 + 2499000 + 10000);
  assert.equal(r.school.receivedValid, 2800000 + 2499000 + 10000 + 1000);
  const rep = F.outstandingReport(db, { academicYearId: 'AY2026-27', asOfDate: '2026-10-20' });
  assert.equal(rep.totals.externalReceivedPaise, 2800000 + 2499000 + 10000);
});

test('#16 outstandingReport is historical as of the given date', () => {
  const db = withInvoices(); // issued 2026-06-01
  const before = F.outstandingReport(db, { academicYearId: 'AY2026-27', asOfDate: '2026-05-20' });
  assert.equal(before.totals.invoicedPaise, 0);
  F.recordPayment(db, { studentId: 'A', amountPaise: 1000000, mode: 'cash', paidOn: '2026-06-10' }, ctx());
  F.cancelInvoice(db, inv(db, 'B', 'Term 2').id, 'issued in error', ctx('2026-10-20'));
  const june5 = F.outstandingReport(db, { academicYearId: 'AY2026-27', asOfDate: '2026-06-05' });
  assert.equal(june5.totals.paidPaise, 0);
  const rowA = june5.rows.find(r => r.studentId === 'A');
  assert.equal(rowA.balancePaise, 2800000 + 2500000);
  const rowB = june5.rows.find(r => r.studentId === 'B');
  assert.equal(rowB.invoiceCount, 2, 'invoice cancelled later is still live on 05-Jun');
  const now = F.outstandingReport(db, { academicYearId: 'AY2026-27', asOfDate: '2026-10-20' });
  assert.equal(now.rows.find(r => r.studentId === 'B').invoiceCount, 1);
  assert.equal(now.totals.paidPaise, 1000000);
});

test('#17 applying credit larger than the debt consumes only the debt and keeps the rest', () => {
  const { db, t2 } = creditOverDebt();
  const cp = F.recordPayment(db, { studentId: 'A', mode: 'credit', paidOn: '2026-06-12', allowCredit: false }, ctx());
  assert.equal(cp.amountPaise, 1000);
  assert.equal(F.invoiceBalance(db, t2), 0);
  assert.equal(F.availableCreditPaise(db, 'A'), 9000);
  assert.deepEqual(errors(validateDb(db)), []);
  assert.ok(reconcile(db).checks.every(c => c.ok));
});

test('#18 unallocated credit can be refunded (by creditId or by paymentId with invoiceId null)', () => {
  const { db, p } = creditOverDebt();
  const credit = F.availableCredits(db, 'A')[0];
  const r1 = F.refund(db, { creditId: credit.id, amountPaise: 4000, mode: 'cash', date: '2026-06-15', reason: 'advance returned' }, ctx());
  assert.equal(r1.invoiceId, null);
  assert.equal(F.availableCreditPaise(db, 'A'), 6000);
  F.refund(db, { paymentId: p.id, invoiceId: null, amountPaise: 6000, mode: 'bank', date: '2026-06-16', reason: 'rest returned' }, ctx());
  assert.equal(F.availableCreditPaise(db, 'A'), 0);
  assert.throws(() => F.refund(db, { paymentId: p.id, invoiceId: null, amountPaise: 1, mode: 'bank', date: '2026-06-16', reason: 'x' }, ctx()), { code: 'INVALID_AMOUNT' });
  assert.deepEqual(errors(validateDb(db)), []);
  assert.ok(reconcile(db).checks.every(c => c.ok), JSON.stringify(reconcile(db).checks.filter(c => !c.ok)));
});

test('#19 refund date must be on/after the payment date and not in the future', () => {
  const db = withInvoices();
  const a1 = inv(db, 'A', 'Term 1');
  const p = F.recordPayment(db, { studentId: 'A', amountPaise: 100000, mode: 'cash', paidOn: '2026-06-10' }, ctx());
  const r = date => F.refund(db, { paymentId: p.id, invoiceId: a1.id, amountPaise: 100, mode: 'cash', date, reason: 'x' }, ctx('2026-10-20'));
  assert.throws(() => r('2026-06-09'), { code: 'VALIDATION' });
  assert.throws(() => r('2026-10-21'), { code: 'VALIDATION' });
  assert.equal(r('2026-06-10').amountPaise, 100);
});

test('#20 a waived late fee does not re-accrue for the waived period', () => {
  const db = withInvoices();
  const a2 = inv(db, 'A', 'Term 2');
  F.applyLateFee(db, a2.id, '2026-10-13', ctx('2026-10-13'));
  F.waiveLateFee(db, a2.id, 'first instance', ctx('2026-10-13'));
  assert.equal(F.lateFeeDue(db, a2, '2026-10-13').amountPaise, 0);
  assert.equal(F.lateFeeDue(db, a2, '2026-10-14').amountPaise, 1000); // one new day only
  assert.equal(a2.lateFeeWaivers.length, 1);
  assert.equal(a2.lateFeeWaivers[0].waivedPaise, 3000);
  assert.equal(a2.lateFeeWaivers[0].waivedUpTo, '2026-10-13');
});

test('#21 (property) effective due date is monotone in the nominal due date, so allocation order agrees', () => {
  const db = fixture();
  db.calendarEvents.push({ id: 'E2', academicYearId: 'AY2026-27', type: 'holiday', title: 'P1 break', startDate: '2026-10-05', endDate: '2026-10-09', programIds: ['P1'], description: '', source: 'manual', importBatchId: null });
  let prev = null;
  for (let d = '2026-09-20'; d <= '2026-11-10'; d = addDays(d, 1)) {
    const eff = nextWorkingDay(db, d, 'P1');
    if (prev) assert.ok(eff >= prev, `${d} → ${eff} < ${prev}`);
    prev = eff;
  }
});

test('#22 fee structure due dates must fall inside the structure\'s academic year', () => {
  const db = fixture();
  const s = structuredClone(db.feeStructures[0]);
  s.installments[0].dueDate = '2027-07-01';
  assert.throws(() => F.saveStructure(db, s, ctx()), { code: 'VALIDATION' });
});

test('#24 receipts keep the fee-head description captured at payment time', () => {
  const db = withInvoices();
  const a2 = inv(db, 'A', 'Term 2');
  const p = F.recordPayment(db, { studentId: 'A', amountPaise: 1000, mode: 'cash', paidOn: '2026-10-12', allocations: [{ invoiceId: a2.id, amountPaise: 1000 }] }, ctx());
  const before = F.receiptView(db, p.id).allocations[0].headName;
  F.applyLateFee(db, a2.id, '2026-10-13', ctx('2026-10-13'));
  assert.equal(F.receiptView(db, p.id).allocations[0].headName, before);
  assert.equal(before, 'Tuition');
});

test('#67 a late fee cannot be applied as of a future date', () => {
  const db = withInvoices();
  assert.throws(() => F.applyLateFee(db, inv(db, 'A', 'Term 2').id, '2026-12-31', ctx('2026-10-20')), { code: 'VALIDATION' });
});

test('#68 the cap also limits flat late fees', () => {
  const db = withInvoices();
  db.school.lateFeeRule = { graceDays: 0, mode: 'flat', amountPaise: 5000, capPaise: 3000, shiftDueToWorkingDay: false };
  assert.equal(F.lateFeeDue(db, inv(db, 'A', 'Term 2'), '2026-10-20').amountPaise, 3000);
});

test('XSS: validateDb/import reject non-numeric or non-boolean late-fee rule fields', () => {
  const be = memoryBackend();
  const s = new Storage({ backend: be, seedFn: withInvoices, clock });
  s.load();
  const bad = withInvoices();
  bad.school.lateFeeRule.graceDays = '<img src=x onerror=alert(1)>';
  assert.throws(() => s.importJson(JSON.stringify(bad), ctx()), { code: 'VALIDATION' });
  const bad2 = withInvoices();
  bad2.school.lateFeeRule.shiftDueToWorkingDay = '<b>yes</b>';
  assert.ok(errors(validateDb(bad2)).length > 0);
  const bad3 = withInvoices();
  bad3.school.lateFeeRule.mode = '<script>';
  assert.ok(errors(validateDb(bad3)).length > 0);
});

test('#23 validateDb warns on academic-year gaps and errors on overlaps', () => {
  const db = fixture();
  db.academicYears[0].endDate = '2026-03-31';
  const v = validateDb(db);
  assert.ok(v.some(x => x.code === 'AY_GAP' && x.severity === 'warning'));
  const db2 = fixture();
  db2.academicYears[0].endDate = '2026-07-31';
  assert.ok(errors(validateDb(db2)).some(x => x.code === 'AY_OVERLAP'));
});

// =============================== api scoping ===============================

test('#27 parents see only their own children in a notice audience', async () => {
  const { api, as } = await makeApi();
  as('ADM');
  await api.notices.send({ title: 'Few', body: 'x', audience: { scope: 'students', studentIds: ['K1', 'K3'] } });
  as('G-SIB');
  const [n] = await api.notices.list();
  assert.deepEqual(n.aboutStudentIds, ['K1']);
  assert.deepEqual(n.audience.studentIds, ['K1']);
});

test('#28 #29 teacher recipients are limited to their programs and work for school-wide notices', async () => {
  const { api, as } = await makeApi();
  as('ADM');
  const school = await api.notices.send({ title: 'All', body: 'x', audience: { scope: 'school' } });
  const both = await api.notices.send({ title: 'Both', body: 'y', audience: { scope: 'program', programIds: ['PA', 'PB'] } });
  as('TA');
  const r1 = await api.notices.recipients(school.id);
  assert.deepEqual(r1.map(r => r.guardianId), ['G-SIB']);
  assert.deepEqual(r1[0].studentIds, ['K1']);
  const r2 = await api.notices.recipients(both.id);
  assert.deepEqual(r2.map(r => r.guardianId), ['G-SIB']);
  assert.deepEqual(r2[0].studentIds, ['K1']);
});

test('#30 calendar events are scoped to the persona\'s programs', async () => {
  const { api, as } = await makeApi();
  const titles = async q => (await api.calendar.events(q)).filter(e => e.type !== 'birthday').map(e => e.title).sort();
  as('TA');
  assert.deepEqual(await titles({}), ['pa-only', 'school-wide']);
  assert.deepEqual(await titles({ programId: 'PB' }), ['school-wide']);
  as('G-OTH');
  assert.deepEqual(await titles({}), ['pb-only', 'school-wide']);
  as('ADM');
  assert.deepEqual(await titles({}), ['pa-only', 'pb-only', 'school-wide']);
});

async function tripWithEvents() {
  const m = await makeApi();
  m.as('DRV');
  const trip = await m.api.transport.startTrip({ routeId: 'R1', direction: 'pickup', simulated: true });
  let t = Date.UTC(2026, 9, 20, 2, 0, 30);
  for (const p of simulationPlan(m.api.getDb().routes[0], { speedKmph: 60 })) {
    t += p.dtMs;
    await m.api.transport.recordPosition(trip.id, { lat: p.lat, lng: p.lng, accuracy: p.accuracy, ts: new Date(t).toISOString() });
  }
  await m.api.transport.markChild(trip.id, { studentId: 'K1', type: 'boarded' });
  await m.api.transport.markChild(trip.id, { studentId: 'K3', type: 'absent' });
  return { ...m, trip };
}

test('#31 parents and teachers do not receive other children\'s trip events', async () => {
  const { api, as } = await tripWithEvents();
  as('G-SIB');
  const t = await api.transport.activeTrip('R1');
  assert.deepEqual(t.childEvents.map(e => e.studentId), ['K1']);
  assert.ok(t.stopEvents.length > 0 && t.stopEvents.every(e => e.stopId === 'S1'));
  as('TA');
  const trips = await api.transport.trips({ routeId: 'R1' });
  assert.ok(trips[0].childEvents.every(e => e.studentId === 'K1'));
  assert.ok(trips[0].stopEvents.every(e => e.stopId === 'S1'));
});

test('#32 parentView returns only the own stop\'s events in trip.stopEvents', async () => {
  const { api, as } = await tripWithEvents();
  as('G-SIB');
  const v = await api.transport.parentView('K1');
  assert.ok(v.trip.stopEvents.length > 0);
  assert.ok(v.trip.stopEvents.every(e => e.stopId === 'S1'));
});

test('#33 export always requires the principal, even after a quota failure', async () => {
  const { api, as, backend } = await makeApi();
  as('ADM');
  await api.notices.send({ title: 'Ack', body: 'x', audience: { scope: 'school' }, requiresAck: false });
  as('G-SIB');
  const [n] = await api.notices.list();
  const real = backend.setItem;
  backend.setItem = quota;
  await assert.rejects(api.notices.markRead(n.id), { code: 'STORAGE_QUOTA' });
  backend.setItem = real;
  await assert.rejects(api.admin.exportJson(), { code: 'NOT_ALLOWED' });
  as('ACC');
  await assert.rejects(api.admin.exportJson(), { code: 'NOT_ALLOWED' });
  as('ADM');
  assert.ok((await api.admin.exportJson()).length > 0);
});

test('#34 guardian records returned to a teacher list only visible children', async () => {
  const { api, as } = await makeApi();
  as('TA');
  const g = await api.people.guardian('G-SIB');
  assert.deepEqual(g.studentIds, ['K1']);
  const all = await api.people.guardians();
  assert.deepEqual(all.find(x => x.id === 'G-SIB').studentIds, ['K1']);
});

test('#35 a parent of a withdrawn child can read (not write) that child\'s records', async () => {
  const { api, as } = await makeApi();
  const p = api.session.personas().find(x => x.id === 'persona-G-LEFT');
  assert.deepEqual(p.studentIds, ['K4']);
  as('G-LEFT');
  const invs = await api.fees.invoices();
  assert.equal(invs.length, 1);
  const kids = await api.people.childrenOf('G-LEFT');
  assert.equal(kids[0].status, 'left');
  await assert.rejects(api.threads.open({ studentId: 'K4', subject: 'x', body: 'y' }), { code: 'VALIDATION' });
});

test('#15 payments() views expose externalReceivedPaise', async () => {
  const seed = () => {
    const d = creditOverDebt().db;
    d.staff.push({ id: 'ADM', firstName: 'Ada', lastName: 'Placeholdar', role: 'admin', programIds: [], phone: '+91-90000-00009' });
    return d;
  };
  const { api, as } = await makeApi(seed);
  as('ADM');
  await api.fees.recordPayment({ studentId: 'A', mode: 'credit', paidOn: '2026-06-12' });
  const ps = await api.fees.payments({ studentId: 'A' });
  const credit = ps.find(x => x.mode === 'credit');
  const cash = ps.find(x => x.mode === 'cash');
  assert.equal(credit.externalReceivedPaise, 0);
  assert.equal(cash.externalReceivedPaise, cash.amountPaise);
});

// =============================== CSV / calendar / dates ===============================

test('#36 same title on the same dates for different programs or types is not a duplicate', () => {
  const db = apiFixture();
  const p = previewHolidayCsv(db, 'title,date,type,programs\nSports day,2026-11-10,event,Primary A\nSports day,2026-11-10,event,Primary B\nSports day,2026-11-10,holiday,Primary B\n', 'AY2026-27');
  assert.deepEqual(p.counts, { inputRows: 3, ok: 3, duplicate: 0, outsideYear: 0, rejected: 0 });
});

test('#37 non-Latin titles are not collapsed into one duplicate key', () => {
  const db = apiFixture();
  const p = previewHolidayCsv(db, 'title,date\nनवमी,2026-10-20\nदशहरा,2026-10-20\n', 'AY2026-27');
  assert.equal(p.counts.ok, 2);
});

test('#38 an unterminated quoted header does not silently discard the file', () => {
  const db = apiFixture();
  const p = previewHolidayCsv(db, 'date,title,"notes\n02-11-2026,Sample day\n', 'AY2026-27');
  assert.ok(p.counts.inputRows >= 1);
  assert.ok(p.counts.rejected >= 1);
});

test('#39 a stale "duplicate" preview row is imported if the matching event was removed', () => {
  const db = apiFixture();
  const p = previewHolidayCsv(db, 'title,date,type\nschool-wide,2026-11-02,event\n', 'AY2026-27');
  assert.equal(p.counts.duplicate, 1);
  db.calendarEvents = db.calendarEvents.filter(e => e.id !== 'school-wide');
  const r = importHolidays(db, p, {}, ctx('2026-10-20', 'admin', 'ADM'));
  assert.equal(r.imported, 1);
  assert.equal(r.inputRows, r.imported + r.skippedDuplicate + r.rejected);
});

test('#40 import re-validation rejects non-ISO dates, empty titles and unknown programs', () => {
  const db = apiFixture();
  const preview = { academicYearId: 'AY2026-27', rows: [
    { line: 2, title: 'A', startDate: '03-Oct-2026', endDate: '03-Oct-2026', type: 'holiday', programIds: [], status: 'ok' },
    { line: 3, title: '', startDate: '2026-10-05', endDate: '2026-10-05', type: 'holiday', programIds: [], status: 'ok' },
    { line: 4, title: 'B', startDate: '2026-10-06', endDate: '2026-10-06', type: 'holiday', programIds: ['NOPE'], status: 'ok' },
  ] };
  const r = importHolidays(db, preview, {}, ctx('2026-10-20', 'admin', 'ADM'));
  assert.deepEqual([r.imported, r.rejected], [0, 3]);
  assert.deepEqual(errors(validateDb(db)), []);
});

test('#41 an included outside-year event shows in the calendar view of the year its dates fall in', () => {
  const db = apiFixture();
  db.academicYears.push({ id: 'AY2027-28', label: '2027-28', startDate: '2027-06-01', endDate: '2028-05-31' });
  const p = previewHolidayCsv(db, 'title,date\nNext year day,2027-06-15\n', 'AY2026-27');
  importHolidays(db, p, { includeOutsideYear: true }, ctx('2026-10-20', 'admin', 'ADM'));
  const evs = listEvents(db, { academicYearId: 'AY2027-28', types: ['holiday'] });
  assert.deepEqual(evs.map(e => e.title), ['Next year day']);
});

test('#42 CR-only newlines inside quoted fields keep the line break', () => {
  assert.equal(parseCsv('"First\rSecond",x\r')[0].fields[0], 'First\nSecond');
});

test('#43 timestamps with impossible times or offsets are rejected', () => {
  assert.equal(tsToMs('2026-10-02T99:99:99+99:99'), null);
  assert.equal(tsToMs('2026-10-02T24:00:00Z'), null);
  assert.equal(tsToMs('2026-10-02T23:59:60Z'), null);
  assert.equal(tsToMs('2026-10-02T10:00:00+15:00'), null);
  assert.notEqual(tsToMs('2026-10-02T10:00:00+05:30'), null);
});

// =============================== transport ===============================

function tfx() {
  const db = apiFixture();
  return { db, trip: T.startTrip(db, { routeId: 'R1', direction: 'pickup', simulated: false }, { actor: { role: 'driver', id: 'DRV' }, now: '2026-10-20T02:00:00.000Z', today: '2026-10-20' }) };
}
const fixAt = (lat, s, accuracy = 10) => ({ lat, lng: 77.750, accuracy, ts: new Date(Date.UTC(2026, 9, 20, 2, 0, s)).toISOString() });

test('#45 duplicate, out-of-order and pre-start fixes are rejected and never trigger events', () => {
  const { db, trip } = tfx();
  const f = fixAt(12.9785, 10); // ~170 m from S2
  T.recordPosition(db, trip.id, f);
  const dup = T.recordPosition(db, trip.id, { ...f });
  assert.equal(dup.rejected, 'not newer than the last fix');
  assert.equal(trip.stopEvents.length, 0, 'identical cached fix must not count as a second consecutive fix');
  assert.equal(T.recordPosition(db, trip.id, fixAt(12.9786, 5)).rejected, 'not newer than the last fix');
  assert.match(T.recordPosition(db, trip.id, { ...fixAt(12.9786, 0), ts: '2026-10-20T01:59:00.000Z' }).rejected, /before the trip started/);
});

test('#46 no ETA when stale; stale is exact (> 45 s, not floored)', () => {
  const { db, trip } = tfx();
  T.recordPosition(db, trip.id, fixAt(12.9600, 10));
  T.recordPosition(db, trip.id, fixAt(12.9610, 20));
  const now = s => new Date(Date.UTC(2026, 9, 20, 2, 0, 0) + s * 1000).toISOString();
  const v = T.parentView(db, 'K3', now(65.5), '2026-10-20');
  assert.equal(v.stale, true);
  assert.equal(v.etaMinutes, null);
});

test('#47 fixes with offsets are normalised to UTC and ordered by instant', () => {
  const { db, trip } = tfx();
  T.recordPosition(db, trip.id, { lat: 12.96, lng: 77.75, accuracy: 10, ts: '2026-10-20T07:30:10+05:30' });
  assert.equal(trip.positions[0].ts, '2026-10-20T02:00:10.000Z');
  assert.equal(T.recordPosition(db, trip.id, { lat: 12.961, lng: 77.75, accuracy: 10, ts: '2026-10-20T02:00:05Z' }).rejected, 'not newer than the last fix');
});

test('#48 a path in the wrong stop order is not trusted by the simulation', () => {
  const route = apiFixture().routes[0];
  route.path = [{ lat: 12.980, lng: 77.750 }, { lat: 12.975, lng: 77.750 }, { lat: 12.970, lng: 77.750 }]; // reversed
  const plan = simulationPlan(route);
  assert.deepEqual([plan[0].lat, plan.at(-1).lat], [12.970, 12.980]);
});

test('#69 a rejected (inaccurate) fix resets the consecutive-fix counters', () => {
  const route = apiFixture().routes[0];
  const tracker = {};
  T.deriveStopEvents(route, tracker, fixAt(12.9770, 0));
  T.deriveStopEvents(route, tracker, fixAt(12.9772, 5)); // nearing S2
  T.deriveStopEvents(route, tracker, fixAt(12.9800, 10)); // inside, 1st
  T.deriveStopEvents(route, tracker, fixAt(12.9800, 15, 300)); // rejected
  const e = T.deriveStopEvents(route, tracker, fixAt(12.9800, 20)); // inside again
  assert.equal(e.filter(x => x.type === 'arrived').length, 0);
});

test('#70 stationary GPS jitter does not fabricate motion or an ETA', () => {
  const pts = [];
  for (let i = 0; i < 10; i++) pts.push({ lat: 12.9600 + (i % 2 ? 0.00015 : -0.00015), lng: 77.75, accuracy: 10, ts: new Date(Date.UTC(2026, 9, 20, 2, 0, i * 5)).toISOString() });
  assert.equal(T.etaMinutes(pts, { lat: 12.98, lng: 77.75 }, new Date(Date.UTC(2026, 9, 20, 2, 0, 50)).toISOString()), null);
});

test('#44 (domain side) a program-specific working Saturday does not make the day a school-wide working day', async () => {
  const { isWorkingDay } = await import('../src/domain/calendar.js');
  const db = apiFixture();
  db.calendarEvents.push({ id: 'ws', academicYearId: 'AY2026-27', type: 'workingSaturday', title: 'PA Saturday', startDate: '2026-11-21', endDate: '2026-11-21', programIds: ['PA'], description: '', source: 'manual', importBatchId: null });
  assert.equal(isWorkingDay(db, '2026-11-21', 'PA'), true);
  assert.equal(isWorkingDay(db, '2026-11-21', 'PB'), false);
  assert.equal(isWorkingDay(db, '2026-11-21'), false);
});
