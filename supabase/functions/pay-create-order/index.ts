// POST /pay-create-order {studentId, invoiceIds, amountPaise?} → {orderId, amountPaise, keyId, mode, prefill}
// The amount is computed here from current invoice balances; a client amount can only lower it (≥ ₹100).

import { body, coded, serve } from '../_shared/http.ts';
import { caller } from '../_shared/authz.ts';
import { runCommand } from '../_shared/persist.ts';
import { rest } from '../_shared/db.ts';
import { gateway } from '../_shared/gateway.ts';

const MAX_ORDERS_PER_HOUR = 10;

serve(async (req) => {
  const g = gateway();
  const who = await caller(req);
  if (who.kind !== 'user') throw coded('UNAUTHENTICATED', 'Sign in first');
  const { studentId, invoiceIds, amountPaise } = await body(req);
  if (!Array.isArray(invoiceIds) || !invoiceIds.length) throw coded('VALIDATION', 'Choose at least one invoice');
  const since = new Date(Date.now() - 3600_000).toISOString();
  const recent = await rest(`gateway_orders?created_by=eq.${who.user.id}&created_at=gte.${encodeURIComponent(since)}&select=id`);
  if (recent.length >= MAX_ORDERS_PER_HOUR) throw coded('RATE_LIMITED', 'Too many payment attempts in the last hour; please try again later');
  const q = (await runCommand('fees.gatewayOrderQuote', [{ studentId, invoiceIds, amountPaise }], who)).result;
  const rzp = await g.client.createOrder({ amountPaise: q.amountPaise, receipt: `stu-${studentId}`.slice(0, 40), notes: { student_id: studentId } });
  if (!rzp || !rzp.id || rzp.amount !== q.amountPaise) throw coded('GATEWAY', 'The payment gateway did not create the order as requested');
  await rest('gateway_orders', { method: 'POST', prefer: 'return=minimal', body: {
    id: rzp.id, student_id: studentId, guardian_id: q.guardianId, invoice_ids: q.invoiceIds, amount_paise: q.amountPaise,
    balances_snapshot: q.balances, status: 'created', mode: g.mode, created_by: who.user.id,
  } });
  return { orderId: rzp.id, amountPaise: q.amountPaise, keyId: g.keyId, mode: g.mode, prefill: q.prefill };
});
