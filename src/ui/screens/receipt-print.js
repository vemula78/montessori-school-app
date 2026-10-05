// A5 printable receipt (browser "Save as PDF"). Demo, mock and test-mode receipts carry a stamp: the demo is public and
// uses the real school's name, so a printed demo receipt must never pass for a real one.
import { esc, money, fdate, fdatetime, empty, notFoundOrThrow, DASH } from '../components.js';
import { isRealMode } from '../mode.js';

const MODE = { cash: 'Cash', upi: 'UPI', cheque: 'Cheque', bank: 'Bank transfer', 'online-mock': 'Online (mock)', online: 'Online (Razorpay)', credit: 'Credit on account' };

export async function render(ctx) {
  const v = await ctx.api.fees.receiptView(ctx.params.id).catch(notFoundOrThrow);
  if (!v) { ctx.el.innerHTML = `${empty('Receipt not found')}<p><a class="btn" href="#/fees">Back to fees</a></p>`; return; }
  const cancelled = v.status === 'cancelled';
  ctx.el.innerHTML = `
    <div class="no-print row between" style="max-width:560px;margin:0 auto 12px">
      <button class="btn" id="r-back">&larr; Back</button>
      <button class="btn primary" id="r-print">Print / Save as PDF</button>
    </div>
    <article class="receipt" aria-label="Fee receipt ${esc(v.receiptNumber)}">
      ${v.isTestMode ? '<div class="stamp">TEST MODE &mdash; NO MONEY MOVED</div>' : ''}${!v.isTestMode && !isRealMode() ? '<div class="stamp">DEMO &mdash; NOT A REAL RECEIPT &middot; SAMPLE FEES</div>' : ''}${v.isMock ? '<div class="stamp">MOCK ONLINE PAYMENT &mdash; NO MONEY MOVED</div>' : ''}
      ${cancelled ? '<div class="cancelled-mark">CANCELLED</div>' : ''}
      <h1>${esc(v.school.name)}</h1>
      <div class="addr">${esc(v.school.address)}${v.school.phone ? ' &middot; ' + esc(v.school.phone) : ''}</div>
      <div class="title">FEE RECEIPT</div>
      <dl>
        <dt>Receipt no.</dt><dd>${esc(v.receiptNumber)}</dd>
        <dt>Date</dt><dd>${fdate(v.paidOn)}</dd>
        <dt>Child</dt><dd>${esc(v.student)}</dd>
        <dt>Programme</dt><dd>${esc(v.program)}</dd>
        <dt>Admission no.</dt><dd>${esc(v.admissionNo)}</dd>
        <dt>Received from</dt><dd>${esc(v.guardianName || DASH)}</dd>
        <dt>Mode</dt><dd>${esc(MODE[v.mode] || v.mode)}${v.reference ? ' - ' + esc(v.reference) : ''}</dd>
      </dl>
      <div class="tablewrap" style="border-radius:0"><table><thead><tr><th>Invoice</th><th>Instalment</th><th>Towards</th><th class="r">Amount</th></tr></thead><tbody>
        ${v.allocations.length ? v.allocations.map((a) => `<tr><td>${esc(a.invoiceNumber)}</td><td>${esc(a.installmentName)}</td><td>${esc(a.headName)}</td><td class="r num">${money(a.amountPaise)}</td></tr>`).join('') : `<tr><td colspan="4">${DASH} (not applied to an invoice)</td></tr>`}
        ${v.creditPaise ? `<tr><td colspan="3">Kept as credit on account</td><td class="r num">${money(v.creditPaise)}</td></tr>` : ''}
        </tbody><tfoot><tr><td colspan="3">Total received</td><td class="r num">${money(v.amountPaise)}</td></tr></tfoot></table></div>
      <div class="words">${esc(v.amountWords)}</div>
      ${cancelled ? `<p style="margin-top:8px"><strong>Cancelled.</strong> ${esc(v.cancelReason || '')}</p>` : ''}
      ${v.refunds?.length ? `<p style="margin-top:8px;font-size:.88rem">Refunds against this receipt: ${v.refunds.map((r) => `${esc(r.voucherNumber)} ${money(r.amountPaise)} (${fdate(r.date)})`).join('; ')}</p>` : ''}
      <div class="sign"><span>Recorded by ${esc(v.recordedBy)} &middot; ${fdatetime(v.recordedAt)}</span><span>Authorised signatory</span></div>
      ${isRealMode() && !v.isTestMode ? '' : `<p style="font-size:.72rem;color:var(--ink-soft);margin:10px 0 0">${v.isTestMode ? 'Test payment. Not a real receipt.' : 'Prototype with fake data and sample fees. Not a real receipt.'}</p>`}
    </article>`;
  ctx.el.querySelector('#r-print').addEventListener('click', () => window.print());
  ctx.el.querySelector('#r-back').addEventListener('click', () => (history.length > 1 ? history.back() : ctx.go('/fees')));
}
