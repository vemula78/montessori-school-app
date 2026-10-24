// UPI payments reported by parents (#81). The office checks each one against the bank statement, then confirms it
// (an ordinary receipt, mode UPI, with the parent's reference) or rejects it with a reason the family sees.
import { esc, money, fdate, fdatetime, badge, empty, pageHead, formModal, fullName, DASH } from '../components.js';

const TABS = [['pending', 'To check'], ['confirmed', 'Confirmed'], ['rejected', 'Rejected']];
const STATUS_BADGE = { pending: ['To check', 'warn'], confirmed: ['Confirmed', 'ok'], rejected: ['Rejected', 'bad'] };

function flash(html) {
  const host = document.getElementById('uc-flash');
  if (host) host.innerHTML = html;
}

export async function render(ctx) {
  const { api, db, query } = ctx;
  const status = TABS.some(([v]) => v === query.status) ? query.status : 'pending';
  const all = await api.fees.claims();
  const count = (s) => all.filter((c) => c.status === s).length;
  const rows = all.filter((c) => c.status === status);
  if (status === 'pending') rows.reverse(); // oldest report first: checked in the order they came in
  const invNo = (id) => (db.invoices || []).find((i) => i.id === id)?.number || id;
  const who = (id) => fullName((db.guardians || []).find((g) => g.id === id));

  ctx.el.innerHTML = `<p><a href="#/fees">&larr; Fees</a></p>
    ${pageHead('UPI payment reports', 'Parents who paid the school by UPI. Check each against the bank statement before confirming.')}
    <div id="uc-flash"></div>
    <div class="seg" style="margin-bottom:12px">${TABS.map(([v, l]) => `<button data-status="${v}" aria-pressed="${status === v}">${esc(l)}${count(v) ? ` (${esc(count(v))})` : ''}</button>`).join('')}</div>
    ${rows.length ? `<ul class="list card-list">${rows.map((c) => `<li><div class="stack">
      <div class="row between"><div><div class="item-title"><span class="num">${money(c.amountPaise)}</span> &middot; ${esc(c.studentName)}</div>
        <small>UPI reference <strong>${esc(c.reference)}</strong> &middot; paid on ${fdate(c.paidOn)} &middot; reported ${fdatetime(c.createdAt)} by ${esc(who(c.guardianId))}</small><br>
        <small>For ${c.invoiceIds.map((id) => esc(invNo(id))).join(', ') || DASH}</small></div>${badge(...(STATUS_BADGE[c.status] || [c.status, 'mute']))}</div>
      ${c.status === 'pending' ? `<div class="row"><button class="btn primary" data-confirm="${esc(c.id)}">Confirm and issue receipt</button><button class="btn" data-reject="${esc(c.id)}">Reject</button><a class="btn ghost" href="#/fees/student/${esc(c.studentId)}">Ledger</a></div>` : ''}
      ${c.status === 'confirmed' ? `<small>Confirmed ${fdatetime(c.decidedAt)}${c.paymentId ? ` &middot; <a href="#/print/receipt/${esc(c.paymentId)}">Receipt ${esc(c.receiptNumber || '')}</a>` : ''}</small>` : ''}
      ${c.status === 'rejected' ? `<small>Rejected ${fdatetime(c.decidedAt)}: ${esc(c.rejectReason || DASH)}</small>` : ''}
    </div></li>`).join('')}</ul>` : empty(status === 'pending' ? 'Nothing to check' : 'None yet', status === 'pending' ? 'No UPI payment reported by a parent is waiting.' : '')}`;

  ctx.el.querySelectorAll('[data-status]').forEach((b) => b.addEventListener('click', () => ctx.setQuery({ status: b.dataset.status })));
  ctx.el.addEventListener('click', async (e) => {
    const ok = e.target.closest('[data-confirm]');
    const no = e.target.closest('[data-reject]');
    const c = all.find((x) => x.id === (ok || no)?.dataset[ok ? 'confirm' : 'reject']);
    if (!c) return;
    if (ok) {
      let made = null;
      const done = await formModal({
        title: 'Confirm UPI payment', submitLabel: `Confirm ${money(c.amountPaise)}`,
        fieldsHtml: `<p>Confirm only after you have seen <strong>${money(c.amountPaise)}</strong> with UPI reference <strong>${esc(c.reference)}</strong> in the school's bank account. A receipt is issued to the family; it can be cancelled later like any other.</p>
          <label class="field"><span class="lbl">Date of the payment (as on the bank statement)</span><input type="date" name="paidOn" value="${esc(c.paidOn)}" required></label>`,
        onSubmit: async (v) => { made = await api.fees.confirmClaim(c.id, { paidOn: v.paidOn || c.paidOn }); },
      });
      if (done && made) {
        await ctx.rerender();
        flash(`<div class="banner ok"><div class="row between"><span><strong>Recorded ${esc(made.payment.receiptNumber)}</strong> - ${money(made.payment.amountPaise)} for ${esc(c.studentName)}.</span><a class="btn sm" href="#/print/receipt/${esc(made.payment.id)}">View / print receipt</a></div></div>`);
      }
    } else {
      const done = await formModal({
        title: 'Reject UPI payment report', submitLabel: 'Reject',
        fieldsHtml: `<p>${money(c.amountPaise)} from ${esc(c.studentName)}'s family, reference ${esc(c.reference)}. The family sees your reason, so say what they should do.</p>
          <label class="field"><span class="lbl">Reason (required)</span><textarea name="reason" required maxlength="200" placeholder="e.g. No payment with this reference reached the school's account; please check the reference"></textarea></label>`,
        onSubmit: (v) => {
          if (!String(v.reason || '').trim()) throw new Error('Give the reason, so the family knows what to do');
          return api.fees.rejectClaim(c.id, v.reason.trim());
        },
      });
      if (done) ctx.rerender();
    }
  });
}
