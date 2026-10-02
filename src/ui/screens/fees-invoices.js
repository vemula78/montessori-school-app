// Invoices: staff list + detail (concessions, late fee, cancel); parent view with mock online payment.
import { todayISO } from '../../domain/dates.js';
import { rupeesToPaise } from '../../domain/money.js';
import { esc, money, fdate, badge, empty, pageHead, options, invoiceStatusBadge, formModal, confirmDialog, attempt, toast, fullName, notFoundOrThrow, DASH } from '../components.js';

const STAFF = ['admin', 'accountant'];
const isOpen = (i) => i.status !== 'cancelled' && i.status !== 'paid' && i.balancePaise > 0;

// ---------------- staff list ----------------
async function staffList(ctx) {
  const { api, db, query } = ctx;
  const ayId = db.school.currentAcademicYearId;
  const programId = query.program || '';
  const filter = query.status || 'all';
  const text = (query.q || '').toLowerCase();
  const all = await api.fees.invoices({ academicYearId: ayId, programId: programId || undefined });
  const rows = all.filter((i) => {
    if (text && !i.studentName.toLowerCase().includes(text) && !i.number.toLowerCase().includes(text)) return false;
    if (filter === 'open') return isOpen(i);
    if (filter === 'overdue') return isOpen(i) && i.overdueDays > 0;
    if (filter === 'paid') return i.status === 'paid';
    if (filter === 'cancelled') return i.status === 'cancelled';
    return true;
  }).sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : a.number < b.number ? -1 : 1));
  const live = all.filter((i) => i.status !== 'cancelled');
  const sum = (arr, k) => arr.reduce((s, i) => s + i[k], 0);
  const students = db.students.filter((s) => s.status === 'active');

  ctx.el.innerHTML = `${pageHead('Fees', 'Invoices for the current academic year', `<a class="btn" href="#/fees/structures">Fee structures</a>`)}
    <div class="grid cols-3" style="margin-bottom:14px">
      <div class="kpi"><div class="v">${money(sum(live, 'totalPaise'))}</div><div class="l">invoiced (after concessions)</div></div>
      <div class="kpi good"><div class="v">${money(sum(live, 'paidPaise'))}</div><div class="l">collected (net of refunds)</div></div>
      <div class="kpi ${sum(live, 'balancePaise') ? 'bad' : ''}"><div class="v">${money(sum(live, 'balancePaise'))}</div><div class="l">outstanding</div></div>
    </div>
    <div class="card" style="margin-bottom:14px"><div class="inline-form">
      <label class="field"><span class="lbl">Record a payment for</span><select id="fi-student" style="min-width:220px">${options(students.map((s) => ({ value: s.id, label: fullName(s) })), '', { blank: 'Choose a child' })}</select></label>
      <button class="btn primary" id="fi-open">Open ledger</button></div></div>
    <div class="row" style="margin-bottom:10px">
      <input id="fi-q" type="search" placeholder="Search child or invoice no." value="${esc(query.q || '')}" style="width:auto;min-width:200px" aria-label="Search">
      <select id="fi-prog" style="width:auto" aria-label="Programme">${options(db.programs.map((p) => ({ value: p.id, label: p.name })), programId, { blank: 'All programmes' })}</select>
      <div class="seg">${[['all', 'All'], ['open', 'Open'], ['overdue', 'Overdue'], ['paid', 'Paid'], ['cancelled', 'Cancelled']].map(([v, l]) => `<button data-status="${v}" aria-pressed="${filter === v}">${l}</button>`).join('')}</div>
    </div>
    ${rows.length ? `<div class="tablewrap"><table><thead><tr><th>Invoice</th><th>Child</th><th>Instalment</th><th>Due</th><th class="r">Total</th><th class="r">Paid</th><th class="r">Balance</th><th>Status</th></tr></thead><tbody>
      ${rows.map((i) => `<tr class="${i.status === 'cancelled' ? 'row-mute' : ''}"><td class="nowrap"><a href="#/fees/invoice/${esc(i.id)}">${esc(i.number)}</a></td>
        <td><a href="#/fees/student/${esc(i.studentId)}">${esc(i.studentName)}</a><br><small>${esc(i.programName)}</small></td><td>${esc(i.installmentName)}</td><td class="nowrap">${fdate(i.dueDate)}</td>
        <td class="r num">${money(i.totalPaise)}</td><td class="r num">${money(i.paidPaise)}</td><td class="r num">${i.status === 'cancelled' ? DASH : money(i.balancePaise)}</td>
        <td>${invoiceStatusBadge(i.status, i.overdueDays > 0 && isOpen(i))}${i.overdueDays > 0 && isOpen(i) ? `<br><small>${i.overdueDays} days late</small>` : ''}${i.lateFeeDuePaise > 0 ? `<br><small>late fee due ${money(i.lateFeeDuePaise)}</small>` : ''}</td></tr>`).join('')}
      </tbody></table></div>` : empty(all.length ? 'No invoices match these filters' : 'No invoices yet', all.length ? '' : 'Generate them from Fee structures.')}`;

  const q = (patch) => ctx.setQuery(patch);
  ctx.el.querySelector('#fi-q').addEventListener('change', (e) => q({ q: e.target.value }));
  ctx.el.querySelector('#fi-prog').addEventListener('change', (e) => q({ program: e.target.value }));
  ctx.el.querySelectorAll('[data-status]').forEach((b) => b.addEventListener('click', () => q({ status: b.dataset.status })));
  ctx.el.querySelector('#fi-open').addEventListener('click', () => {
    const v = ctx.el.querySelector('#fi-student').value;
    if (v) ctx.go(`/fees/student/${v}`); else toast('Choose a child first', 'bad');
  });
}

// ---------------- parent ----------------
async function mockPay(ctx, student, invoices) {
  const total = invoices.reduce((s, i) => s + i.balancePaise, 0);
  const ok = await confirmDialog('Mock online payment', `This is a demonstration. Paying ${money(total)} for ${student.firstName} (${invoices.map((i) => i.number).join(', ')}) will produce a receipt stamped "MOCK ONLINE PAYMENT \u2014 NO MONEY MOVED". No card or bank details are collected.`, { okLabel: `Pay ${money(total)} (mock)` });
  if (!ok) return;
  const res = await attempt(() => ctx.api.fees.mockOnlinePayment({ studentId: student.id, invoiceIds: invoices.map((i) => i.id) }), 'Mock payment recorded');
  if (res.ok) ctx.go(`/print/receipt/${res.value.id}`);
}

async function parentList(ctx) {
  const { api, persona } = ctx;
  const kids = await api.people.childrenOf(persona.guardianId);
  const blocks = [];
  const store = new Map();
  for (const k of kids) {
    if (k.status !== 'active') {
      blocks.push(`<div class="card"><div class="row between"><h3 style="margin:0">${esc(fullName(k))}</h3>${badge('Left', 'mute')}</div><small>This child has left the school; fee records are held by the school office.</small></div>`);
      continue;
    }
    const inv = (await api.fees.invoices({ studentId: k.id })).filter((i) => i.status !== 'cancelled').sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1));
    store.set(k.id, inv);
    const open = inv.filter(isOpen);
    const bal = open.reduce((s, i) => s + i.balancePaise, 0);
    blocks.push(`<div class="card stack"><div class="row between"><h3 style="margin:0">${esc(fullName(k))}</h3><div class="row">${bal ? badge(`Due ${money(bal)}`, 'bad') : badge('All paid', 'ok')}<a class="btn sm" href="#/fees/student/${esc(k.id)}">Payments &amp; receipts</a></div></div>
      ${inv.length ? `<ul class="list">${inv.map((i) => `<li><div class="row between"><div><a href="#/fees/invoice/${esc(i.id)}" class="item-title">${esc(i.installmentName)}</a> <small>${esc(i.number)} &middot; due ${fdate(i.dueDate)}</small></div>
        <div class="row"><span class="num">${isOpen(i) ? money(i.balancePaise) : money(i.totalPaise)}</span>${invoiceStatusBadge(i.status, i.overdueDays > 0 && isOpen(i))}</div></div></li>`).join('')}</ul>` : empty('No invoices yet')}
      ${open.length ? `<button class="btn primary" data-pay="${esc(k.id)}">Pay ${money(bal)} online (mock)</button>` : ''}</div>`);
  }
  ctx.el.innerHTML = `${pageHead('Fees')}<div class="stack">${blocks.join('') || empty('No children linked to this account')}</div>
    <p class="muted" style="font-size:.82rem;margin-top:12px">Online payment here is a mock for the prototype - no real payment is taken.</p>`;
  ctx.el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-pay]');
    if (!b) return;
    const kid = kids.find((k) => k.id === b.dataset.pay);
    await mockPay(ctx, kid, store.get(kid.id).filter(isOpen));
  });
}

// ---------------- detail ----------------
async function detail(ctx) {
  const { api, db, persona } = ctx;
  const staff = STAFF.includes(persona.role);
  const inv = await api.fees.invoice(ctx.params.id).catch(notFoundOrThrow);
  if (!inv) { ctx.el.innerHTML = `${empty('Invoice not found')}<p><a class="btn" href="#/fees">Back</a></p>`; return; }
  const today = todayISO();
  const hasLate = inv.lines.some((l) => l.kind === 'lateFee');
  let lf = null;
  if (staff && inv.status !== 'cancelled') { try { lf = await api.fees.lateFeeDue(inv.id, today); } catch { lf = null; } }
  const pays = (await api.fees.payments({ studentId: inv.studentId })).filter((p) => p.allocations.some((a) => a.invoiceId === inv.id));
  const refunds = db.refunds.filter((r) => r.invoiceId === inv.id);
  const open = isOpen(inv);

  ctx.el.innerHTML = `<p><a href="${staff ? '#/fees' : '#/fees'}">&larr; Fees</a></p>
    <div class="page-head"><div><h1>${esc(inv.number)}</h1><div class="sub">${esc(inv.studentName)} &middot; ${esc(inv.programName)} &middot; ${esc(inv.installmentName)}</div></div>${invoiceStatusBadge(inv.status, inv.overdueDays > 0 && open)}</div>
    <div class="grid cols-4" style="margin-bottom:14px">
      <div class="kpi"><div class="v">${money(inv.totalPaise)}</div><div class="l">total</div></div>
      <div class="kpi good"><div class="v">${money(inv.paidPaise)}</div><div class="l">paid</div></div>
      <div class="kpi ${inv.balancePaise ? 'bad' : ''}"><div class="v">${inv.status === 'cancelled' ? DASH : money(inv.balancePaise)}</div><div class="l">balance</div></div>
      <div class="kpi"><div class="v" style="font-size:1.1rem">${fdate(inv.dueDate)}</div><div class="l">due${inv.effectiveDueDate !== inv.dueDate ? ` (effective ${fdate(inv.effectiveDueDate)})` : ''}</div></div></div>
    ${inv.status === 'cancelled' ? `<div class="banner">Cancelled: ${esc(inv.cancelReason || DASH)}</div>` : ''}
    ${inv.locked && staff ? '<div class="banner">Payments exist, so lines and concessions are locked. To correct: refund or cancel the payment, cancel the invoice, then reissue.</div>' : ''}
    <div class="tablewrap"><table><thead><tr><th>Line</th><th class="r">Amount</th></tr></thead><tbody>
      ${inv.lines.map((l) => `<tr><td>${esc(l.description)}${l.kind === 'lateFee' ? ' ' + badge('late fee', 'bad') : ''}</td><td class="r num">${money(l.amountPaise)}</td></tr>`).join('')}
      ${inv.concessions.map((c) => `<tr><td>${esc(c.description)} ${badge(c.type, 'info')}${staff && !inv.locked && inv.status !== 'cancelled' ? ` <button class="btn sm ghost" data-rmcon="${esc(c.id)}">Remove</button>` : ''}</td><td class="r num">&minus;${money(c.amountPaise)}</td></tr>`).join('')}
      </tbody><tfoot><tr><td>Total</td><td class="r num">${money(inv.totalPaise)}</td></tr></tfoot></table></div>
    ${staff && inv.status !== 'cancelled' ? `
      <div class="card stack" style="margin-top:14px"><h3 style="margin:0">Late fee</h3>
        ${lf ? (lf.amountPaise == null ? `<div class="muted">${esc(lf.reason || 'No late-fee rule configured.')}</div>`
          : lf.amountPaise > 0 ? `<div><strong>Late fee due ${money(lf.amountPaise)}</strong> <small>(${lf.days} day${lf.days === 1 ? '' : 's'} past the grace period; effective due date ${fdate(lf.effectiveDueDate)})</small></div>`
          : `<div class="muted">No late fee due as of ${fdate(today)}${lf.alreadyAppliedPaise ? ` (${money(lf.alreadyAppliedPaise)} already applied)` : ''}.</div>`) : ''}
        <div class="row">${lf && lf.amountPaise > 0 ? `<button class="btn primary sm" id="fi-apply">Apply late fee ${money(lf.amountPaise)}</button>` : ''}${hasLate ? '<button class="btn sm" id="fi-waive">Waive late fee</button>' : ''}</div>
        <small>Late fees are never added automatically; applying one adds a line and an audit entry.</small></div>
      <div class="row" style="margin-top:14px">
        ${open ? `<a class="btn primary" href="#/fees/student/${esc(inv.studentId)}?invoice=${esc(inv.id)}">Record payment</a>` : ''}
        ${!inv.locked ? '<button class="btn" id="fi-con">Add concession</button>' : ''}
        <button class="btn danger ghost" id="fi-cancel">Cancel invoice</button></div>` : ''}
    ${persona.role === 'parent' && open ? `<div class="row" style="margin-top:14px"><button class="btn primary" id="fi-mock">Pay ${money(inv.balancePaise)} online (mock)</button></div>` : ''}
    <h2 style="margin-top:20px">Payments against this invoice</h2>
    ${pays.length ? `<div class="tablewrap"><table><thead><tr><th>Receipt</th><th>Date</th><th>Mode</th><th class="r">Applied</th><th>Status</th></tr></thead><tbody>
      ${pays.map((p) => `<tr class="${p.status === 'cancelled' ? 'row-mute' : ''}"><td><a href="#/print/receipt/${esc(p.id)}">${esc(p.receiptNumber)}</a></td><td>${fdate(p.paidOn)}</td><td>${esc(p.mode)}</td><td class="r num">${money(p.allocations.find((a) => a.invoiceId === inv.id).amountPaise)}</td><td>${p.status === 'valid' ? badge('Valid', 'ok') : badge('Cancelled', 'mute')}</td></tr>`).join('')}
      </tbody></table></div>` : empty('No payments yet')}
    ${refunds.length ? `<h2 style="margin-top:20px">Refunds</h2><div class="tablewrap"><table><thead><tr><th>Voucher</th><th>Date</th><th class="r">Amount</th><th>Reason</th></tr></thead><tbody>${refunds.map((r) => `<tr><td>${esc(r.voucherNumber)}</td><td>${fdate(r.date)}</td><td class="r num">${money(r.amountPaise)}</td><td>${esc(r.reason)}</td></tr>`).join('')}</tbody></table></div>` : ''}`;

  const done = async (p, msg) => { if ((await attempt(() => p, msg)).ok) ctx.rerender(); };
  ctx.el.querySelector('#fi-apply')?.addEventListener('click', () => done(api.fees.applyLateFee(inv.id, today), 'Late fee applied'));
  ctx.el.querySelector('#fi-waive')?.addEventListener('click', async () => {
    const ok = await formModal({ title: 'Waive late fee', submitLabel: 'Waive', fieldsHtml: '<label class="field"><span class="lbl">Reason (required, audit-logged)</span><textarea name="reason" required></textarea></label>', onSubmit: (v) => api.fees.waiveLateFee(inv.id, v.reason) });
    if (ok) ctx.rerender();
  });
  ctx.el.querySelector('#fi-cancel')?.addEventListener('click', async () => {
    const ok = await formModal({ title: 'Cancel invoice', submitLabel: 'Cancel invoice', fieldsHtml: `<p>Cancels ${esc(inv.number)}. Allowed only when nothing is net-paid on it. The number is kept.</p><label class="field"><span class="lbl">Reason (required, audit-logged)</span><textarea name="reason" required></textarea></label>`, onSubmit: (v) => api.fees.cancelInvoice(inv.id, v.reason) });
    if (ok) ctx.rerender();
  });
  ctx.el.querySelector('#fi-con')?.addEventListener('click', async () => {
    const ok = await formModal({
      title: 'Add concession', submitLabel: 'Add',
      fieldsHtml: `<label class="field"><span class="lbl">Type</span><select name="type">${options(['scholarship', 'adhoc', 'staffWard', 'sibling'].map((t) => ({ value: t, label: t })), 'adhoc')}</select></label>
        <label class="field"><span class="lbl">Description</span><input name="description" required></label>
        <label class="field"><span class="lbl">Amount (&#8377;)</span><input name="amount" inputmode="decimal" required></label>`,
      onSubmit: (v) => {
        const p = rupeesToPaise(v.amount);
        if (p === null || p <= 0) throw new Error('Enter a valid amount greater than zero');
        return api.fees.addConcession(inv.id, { type: v.type, description: v.description.trim(), amountPaise: p });
      },
    });
    if (ok) ctx.rerender();
  });
  ctx.el.addEventListener('click', async (e) => {
    const r = e.target.closest('[data-rmcon]');
    if (!r) return;
    const ok = await formModal({ title: 'Remove concession', submitLabel: 'Remove', fieldsHtml: '<label class="field"><span class="lbl">Reason (required)</span><textarea name="reason" required></textarea></label>', onSubmit: (v) => api.fees.removeConcession(inv.id, r.dataset.rmcon, v.reason) });
    if (ok) ctx.rerender();
  });
  ctx.el.querySelector('#fi-mock')?.addEventListener('click', async () => {
    const kid = await api.people.student(inv.studentId);
    await mockPay(ctx, kid, [inv]);
  });
}

export async function render(ctx) {
  if (ctx.params.id) return detail(ctx);
  if (ctx.persona.role === 'parent') return parentList(ctx);
  return staffList(ctx);
}
