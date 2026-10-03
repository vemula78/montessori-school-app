// Fee structures, invoices, payments, credits, refunds, receipts.
// All amounts are integer paise. Every mutating function runs inside storage.commit() so document
// numbers come from the freshly re-read counters.

import { fail, newId, nextNumber } from './ids.js';
import { assertPaise, sumPaise, percentOf, amountInWords } from './money.js';
import { isISODate, compareISO, diffDays, formatDate, tsToLocalDate } from './dates.js';
import { byId, mustGet, activeStudents, fullName, isEldestSibling } from './people.js';
import { academicYearFor } from './calendar.js';
import { effectiveDueDate, computeLateFee } from './late-fee.js';
import { appendAudit } from './audit.js';

// 'online' = a real gateway capture (Razorpay); 'online-mock' = the demo's mock payment.
export const PAYMENT_MODES = ['cash', 'upi', 'cheque', 'bank', 'online', 'online-mock', 'credit'];
export const REFUND_MODES = ['cash', 'upi', 'cheque', 'bank', 'online'];
export const CONCESSION_TYPES = ['sibling', 'staffWard', 'scholarship', 'adhoc'];
export const HEAD_KINDS = ['tuition', 'transport', 'materials', 'admission', 'lateFee', 'openingBalance'];

const requireReason = r => { if (!r || !String(r).trim()) fail('VALIDATION', 'A reason is required'); return String(r).trim(); };
const positive = n => { assertPaise(n); if (n <= 0) fail('INVALID_AMOUNT', 'Amount must be greater than zero'); return n; };
const headKind = (db, headId) => byId(db.feeHeads, headId)?.kind ?? null;
const firstHead = (db, kind) => db.feeHeads.find(h => h.kind === kind) || null;

// ---------------- derived amounts ----------------

/** Every derived money figure for one invoice. paid = valid allocations − refunds. */
export function invoiceAmounts(db, inv) {
  const linesPaise = sumPaise(inv.lines.map(l => l.amountPaise));
  const lateFeePaise = sumPaise(inv.lines.filter(l => headKind(db, l.headId) === 'lateFee').map(l => l.amountPaise));
  const concessionPaise = sumPaise(inv.concessions.map(c => c.amountPaise));
  const totalPaise = linesPaise - concessionPaise;
  let allocatedPaise = 0;
  for (const p of db.payments) {
    if (p.status !== 'valid') continue;
    for (const a of p.allocations) if (a.invoiceId === inv.id) allocatedPaise += a.amountPaise;
  }
  const refundedPaise = sumPaise(db.refunds.filter(r => r.invoiceId === inv.id).map(r => r.amountPaise));
  const paidPaise = allocatedPaise - refundedPaise;
  const balancePaise = inv.status === 'cancelled' ? 0 : totalPaise - paidPaise;
  return { linesPaise, lateFeePaise, concessionPaise, totalPaise, allocatedPaise, refundedPaise, paidPaise, balancePaise };
}

/**
 * Amounts as they stood at the end of `asOf` (historical): invoice issued on/before asOf, cancellation
 * effective only if cancelled on/before asOf, late-fee lines applied on/before asOf, concessions created
 * on/before asOf, payments paid on/before asOf (and not yet cancelled then), refunds dated on/before asOf.
 * Waived late-fee lines and removed concessions are no longer stored, so they do not appear historically.
 * live = the invoice existed and was not cancelled at asOf.
 */
export function invoiceAmountsAsOf(db, inv, asOf) {
  const onOrBefore = d => d && compareISO(d, asOf) <= 0;
  const issued = onOrBefore(inv.issueDate);
  const cancelled = inv.status === 'cancelled' && (!inv.cancelledOn || onOrBefore(inv.cancelledOn));
  const lines = inv.lines.filter(l => !l.appliedOn || onOrBefore(l.appliedOn));
  const linesPaise = sumPaise(lines.map(l => l.amountPaise));
  const lateFeePaise = sumPaise(lines.filter(l => headKind(db, l.headId) === 'lateFee').map(l => l.amountPaise));
  const concessionPaise = sumPaise(inv.concessions.filter(c => !c.createdAt || onOrBefore(tsToLocalDate(c.createdAt))).map(c => c.amountPaise));
  const totalPaise = linesPaise - concessionPaise;
  let allocatedPaise = 0;
  for (const p of db.payments) {
    if (!onOrBefore(p.paidOn)) continue;
    if (p.status !== 'valid' && (!p.cancelledOn || onOrBefore(p.cancelledOn))) continue;
    for (const a of p.allocations) if (a.invoiceId === inv.id) allocatedPaise += a.amountPaise;
  }
  const refundedPaise = sumPaise(db.refunds.filter(r => r.invoiceId === inv.id && onOrBefore(r.date)).map(r => r.amountPaise));
  const paidPaise = allocatedPaise - refundedPaise;
  const live = issued && !cancelled;
  return { live, linesPaise, lateFeePaise, concessionPaise, totalPaise, allocatedPaise, refundedPaise, paidPaise, balancePaise: live ? totalPaise - paidPaise : 0 };
}

export function invoiceBalance(db, inv) {
  return invoiceAmounts(db, inv).balancePaise;
}

export function derivedStatus(db, inv) {
  if (inv.status === 'cancelled') return 'cancelled';
  const a = invoiceAmounts(db, inv);
  if (a.balancePaise <= 0) return 'paid';
  return a.paidPaise > 0 ? 'partiallyPaid' : 'issued';
}

function refreshStatus(db, inv) {
  if (inv.status !== 'cancelled') inv.status = derivedStatus(db, inv);
}

/** Lines and concessions are immutable once any valid allocation exists. */
export function isLocked(db, inv) {
  return db.payments.some(p => p.status === 'valid' && p.allocations.some(a => a.invoiceId === inv.id && a.amountPaise > 0));
}

export function lateFeeDue(db, invoiceOrId, asOf) {
  const inv = typeof invoiceOrId === 'string' ? mustGet(db, 'invoices', invoiceOrId, 'Invoice') : invoiceOrId;
  if (!isISODate(asOf)) fail('VALIDATION', `Invalid date: ${asOf}`);
  const a = invoiceAmounts(db, inv);
  const eff = effectiveDueDate(db, inv);
  if (inv.status === 'cancelled') return { days: 0, amountPaise: 0, computedPaise: 0, alreadyAppliedPaise: a.lateFeePaise, effectiveDueDate: eff };
  const principal = a.totalPaise - a.lateFeePaise - a.paidPaise;
  return computeLateFee(db.school.lateFeeRule, { effectiveDueDate: eff, principalBalancePaise: principal, alreadyAppliedPaise: a.lateFeePaise, waivedPaise: waivedLateFeePaise(inv) }, asOf);
}

/** Total late fee waived so far (persisted, so a waiver is not undone by re-accrual of the same period). */
export function waivedLateFeePaise(inv) {
  return sumPaise((inv.lateFeeWaivers || []).map(w => w.waivedPaise));
}

/** Invoice plus derived figures for screens. */
export function invoiceView(db, inv, asOf) {
  const a = invoiceAmounts(db, inv);
  const student = byId(db.students, inv.studentId);
  const program = student ? byId(db.programs, student.programId) : null;
  const eff = effectiveDueDate(db, inv);
  const lf = asOf ? lateFeeDue(db, inv, asOf) : null;
  const overdueDays = asOf && inv.status !== 'cancelled' && a.balancePaise > 0 && compareISO(asOf, eff) > 0 ? diffDays(eff, asOf) : 0;
  return {
    ...structuredClone(inv),
    studentName: fullName(student),
    programId: student ? student.programId : null,
    programName: program ? program.name : '—',
    ...a,
    effectiveDueDate: eff,
    lateFeeDuePaise: lf ? lf.amountPaise : null,
    overdueDays,
    locked: isLocked(db, inv),
    lines: inv.lines.map(l => ({ ...l, kind: headKind(db, l.headId) })),
  };
}

/** Unconsumed credit from valid payments. */
export function availableCredits(db, studentId) {
  return db.credits.filter(c => c.studentId === studentId && !c.consumedByPaymentId && !c.consumedByRefundId &&
    byId(db.payments, c.sourcePaymentId)?.status === 'valid');
}

/**
 * Consume `amount` from credit rows oldest-first; a partly used row is split so every row is either
 * fully consumed or fully available (row sums per source payment never change). Returns consumed rows.
 */
function consumeCredits(db, rows, amount, mark) {
  let left = amount;
  const used = [];
  for (const c of rows) {
    if (left <= 0) break;
    if (c.amountPaise > left) {
      db.credits.push({ id: newId('crd'), studentId: c.studentId, amountPaise: c.amountPaise - left, sourcePaymentId: c.sourcePaymentId, consumedByPaymentId: null });
      c.amountPaise = left;
    }
    left -= c.amountPaise;
    mark(c);
    used.push(c);
  }
  if (left !== 0) fail('INVALID_AMOUNT', 'Not enough credit');
  return used;
}

export function availableCreditPaise(db, studentId) {
  return sumPaise(availableCredits(db, studentId).map(c => c.amountPaise));
}

// ---------------- structures ----------------

export function saveStructure(db, s, ctx) {
  const ay = mustGet(db, 'academicYears', s.academicYearId, 'Academic year');
  mustGet(db, 'programs', s.programId, 'Program');
  assertPaise(s.siblingDiscountBp);
  if (s.siblingDiscountBp < 0 || s.siblingDiscountBp > 10000) fail('VALIDATION', 'Sibling discount must be 0–100%');
  if (s.staffWardDiscountBp !== undefined && s.staffWardDiscountBp !== null) {
    assertPaise(s.staffWardDiscountBp);
    if (s.staffWardDiscountBp < 0 || s.staffWardDiscountBp > 10000) fail('VALIDATION', 'Staff-ward discount must be 0–100%');
  }
  if (!Array.isArray(s.installments) || !s.installments.length) fail('VALIDATION', 'At least one installment is required');
  const names = new Set();
  for (const ins of s.installments) {
    if (!ins.name || names.has(ins.name)) fail('VALIDATION', `Installment names must be unique and non-empty: "${ins.name}"`);
    names.add(ins.name);
    if (!isISODate(ins.dueDate)) fail('VALIDATION', `Invalid due date for ${ins.name}`);
    if (compareISO(ins.dueDate, ay.startDate) < 0 || compareISO(ins.dueDate, ay.endDate) > 0) {
      fail('VALIDATION', `${ins.name} is due ${formatDate(ins.dueDate)}, outside ${ay.label || ay.id} (${formatDate(ay.startDate)} – ${formatDate(ay.endDate)})`);
    }
    if (!ins.lines.length) fail('VALIDATION', `${ins.name} has no fee lines`);
    for (const l of ins.lines) {
      const k = headKind(db, l.headId);
      if (!k) fail('VALIDATION', `Unknown fee head: ${l.headId}`);
      if (k === 'lateFee' || k === 'transport') fail('VALIDATION', `${k} lines are added automatically, not in structures`);
      assertPaise(l.amountPaise);
      if (l.amountPaise < 0) fail('INVALID_AMOUNT', 'Fee amounts cannot be negative');
    }
  }
  const clash = db.feeStructures.find(x => x.academicYearId === s.academicYearId && x.programId === s.programId && x.id !== s.id);
  if (clash) fail('VALIDATION', 'A structure for this program and year already exists');
  const clean = {
    id: s.id || newId('fst'), academicYearId: s.academicYearId, programId: s.programId, siblingDiscountBp: s.siblingDiscountBp,
    staffWardDiscountBp: s.staffWardDiscountBp ?? null,
    installments: s.installments.map(i => ({ name: i.name, dueDate: i.dueDate, lines: i.lines.map(l => ({ headId: l.headId, amountPaise: l.amountPaise })) })),
  };
  const idx = db.feeStructures.findIndex(x => x.id === clean.id);
  if (idx >= 0) db.feeStructures[idx] = clean; else db.feeStructures.push(clean);
  appendAudit(db, ctx, { entity: 'feeStructure', entityId: clean.id, action: idx >= 0 ? 'update' : 'create', summary: `${s.programId} ${s.academicYearId}, ${clean.installments.length} installments` });
  return clean;
}

// ---------------- invoices ----------------

/**
 * One invoice per active student in the program for the installment. Idempotent: students who
 * already hold a non-cancelled invoice for (AY, installment) are counted in skippedExisting.
 * created + skippedExisting === eligibleStudents. Throws (nothing written) on any invalid student.
 */
export function generateInvoices(db, { academicYearId, programId, installmentName }, ctx) {
  const st = db.feeStructures.find(x => x.academicYearId === academicYearId && x.programId === programId);
  if (!st) fail('VALIDATION', 'No fee structure for this program and year');
  const ins = st.installments.find(i => i.name === installmentName);
  if (!ins) fail('VALIDATION', `No installment named "${installmentName}"`);
  const students = activeStudents(db, programId);
  let created = 0, skippedExisting = 0;
  const invoiceIds = [];
  for (const s of students) {
    const exists = db.invoices.some(i => i.studentId === s.id && i.academicYearId === academicYearId && i.installmentName === installmentName && i.status !== 'cancelled');
    if (exists) { skippedExisting++; continue; }
    const lines = ins.lines.map(l => {
      const head = mustGet(db, 'feeHeads', l.headId, 'Fee head');
      return { id: newId('iln'), headId: l.headId, description: head.name, amountPaise: l.amountPaise };
    });
    if (s.routeId) {
      const route = mustGet(db, 'routes', s.routeId, 'Route');
      if (!s.stopId || !route.stops.some(x => x.id === s.stopId)) fail('VALIDATION', `Student ${s.id} has a route but no stop on it`);
      const head = firstHead(db, 'transport');
      if (!head) fail('VALIDATION', 'No transport fee head defined');
      assertPaise(route.transportFeePaise);
      lines.push({ id: newId('iln'), headId: head.id, description: `${head.name} — ${route.name}`, amountPaise: route.transportFeePaise });
    }
    const tuition = sumPaise(lines.filter(l => headKind(db, l.headId) === 'tuition').map(l => l.amountPaise));
    const concessions = [];
    const add = (type, bp, label) => {
      const amt = percentOf(tuition, bp);
      if (amt > 0) concessions.push({ id: newId('con'), type, description: `${label} (${bp / 100}% of tuition)`, amountPaise: amt, approvedBy: ctx.actor.id, createdAt: ctx.now });
    };
    if (s.feeCategory === 'staffWard') {
      if (st.staffWardDiscountBp) add('staffWard', st.staffWardDiscountBp, 'Staff-ward concession');
    } else if (st.siblingDiscountBp > 0 && !isEldestSibling(db, s.id)) {
      add('sibling', st.siblingDiscountBp, 'Sibling discount');
    }
    const inv = {
      id: newId('inv'), number: nextNumber(db, 'invoice', academicYearId), studentId: s.id, academicYearId, installmentName,
      issueDate: ctx.today, dueDate: ins.dueDate, lines, concessions, status: 'issued', cancelReason: null, createdAt: ctx.now,
    };
    db.invoices.push(inv);
    refreshStatus(db, inv);
    invoiceIds.push(inv.id);
    created++;
  }
  appendAudit(db, ctx, { entity: 'invoice', entityId: `${programId}/${academicYearId}/${installmentName}`, action: 'generate', summary: `eligible ${students.length}, created ${created}, skipped existing ${skippedExisting}` });
  return { created, skippedExisting, eligibleStudents: students.length, invoiceIds };
}

function editableInvoice(db, invoiceId) {
  const inv = mustGet(db, 'invoices', invoiceId, 'Invoice');
  if (inv.status === 'cancelled') fail('VALIDATION', 'Invoice is cancelled');
  if (isLocked(db, inv)) fail('INVOICE_LOCKED', 'Invoice has payments; refund or cancel them before editing');
  return inv;
}

export function addConcession(db, invoiceId, { type, description, amountPaise }, ctx) {
  const inv = editableInvoice(db, invoiceId);
  if (!CONCESSION_TYPES.includes(type)) fail('VALIDATION', `Unknown concession type: ${type}`);
  positive(amountPaise);
  if (amountPaise > invoiceAmounts(db, inv).totalPaise) fail('INVALID_AMOUNT', 'Concession exceeds the invoice total');
  const c = { id: newId('con'), type, description: String(description || '').trim() || type, amountPaise, approvedBy: ctx.actor.id, createdAt: ctx.now };
  inv.concessions.push(c);
  refreshStatus(db, inv);
  appendAudit(db, ctx, { entity: 'invoice', entityId: inv.id, action: 'addConcession', summary: `${inv.number}: ${type} ${amountPaise} paise` });
  return c;
}

export function removeConcession(db, invoiceId, concessionId, reason, ctx) {
  const inv = editableInvoice(db, invoiceId);
  const why = requireReason(reason);
  const c = inv.concessions.find(x => x.id === concessionId);
  if (!c) fail('NOT_FOUND', 'Concession not found');
  inv.concessions = inv.concessions.filter(x => x.id !== concessionId);
  refreshStatus(db, inv);
  appendAudit(db, ctx, { entity: 'invoice', entityId: inv.id, action: 'removeConcession', summary: `${inv.number}: ${c.type} ${c.amountPaise} paise removed — ${why}` });
  return inv;
}

export function applyLateFee(db, invoiceId, asOf, ctx) {
  const inv = mustGet(db, 'invoices', invoiceId, 'Invoice');
  if (inv.status === 'cancelled') fail('VALIDATION', 'Invoice is cancelled');
  if (!isISODate(asOf) || compareISO(asOf, ctx.today) > 0) fail('VALIDATION', 'A late fee can only be charged up to today');
  const due = lateFeeDue(db, inv, asOf);
  if (due.amountPaise === null) fail('VALIDATION', due.reason);
  if (due.amountPaise <= 0) fail('VALIDATION', 'No late fee is due');
  const head = firstHead(db, 'lateFee');
  if (!head) fail('VALIDATION', 'No late-fee head defined');
  const line = { id: newId('iln'), headId: head.id, description: `${head.name} — ${due.days} day(s) after ${formatDate(due.effectiveDueDate)} (as of ${formatDate(asOf)})`, amountPaise: due.amountPaise, appliedOn: ctx.today };
  inv.lines.push(line);
  refreshStatus(db, inv);
  appendAudit(db, ctx, { entity: 'invoice', entityId: inv.id, action: 'applyLateFee', summary: `${inv.number}: +${due.amountPaise} paise (${due.days} days)` });
  return line;
}

/**
 * Waive the late fee accrued up to today: removes the applied late-fee lines and records
 * {waivedPaise, waivedUpTo} so lateFeeDue does not charge the same period again. Later days still accrue.
 */
export function waiveLateFee(db, invoiceId, reason, ctx) {
  const inv = mustGet(db, 'invoices', invoiceId, 'Invoice');
  if (inv.status === 'cancelled') fail('VALIDATION', 'Invoice is cancelled');
  const why = requireReason(reason);
  const late = inv.lines.filter(l => headKind(db, l.headId) === 'lateFee');
  const removed = sumPaise(late.map(l => l.amountPaise));
  const prev = waivedLateFeePaise(inv);
  const accrued = lateFeeDue(db, inv, ctx.today).computedPaise || 0;
  const waivedTotal = Math.max(prev + removed, accrued);
  const waivedPaise = waivedTotal - prev;
  if (waivedPaise <= 0) fail('VALIDATION', 'No late fee to waive');
  const before = inv.lines;
  inv.lines = inv.lines.filter(l => headKind(db, l.headId) !== 'lateFee');
  if (invoiceAmounts(db, inv).balancePaise < 0) {
    inv.lines = before;
    fail('VALIDATION', 'Late fee has already been paid; refund it before waiving');
  }
  (inv.lateFeeWaivers || (inv.lateFeeWaivers = [])).push({ waivedPaise, waivedUpTo: ctx.today, reason: why, by: ctx.actor.id, at: ctx.now });
  refreshStatus(db, inv);
  appendAudit(db, ctx, { entity: 'invoice', entityId: inv.id, action: 'waiveLateFee', summary: `${inv.number}: −${waivedPaise} paise waived up to ${ctx.today} (${removed} paise of applied lines removed) — ${why}` });
  return inv;
}

/** Allowed only when nothing is net-paid on the invoice (cancel or refund payments first). */
export function cancelInvoice(db, invoiceId, reason, ctx) {
  const inv = mustGet(db, 'invoices', invoiceId, 'Invoice');
  if (inv.status === 'cancelled') fail('VALIDATION', 'Invoice is already cancelled');
  const why = requireReason(reason);
  const a = invoiceAmounts(db, inv);
  if (a.paidPaise !== 0) fail('VALIDATION', `Invoice has ${a.paidPaise} paise paid; refund or cancel those payments first`);
  inv.status = 'cancelled';
  inv.cancelReason = why;
  inv.cancelledOn = ctx.today;
  appendAudit(db, ctx, { entity: 'invoice', entityId: inv.id, action: 'cancel', summary: `${inv.number} cancelled — ${why}` });
  return inv;
}

// ---------------- payments ----------------

const headNamesOf = (db, inv) => [...new Set(inv.lines.map(l => byId(db.feeHeads, l.headId)?.name).filter(Boolean))].join(', ');

/** Allocation with the invoice details captured at payment time, so later invoice edits never change an issued receipt. */
function allocationSnapshot(db, inv, amountPaise) {
  return { invoiceId: inv.id, amountPaise, invoiceNumber: inv.number, installmentName: inv.installmentName, headNames: headNamesOf(db, inv) };
}

function openInvoicesOldestFirst(db, studentId) {
  return db.invoices
    .filter(i => i.studentId === studentId && i.status !== 'cancelled' && invoiceBalance(db, i) > 0)
    .sort((a, b) => compareISO(a.dueDate, b.dueDate) || compareISO(a.number, b.number));
}

/**
 * Record a payment. Allocation is explicit (allocations given) or oldest-due-first.
 * Remainder becomes a credit row (allowCredit) or throws OVERPAYMENT_NOT_ALLOWED.
 * mode 'credit' consumes all of the student's available credit (amountPaise, if given, must equal it).
 * explicitAllocations: true → `allocations` is final even when empty (everything becomes credit); used by
 * the gateway, whose order covers only the invoices the payer chose.
 */
export function recordPayment(db, { studentId, amountPaise, mode, reference = null, paidOn, allocations, allowCredit = true, guardianId = null, explicitAllocations = false }, ctx) {
  const student = mustGet(db, 'students', studentId, 'Student');
  if (!PAYMENT_MODES.includes(mode)) fail('VALIDATION', `Unknown payment mode: ${mode}`);
  if (!isISODate(paidOn)) fail('VALIDATION', `Invalid payment date: ${paidOn}`);
  if (compareISO(paidOn, ctx.today) > 0) fail('VALIDATION', 'Payment date is in the future');
  const ay = academicYearFor(db, paidOn);
  if (!ay) fail('VALIDATION', `${formatDate(paidOn)} is not inside any academic year`);
  if (guardianId && !student.guardianIds.includes(guardianId)) fail('VALIDATION', 'Guardian is not linked to this child');
  let creditRows = [];
  if (mode === 'credit') {
    // Internal transfer: apply min(available credit, what is owed); the rest stays on account.
    creditRows = availableCredits(db, studentId);
    const avail = sumPaise(creditRows.map(c => c.amountPaise));
    if (avail <= 0) fail('INVALID_AMOUNT', 'No credit available');
    if (amountPaise !== undefined && amountPaise !== null) { positive(amountPaise); if (amountPaise > avail) fail('INVALID_AMOUNT', 'More than the available credit'); }
    const owed = allocations && allocations.length
      ? sumPaise(allocations.map(a => assertPaise(a.amountPaise)))
      : sumPaise(openInvoicesOldestFirst(db, studentId).map(i => invoiceBalance(db, i)));
    if (allocations && allocations.length && owed > avail) fail('INVALID_AMOUNT', 'Allocations exceed the available credit');
    const take = Math.min(avail, owed, amountPaise ?? avail);
    if (take <= 0) fail('VALIDATION', 'Nothing outstanding to apply credit to');
    amountPaise = take;
  }
  positive(amountPaise);
  const allocs = [];
  if (allocations && (allocations.length || explicitAllocations)) {
    const seen = new Set();
    for (const a of allocations) {
      if (seen.has(a.invoiceId)) fail('VALIDATION', 'Each invoice may appear once in allocations');
      seen.add(a.invoiceId);
      const inv = mustGet(db, 'invoices', a.invoiceId, 'Invoice');
      if (inv.studentId !== studentId) fail('VALIDATION', 'Invoice belongs to another student');
      if (inv.status === 'cancelled') fail('VALIDATION', `Invoice ${inv.number} is cancelled`);
      const bal = invoiceBalance(db, inv);
      if (bal <= 0) fail('VALIDATION', `Invoice ${inv.number} is already fully paid`);
      positive(a.amountPaise);
      if (a.amountPaise > bal) fail('INVALID_AMOUNT', `Allocation exceeds the balance of ${inv.number}`);
      allocs.push(allocationSnapshot(db, inv, a.amountPaise));
    }
    if (sumPaise(allocs.map(a => a.amountPaise)) > amountPaise) fail('INVALID_AMOUNT', 'Allocations exceed the amount received');
  } else {
    let left = amountPaise;
    for (const inv of openInvoicesOldestFirst(db, studentId)) {
      if (left <= 0) break;
      const take = Math.min(left, invoiceBalance(db, inv));
      allocs.push(allocationSnapshot(db, inv, take));
      left -= take;
    }
  }
  const creditPaise = amountPaise - sumPaise(allocs.map(a => a.amountPaise));
  if (creditPaise > 0 && !allowCredit) fail('OVERPAYMENT_NOT_ALLOWED', 'Amount exceeds the balance due');
  const pay = {
    id: newId('pay'), receiptNumber: nextNumber(db, 'receipt', ay.id), academicYearId: ay.id, studentId,
    guardianId: guardianId || null, amountPaise, mode, reference: reference ? String(reference) : null, paidOn,
    allocations: allocs, creditPaise, status: 'valid', cancelReason: null, recordedBy: ctx.actor.id, recordedAt: ctx.now,
  };
  db.payments.push(pay);
  if (mode === 'credit') consumeCredits(db, creditRows, amountPaise, c => { c.consumedByPaymentId = pay.id; });
  if (creditPaise > 0) db.credits.push({ id: newId('crd'), studentId, amountPaise: creditPaise, sourcePaymentId: pay.id, consumedByPaymentId: null });
  for (const a of allocs) refreshStatus(db, byId(db.invoices, a.invoiceId));
  appendAudit(db, ctx, { entity: 'payment', entityId: pay.id, action: 'record', summary: `${pay.receiptNumber}: ${mode} ${amountPaise} paise, allocated ${amountPaise - creditPaise}, credit ${creditPaise}` });
  return pay;
}

/** Pays the full balance of the chosen invoices with mode 'online-mock'. No money moves. */
export function mockOnlinePayment(db, { studentId, invoiceIds, guardianId = null }, ctx) {
  if (!invoiceIds || !invoiceIds.length) fail('VALIDATION', 'Choose at least one invoice');
  const allocations = invoiceIds.map(id => ({ invoiceId: id, amountPaise: invoiceBalance(db, mustGet(db, 'invoices', id, 'Invoice')) }));
  const amountPaise = sumPaise(allocations.map(a => a.amountPaise));
  const pay = recordPayment(db, { studentId, amountPaise, mode: 'online-mock', reference: null, paidOn: ctx.today, allocations, allowCredit: false, guardianId }, ctx);
  pay.reference = `MOCK-${pay.id}`;
  return pay;
}

/** Receipt number is kept (status 'cancelled'), so the sequence has no gaps. */
export function cancelPayment(db, paymentId, reason, ctx) {
  const pay = mustGet(db, 'payments', paymentId, 'Payment');
  if (pay.status !== 'valid') fail('VALIDATION', 'Payment is already cancelled');
  const why = requireReason(reason);
  if (db.refunds.some(r => r.paymentId === pay.id)) fail('VALIDATION', 'Payment has refunds; it cannot also be cancelled');
  const ownCredit = db.credits.filter(c => c.sourcePaymentId === pay.id);
  const usedBy = ownCredit.map(c => c.consumedByPaymentId).filter(id => id && byId(db.payments, id)?.status === 'valid');
  if (usedBy.length) fail('VALIDATION', `Credit from this payment was used by ${byId(db.payments, usedBy[0]).receiptNumber}; cancel that first`);
  pay.status = 'cancelled';
  pay.cancelReason = why;
  pay.cancelledOn = ctx.today;
  for (const c of db.credits) if (c.consumedByPaymentId === pay.id) c.consumedByPaymentId = null;
  for (const a of pay.allocations) refreshStatus(db, byId(db.invoices, a.invoiceId));
  appendAudit(db, ctx, { entity: 'payment', entityId: pay.id, action: 'cancel', summary: `${pay.receiptNumber} cancelled — ${why}` });
  return pay;
}

function checkRefundCommon(pay, { mode, date, reason }, ctx) {
  if (!REFUND_MODES.includes(mode)) fail('VALIDATION', `Unknown refund mode: ${mode}`);
  if (!isISODate(date)) fail('VALIDATION', `Invalid refund date: ${date}`);
  if (compareISO(date, pay.paidOn) < 0) fail('VALIDATION', `Refund date is before the payment date (${formatDate(pay.paidOn)})`);
  if (compareISO(date, ctx.today) > 0) fail('VALIDATION', 'Refund date is in the future');
  return requireReason(reason);
}

/**
 * Refund against an invoice allocation: {paymentId, invoiceId, amountPaise, mode, reference, date, reason}.
 * Refund of unallocated credit: {creditId, …} or {paymentId, invoiceId: null, …} (stored with invoiceId null
 * and the consumed creditIds). Refund date must be on/after the payment date and not after today.
 */
export function refund(db, args, ctx) {
  const { paymentId, invoiceId, amountPaise, mode, reference = null, date, reason } = args;
  if (args.creditId || (invoiceId === null && paymentId)) return refundCredit(db, args, ctx);
  const pay = mustGet(db, 'payments', paymentId, 'Payment');
  if (pay.status !== 'valid') fail('VALIDATION', 'Payment is cancelled');
  const inv = mustGet(db, 'invoices', invoiceId, 'Invoice');
  const alloc = pay.allocations.find(a => a.invoiceId === invoiceId);
  if (!alloc) fail('VALIDATION', 'This payment was not allocated to that invoice');
  positive(amountPaise);
  const already = sumPaise(db.refunds.filter(r => r.paymentId === paymentId && r.invoiceId === invoiceId).map(r => r.amountPaise));
  if (amountPaise > alloc.amountPaise - already) fail('INVALID_AMOUNT', 'Refund exceeds what this payment contributed to the invoice');
  const why = checkRefundCommon(pay, args, ctx);
  const ay = academicYearFor(db, date);
  if (!ay) fail('VALIDATION', `${formatDate(date)} is not inside any academic year`);
  const r = {
    id: newId('rfd'), voucherNumber: nextNumber(db, 'refund', ay.id), paymentId, invoiceId, amountPaise, mode,
    reference: reference ? String(reference) : null, date, reason: why, recordedBy: ctx.actor.id,
  };
  db.refunds.push(r);
  refreshStatus(db, inv);
  appendAudit(db, ctx, { entity: 'refund', entityId: r.id, action: 'record', summary: `${r.voucherNumber}: ${amountPaise} paise against ${pay.receiptNumber} / ${inv.number} — ${why}` });
  return r;
}

function refundCredit(db, { creditId, paymentId, amountPaise, mode, reference = null, date, reason }, ctx) {
  let rows;
  if (creditId) {
    const c = mustGet(db, 'credits', creditId, 'Credit');
    rows = [c];
    if (paymentId && paymentId !== c.sourcePaymentId) fail('VALIDATION', 'Credit does not belong to that payment');
    paymentId = c.sourcePaymentId;
  } else rows = db.credits.filter(c => c.sourcePaymentId === paymentId);
  const pay = mustGet(db, 'payments', paymentId, 'Payment');
  if (pay.status !== 'valid') fail('VALIDATION', 'Payment is cancelled');
  rows = rows.filter(c => !c.consumedByPaymentId && !c.consumedByRefundId);
  positive(amountPaise);
  if (amountPaise > sumPaise(rows.map(c => c.amountPaise))) fail('INVALID_AMOUNT', 'Refund exceeds the unused credit');
  const why = checkRefundCommon(pay, { mode, date, reason }, ctx);
  const ay = academicYearFor(db, date);
  if (!ay) fail('VALIDATION', `${formatDate(date)} is not inside any academic year`);
  const r = {
    id: newId('rfd'), voucherNumber: nextNumber(db, 'refund', ay.id), paymentId, invoiceId: null, creditIds: [], amountPaise, mode,
    reference: reference ? String(reference) : null, date, reason: why, recordedBy: ctx.actor.id,
  };
  r.creditIds = consumeCredits(db, rows, amountPaise, c => { c.consumedByRefundId = r.id; }).map(c => c.id);
  db.refunds.push(r);
  appendAudit(db, ctx, { entity: 'refund', entityId: r.id, action: 'record', summary: `${r.voucherNumber}: ${amountPaise} paise of unused credit from ${pay.receiptNumber} — ${why}` });
  return r;
}

export function receiptView(db, paymentId) {
  const p = mustGet(db, 'payments', paymentId, 'Payment');
  const student = byId(db.students, p.studentId);
  const program = student ? byId(db.programs, student.programId) : null;
  const recorder = byId(db.staff, p.recordedBy) || byId(db.guardians, p.recordedBy);
  return {
    school: { name: db.school.name, address: db.school.address, phone: db.school.phone },
    receiptNumber: p.receiptNumber,
    status: p.status,
    cancelReason: p.cancelReason,
    paidOn: p.paidOn,
    student: fullName(student),
    program: program ? program.name : '—',
    admissionNo: student ? student.admissionNo : '—',
    guardianName: p.guardianId ? fullName(byId(db.guardians, p.guardianId)) : null,
    mode: p.mode,
    reference: p.reference,
    allocations: p.allocations.map(a => {
      if (a.invoiceNumber) return { invoiceNumber: a.invoiceNumber, installmentName: a.installmentName, headName: a.headNames, amountPaise: a.amountPaise };
      const inv = byId(db.invoices, a.invoiceId); // documents created before allocation snapshots existed
      return { invoiceNumber: inv ? inv.number : '—', installmentName: inv ? inv.installmentName : '—', headName: inv ? headNamesOf(db, inv) : '—', amountPaise: a.amountPaise };
    }),
    amountPaise: p.amountPaise,
    amountWords: amountInWords(p.amountPaise),
    creditPaise: p.creditPaise,
    refunds: db.refunds.filter(r => r.paymentId === p.id).map(r => ({ voucherNumber: r.voucherNumber, amountPaise: r.amountPaise, date: r.date })),
    recordedBy: recorder ? fullName(recorder) : p.recordedBy,
    recordedAt: p.recordedAt,
    isMock: p.mode === 'online-mock',
    gatewayMode: p.gatewayMode ?? null,
    isTestMode: p.mode === 'online' && p.gatewayMode !== 'live', // stamped "TEST MODE — NO MONEY MOVED"
  };
}

/**
 * Per-student outstanding for one academic year, as it stood at the end of asOfDate (historical: see
 * invoiceAmountsAsOf). Without asOfDate, current figures. paidPaise is net of refunds, so
 * invoiced − concession − paid = balance on every row.
 * totals.externalReceivedPaise = money actually received in this year up to asOfDate (excludes 'credit'
 * transfers), for the students in scope.
 */
export function outstandingReport(db, { academicYearId, programId, asOfDate }) {
  const byStudent = new Map();
  const inScope = studentId => { const s = byId(db.students, studentId); return !programId || (s && s.programId === programId); };
  for (const inv of db.invoices) {
    if (inv.academicYearId !== academicYearId || !inScope(inv.studentId)) continue;
    const a = asOfDate ? invoiceAmountsAsOf(db, inv, asOfDate) : { ...invoiceAmounts(db, inv), live: inv.status !== 'cancelled' };
    if (!a.live) continue;
    const s = byId(db.students, inv.studentId);
    if (!byStudent.has(inv.studentId)) {
      byStudent.set(inv.studentId, {
        studentId: inv.studentId, name: fullName(s), program: (s && byId(db.programs, s.programId)?.name) || '—', invoiceCount: 0,
        invoicedPaise: 0, concessionPaise: 0, lateFeePaise: 0, paidPaise: 0, refundedPaise: 0, balancePaise: 0, overdueDays: 0,
      });
    }
    const r = byStudent.get(inv.studentId);
    r.invoiceCount++;
    r.invoicedPaise += a.linesPaise;
    r.concessionPaise += a.concessionPaise;
    r.lateFeePaise += a.lateFeePaise;
    r.paidPaise += a.paidPaise;
    r.refundedPaise += a.refundedPaise;
    r.balancePaise += a.balancePaise;
    if (asOfDate && a.balancePaise > 0) {
      const eff = effectiveDueDate(db, inv);
      const od = compareISO(asOfDate, eff) > 0 ? diffDays(eff, asOfDate) : 0;
      if (od > r.overdueDays) r.overdueDays = od;
    }
  }
  const rows = [...byStudent.values()].sort((a, b) => b.balancePaise - a.balancePaise || a.name.localeCompare(b.name));
  const totals = { students: rows.length, defaulters: rows.filter(r => r.overdueDays > 0).length, invoicedPaise: 0, concessionPaise: 0, lateFeePaise: 0, paidPaise: 0, refundedPaise: 0, balancePaise: 0, externalReceivedPaise: 0 };
  for (const r of rows) for (const k of ['invoicedPaise', 'concessionPaise', 'lateFeePaise', 'paidPaise', 'refundedPaise', 'balancePaise']) totals[k] += r[k];
  for (const p of db.payments) {
    if (p.mode === 'credit' || !inScope(p.studentId)) continue;
    if ((p.academicYearId ?? academicYearFor(db, p.paidOn)?.id) !== academicYearId) continue;
    if (asOfDate) {
      if (compareISO(p.paidOn, asOfDate) > 0) continue;
      if (p.status !== 'valid' && (!p.cancelledOn || compareISO(p.cancelledOn, asOfDate) <= 0)) continue;
    } else if (p.status !== 'valid') continue;
    totals.externalReceivedPaise += p.amountPaise;
  }
  return { academicYearId, asOfDate, rows, totals };
}
