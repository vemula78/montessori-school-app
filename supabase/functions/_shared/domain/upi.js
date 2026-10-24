// Paying the school by UPI from the parent's own banking app (#81). The school's UPI ID is a school setting
// (school.upi = {vpa, payeeName}); the app shows a upi://pay link with the amount due. The parent then tells the school
// "I paid ₹X by UPI, reference R" against chosen invoices (a payment claim). A claim never creates a receipt by itself:
// the accountant checks it against the bank statement and confirms it — which records an ordinary payment
// (fees.recordPayment, mode 'upi', reference R; receipt numbers stay contiguous) — or rejects it with a reason.
// Money is integer paise; the amount is checked against the open balance of the chosen invoices (minus other pending
// claims on them) when claimed and again when confirmed.

import { fail, newId } from './ids.js';
import { isISODate, compareISO, addDays } from './dates.js';
import { mustGet, byId } from './people.js';
import { appendAudit } from './audit.js';
import { assertPaise, formatPaise, sumPaise } from './money.js';
import { invoiceBalance, recordPayment } from './fees.js';

export const UPI_REFERENCE_RE = /^[A-Za-z0-9-]{6,35}$/;
export const CLAIM_MAX_DAYS_BACK = 60;
export const CLAIM_REASON_MAX = 200;

const openInvoices = (db, studentId, invoiceIds) => {
  if (!Array.isArray(invoiceIds) || !invoiceIds.length) fail('VALIDATION', 'Choose the invoices you paid');
  return [...new Set(invoiceIds)].map(id => {
    const inv = mustGet(db, 'invoices', id, 'Invoice');
    if (inv.studentId !== studentId) fail('VALIDATION', 'Invoice belongs to another child');
    if (inv.status === 'cancelled') fail('VALIDATION', `Invoice ${inv.number} is cancelled`);
    return inv;
  }).sort((a, b) => compareISO(a.dueDate, b.dueDate) || compareISO(a.number, b.number));
};
const pendingOn = (db, invoiceIds, exceptId = null) => sumPaise((db.paymentClaims || [])
  .filter(c => c.status === 'pending' && c.id !== exceptId && c.invoiceIds.some(id => invoiceIds.includes(id))).map(c => c.amountPaise));
const referenceUsed = (db, reference, exceptId = null) => (db.paymentClaims || []).some(c => c.id !== exceptId && c.status !== 'rejected' && c.reference.toUpperCase() === reference.toUpperCase())
  || (db.payments || []).some(p => p.status === 'valid' && p.reference && String(p.reference).toUpperCase() === reference.toUpperCase());

/** claim({studentId, invoiceIds, amountPaise, reference, paidOn}) — a parent of the child; a pending claim. */
export function claimUpiPayment(db, { studentId, invoiceIds, amountPaise, reference, paidOn } = {}, ctx, guardianId) {
  const s = mustGet(db, 'students', studentId, 'Student');
  if (!(s.guardianIds || []).includes(guardianId)) fail('NOT_ALLOWED', 'Not your child');
  const invs = openInvoices(db, s.id, invoiceIds);
  try { assertPaise(amountPaise); } catch { fail('INVALID_AMOUNT', 'The amount must be in whole paise'); }
  if (amountPaise <= 0) fail('INVALID_AMOUNT', 'The amount must be more than zero');
  const ref = String(reference ?? '').trim();
  if (!UPI_REFERENCE_RE.test(ref)) fail('VALIDATION', 'Enter the UPI reference (UTR) shown in your banking app: 6 to 35 letters or digits');
  if (!isISODate(paidOn)) fail('VALIDATION', 'Enter the date you paid');
  if (compareISO(paidOn, ctx.today) > 0) fail('VALIDATION', 'The payment date is in the future');
  if (compareISO(paidOn, addDays(ctx.today, -CLAIM_MAX_DAYS_BACK)) < 0) fail('VALIDATION', `Payments older than ${CLAIM_MAX_DAYS_BACK} days are settled with the school office`);
  if (referenceUsed(db, ref)) fail('VALIDATION', 'This reference has already been reported or recorded');
  const ids = invs.map(i => i.id);
  const room = sumPaise(invs.map(i => invoiceBalance(db, i))) - pendingOn(db, ids);
  if (room <= 0) fail('INVALID_AMOUNT', 'Nothing is open on these invoices (or a reported payment already covers them)');
  if (amountPaise > room) fail('INVALID_AMOUNT', `The amount is more than what is open on these invoices (${formatPaise(room)})`);
  const c = { id: newId('upc'), studentId: s.id, guardianId, invoiceIds: ids, amountPaise, reference: ref, paidOn, status: 'pending', createdAt: ctx.now,
    decidedBy: null, decidedAt: null, rejectReason: null, paymentId: null, receiptNumber: null };
  db.paymentClaims.push(c);
  appendAudit(db, ctx, { entity: 'paymentClaim', entityId: c.id, action: 'claim', summary: `UPI payment of ${formatPaise(amountPaise)} reported for ${s.id} on ${ids.length} invoice(s)` });
  return c;
}

/**
 * confirm(claimId, {paidOn?}) — the accountant, after seeing the money in the bank: an ordinary 'upi' payment allocated
 * to the claim's invoices (oldest due first), with the claim's reference. Refused when the invoices no longer have that
 * much open (paid meanwhile): reject the claim instead, or record the payment by hand.
 */
export function confirmClaim(db, claimId, { paidOn } = {}, ctx) {
  const c = mustGet(db, 'paymentClaims', claimId, 'Payment claim');
  if (c.status !== 'pending') fail('VALIDATION', `This claim is already ${c.status}`);
  const invs = openInvoices(db, c.studentId, c.invoiceIds);
  let left = c.amountPaise;
  const allocations = [];
  for (const inv of invs) {
    if (left <= 0) break;
    const bal = invoiceBalance(db, inv);
    if (bal <= 0) continue;
    const take = Math.min(bal, left);
    allocations.push({ invoiceId: inv.id, amountPaise: take });
    left -= take;
  }
  if (left > 0) fail('INVALID_AMOUNT', 'These invoices no longer have that much open (paid meanwhile?); reject the claim or record the payment by hand');
  const pay = recordPayment(db, { studentId: c.studentId, amountPaise: c.amountPaise, mode: 'upi', reference: c.reference, paidOn: paidOn || c.paidOn,
    allocations, allowCredit: false, guardianId: byId(db.guardians, c.guardianId) ? c.guardianId : null }, ctx);
  Object.assign(c, { status: 'confirmed', decidedBy: ctx.actor.id, decidedAt: ctx.now, paymentId: pay.id, receiptNumber: pay.receiptNumber });
  appendAudit(db, ctx, { entity: 'paymentClaim', entityId: c.id, action: 'confirm', summary: `confirmed as ${pay.receiptNumber}` });
  return { claim: c, payment: pay };
}

/** reject(claimId, reason) — the money is not in the bank (or the details are wrong); the parent sees the reason. */
export function rejectClaim(db, claimId, reason, ctx) {
  const c = mustGet(db, 'paymentClaims', claimId, 'Payment claim');
  if (c.status !== 'pending') fail('VALIDATION', `This claim is already ${c.status}`);
  const why = String(reason ?? '').trim().replace(/\s+/g, ' ');
  if (!why) fail('VALIDATION', 'Give the reason, so the family knows what to do');
  if (why.length > CLAIM_REASON_MAX) fail('VALIDATION', `The reason must be at most ${CLAIM_REASON_MAX} characters`);
  Object.assign(c, { status: 'rejected', decidedBy: ctx.actor.id, decidedAt: ctx.now, rejectReason: why });
  appendAudit(db, ctx, { entity: 'paymentClaim', entityId: c.id, action: 'reject', summary: 'claim rejected' });
  return c;
}

/**
 * upi://pay link for paying these invoices (or every open one of the child): {link, vpa, payeeName, amountPaise, note} —
 * null when the school has not set its UPI ID. Amount = what is open now, less pending claims on those invoices.
 */
export function upiLink(db, studentId, invoiceIds = null) {
  const upi = db.school && db.school.upi;
  if (!upi) return null;
  const s = mustGet(db, 'students', studentId, 'Student');
  const invs = invoiceIds ? openInvoices(db, s.id, invoiceIds) : db.invoices.filter(i => i.studentId === s.id && i.status !== 'cancelled' && invoiceBalance(db, i) > 0);
  const amountPaise = Math.max(0, sumPaise(invs.map(i => invoiceBalance(db, i))) - pendingOn(db, invs.map(i => i.id)));
  if (amountPaise <= 0) return { link: null, vpa: upi.vpa, payeeName: upi.payeeName, amountPaise: 0, note: '' };
  const note = `Fees ${invs.map(i => i.number).join(' ')}`.slice(0, 80);
  const rupees = `${Math.floor(amountPaise / 100)}.${String(amountPaise % 100).padStart(2, '0')}`;
  const q = [['pa', upi.vpa], ['pn', upi.payeeName], ['am', rupees], ['cu', 'INR'], ['tn', note]].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  return { link: `upi://pay?${q}`, vpa: upi.vpa, payeeName: upi.payeeName, amountPaise, note };
}
