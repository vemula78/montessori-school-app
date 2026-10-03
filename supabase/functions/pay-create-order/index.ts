// POST /pay-create-order {studentId, invoiceIds, amountPaise?} → {orderId, amountPaise, keyId, mode, prefill}
// The amount is computed here from current invoice balances; a client amount can only lower it (≥ ₹100).

import { body, coded, serve } from '../_shared/http.ts';
import { caller } from '../_shared/authz.ts';
import { runCommand } from '../_shared/persist.ts';
import { rest, rpc } from '../_shared/db.ts';
import { gateway } from '../_shared/gateway.ts';

const MAX_ORDERS_PER_HOUR = 10;
// Razorpay's receipt (≤ 40 chars) must be unique per order: student id + time + random, never reused
const receiptFor = (studentId: string) => {
  const r = Array.from(crypto.getRandomValues(new Uint8Array(4)), b => b.toString(16).padStart(2, '0')).join('');
  return `${String(studentId).slice(0, 18)}-${Date.now().toString(36)}-${r}`.slice(0, 40);
};

serve(async (req) => {
  const g = gateway();
  const who = await caller(req);
  if (who.kind !== 'user') throw coded('UNAUTHENTICATED', 'Sign in first');
  const { studentId, invoiceIds, amountPaise } = await body(req);
  if (!Array.isArray(invoiceIds) || !invoiceIds.length) throw coded('VALIDATION', 'Choose at least one invoice');
  const q = (await runCommand('fees.gatewayOrderQuote', [{ studentId, invoiceIds, amountPaise }], who)).result;
  // the slot is taken atomically (per-user lock) and BEFORE the gateway call, so parallel requests cannot all pass
  // and an attempt whose order row is never stored still counts
  if (!(await rpc('take_order_slot', { p_user: who.user.id, p_max: MAX_ORDERS_PER_HOUR }))) throw coded('RATE_LIMITED', 'Too many payment attempts in the last hour; please try again later');
  const rzp = await g.client.createOrder({ amountPaise: q.amountPaise, receipt: receiptFor(studentId), notes: { student_id: studentId } });
  if (!rzp || !rzp.id || rzp.amount !== q.amountPaise) throw coded('GATEWAY', 'The payment gateway did not create the order as requested');
  await rest('gateway_orders', { method: 'POST', prefer: 'return=minimal', body: {
    id: rzp.id, student_id: studentId, guardian_id: q.guardianId, invoice_ids: q.invoiceIds, amount_paise: q.amountPaise,
    balances_snapshot: q.balances, status: 'created', mode: g.mode, created_by: who.user.id,
  } });
  return { orderId: rzp.id, amountPaise: q.amountPaise, keyId: g.keyId, mode: g.mode, prefill: q.prefill };
});
