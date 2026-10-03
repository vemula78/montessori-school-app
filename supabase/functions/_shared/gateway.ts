// Razorpay configuration and the capture/refund steps shared by pay-verify, pay-status, rzp-webhook and cron-daily.
// Every path into the ledger goes through the same idempotent registry commands (fees.recordGatewayPayment /
// fees.recordGatewayRefund), so verify + webhook + status-poll can never record one capture twice.

import { checkKeyMode, razorpayClient } from './razorpay.js';
import { runCommand } from './persist.ts';
import { system } from './authz.ts';
import { rest, restAll } from './db.ts';
import { coded } from './http.ts';
import { fanOut } from './push.ts';

const KEY_ID = Deno.env.get('RAZORPAY_KEY_ID') ?? '';
const KEY_SECRET = Deno.env.get('RAZORPAY_KEY_SECRET') ?? '';
const WEBHOOK_SECRET = Deno.env.get('RAZORPAY_WEBHOOK_SECRET') ?? '';
const MODE = Deno.env.get('APP_GATEWAY_MODE') ?? '';
const API_BASE = Deno.env.get('RAZORPAY_API_BASE') || 'https://api.razorpay.com';

// Refuse to work at all when the key and the declared mode disagree (a live key in a test deployment or v.v.).
let configError: string | null = null;
try {
  if (!KEY_ID || !KEY_SECRET || !WEBHOOK_SECRET) throw new Error('RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET / RAZORPAY_WEBHOOK_SECRET are not set');
  checkKeyMode(KEY_ID, MODE);
} catch (e) {
  configError = (e as Error).message;
  console.error(`gateway disabled: ${configError}`);
}

export function gateway() {
  if (configError) throw coded('GATEWAY', `Online payment is not configured: ${configError}`);
  return { keyId: KEY_ID, keySecret: KEY_SECRET, webhookSecret: WEBHOOK_SECRET, mode: MODE as 'test' | 'live', client: razorpayClient({ keyId: KEY_ID, keySecret: KEY_SECRET, apiBase: API_BASE }) };
}

export async function orderRow(orderId: string) {
  const rows = await rest(`gateway_orders?id=eq.${encodeURIComponent(orderId)}&select=*`);
  return rows && rows[0] ? rows[0] : null;
}
const toOrder = (r: any) => ({ id: r.id, studentId: r.student_id, guardianId: r.guardian_id, invoiceIds: r.invoice_ids, amountPaise: Number(r.amount_paise) });

export async function ledgerPayment(paymentId: string | null) {
  if (!paymentId) return null;
  const rows = await rest(`payments?id=eq.${encodeURIComponent(paymentId)}&select=doc`);
  return rows && rows[0] ? rows[0].doc : null;
}

/** Record a captured Razorpay payment (idempotent), update the order, notify, then settle refunds that arrived first. */
export async function recordCapture(row: any, rzpPayment: any) {
  const run = await runCommand('fees.recordGatewayPayment', [{ order: toOrder(row), payment: rzpPayment, gatewayMode: row.mode }], system('gateway'));
  const { payment, status, created } = run.result;
  await rest(`gateway_orders?id=eq.${encodeURIComponent(row.id)}`, { method: 'PATCH', body: { status, payment_id: payment.id, updated_at: new Date().toISOString() } });
  if (created) await fanOut('fees.recordGatewayPayment', run);
  await retryPendingRefunds(rzpPayment.id);
  return { payment, status, created };
}

/**
 * Apply one stored webhook event. Never throws: returns the result to store on the event row.
 * Out-of-order refund (before its capture) → 'pending' (re-run after the capture lands, and by cron-daily).
 */
export async function processEvent(ev: { event: string; payload: any }): Promise<{ result: string; error: string | null }> {
  try {
    const p = ev.payload?.payload || {};
    if (ev.event === 'payment.captured' || ev.event === 'order.paid') {
      const pay = p.payment?.entity;
      if (!pay || pay.status !== 'captured') return { result: 'ignored', error: 'no captured payment in the event' };
      const row = await orderRow(pay.order_id);
      if (!row) return { result: 'error', error: `unknown order ${pay.order_id}` };
      await recordCapture(row, pay);
      return { result: 'ok', error: null };
    }
    if (ev.event === 'payment.failed') {
      const pay = p.payment?.entity;
      if (pay?.order_id) {
        // a failure after a capture changes nothing; a created order stays payable (the payer may retry)
        await rest(`gateway_orders?id=eq.${encodeURIComponent(pay.order_id)}&status=eq.created`, { method: 'PATCH',
          body: { last_error: String(pay.error_description || pay.error_code || 'payment failed').slice(0, 300), updated_at: new Date().toISOString() } });
      }
      return { result: 'ok', error: null };
    }
    if (ev.event === 'refund.created' || ev.event === 'refund.processed' || ev.event === 'refund.failed') {
      const rf = p.refund?.entity;
      if (!rf) return { result: 'ignored', error: 'no refund in the event' };
      // money is booked only for a processed refund; a pending one waits for refund.processed, a failed one never books
      if (ev.event === 'refund.failed' || rf.status === 'failed') return { result: 'ignored', error: `refund ${rf.id} failed at the gateway; nothing booked` };
      const run = await runCommand('fees.recordGatewayRefund', [{ refund: rf }], system('gateway'));
      if (run.result.pending) return { result: 'pending', error: run.result.reason };
      if (run.result.skipped) return { result: 'ignored', error: run.result.skipped };
      // more recorded by hand than the gateway refunded: nothing booked, left as an error for the accountant
      if (run.result.mismatch) return { result: 'error', error: run.result.mismatch };
      return { result: 'ok', error: null };
    }
    return { result: 'ignored', error: null };
  } catch (e: any) {
    return { result: 'error', error: String(e?.message || e).slice(0, 500) };
  }
}

export async function settleEvent(row: any) {
  const r = await processEvent(row);
  await rest(`gateway_events?event_id=eq.${encodeURIComponent(row.event_id)}`, { method: 'PATCH',
    body: { result: r.result, error: r.error, attempts: (row.attempts || 0) + 1, processed_at: new Date().toISOString() } });
  return r;
}

async function retryPendingRefunds(rzpPaymentId: string) {
  const rows = await restAll(`gateway_events?result=eq.pending&event=like.refund.*&select=*&order=event_id`);
  for (const row of rows || []) {
    if (row.payload?.payload?.refund?.entity?.payment_id === rzpPaymentId) await settleEvent(row);
  }
}
