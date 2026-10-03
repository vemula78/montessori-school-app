#!/usr/bin/env node
// End-to-end money check against the LOCAL stack (fake data only). Prerequisites:
//   supabase start && supabase db reset
//   node scripts/mock-razorpay.mjs --write-env      (once: invents local test secrets in supabase/.env.local)
//   supabase functions serve --env-file supabase/.env.local
// This script starts the mock gateway itself, then runs through the Edge Functions:
//   cash, partial, overpayment (credit), cancellation, refund, gateway capture (checkout + verify),
//   a gateway-dashboard refund (webhook), and 10 simultaneous payments (deferred #1: contiguous numbers).
// Then: the accountant's RLS snapshot → Phase 1 reconcile() → all five checks must pass; and a SECOND PATH in
// SQL over payments.doc / invoices.doc / refunds.doc / credits.doc must equal the JS totals. Counts are printed.
// Finally prints two unredeemed invite codes for the browser smoke test. Exit 1 on any mismatch.

import { reconcile } from '../src/domain/reconcile.js';
import { invoiceBalance } from '../src/domain/fees.js';
import { startMock } from './mock-razorpay.mjs';
import { signIn, command, fn, rpcAs, http, psql, MOCK } from '../tests-supabase/helpers.mjs';
import { signWebhook } from '../supabase/functions/_shared/razorpay.js';
import { local } from '../tests-supabase/helpers.mjs';

const problems = [];
const check = (ok, what) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) problems.push(what); };
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.data)}`); return r.data.result ?? r.data; };
const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10); // IST

const mock = await startMock();
try {
  const [acct, admin, parent] = await Promise.all(['accountant@example.com', 'principal@example.com', 'parent-bus@example.com'].map(signIn));
  const snap = async (who = acct) => (await rpcAs(who.token, 'my_snapshot')).data;
  for (const [programId, installmentName] of [['prog-primary-a', 'Term 2'], ['prog-primary-a', 'Term 3'], ['prog-primary-b', 'Term 3'], ['prog-toddler', 'Term 3']]) {
    must(await command(acct.token, 'fees.generateInvoices', { academicYearId: 'AY2026-27', programId, installmentName }), 'generateInvoices');
  }
  let db = await snap();
  const open = db.invoices.filter(i => i.status !== 'cancelled' && invoiceBalance(db, i) >= 200000 && !['stu-03', 'stu-04'].includes(i.studentId));
  const byStudent = new Map();
  for (const i of open) if (!byStudent.has(i.studentId)) byStudent.set(i.studentId, i);
  const [invA, invB, invC] = [...byStudent.values()];
  console.log('Money scenarios (through the command / pay-* / rzp-webhook functions)');
  const cash = must(await command(acct.token, 'fees.recordPayment', { studentId: invA.studentId, amountPaise: invoiceBalance(db, invA), mode: 'cash', paidOn: today }), 'cash');
  check(cash.allocations.length === 1 && cash.creditPaise === 0, `cash full payment ${cash.receiptNumber}`);
  const part = must(await command(acct.token, 'fees.recordPayment', { studentId: invB.studentId, amountPaise: 100000, mode: 'upi', reference: 'UPI-E2E-1', paidOn: today }), 'partial');
  check(part.amountPaise === 100000, `partial payment ${part.receiptNumber}`);
  const over = must(await command(acct.token, 'fees.recordPayment', { studentId: invC.studentId, amountPaise: invoiceBalance(db, invC) + 50000, mode: 'bank', reference: 'NEFT-E2E-1', paidOn: today, allocations: [{ invoiceId: invC.id, amountPaise: invoiceBalance(db, invC) }] }), 'overpay');
  check(over.creditPaise === 50000, `overpayment → ₹500 credit on ${over.receiptNumber}`);
  const cancelled = must(await command(acct.token, 'fees.cancelPayment', part.id, 'E2E: cheque bounced (fake)'), 'cancel');
  check(cancelled.status === 'cancelled' && cancelled.receiptNumber === part.receiptNumber, `cancellation keeps the number ${cancelled.receiptNumber}`);
  const rf = must(await command(acct.token, 'fees.refund', { paymentId: cash.id, invoiceId: invA.id, amountPaise: 20000, mode: 'cash', date: today, reason: 'E2E partial refund (fake)' }), 'refund');
  check(rf.amountPaise === 20000, `refund ${rf.voucherNumber}`);

  // gateway capture by a parent: order → mock checkout → verify
  const pdb = await snap(parent);
  const pinv = pdb.invoices.find(i => i.status !== 'cancelled' && invoiceBalance(pdb, i) > 0);
  const order = must(await fn('pay-create-order', { studentId: pinv.studentId, invoiceIds: [pinv.id] }, parent.token), 'pay-create-order');
  const paid = (await http('POST', `${MOCK}/__mock/pay`, { body: { orderId: order.orderId } })).data;
  const gpay = must(await fn('pay-verify', { orderId: order.orderId, razorpayPaymentId: paid.payment.id, razorpaySignature: paid.signature }, parent.token), 'pay-verify');
  check(gpay.mode === 'online' && gpay.gatewayMode === 'test', `gateway capture recorded as ${gpay.receiptNumber} (TEST MODE)`);
  // a refund made on the gateway dashboard arrives by webhook
  const drf = (await http('POST', `${MOCK}/__mock/refund`, { body: { paymentId: paid.payment.id, amount: 30000 } })).data;
  const body = JSON.stringify({ entity: 'event', event: 'refund.processed', payload: { refund: { entity: drf } }, created_at: Math.floor(Date.now() / 1000) });
  const res = await fetch(`${local().fns}/rzp-webhook`, { method: 'POST', body, headers: { 'Content-Type': 'application/json', 'x-razorpay-event-id': `evt_e2e_${drf.id}`, 'x-razorpay-signature': await signWebhook(new TextEncoder().encode(body), local().env.RAZORPAY_WEBHOOK_SECRET) } });
  const wh = await res.json();
  check(res.status === 200 && wh.result === 'ok', `dashboard refund via webhook (${wh.result})`);

  // deferred #1: simultaneous payments get distinct, contiguous numbers
  const par = await Promise.all(Array.from({ length: 10 }, () => command(acct.token, 'fees.recordPayment', { studentId: invC.studentId, amountPaise: 100, mode: 'cash', paidOn: today })));
  const nums = par.filter(r => r.status === 200).map(r => Number(r.data.result.receiptNumber.split('/')[2])).sort((a, b) => a - b);
  check(nums.length === 10 && new Set(nums).size === 10 && nums[9] - nums[0] === 9, `10 simultaneous payments → receipts ${nums[0]}..${nums[9]}, distinct and contiguous`);

  // ---------------------------------------------------------------- reconciliation: JS path
  db = await snap();
  const rec = reconcile(db, { asOfDate: today });
  console.log('\nPhase 1 reconcile() over the accountant snapshot');
  for (const c of rec.checks) check(c.ok, `${c.name} (expected ${c.expected}, actual ${c.actual}, mismatches ${c.mismatches.length})`);
  // ---------------------------------------------------------------- second path: SQL over the stored docs
  const n = q => Number(psql(q) || 0);
  const sqlPath = {
    invoiced: n(`select coalesce(sum((l->>'amountPaise')::bigint),0) from invoices i, jsonb_array_elements(i.doc->'lines') l where i.status <> 'cancelled'`),
    concessions: n(`select coalesce(sum((c->>'amountPaise')::bigint),0) from invoices i, jsonb_array_elements(i.doc->'concessions') c where i.status <> 'cancelled'`),
    paid: n(`select coalesce(sum((a->>'amountPaise')::bigint),0) from payments p, jsonb_array_elements(p.doc->'allocations') a where p.status = 'valid'`),
    refunded: n(`select coalesce(sum((doc->>'amountPaise')::bigint),0) from refunds where doc->>'invoiceId' is not null`),
    creditRefunded: n(`select coalesce(sum((doc->>'amountPaise')::bigint),0) from refunds where doc->>'invoiceId' is null`),
    receivedValid: n(`select coalesce(sum((doc->>'amountPaise')::bigint),0) from payments where status = 'valid'`),
    credit: n(`select coalesce(sum((c.doc->>'amountPaise')::bigint),0) from credits c join payments p on p.id = c.doc->>'sourcePaymentId'
               where p.status = 'valid' and c.doc->>'consumedByPaymentId' is null and c.doc->>'consumedByRefundId' is null`),
  };
  sqlPath.outstanding = sqlPath.invoiced - sqlPath.concessions - sqlPath.paid + sqlPath.refunded;
  console.log('\nSecond path: SQL sums over the stored docs = JS totals');
  for (const k of Object.keys(sqlPath)) check(sqlPath[k] === rec.school[k], `${k}: SQL ${sqlPath[k]} = JS ${rec.school[k]}`);
  const gaps = n(`select count(*) from (select substring(receipt_number from '\\d+$')::int k from payments where receipt_number like 'RCP/26-27/%') x
    where k > 1 and not exists (select 1 from payments p where p.receipt_number = 'RCP/26-27/' || lpad((x.k - 1)::text, 4, '0'))`);
  const counter = n(`select n from counters where kind = 'receipt' and academic_year_id = 'AY2026-27'`);
  const maxNo = n(`select max(substring(receipt_number from '\\d+$')::int) from payments where receipt_number like 'RCP/26-27/%'`);
  check(gaps === 0 && counter === maxNo, `receipt numbers 1..${maxNo} have no gap; counter ${counter} = highest`);
  console.log(`\nCounts: students ${db.students.length}, invoices ${db.invoices.length}, payments ${db.payments.length} (valid ${db.payments.filter(p => p.status === 'valid').length}), refunds ${db.refunds.length}, credits ${db.credits.length}`);

  // ---------------------------------------------------------------- invite codes for the browser smoke test
  console.log('\nUnredeemed invite codes (local, fake families) — sign in at /app/ with any @example.com email, then redeem:');
  for (const gid of ['grd-03', 'grd-04']) {
    const inv = must(await command(admin.token, 'admin.inviteCode', gid), 'inviteCode');
    const kid = db.students.find(s => s.guardianIds.includes(gid));
    console.log(`  ${inv.code}  guardian ${gid}, expires ${inv.expiresAt.slice(0, 10)}; child DOB to enter: ${kid ? kid.dob : '(see students)'}`);
  }
} catch (e) {
  problems.push(e.message);
  console.error(`\nERROR: ${e.message}`);
} finally {
  await mock.close();
}
console.log(problems.length ? `\nFAIL — ${problems.length} problem(s)` : '\nPASS — every scenario recorded, reconciled on both paths');
process.exit(problems.length ? 1 : 0);
