// Payment-gateway (Razorpay) ledger steps and settlement reconciliation. Pure: no network, no crypto.
// The Edge Functions verify signatures and call Razorpay; everything that touches the ledger is here so
// the same rules run under node tests and inside Deno.
//
// recordGatewayPayment is the ONE idempotent step used by pay-verify, the webhook and pay-status:
// a capture already recorded (same gatewayPaymentId) is returned, never recorded twice.

import { fail } from './ids.js';
import { assertPaise, sumPaise, rupeesToPaise } from './money.js';
import { compareISO, dateInZone, IST_OFFSET_MIN, parseDate, isISODate } from './dates.js';
import { byId, fullName } from './people.js';
import { invoiceBalance, recordPayment, refund } from './fees.js';
import { appendAudit } from './audit.js';
import { parseCsvObjects, normHeader } from './csv.js';

export const MIN_ONLINE_PAISE = 10000; // ₹100: the smallest part-payment a payer may choose

/** Open invoices of the order (chosen by the payer), oldest due first; cancelled/paid/foreign ones skipped. */
export function orderInvoices(db, studentId, invoiceIds) {
  return [...new Set(invoiceIds || [])]
    .map(id => byId(db.invoices, id))
    .filter(i => i && i.studentId === studentId && i.status !== 'cancelled' && invoiceBalance(db, i) > 0)
    .sort((a, b) => compareISO(a.dueDate, b.dueDate) || compareISO(a.number, b.number));
}

/**
 * Amount for a new order: Σ current balances of the chosen open invoices, optionally lowered (never raised)
 * by the payer to a part-payment ≥ ₹100. The client's figure is never trusted upward.
 * @returns {{amountPaise:number, balancePaise:number, balances:{invoiceId:string, balancePaise:number}[]}}
 */
export function orderAmount(db, { studentId, invoiceIds, amountPaise }) {
  const invs = orderInvoices(db, studentId, invoiceIds);
  if (!invs.length) fail('VALIDATION', 'None of the chosen invoices has anything to pay');
  const balances = invs.map(i => ({ invoiceId: i.id, balancePaise: invoiceBalance(db, i) }));
  const balancePaise = sumPaise(balances.map(b => b.balancePaise));
  let amount = balancePaise;
  if (amountPaise !== undefined && amountPaise !== null) {
    assertPaise(amountPaise);
    if (amountPaise < amount) {
      if (amountPaise < MIN_ONLINE_PAISE) fail('INVALID_AMOUNT', 'A part-payment must be at least ₹100.00');
      amount = amountPaise;
    }
  }
  return { amountPaise: amount, balancePaise, balances };
}

/** Allocation computed at capture time (failure mode 6): oldest-due-first over the order's invoices; rest → credit. */
export function allocateAtCapture(db, studentId, invoiceIds, amountPaise) {
  let left = assertPaise(amountPaise);
  const allocations = [];
  for (const inv of orderInvoices(db, studentId, invoiceIds)) {
    if (left <= 0) break;
    const take = Math.min(left, invoiceBalance(db, inv));
    allocations.push({ invoiceId: inv.id, amountPaise: take });
    left -= take;
  }
  return { allocations, creditPaise: left };
}

/** IST business date of a Razorpay `created_at` (Unix seconds). Never the machine zone (Deno runs in UTC). */
export const gatewayDate = unixSeconds => dateInZone(unixSeconds * 1000, IST_OFFSET_MIN);

/**
 * @param {{order:{id:string, studentId:string, guardianId:string|null, invoiceIds:string[], amountPaise:number},
 *   payment:{id:string, order_id:string, amount:number, status:string, created_at:number}, gatewayMode:'test'|'live'}} a
 * @returns {{payment:Object, created:boolean, status:'paid'|'amount_mismatch'}}
 */
export function recordGatewayPayment(db, { order, payment: rp, gatewayMode }, ctx) {
  if (!['test', 'live'].includes(gatewayMode)) fail('VALIDATION', `Unknown gateway mode: ${gatewayMode}`);
  if (!rp || typeof rp.id !== 'string' || !rp.id) fail('VALIDATION', 'Gateway payment id missing');
  const statusOf = p => (p.amountPaise === order.amountPaise ? 'paid' : 'amount_mismatch');
  const existing = db.payments.find(p => p.gatewayPaymentId === rp.id);
  if (existing) return { payment: existing, created: false, status: statusOf(existing) };
  if (rp.order_id !== order.id) fail('VALIDATION', 'Gateway payment belongs to a different order');
  if (rp.status !== 'captured') fail('VALIDATION', `Gateway payment is ${rp.status}, not captured`);
  assertPaise(rp.amount);
  if (rp.amount <= 0) fail('INVALID_AMOUNT', 'Captured amount must be greater than zero');
  if (!Number.isFinite(rp.created_at)) fail('VALIDATION', 'Gateway payment has no created_at');
  const paidOn = gatewayDate(rp.created_at);
  const { allocations } = allocateAtCapture(db, order.studentId, order.invoiceIds, rp.amount);
  const pay = recordPayment(db, {
    studentId: order.studentId, amountPaise: rp.amount, mode: 'online', reference: rp.id, paidOn,
    allocations, allowCredit: true, guardianId: order.guardianId || null, explicitAllocations: true,
  }, ctx);
  pay.gatewayPaymentId = rp.id;
  pay.gatewayOrderId = order.id;
  pay.gatewayMode = gatewayMode;
  const status = statusOf(pay);
  if (status === 'amount_mismatch') {
    // Money is real: it is recorded anyway and flagged for the accountant (failure mode in plan (d)4).
    appendAudit(db, ctx, { entity: 'payment', entityId: pay.id, action: 'amountMismatch', summary: `${pay.receiptNumber}: captured ${rp.amount} paise, order ${order.id} was for ${order.amountPaise} paise` });
  }
  return { payment: pay, created: true, status };
}

/**
 * A refund made on the gateway dashboard → ledger refunds, idempotent on gatewayRefundId.
 * Split across the payment's allocations largest-first, then its unused credit. Refund for a payment not
 * yet in the ledger (out-of-order event) → {pending:true}; the caller keeps the event and retries later.
 * @param {{refund:{id:string, payment_id:string, amount:number, created_at:number}}} a
 */
export function recordGatewayRefund(db, { refund: rr }, ctx) {
  if (!rr || typeof rr.id !== 'string' || !rr.id) fail('VALIDATION', 'Gateway refund id missing');
  const prior = db.refunds.filter(r => r.gatewayRefundId === rr.id || r.reference === rr.id);
  // the gateway's own booking of this refund exists: replay
  if (prior.some(r => r.gatewayRefundId === rr.id && Number.isInteger(r.gatewayRefundPart))) return { pending: false, created: false, refunds: prior };
  // only a refund the gateway has processed moves money: 'pending' waits for refund.processed, 'failed' never books
  if (rr.status !== 'processed') return { pending: false, created: false, refunds: [], skipped: `refund ${rr.id} is ${rr.status || 'of unknown status'} at the gateway; booked only once processed` };
  const pay = db.payments.find(p => p.gatewayPaymentId === rr.payment_id);
  if (!pay) return { pending: true, created: false, refunds: [], reason: `payment ${rr.payment_id} is not in the ledger yet` };
  assertPaise(rr.amount);
  if (rr.amount <= 0) fail('INVALID_AMOUNT', 'Refund amount must be greater than zero');
  // recorded by hand already (reference = gateway refund id): book only the rest; more than the gateway refund is flagged
  const manualPaise = sumPaise(prior.map(r => r.amountPaise));
  if (manualPaise > rr.amount) {
    appendAudit(db, ctx, { entity: 'refund', entityId: rr.id, action: 'gatewayRefundMismatch', summary: `${rr.id}: ${manualPaise} paise recorded by hand, gateway refunded ${rr.amount} paise; nothing booked` });
    return { pending: false, created: false, refunds: prior, mismatch: `${manualPaise} paise recorded by hand is more than the ${rr.amount} paise the gateway refunded` };
  }
  if (manualPaise === rr.amount) return { pending: false, created: false, refunds: prior };
  const amount = rr.amount - manualPaise;
  const date = gatewayDate(rr.created_at);
  const reason = `Refund made on the payment gateway (${rr.id})`;
  const refunded = (paymentId, invoiceId) => sumPaise(db.refunds.filter(r => r.paymentId === paymentId && r.invoiceId === invoiceId).map(r => r.amountPaise));
  const roomOf = p => p.allocations
    .map(a => ({ paymentId: p.id, invoiceId: a.invoiceId, room: a.amountPaise - refunded(p.id, a.invoiceId) }))
    .filter(x => x.room > 0)
    .sort((a, b) => b.room - a.room || (a.invoiceId < b.invoiceId ? -1 : 1));
  const parts = roomOf(pay);
  const unusedCredit = sumPaise(db.credits.filter(c => c.sourcePaymentId === pay.id && !c.consumedByPaymentId && !c.consumedByRefundId).map(c => c.amountPaise));
  // credit from this capture that a later 'credit' payment applied to other invoices (finding 19): that application
  // is reversed against the credit payment's allocations, up to what it took from this capture
  const viaCredit = [];
  const byConsumer = new Map();
  for (const c of db.credits) {
    if (c.sourcePaymentId !== pay.id || !c.consumedByPaymentId) continue;
    const p2 = byId(db.payments, c.consumedByPaymentId);
    if (!p2 || p2.status !== 'valid') continue;
    byConsumer.set(p2.id, (byConsumer.get(p2.id) || 0) + c.amountPaise);
  }
  for (const [p2id, took] of byConsumer) {
    const p2 = byId(db.payments, p2id);
    const already = sumPaise(db.refunds.filter(r => r.paymentId === p2id && r.gatewaySourcePaymentId === pay.id).map(r => r.amountPaise));
    let cap = took - already;
    for (const x of roomOf(p2)) {
      if (cap <= 0) break;
      const amt = Math.min(cap, x.room);
      viaCredit.push({ ...x, room: amt, viaReceipt: p2.receiptNumber });
      cap -= amt;
    }
  }
  const room = sumPaise(parts.map(x => x.room)) + unusedCredit + sumPaise(viaCredit.map(x => x.room));
  if (amount > room) fail('INVALID_AMOUNT', `Gateway refund ${amount} paise exceeds what ${pay.receiptNumber} can still return (${room} paise); record it manually after checking`);
  let left = amount;
  const out = [];
  const take = (paymentId, invoiceId, amt) => {
    const r = refund(db, { paymentId, invoiceId, amountPaise: amt, mode: 'online', reference: rr.id, date, reason }, ctx, { gatewayRefundId: rr.id });
    r.gatewayRefundPart = out.length;
    if (paymentId !== pay.id) r.gatewaySourcePaymentId = pay.id;
    out.push(r);
  };
  for (const x of parts) {
    if (left <= 0) break;
    const amt = Math.min(left, x.room);
    take(pay.id, x.invoiceId, amt);
    left -= amt;
  }
  if (left > 0 && unusedCredit > 0) {
    const amt = Math.min(left, unusedCredit);
    take(pay.id, null, amt);
    left -= amt;
  }
  for (const x of viaCredit) {
    if (left <= 0) break;
    const amt = Math.min(left, x.room);
    take(x.paymentId, x.invoiceId, amt);
    left -= amt;
  }
  return { pending: false, created: true, refunds: out };
}

// ---------------------------------------------------------------- settlement report (CSV from the gateway dashboard)

const SETTLE_ALIASES = {
  type: ['type', 'entitytype'],
  entityId: ['entityid', 'paymentid', 'id'],
  gross: ['amount', 'gross', 'grossamount'],
  fee: ['fee', 'fees'],
  tax: ['tax', 'gst', 'taxes'],
  net: ['credit', 'net', 'netamount', 'settledamount'],
  debit: ['debit'],
  settlementId: ['settlementid'],
  utr: ['settlementutr', 'utr'],
  settledAt: ['settledat', 'settlementdate', 'settledon', 'settlementat'],
};

function settledDate(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/^\d{9,10}$/.test(s)) return gatewayDate(Number(s)); // Unix seconds
  return parseDate(s.split(/[ T]/)[0]); // '2026-10-05 10:21:33' → '2026-10-05'; unknown shape → null (missing)
}

/**
 * Parse a settlement report CSV. Amounts are rupees with decimals, as the dashboard exports them
 * (verify against a real export before go-live). Nothing is dropped: every data row is a line or rejected.
 * @returns {{inputRows:number, lines:Object[], rejected:{line:number, reason:string}[]}}
 */
export function parseSettlementCsv(text) {
  const { headers, rows } = parseCsvObjects(text);
  const col = {};
  for (const [k, list] of Object.entries(SETTLE_ALIASES)) col[k] = headers.find(h => list.includes(normHeader(h)));
  const lines = [], rejected = [];
  if (rows.length && (!col.entityId || !col.gross || !col.settlementId)) {
    for (const r of rows) rejected.push({ line: r.line, reason: 'file has no entity_id / amount / settlement_id columns' });
    return { inputRows: rows.length, lines, rejected };
  }
  const money = (r, k) => (col[k] && r.values[col[k]] !== '' ? rupeesToPaise(r.values[col[k]]) : null);
  // fee/tax: an absent column or empty cell is zero; anything present but not an amount is an error (never zero)
  const optional = (r, k) => (col[k] && r.values[col[k]] !== '' ? rupeesToPaise(r.values[col[k]]) : 0);
  for (const r of rows) {
    if (r.problem) { rejected.push({ line: r.line, reason: r.problem }); continue; }
    const v = r.values;
    const entityId = v[col.entityId];
    const settlementId = v[col.settlementId];
    const type = (col.type ? v[col.type] : '') || (entityId.startsWith('rfnd_') ? 'refund' : entityId.startsWith('pay_') ? 'payment' : '');
    const gross = money(r, 'gross'), fee = optional(r, 'fee'), tax = optional(r, 'tax');
    let net = money(r, 'net');
    if (!entityId) { rejected.push({ line: r.line, reason: 'entity id is empty' }); continue; }
    if (!settlementId) { rejected.push({ line: r.line, reason: 'settlement id is empty (not settled yet?)' }); continue; }
    if (gross === null) { rejected.push({ line: r.line, reason: `amount "${v[col.gross]}" is not a number` }); continue; }
    if ([fee, tax].some(x => x === null)) { rejected.push({ line: r.line, reason: 'fee or tax is not a number' }); continue; }
    if (type === 'refund' && net === null) net = money(r, 'debit');
    if (net === null) { rejected.push({ line: r.line, reason: 'net (credit) amount missing' }); continue; }
    lines.push({
      line: r.line, type, entityId, settlementId, utr: col.utr ? v[col.utr] || null : null,
      settledOn: col.settledAt ? settledDate(v[col.settledAt]) : null,
      grossPaise: gross, feePaise: fee, taxPaise: tax, netPaise: net,
    });
  }
  return { inputRows: rows.length, lines, rejected };
}

/**
 * Idempotent merge of parsed lines into the stored ones (key = settlementId + entityId).
 * Same key with the same figures → duplicate; same key with different figures (vs a stored line, or between lines
 * of this file) → every such line rejected with the reason: a corrected export must not be silently ignored.
 * imported + duplicate + rejected.length === parsed.lines.length.
 */
export function mergeSettlementLines(stored, parsed) {
  const key = l => `${l.settlementId}|${l.entityId}`;
  const sig = l => JSON.stringify([l.type, l.grossPaise, l.feePaise, l.taxPaise, l.netPaise, l.utr ?? null, l.settledOn ?? null]);
  const have = new Map(stored.map(l => [key(l), l]));
  const groups = new Map();
  for (const l of parsed.lines) { const k = key(l); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(l); }
  const added = [], rejected = [];
  let duplicate = 0;
  for (const [k, ls] of groups) {
    const old = have.get(k);
    if (ls.some(l => sig(l) !== sig(ls[0]))) {
      const lines = ls.map(l => l.line).join(', ');
      for (const l of ls) rejected.push({ line: l.line, reason: `lines ${lines} give different figures for ${l.entityId} in settlement ${l.settlementId}` });
      continue;
    }
    if (old && sig(old) !== sig(ls[0])) {
      for (const l of ls) rejected.push({ line: l.line, reason: `${l.entityId} in settlement ${l.settlementId} was already imported with different figures (line ${old.line ?? '?'} of an earlier file); check with the payment provider` });
      continue;
    }
    if (!old) added.push({ ...ls[0], id: k });
    duplicate += old ? ls.length : ls.length - 1;
  }
  return { added, imported: added.length, duplicate, rejected };
}

/**
 * Ledger online payments (and gateway refunds) joined to settlement lines. Every unmatched row on either
 * side is listed; totals carry the identity Σ gross = Σ net + Σ fee + Σ tax (mismatching lines listed).
 * from/to filter the LEDGER side by paidOn; settlement lines are matched whatever their date.
 */
export function settlementReport(db, lines, { from, to } = {}) {
  const inRange = d => (!from || compareISO(d, from) >= 0) && (!to || compareISO(d, to) <= 0);
  const pays = db.payments.filter(p => p.mode === 'online' && p.gatewayPaymentId && inRange(p.paidOn));
  const refunds = db.refunds.filter(r => r.gatewayRefundId && (isISODate(r.date) ? inRange(r.date) : true));
  const byEntity = new Map();
  for (const l of lines) { if (!byEntity.has(l.entityId)) byEntity.set(l.entityId, []); byEntity.get(l.entityId).push(l); }
  const used = new Set();
  const rows = [], unmatchedLedger = [];
  for (const p of pays) {
    const ls = (byEntity.get(p.gatewayPaymentId) || []).filter(l => l.type !== 'refund');
    const student = byId(db.students, p.studentId);
    if (!ls.length) { unmatchedLedger.push({ kind: 'payment', paymentId: p.id, receiptNumber: p.receiptNumber, gatewayPaymentId: p.gatewayPaymentId, paidOn: p.paidOn, amountPaise: p.amountPaise, status: p.status, reason: 'not in any imported settlement (not settled yet, or report not imported)' }); continue; }
    // one capture is settled once: several lines (e.g. under two settlement ids) are all flagged, never two good matches
    const many = ls.length > 1 ? `this payment appears in ${ls.length} settlement lines (${ls.map(l => l.settlementId).join(', ')})` : null;
    for (const l of ls) {
      used.add(l);
      rows.push({ kind: 'payment', paymentId: p.id, receiptNumber: p.receiptNumber, studentName: fullName(student), paidOn: p.paidOn, ledgerPaise: p.amountPaise, status: p.status,
        settlementId: l.settlementId, utr: l.utr, settledOn: l.settledOn, grossPaise: l.grossPaise, feePaise: l.feePaise, taxPaise: l.taxPaise, netPaise: l.netPaise,
        amountMatches: !many && l.grossPaise === p.amountPaise, reason: many || (l.grossPaise === p.amountPaise ? null : 'settled amount differs from the ledger') });
    }
  }
  const refundGroups = new Map();
  for (const r of refunds) { if (!refundGroups.has(r.gatewayRefundId)) refundGroups.set(r.gatewayRefundId, []); refundGroups.get(r.gatewayRefundId).push(r); }
  for (const [gid, rs] of refundGroups) {
    const ledgerPaise = sumPaise(rs.map(r => r.amountPaise));
    const ls = (byEntity.get(gid) || []);
    if (!ls.length) { unmatchedLedger.push({ kind: 'refund', gatewayRefundId: gid, voucherNumbers: rs.map(r => r.voucherNumber), amountPaise: ledgerPaise, reason: 'refund not in any imported settlement' }); continue; }
    const many = ls.length > 1 ? `this refund appears in ${ls.length} settlement lines` : null;
    for (const l of ls) {
      used.add(l);
      rows.push({ kind: 'refund', gatewayRefundId: gid, voucherNumbers: rs.map(r => r.voucherNumber), ledgerPaise, settlementId: l.settlementId, utr: l.utr, settledOn: l.settledOn,
        grossPaise: l.grossPaise, feePaise: l.feePaise, taxPaise: l.taxPaise, netPaise: l.netPaise, amountMatches: !many && l.grossPaise === ledgerPaise,
        reason: many || (l.grossPaise === ledgerPaise ? null : 'refunded amount differs from the ledger') });
    }
  }
  const unmatchedSettlement = lines.filter(l => !used.has(l)).map(l => ({ ...l, reason: l.type === 'payment' || l.type === 'refund' ? `no ${l.type} with this gateway id in the ledger${from || to ? ' for the chosen dates' : ''}` : `line type "${l.type || 'unknown'}" is not matched to receipts` }));
  const sum = (arr, k) => arr.reduce((s, x) => s + x[k], 0);
  // payment line: gross = net credited + fee + tax.  refund line: net debited = refunded amount + fee + tax.
  // (Unverified against a real export — see parseSettlementCsv.)
  const balanced = l => (l.type === 'refund' ? l.netPaise === l.grossPaise + l.feePaise + l.taxPaise : l.grossPaise === l.netPaise + l.feePaise + l.taxPaise);
  const identityMismatches = lines.filter(l => !balanced(l))
    .map(l => ({ line: l.line, entityId: l.entityId, type: l.type, grossPaise: l.grossPaise, netPaise: l.netPaise, feePaise: l.feePaise, taxPaise: l.taxPaise }));
  const payLines = lines.filter(l => l.type !== 'refund');
  const refundLines = lines.filter(l => l.type === 'refund');
  const refundDebitPaise = sum(refundLines, 'netPaise');
  const totals = {
    ledgerPayments: pays.length, ledgerPaise: sum(pays, 'amountPaise'),
    settlementLines: lines.length, matchedRows: rows.length, unmatchedLedger: unmatchedLedger.length, unmatchedSettlement: unmatchedSettlement.length,
    grossPaise: sum(payLines, 'grossPaise'), feePaise: sum(payLines, 'feePaise'), taxPaise: sum(payLines, 'taxPaise'),
    paymentNetPaise: sum(payLines, 'netPaise'), refundGrossPaise: sum(refundLines, 'grossPaise'), refundDebitPaise,
    netPaise: sum(payLines, 'netPaise') - refundDebitPaise, // net to bank: payment credits less refund debits
    identityOk: identityMismatches.length === 0, identityMismatches,
    amountMismatches: rows.filter(r => !r.amountMatches).length,
  };
  return { rows, unmatchedLedger, unmatchedSettlement, totals };
}
