// Student fee ledger: record payments (cash/UPI/cheque/bank), apply credit, cancel, refund. Staff write; parents read.
import { todayISO } from '../../domain/dates.js';
import { rupeesToPaise, formatPaise } from '../../domain/money.js';
import { esc, money, fdate, badge, empty, options, invoiceStatusBadge, formModal, confirmDialog, attempt, toast, fullName, notFoundOrThrow, DASH } from '../components.js';

const STAFF = ['admin', 'accountant'];
const MODES = [['cash', 'Cash'], ['upi', 'UPI'], ['cheque', 'Cheque'], ['bank', 'Bank transfer']];
const isOpen = (i) => i.status !== 'cancelled' && i.balancePaise > 0;

function flash(html) {
  const host = document.getElementById('fp-flash');
  if (host) host.innerHTML = html;
}

async function refundForm(ctx, pay, studentInvoices) {
  const db = ctx.db;
  const rows = pay.allocations.map((a) => {
    const already = db.refunds.filter((r) => r.paymentId === pay.id && r.invoiceId === a.invoiceId).reduce((s, r) => s + r.amountPaise, 0);
    const inv = studentInvoices.find((i) => i.id === a.invoiceId);
    return { invoiceId: a.invoiceId, number: inv?.number || a.invoiceId, left: a.amountPaise - already };
  }).filter((r) => r.left > 0);
  if (!rows.length) { toast('Nothing left to refund on this payment', 'bad'); return false; }
  return formModal({
    title: `Refund against ${pay.receiptNumber}`, submitLabel: 'Record refund',
    fieldsHtml: `${pay.mode === 'online' ? '<div class="banner warn"><strong>This was an online payment.</strong> Refund the money from the payment provider\'s dashboard: the refund is then recorded here automatically. Use this form only to record a refund that was already made, otherwise it will be counted twice.</div>' : ''}<label class="field"><span class="lbl">Invoice</span><select name="invoiceId">${options(rows.map((r) => ({ value: r.invoiceId, label: `${r.number} - up to ${formatPaise(r.left)}` })), rows[0].invoiceId)}</select></label>
      <label class="field"><span class="lbl">Amount (&#8377;)</span><input name="amount" inputmode="decimal" required></label>
      <div class="grid cols-2"><label class="field"><span class="lbl">Refund mode</span><select name="mode">${options((pay.mode === 'online' ? [...MODES, ['online', 'Online (payment provider)']] : MODES).map(([value, label]) => ({ value, label })), pay.mode === 'online' ? 'online' : 'cash')}</select></label>
      <label class="field"><span class="lbl">Date</span><input type="date" name="date" value="${esc(todayISO())}" max="${esc(todayISO())}" required></label></div>
      <label class="field"><span class="lbl">Reference (optional)</span><input name="reference"></label>
      <label class="field"><span class="lbl">Reason (required)</span><textarea name="reason" required></textarea></label>`,
    onSubmit: (v) => {
      const p = rupeesToPaise(v.amount);
      if (p === null || p <= 0) throw new Error('Enter a valid amount greater than zero');
      return ctx.api.fees.refund({ paymentId: pay.id, invoiceId: v.invoiceId, amountPaise: p, mode: v.mode, reference: v.reference || null, date: v.date, reason: v.reason.trim() });
    },
  });
}

export async function render(ctx) {
  const { api, persona, query } = ctx;
  const staff = STAFF.includes(persona.role);
  const student = await api.people.student(ctx.params.studentId).catch(notFoundOrThrow);
  if (!student) { ctx.el.innerHTML = `${empty('Child not found')}<p><a class="btn" href="#/fees">Back</a></p>`; return; }
  const db = ctx.db;
  const [invoices, payments] = await Promise.all([api.fees.invoices({ studentId: student.id }), api.fees.payments({ studentId: student.id })]);
  invoices.sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : a.number < b.number ? -1 : 1));
  payments.sort((a, b) => (a.recordedAt < b.recordedAt ? 1 : -1));
  const open = invoices.filter(isOpen);
  const outstanding = open.reduce((s, i) => s + i.balancePaise, 0);
  const payById = new Map(db.payments.map((p) => [p.id, p]));
  const credit = db.credits.filter((c) => c.studentId === student.id && !c.consumedByPaymentId && payById.get(c.sourcePaymentId)?.status === 'valid').reduce((s, c) => s + c.amountPaise, 0);
  const guardians = student.guardianIds.map((id) => db.guardians.find((g) => g.id === id)).filter(Boolean);
  const invNum = new Map(invoices.map((i) => [i.id, i.number]));
  const today = todayISO();
  const preInv = query.invoice;
  const studentRefunds = db.refunds.filter((r) => payById.get(r.paymentId)?.studentId === student.id);

  ctx.el.innerHTML = `<p><a href="#/fees">&larr; Fees</a></p>
    <div class="page-head"><div><h1>${esc(fullName(student))} ${student.status === 'left' ? badge('Left', 'mute') : ''}</h1><div class="sub">${esc(db.programs.find((p) => p.id === student.programId)?.name || DASH)} &middot; Adm. ${esc(student.admissionNo)} &middot; ${guardians.map((g) => esc(fullName(g))).join(', ') || DASH}</div></div></div>
    <div id="fp-flash"></div>
    <div class="grid cols-3" style="margin-bottom:14px">
      <div class="kpi ${outstanding ? 'bad' : 'good'}"><div class="v">${money(outstanding)}</div><div class="l">outstanding</div></div>
      <div class="kpi"><div class="v">${money(credit)}</div><div class="l">credit on account</div></div>
      <div class="kpi"><div class="v">${open.length}</div><div class="l">open invoices</div></div></div>
    <h2>Invoices</h2>
    ${invoices.length ? `<div class="tablewrap"><table><thead><tr><th>Invoice</th><th>Instalment</th><th>Due</th><th class="r">Total</th><th class="r">Paid</th><th class="r">Balance</th><th>Status</th></tr></thead><tbody>
      ${invoices.map((i) => `<tr class="${i.status === 'cancelled' ? 'row-mute' : ''}"><td><a href="#/fees/invoice/${esc(i.id)}">${esc(i.number)}</a></td><td>${esc(i.installmentName)}</td><td>${fdate(i.dueDate)}</td><td class="r num">${money(i.totalPaise)}</td><td class="r num">${money(i.paidPaise)}</td><td class="r num">${i.status === 'cancelled' ? DASH : money(i.balancePaise)}</td><td>${invoiceStatusBadge(i.status, i.overdueDays > 0 && isOpen(i))}</td></tr>`).join('')}
      </tbody></table></div>` : empty('No invoices for this child')}
    ${staff ? `
    <h2 style="margin-top:20px">Record payment</h2>
    ${open.length || true ? `<form id="fp-form" class="card stack" novalidate>
      <div class="grid cols-2">
        <label class="field"><span class="lbl">Amount received (&#8377;)</span><input name="amount" inputmode="decimal" required placeholder="e.g. 5,000.00"></label>
        <label class="field"><span class="lbl">Mode</span><select name="mode">${options(MODES.map(([value, label]) => ({ value, label })), 'cash')}</select></label>
        <label class="field"><span class="lbl">Paid on</span><input type="date" name="paidOn" value="${esc(today)}" max="${esc(today)}" required></label>
        <label class="field"><span class="lbl">Reference (cheque / UPI / txn no.)</span><input name="reference"></label>
        <label class="field"><span class="lbl">Received from</span><select name="guardianId">${options(guardians.map((g) => ({ value: g.id, label: `${fullName(g)} (${g.relation})` })), guardians[0]?.id, { blank: DASH })}</select></label></div>
      ${open.length ? `<fieldset style="border:1px solid var(--line);border-radius:12px;padding:10px 12px"><legend style="font-weight:800;font-size:.82rem">Apply to (optional)</legend>
        <small>Leave blank to allocate automatically to the oldest due invoice first. Or enter amounts to choose.</small>
        ${open.map((i) => `<label class="row between" style="margin-top:6px"><span>${esc(i.number)} ${esc(i.installmentName)} <small>balance ${money(i.balancePaise)}</small></span><input data-alloc="${esc(i.id)}" data-bal="${i.balancePaise}" inputmode="decimal" style="width:130px" placeholder="auto" value="${i.id === preInv ? esc(formatPaise(i.balancePaise, { symbol: false }).replace(/,/g, '')) : ''}" aria-label="Amount to apply to ${esc(i.number)}"></label>`).join('')}</fieldset>` : '<div class="banner">No open invoices. Any amount recorded now becomes credit.</div>'}
      <label class="check"><input type="checkbox" name="allowCredit" checked> Keep any excess as credit (otherwise an overpayment is refused)</label>
      <div class="row"><button class="btn primary" type="submit">Record payment</button>
        ${credit > 0 && open.length ? `<button class="btn" type="button" id="fp-credit">Apply credit ${money(credit)}</button>` : ''}</div>
    </form>` : ''}` : ''}
    <h2 style="margin-top:20px">Payments</h2>
    ${payments.length ? `<div class="tablewrap"><table><thead><tr><th>Receipt</th><th>Date</th><th>Mode</th><th class="r">Amount</th><th>Applied to</th><th>Status</th><th></th></tr></thead><tbody>
      ${payments.map((p) => `<tr class="${p.status === 'cancelled' ? 'row-mute' : ''}"><td class="nowrap"><a href="#/print/receipt/${esc(p.id)}">${esc(p.receiptNumber)}</a></td><td class="nowrap">${fdate(p.paidOn)}</td><td>${esc(p.mode)}${p.mode === 'online-mock' ? ' ' + badge('MOCK', 'warn') : ''}${p.mode === 'online' && p.gatewayMode === 'test' ? ' ' + badge('TEST', 'warn') : ''}</td>
        <td class="r num">${money(p.amountPaise)}</td><td><small>${p.allocations.map((a) => esc(invNum.get(a.invoiceId) || a.invoiceId) + ' ' + money(a.amountPaise)).join('<br>') || DASH}${p.creditPaise ? `<br>credit ${money(p.creditPaise)}` : ''}</small></td>
        <td>${p.status === 'valid' ? badge('Valid', 'ok') : badge('Cancelled', 'mute')}${p.status === 'cancelled' && p.cancelReason ? `<br><small>${esc(p.cancelReason)}</small>` : ''}</td>
        <td class="nowrap"><a class="btn sm" href="#/print/receipt/${esc(p.id)}">Receipt</a>${staff && p.status === 'valid' ? ` <button class="btn sm" data-refund="${esc(p.id)}">Refund</button> ${p.gatewayPaymentId || p.mode === 'online' ? '<br><small class="muted">Online payment: it cannot be cancelled, only refunded (from the payment provider).</small>' : `<button class="btn sm ghost" data-cancel="${esc(p.id)}">Cancel</button>`}` : ''}</td></tr>`).join('')}
      </tbody></table></div>` : empty('No payments recorded')}
    ${studentRefunds.length ? `<h2 style="margin-top:20px">Refunds</h2><div class="tablewrap"><table><thead><tr><th>Voucher</th><th>Date</th><th>Receipt</th><th>Invoice</th><th class="r">Amount</th><th>Reason</th></tr></thead><tbody>
      ${studentRefunds.map((r) => `<tr><td>${esc(r.voucherNumber)}</td><td>${fdate(r.date)}</td><td>${esc(payById.get(r.paymentId)?.receiptNumber || DASH)}</td><td>${esc(invNum.get(r.invoiceId) || DASH)}</td><td class="r num">${money(r.amountPaise)}</td><td>${esc(r.reason)}</td></tr>`).join('')}</tbody></table></div>` : ''}`;

  // ---- actions
  ctx.el.querySelector('#fp-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const amount = rupeesToPaise(f.amount.value);
    if (amount === null || amount <= 0) { toast('Enter a valid amount greater than zero', 'bad'); return; }
    const allocations = [];
    for (const inp of f.querySelectorAll('[data-alloc]')) {
      if (!inp.value.trim()) continue;
      const a = rupeesToPaise(inp.value);
      if (a === null || a <= 0) { toast('An "Apply to" amount is not valid', 'bad'); return; }
      allocations.push({ invoiceId: inp.dataset.alloc, amountPaise: a });
    }
    const res = await attempt(() => api.fees.recordPayment({
      studentId: student.id, amountPaise: amount, mode: f.mode.value, reference: f.reference.value.trim() || null, paidOn: f.paidOn.value,
      allocations: allocations.length ? allocations : undefined, allowCredit: f.allowCredit.checked, guardianId: f.guardianId.value || null,
    }));
    if (res.ok) {
      const pay = res.value;
      await ctx.rerender();
      flash(`<div class="banner ok"><div class="row between"><span><strong>Recorded ${esc(pay.receiptNumber)}</strong> - ${money(pay.amountPaise)}${pay.creditPaise ? `, of which ${money(pay.creditPaise)} kept as credit` : ''}.</span><a class="btn sm" href="#/print/receipt/${esc(pay.id)}">View / print receipt</a></div></div>`);
    }
  });
  ctx.el.querySelector('#fp-credit')?.addEventListener('click', async () => {
    if (!(await confirmDialog('Apply credit', `Apply the full credit of ${money(credit)} to the oldest open invoice(s)?`, { okLabel: 'Apply credit' }))) return;
    // allowCredit stays true: when credit exceeds the debt, the remainder is kept as credit instead of being refused
    const res = await attempt(() => api.fees.recordPayment({ studentId: student.id, amountPaise: credit, mode: 'credit', paidOn: today, allowCredit: true }));
    if (res.ok) { const pay = res.value; await ctx.rerender(); flash(`<div class="banner ok"><strong>Applied credit as ${esc(pay.receiptNumber)}.</strong></div>`); }
  });
  ctx.el.addEventListener('click', async (e) => {
    const c = e.target.closest('[data-cancel]');
    const r = e.target.closest('[data-refund]');
    if (c) {
      const pay = payments.find((p) => p.id === c.dataset.cancel);
      const ok = await formModal({ title: `Cancel ${pay.receiptNumber}`, submitLabel: 'Cancel payment', fieldsHtml: `<p>The receipt number is kept and shown as cancelled. The invoice balance is restored.</p><label class="field"><span class="lbl">Reason (required, audit-logged)</span><textarea name="reason" required></textarea></label>`, onSubmit: (v) => api.fees.cancelPayment(pay.id, v.reason) });
      if (ok) { await ctx.rerender(); flash(`<div class="banner ok"><strong>${esc(pay.receiptNumber)} cancelled</strong> - the number is retained, balances restored.</div>`); }
    } else if (r) {
      const pay = payments.find((p) => p.id === r.dataset.refund);
      if (await refundForm(ctx, pay, invoices)) ctx.rerender();
    }
  });
}
