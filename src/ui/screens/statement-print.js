// Printable fee statement for one child and one academic year (browser "Save as PDF"): what parents ask the office
// for at tax-declaration time. Same stamps as receipts: a demo statement must never pass for a real one.
import { esc, money, fdate, empty, notFoundOrThrow, options, DASH, PAYMENT_MODE_LABEL } from '../components.js';
import { todayISO } from '../../domain/dates.js';
import { isRealMode } from '../mode.js';

export async function render(ctx) {
  const { api, query, params } = ctx;
  const years = await api.calendar.academicYears();
  const ayId = years.some((y) => y.id === query.ay) ? query.ay : ctx.db.school.currentAcademicYearId;
  const v = await api.fees.statement(params.studentId, ayId).catch(notFoundOrThrow);
  if (!v) { ctx.el.innerHTML = `${empty('Statement not found')}<p><a class="btn" href="#/fees">Back to fees</a></p>`; return; }
  const demo = !isRealMode();
  ctx.el.innerHTML = `
    <div class="no-print row between" style="max-width:720px;margin:0 auto 12px">
      <button class="btn" id="s-back">&larr; Back</button>
      <select id="s-ay" style="width:auto" aria-label="Academic year">${options(years.map((y) => ({ value: y.id, label: y.label || y.id })), ayId)}</select>
      <button class="btn primary" id="s-print">Print / Save as PDF</button>
    </div>
    <article class="receipt" style="max-width:720px" aria-label="Fee statement ${esc(v.academicYear.label)}">
      ${demo ? '<div class="stamp">DEMO &mdash; NOT A REAL STATEMENT &middot; SAMPLE FEES</div>' : ''}
      <h1>${esc(v.school.name)}</h1>
      <div class="addr">${esc(v.school.address)}${v.school.phone ? ' &middot; ' + esc(v.school.phone) : ''}</div>
      <div class="title">FEE STATEMENT &middot; ${esc(v.academicYear.label)}</div>
      <dl>
        <dt>Child</dt><dd>${esc(v.student)}</dd>
        <dt>Programme</dt><dd>${esc(v.program)}</dd>
        <dt>Admission no.</dt><dd>${esc(v.admissionNo)}</dd>
        <dt>Parents</dt><dd>${esc(v.guardians.join(', ') || DASH)}</dd>
        <dt>Period</dt><dd>${fdate(v.academicYear.startDate)} to ${fdate(v.academicYear.endDate)}</dd>
      </dl>
      <h2 style="font-size:1rem;margin:14px 0 6px">Fees received</h2>
      <div class="tablewrap" style="border-radius:0"><table><thead><tr><th>Receipt</th><th>Date</th><th>Mode</th><th class="r">Amount</th></tr></thead><tbody>
        ${v.receipts.length ? v.receipts.map((r) => `<tr><td>${esc(r.receiptNumber)}</td><td class="nowrap">${fdate(r.paidOn)}</td><td>${esc(PAYMENT_MODE_LABEL[r.mode] || r.mode)}${r.reference ? ` - ${esc(r.reference)}` : ''}</td><td class="r num">${money(r.amountPaise)}</td></tr>`).join('') : `<tr><td colspan="4">${DASH} (no receipt in this year)</td></tr>`}
        ${v.refunds.map((r) => `<tr><td>${esc(r.voucherNumber)} (refund)</td><td class="nowrap">${fdate(r.date)}</td><td></td><td class="r num">&minus;${money(r.amountPaise)}</td></tr>`).join('')}
        </tbody><tfoot><tr><td colspan="3">Net fees paid in the year</td><td class="r num">${money(v.netPaise)}</td></tr></tfoot></table></div>
      <div class="words">${esc(v.netWords)}</div>
      ${v.appliedPaise ? `<h2 style="font-size:1rem;margin:14px 0 6px">Paid towards</h2>
      <div class="tablewrap" style="border-radius:0"><table><tbody>
        ${v.byKind.map((k) => `<tr><td>${k.kind === 'tuition' ? '<strong>Tuition fees</strong>' : esc(k.label)}</td><td class="r num">${k.kind === 'tuition' ? `<strong>${money(k.amountPaise)}</strong>` : money(k.amountPaise)}</td></tr>`).join('')}
        ${v.concessionPaise ? `<tr><td>Less concessions on these invoices</td><td class="r num">&minus;${money(v.concessionPaise)}</td></tr>` : ''}
        ${v.partPaidPaise ? `<tr><td>Part payments of invoices not yet paid in full (not split by fee head)</td><td class="r num">${money(v.partPaidPaise)}</td></tr>` : ''}
        </tbody><tfoot><tr><td>Applied to invoices</td><td class="r num">${money(v.appliedPaise)}</td></tr></tfoot></table></div>
      ${v.appliedPaise !== v.netPaise ? '<p style="font-size:.82rem;margin:6px 0 0">The amount applied differs from the net paid by money kept as credit on account, or by credit from an earlier year applied in this one.</p>' : ''}
      <p style="font-size:.82rem;margin:6px 0 0">Fee heads are shown for invoices paid in full in this year. Concessions are shown as a whole; ask the office if a concession must be shown against one fee head.</p>` : ''}
      <div class="sign"><span>Issued ${fdate(todayISO())}</span><span>Authorised signatory</span></div>
      ${demo ? '<p style="font-size:.72rem;color:var(--ink-soft);margin:10px 0 0">Prototype with fake data and sample fees. Not a real statement.</p>' : ''}
    </article>`;
  ctx.el.querySelector('#s-print').addEventListener('click', () => window.print());
  ctx.el.querySelector('#s-ay').addEventListener('change', (e) => ctx.setQuery({ ay: e.target.value }));
  ctx.el.querySelector('#s-back').addEventListener('click', () => (history.length > 1 ? history.back() : ctx.go(`/fees/student/${params.studentId}`)));
}
