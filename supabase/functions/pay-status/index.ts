// POST /pay-status {orderId} → {status:'created'|'paid'|'failed'|'amount_mismatch', payment|null}
// Called when the pay tab regains focus: if the browser closed before pay-verify, captured payments are
// fetched from Razorpay and recorded through the same idempotent step (the webhook may also have done it).

import { body, coded, serve } from '../_shared/http.ts';
import { caller } from '../_shared/authz.ts';
import { runCommand } from '../_shared/persist.ts';
import { gateway, ledgerPayment, orderRow, recordCapture } from '../_shared/gateway.ts';

serve(async (req) => {
  const g = gateway();
  const who = await caller(req);
  const { orderId } = await body(req);
  const row = orderId ? await orderRow(orderId) : null;
  if (!row) throw coded('NOT_FOUND', 'Payment order not found');
  await runCommand('fees.gatewayOrderAccess', [{ studentId: row.student_id }], who);
  if (row.status === 'paid' || row.status === 'amount_mismatch') return { status: row.status, payment: await ledgerPayment(row.payment_id) };
  const items = await g.client.orderPayments(orderId);
  let last = null;
  for (const p of items.filter((x: any) => x.status === 'captured')) last = await recordCapture(row, p);
  if (last) return { status: last.status, payment: last.payment };
  const failed = items.length > 0 && items.every((x: any) => x.status === 'failed');
  return { status: failed ? 'failed' : 'created', payment: null };
});
