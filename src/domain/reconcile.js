// Numeric reconciliation of the fee ledger. Every check lists its mismatches; nothing is summarised away.
//   invoiced    = Σ lines of non-cancelled invoices (late-fee lines included; also reported separately as lateFees)
//   concessions = Σ concessions of non-cancelled invoices
//   paid        = Σ allocations of valid payments (to any invoice)
//   refunded    = Σ refunds against invoices (refunds of unused credit are reported as creditRefunded)
//   outstanding = invoiced − concessions − paid + refunded

import { byId, fullName } from './people.js';
import { invoiceAmounts, invoiceBalance, availableCreditPaise, outstandingReport } from './fees.js';

const KEYS = ['invoiced', 'concessions', 'lateFees', 'paid', 'refunded', 'credit', 'outstanding'];

export function reconcile(db, { asOfDate } = {}) {
  const per = new Map();
  const row = id => {
    if (!per.has(id)) {
      const s = byId(db.students, id);
      per.set(id, { studentId: id, name: fullName(s), invoiced: 0, concessions: 0, lateFees: 0, paid: 0, refunded: 0, credit: 0, outstanding: 0 });
    }
    return per.get(id);
  };
  const invById = new Map(db.invoices.map(i => [i.id, i]));

  // Path 1: ledger sums per student.
  for (const inv of db.invoices) {
    if (inv.status === 'cancelled') continue;
    const a = invoiceAmounts(db, inv);
    const r = row(inv.studentId);
    r.invoiced += a.linesPaise;
    r.concessions += a.concessionPaise;
    r.lateFees += a.lateFeePaise;
  }
  for (const p of db.payments) {
    if (p.status !== 'valid') continue;
    for (const al of p.allocations) row(invById.get(al.invoiceId)?.studentId ?? p.studentId).paid += al.amountPaise;
  }
  for (const rf of db.refunds) if (rf.invoiceId) row(invById.get(rf.invoiceId)?.studentId ?? '(unknown)').refunded += rf.amountPaise;
  for (const r of per.values()) {
    r.credit = availableCreditPaise(db, r.studentId);
    r.outstanding = r.invoiced - r.concessions - r.paid + r.refunded;
  }
  for (const c of db.credits) if (!per.has(c.studentId)) { const r = row(c.studentId); r.credit = availableCreditPaise(db, c.studentId); }
  const perStudent = [...per.values()].sort((a, b) => a.name.localeCompare(b.name));

  // School-wide totals computed directly from the collections (not by summing perStudent).
  // receivedValid includes 'credit' payments (internal transfers); externalReceivedPaise is money actually received.
  const school = { invoiced: 0, concessions: 0, lateFees: 0, paid: 0, refunded: 0, credit: 0, outstanding: 0, receivedValid: 0, externalReceivedPaise: 0, creditCreated: 0, creditRefunded: 0 };
  for (const inv of db.invoices) {
    if (inv.status === 'cancelled') continue;
    const a = invoiceAmounts(db, inv);
    school.invoiced += a.linesPaise; school.concessions += a.concessionPaise; school.lateFees += a.lateFeePaise;
  }
  let allocSum = 0;
  for (const p of db.payments) {
    if (p.status !== 'valid') continue;
    school.receivedValid += p.amountPaise;
    if (p.mode !== 'credit') school.externalReceivedPaise += p.amountPaise;
    school.creditCreated += p.creditPaise;
    for (const al of p.allocations) allocSum += al.amountPaise;
  }
  school.paid = allocSum;
  for (const rf of db.refunds) { if (rf.invoiceId) school.refunded += rf.amountPaise; else school.creditRefunded += rf.amountPaise; }
  for (const c of db.credits) {
    if (!c.consumedByPaymentId && !c.consumedByRefundId && byId(db.payments, c.sourcePaymentId)?.status === 'valid') school.credit += c.amountPaise;
  }
  school.outstanding = school.invoiced - school.concessions - school.paid + school.refunded;

  const checks = [];
  const sum = (arr, k) => arr.reduce((s, r) => s + r[k], 0);

  // (a) per-student outstanding sums to school-wide outstanding (also every other column).
  {
    const mismatches = KEYS.filter(k => sum(perStudent, k) !== school[k]).map(k => ({ field: k, perStudent: sum(perStudent, k), school: school[k] }));
    checks.push({ name: 'Σ per-student outstanding = school outstanding', ok: mismatches.length === 0, expected: school.outstanding, actual: sum(perStudent, 'outstanding'), mismatches });
  }
  // (b) independent second path: Σ invoiceBalance over non-cancelled invoices, per student and overall.
  {
    const balByStudent = new Map();
    for (const inv of db.invoices) {
      if (inv.status === 'cancelled') continue;
      balByStudent.set(inv.studentId, (balByStudent.get(inv.studentId) || 0) + invoiceBalance(db, inv));
    }
    const total = [...balByStudent.values()].reduce((s, x) => s + x, 0);
    const mismatches = perStudent.filter(r => (balByStudent.get(r.studentId) || 0) !== r.outstanding)
      .map(r => ({ studentId: r.studentId, name: r.name, ledger: r.outstanding, invoiceBalances: balByStudent.get(r.studentId) || 0 }));
    checks.push({ name: 'School outstanding = Σ invoice balances', ok: total === school.outstanding && mismatches.length === 0, expected: school.outstanding, actual: total, mismatches });
  }
  // (c) money in = money allocated + credit created, for valid payments.
  {
    const mismatches = db.payments.filter(p => p.status === 'valid' && p.amountPaise !== p.allocations.reduce((s, a) => s + a.amountPaise, 0) + p.creditPaise)
      .map(p => ({ paymentId: p.id, receiptNumber: p.receiptNumber, amountPaise: p.amountPaise, allocatedPaise: p.allocations.reduce((s, a) => s + a.amountPaise, 0), creditPaise: p.creditPaise }));
    const actual = allocSum + school.creditCreated;
    checks.push({ name: 'Σ valid payments = Σ allocations + Σ credit', ok: actual === school.receivedValid && mismatches.length === 0, expected: school.receivedValid, actual, mismatches });
  }
  // (d) no negative invoice balance.
  {
    const mismatches = db.invoices.filter(i => i.status !== 'cancelled' && invoiceBalance(db, i) < 0)
      .map(i => ({ invoiceId: i.id, number: i.number, balancePaise: invoiceBalance(db, i) }));
    checks.push({ name: 'No invoice balance below zero', ok: mismatches.length === 0, expected: 0, actual: mismatches.length, mismatches });
  }
  // (e) the outstanding report (per academic year) totals to the reconciled outstanding.
  {
    const asOf = asOfDate || null;
    const byAy = db.academicYears.map(ay => ({ academicYearId: ay.id, balancePaise: outstandingReport(db, { academicYearId: ay.id, asOfDate: asOf }).totals.balancePaise }));
    const orphanAy = db.invoices.filter(i => i.status !== 'cancelled' && !byId(db.academicYears, i.academicYearId)).map(i => ({ invoiceId: i.id, number: i.number, academicYearId: i.academicYearId }));
    const actual = byAy.reduce((s, x) => s + x.balancePaise, 0);
    checks.push({ name: 'Outstanding report total = reconciled outstanding', ok: actual === school.outstanding && orphanAy.length === 0, expected: school.outstanding, actual, byAcademicYear: byAy, mismatches: orphanAy });
  }
  return { perStudent, school, checks };
}
