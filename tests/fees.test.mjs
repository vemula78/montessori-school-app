import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyDb } from '../src/store/schema.js';
import { Storage, memoryBackend } from '../src/store/storage.js';
import * as F from '../src/domain/fees.js';
import { reconcile } from '../src/domain/reconcile.js';
import { validateDb } from '../src/domain/validate.js';

const ctx = (today = '2026-10-20', role = 'accountant', id = 'stf-acc') => ({ actor: { role, id }, now: `${today}T05:00:00.000Z`, today });

/** Small self-contained fixture (fake names only). */
function fixture() {
  const db = createEmptyDb();
  db.school = { ...db.school, name: 'Fixture School (Demo)', currentAcademicYearId: 'AY2026-27',
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
  // 02-Oct-2026 (Friday) is a school-wide holiday → Term 2 effective due date shifts to Monday 05-Oct.
  db.calendarEvents.push({ id: 'E1', academicYearId: 'AY2026-27', type: 'holiday', title: 'Sample holiday', startDate: '2026-10-02', endDate: '2026-10-02', programIds: [], description: '', source: 'manual', importBatchId: null });
  return db;
}

function withInvoices() {
  const db = fixture();
  for (const p of ['P1', 'P2']) for (const t of ['Term 1', 'Term 2']) F.generateInvoices(db, { academicYearId: 'AY2026-27', programId: p, installmentName: t }, ctx('2026-06-01'));
  return db;
}
const inv = (db, studentId, term) => db.invoices.find(i => i.studentId === studentId && i.installmentName === term && i.status !== 'cancelled');
const bal = (db, i) => F.invoiceBalance(db, i);

test('generateInvoices: students × installments, idempotent re-run', () => {
  const db = fixture();
  const r1 = F.generateInvoices(db, { academicYearId: 'AY2026-27', programId: 'P1', installmentName: 'Term 1' }, ctx());
  assert.deepEqual([r1.created, r1.skippedExisting, r1.eligibleStudents], [2, 0, 2]);
  const r2 = F.generateInvoices(db, { academicYearId: 'AY2026-27', programId: 'P1', installmentName: 'Term 2' }, ctx());
  assert.equal(r2.created, 2);
  assert.equal(db.invoices.length, 2 * 2); // 2 students × 2 installments
  const again = F.generateInvoices(db, { academicYearId: 'AY2026-27', programId: 'P1', installmentName: 'Term 1' }, ctx());
  assert.deepEqual([again.created, again.skippedExisting], [0, 2]);
  assert.equal(db.invoices.length, 4);
  assert.deepEqual(db.invoices.map(i => i.number), ['INV/26-27/0001', 'INV/26-27/0002', 'INV/26-27/0003', 'INV/26-27/0004']);
});

test('transport line only for bus students; sibling concession only on non-eldest', () => {
  const db = withInvoices();
  const kinds = i => i.lines.map(l => db.feeHeads.find(h => h.id === l.headId).kind);
  assert.ok(kinds(inv(db, 'C', 'Term 1')).includes('transport'));
  assert.equal(inv(db, 'C', 'Term 1').lines.find(l => l.headId === 'H-TRN').amountPaise, 300000);
  assert.ok(!kinds(inv(db, 'A', 'Term 1')).includes('transport'));
  assert.equal(inv(db, 'A', 'Term 1').concessions.length, 0); // eldest sibling
  const bCon = inv(db, 'B', 'Term 1').concessions;
  assert.equal(bCon.length, 1);
  assert.equal(bCon[0].type, 'sibling');
  assert.equal(bCon[0].amountPaise, 250000); // 10% of tuition only, not materials
  assert.equal(inv(db, 'C', 'Term 1').concessions.length, 0);
});

test('partial, full and over-payment', () => {
  const db = withInvoices();
  const a1 = inv(db, 'A', 'Term 1');
  assert.equal(bal(db, a1), 2800000);
  const p1 = F.recordPayment(db, { studentId: 'A', amountPaise: 1000000, mode: 'cash', paidOn: '2026-06-10' }, ctx());
  assert.equal(p1.receiptNumber, 'RCP/26-27/0001');
  assert.equal(a1.status, 'partiallyPaid');
  assert.equal(bal(db, a1), 1800000);
  F.recordPayment(db, { studentId: 'A', amountPaise: 1800000, mode: 'upi', reference: 'UPI-DEMO-1', paidOn: '2026-06-11' }, ctx());
  assert.equal(a1.status, 'paid');
  assert.equal(bal(db, a1), 0);
  // overpay: Term 2 balance 2500000, pay 2600000 → credit 100000
  const a2 = inv(db, 'A', 'Term 2');
  const p3 = F.recordPayment(db, { studentId: 'A', amountPaise: 2600000, mode: 'bank', paidOn: '2026-09-01' }, ctx());
  assert.equal(bal(db, a2), 0);
  assert.equal(p3.creditPaise, 100000);
  assert.equal(F.availableCreditPaise(db, 'A'), 100000);
  assert.throws(() => F.recordPayment(db, { studentId: 'A', amountPaise: 1, mode: 'cash', paidOn: '2026-09-02', allowCredit: false }, ctx()), { code: 'OVERPAYMENT_NOT_ALLOWED' });
  assert.deepEqual(validateDb(db), []);
});

test('oldest-due-first allocation and applying credit', () => {
  const db = withInvoices();
  const pay = F.recordPayment(db, { studentId: 'C', amountPaise: 3200000, mode: 'cash', paidOn: '2026-06-10' }, ctx());
  const t1 = inv(db, 'C', 'Term 1'), t2 = inv(db, 'C', 'Term 2');
  assert.deepEqual(pay.allocations.map(a => [a.invoiceId, a.amountPaise]), [[t1.id, 3100000], [t2.id, 100000]]);
  assert.equal(t1.status, 'paid');
  assert.equal(t2.status, 'partiallyPaid');
  // credit from an overpayment by B, then applied as a 'credit' payment
  F.recordPayment(db, { studentId: 'B', amountPaise: 5000000, mode: 'cash', paidOn: '2026-06-10', allocations: [{ invoiceId: inv(db, 'B', 'Term 1').id, amountPaise: 2550000 }] }, ctx());
  assert.equal(F.availableCreditPaise(db, 'B'), 2450000);
  const cp = F.recordPayment(db, { studentId: 'B', mode: 'credit', paidOn: '2026-06-12' }, ctx());
  assert.equal(cp.amountPaise, 2250000); // min(credit 2450000, owed 2250000)
  assert.equal(bal(db, inv(db, 'B', 'Term 2')), 0);
  assert.equal(cp.creditPaise, 0);
  assert.equal(F.availableCreditPaise(db, 'B'), 200000);
  assert.deepEqual(validateDb(db), []);
  assert.ok(reconcile(db).checks.every(c => c.ok));
});

test('paying a cancelled or fully paid invoice throws; editing after payment throws', () => {
  const db = withInvoices();
  const b2 = inv(db, 'B', 'Term 2');
  F.cancelInvoice(db, b2.id, 'issued in error', ctx());
  assert.throws(() => F.recordPayment(db, { studentId: 'B', amountPaise: 100, mode: 'cash', paidOn: '2026-06-10', allocations: [{ invoiceId: b2.id, amountPaise: 100 }] }, ctx()), { code: 'VALIDATION' });
  const a1 = inv(db, 'A', 'Term 1');
  F.recordPayment(db, { studentId: 'A', amountPaise: bal(db, a1), mode: 'cash', paidOn: '2026-06-10', allocations: [{ invoiceId: a1.id, amountPaise: bal(db, a1) }] }, ctx());
  assert.throws(() => F.recordPayment(db, { studentId: 'A', amountPaise: 100, mode: 'cash', paidOn: '2026-06-10', allocations: [{ invoiceId: a1.id, amountPaise: 100 }] }, ctx()), { code: 'VALIDATION' });
  assert.throws(() => F.addConcession(db, a1.id, { type: 'adhoc', description: 'x', amountPaise: 100 }, ctx()), { code: 'INVOICE_LOCKED' });
  assert.throws(() => F.cancelInvoice(db, a1.id, 'x', ctx()), { code: 'VALIDATION' });
  assert.throws(() => F.recordPayment(db, { studentId: 'A', amountPaise: 1.5, mode: 'cash', paidOn: '2026-06-10' }, ctx()), { code: 'INVALID_AMOUNT' });
});

test('cancel payment restores balance, keeps its receipt number; next number continues', () => {
  const db = withInvoices();
  const a1 = inv(db, 'A', 'Term 1');
  const p1 = F.recordPayment(db, { studentId: 'A', amountPaise: 1000000, mode: 'cash', paidOn: '2026-06-10' }, ctx());
  F.cancelPayment(db, p1.id, 'counterfeit note', ctx());
  assert.equal(p1.status, 'cancelled');
  assert.equal(p1.receiptNumber, 'RCP/26-27/0001');
  assert.equal(bal(db, a1), 2800000);
  assert.equal(a1.status, 'issued');
  const p2 = F.recordPayment(db, { studentId: 'A', amountPaise: 500000, mode: 'cash', paidOn: '2026-06-11' }, ctx());
  assert.equal(p2.receiptNumber, 'RCP/26-27/0002');
  assert.throws(() => F.cancelPayment(db, p1.id, 'again', ctx()), { code: 'VALIDATION' });
  assert.throws(() => F.cancelPayment(db, p2.id, '', ctx()), { code: 'VALIDATION' });
  assert.deepEqual(validateDb(db), []);
});

test('refund: partial reopens invoice, over-refund throws, then correction path', () => {
  const db = withInvoices();
  const a1 = inv(db, 'A', 'Term 1');
  const p = F.recordPayment(db, { studentId: 'A', amountPaise: 2800000, mode: 'cash', paidOn: '2026-06-10' }, ctx());
  assert.equal(a1.status, 'paid');
  const r = F.refund(db, { paymentId: p.id, invoiceId: a1.id, amountPaise: 300000, mode: 'cash', date: '2026-06-20', reason: 'materials not issued' }, ctx());
  assert.equal(r.voucherNumber, 'RFD/26-27/0001');
  assert.equal(a1.status, 'partiallyPaid');
  assert.equal(bal(db, a1), 300000);
  assert.throws(() => F.refund(db, { paymentId: p.id, invoiceId: a1.id, amountPaise: 2500001, mode: 'cash', date: '2026-06-20', reason: 'x' }, ctx()), { code: 'INVALID_AMOUNT' });
  assert.throws(() => F.cancelPayment(db, p.id, 'x', ctx()), { code: 'VALIDATION' }); // refunded payment cannot also be cancelled
  F.refund(db, { paymentId: p.id, invoiceId: a1.id, amountPaise: 2500000, mode: 'bank', date: '2026-06-21', reason: 'withdrawn' }, ctx());
  F.cancelInvoice(db, a1.id, 'student withdrawn', ctx()); // net paid is now 0
  assert.equal(a1.status, 'cancelled');
  assert.deepEqual(validateDb(db), []);
  assert.ok(reconcile(db).checks.every(c => c.ok), JSON.stringify(reconcile(db).checks.filter(c => !c.ok)));
});

test('late fee: grace, per-day with cap, holiday shift, apply and waive', () => {
  const db = withInvoices();
  const a2 = inv(db, 'A', 'Term 2'); // due Fri 02-Oct (holiday) → effective Mon 05-Oct; grace 5 days
  let d = F.lateFeeDue(db, a2, '2026-10-10');
  assert.equal(d.effectiveDueDate, '2026-10-05');
  assert.deepEqual([d.days, d.amountPaise], [0, 0]); // within grace
  d = F.lateFeeDue(db, a2, '2026-10-13');
  assert.deepEqual([d.days, d.amountPaise], [3, 3000]);
  d = F.lateFeeDue(db, a2, '2026-12-31');
  assert.equal(d.amountPaise, 20000); // capped
  const auditBefore = db.auditLog.length;
  const line = F.applyLateFee(db, a2.id, '2026-10-13', ctx('2026-10-13'));
  assert.equal(line.amountPaise, 3000);
  assert.equal(db.auditLog.length, auditBefore + 1);
  assert.equal(db.auditLog.at(-1).action, 'applyLateFee');
  assert.equal(F.lateFeeDue(db, a2, '2026-10-13').amountPaise, 0); // already applied
  assert.equal(F.lateFeeDue(db, a2, '2026-10-15').amountPaise, 2000); // increment only
  assert.equal(bal(db, a2), 2503000);
  // a payment locks lines/concessions but late fee can still be waived
  F.recordPayment(db, { studentId: 'A', amountPaise: 100000, mode: 'cash', paidOn: '2026-10-14', allocations: [{ invoiceId: a2.id, amountPaise: 100000 }] }, ctx('2026-10-14'));
  assert.throws(() => F.waiveLateFee(db, a2.id, '', ctx()), { code: 'VALIDATION' });
  F.waiveLateFee(db, a2.id, 'first instance', ctx());
  assert.equal(a2.lines.some(l => l.headId === 'H-LATE'), false);
  assert.equal(bal(db, a2), 2400000);
  assert.equal(db.auditLog.at(-1).action, 'waiveLateFee');
  // no rule configured → amount is missing (null), not zero
  db.school.lateFeeRule = null;
  assert.equal(F.lateFeeDue(db, a2, '2026-12-31').amountPaise, null);
  assert.throws(() => F.applyLateFee(db, a2.id, '2026-12-31', ctx()), { code: 'VALIDATION' });
});

test('new academic year counters start at 1; switching current AY renumbers nothing', () => {
  const db = withInvoices();
  F.recordPayment(db, { studentId: 'A', amountPaise: 100000, mode: 'cash', paidOn: '2026-06-10' }, ctx());
  const before = db.invoices.map(i => i.number).concat(db.payments.map(p => p.receiptNumber));
  db.feeStructures.push({ ...structuredClone(db.feeStructures[0]), id: 'FS-OLD', academicYearId: 'AY2025-26',
    installments: [{ name: 'Term 1', dueDate: '2025-06-15', lines: [{ headId: 'H-TUI', amountPaise: 2000000 }] }] });
  db.school.currentAcademicYearId = 'AY2025-26';
  F.generateInvoices(db, { academicYearId: 'AY2025-26', programId: 'P1', installmentName: 'Term 1' }, ctx('2025-06-01'));
  const old = db.invoices.filter(i => i.academicYearId === 'AY2025-26').map(i => i.number);
  assert.deepEqual(old, ['INV/25-26/0001', 'INV/25-26/0002']);
  const p = F.recordPayment(db, { studentId: 'C', amountPaise: 100000, mode: 'cash', paidOn: '2025-07-01' }, ctx());
  assert.equal(p.receiptNumber, 'RCP/25-26/0001');
  db.school.currentAcademicYearId = 'AY2026-27';
  const after = db.invoices.filter(i => i.academicYearId === 'AY2026-27').map(i => i.number).concat(db.payments.filter(x => x.academicYearId === 'AY2026-27').map(x => x.receiptNumber));
  assert.deepEqual(after, before);
  assert.deepEqual(validateDb(db), []);
});

// Sequential commits from two tabs with stale caches: the second re-reads storage before numbering.
// This is NOT a proof of concurrent safety — see the interleaved test below (deferred finding #1).
test('stale tab: two Storage instances on one store, committing one after the other, get distinct receipt numbers', () => {
  const backing = memoryBackend();
  const seed = () => withInvoices();
  const tabA = new Storage({ backend: backing, seedFn: seed });
  const tabB = new Storage({ backend: backing, seedFn: seed });
  tabA.load();
  tabB.load(); // both hold rev 0 in memory
  const pa = tabA.commit(d => F.recordPayment(d, { studentId: 'A', amountPaise: 1000, mode: 'cash', paidOn: '2026-06-10' }, ctx()));
  const pb = tabB.commit(d => F.recordPayment(d, { studentId: 'C', amountPaise: 2000, mode: 'cash', paidOn: '2026-06-10' }, ctx()));
  assert.notEqual(pa.receiptNumber, pb.receiptNumber);
  assert.deepEqual([pa.receiptNumber, pb.receiptNumber], ['RCP/26-27/0001', 'RCP/26-27/0002']);
  const stored = JSON.parse(backing.getItem('montessori.db.v2'));
  assert.equal(stored.counters.receipt['AY2026-27'], 2);
  assert.equal(stored.payments.length, 2); // tab B re-read tab A's write instead of overwriting it
  assert.equal(stored.rev, 2);
  assert.deepEqual(validateDb(stored), []);
});

test('reconciliation identity holds after mixed operations, and a broken ledger is listed', () => {
  const db = withInvoices();
  F.recordPayment(db, { studentId: 'A', amountPaise: 1000000, mode: 'cash', paidOn: '2026-06-10' }, ctx());
  const pB = F.recordPayment(db, { studentId: 'B', amountPaise: 6000000, mode: 'upi', paidOn: '2026-06-10' }, ctx());
  const pC = F.recordPayment(db, { studentId: 'C', amountPaise: 500000, mode: 'cash', paidOn: '2026-06-10' }, ctx());
  F.cancelPayment(db, pC.id, 'bounced', ctx());
  F.refund(db, { paymentId: pB.id, invoiceId: inv(db, 'B', 'Term 1').id, amountPaise: 50000, mode: 'cash', date: '2026-06-12', reason: 'materials' }, ctx());
  F.applyLateFee(db, inv(db, 'C', 'Term 2').id, '2026-10-20', ctx());
  const r = reconcile(db, { asOfDate: '2026-10-20' });
  assert.equal(r.checks.length, 5);
  for (const c of r.checks) assert.ok(c.ok, `${c.name}: expected ${c.expected}, actual ${c.actual}`);
  const sumOut = r.perStudent.reduce((s, x) => s + x.outstanding, 0);
  assert.equal(sumOut, r.school.outstanding);
  assert.equal(r.school.outstanding, db.invoices.filter(i => i.status !== 'cancelled').reduce((s, i) => s + F.invoiceBalance(db, i), 0));
  // tamper: payment amount no longer equals allocations + credit → check (c) fails and lists it
  db.payments[0].amountPaise += 1;
  const bad = reconcile(db);
  const c = bad.checks.find(x => x.name.startsWith('Σ valid payments'));
  assert.equal(c.ok, false);
  assert.equal(c.mismatches.length, 1);
  assert.equal(c.mismatches[0].paymentId, db.payments[0].id);
});

test('KNOWN LIMIT (#1, deferred to backend DB sequence): interleaved commits from two tabs can duplicate a receipt number',
  { todo: 'localStorage has no lock or compare-and-set; the backend replaces this with a database sequence' }, () => {
    const backing = memoryBackend();
    const tabA = new Storage({ backend: backing, seedFn: withInvoices });
    const tabB = new Storage({ backend: backing, seedFn: withInvoices });
    tabA.load(); tabB.load();
    let pb;
    // B commits while A is between its read and its write (what two processes can do).
    const pa = tabA.commit(d => {
      pb = tabB.commit(d2 => F.recordPayment(d2, { studentId: 'C', amountPaise: 2000, mode: 'cash', paidOn: '2026-06-10' }, ctx()));
      return F.recordPayment(d, { studentId: 'A', amountPaise: 1000, mode: 'cash', paidOn: '2026-06-10' }, ctx());
    });
    assert.notEqual(pa.receiptNumber, pb.receiptNumber);
    assert.equal(JSON.parse(backing.getItem('montessori.db.v2')).payments.length, 2);
  });
