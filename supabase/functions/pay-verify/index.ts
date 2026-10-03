// POST /pay-verify {orderId, razorpayPaymentId, razorpaySignature} → ledger Payment
// Signature: HMAC-SHA256(order_id|payment_id, key secret), constant-time. The amount and status are then
// re-read from Razorpay (never from the browser) and recorded through the idempotent ledger step.

import { body, coded, serve } from '../_shared/http.ts';
import { caller } from '../_shared/authz.ts';
import { runCommand } from '../_shared/persist.ts';
import { gateway, orderRow, recordCapture } from '../_shared/gateway.ts';
import { verifyPaymentSignature } from '../_shared/razorpay.js';

serve(async (req) => {
  const g = gateway();
  const who = await caller(req);
  const { orderId, razorpayPaymentId, razorpaySignature } = await body(req);
  const row = orderId ? await orderRow(orderId) : null;
  if (!row) throw coded('NOT_FOUND', 'Payment order not found');
  await runCommand('fees.gatewayOrderAccess', [{ studentId: row.student_id }], who);
  if (!(await verifyPaymentSignature({ orderId, paymentId: razorpayPaymentId, signature: razorpaySignature }, g.keySecret))) {
    throw coded('NOT_ALLOWED', 'The payment confirmation is not valid');
  }
  const pay = await g.client.fetchPayment(razorpayPaymentId);
  if (!pay || pay.order_id !== orderId) throw coded('VALIDATION', 'This payment does not belong to the order');
  if (pay.status !== 'captured') throw coded('VALIDATION', `The payment is ${pay.status}; it will appear here once the bank confirms it`);
  const r = await recordCapture(row, pay);
  return r.payment;
});
