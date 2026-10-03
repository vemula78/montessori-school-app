// Fee reminders sent (real app). The same list the push alert came from, so a missed or switched-off
// notification never means a missed reminder.
import { esc, fdate, badge, banner, empty, pageHead, errMessage } from '../components.js';

const KIND = { 'T-3': ['Due in 3 days', 'info'], due: ['Due today', 'warn'], '+7': ['7 days overdue', 'bad'], '+14': ['14 days overdue', 'bad'] };

export async function render(ctx) {
  const staff = ctx.persona.role !== 'parent';
  let rows;
  try { rows = await ctx.api.reminders.list(); } catch (e) {
    ctx.el.innerHTML = `${pageHead('Fee reminders')}${banner('bad', `<strong>Reminders are unavailable.</strong> ${esc(errMessage(e))}`)}`;
    return;
  }
  rows = [...rows].sort((a, b) => (a.sentOn < b.sentOn ? 1 : a.sentOn > b.sentOn ? -1 : 0));
  ctx.el.innerHTML = `${pageHead('Fee reminders', staff ? 'Reminders sent to families (3 days before the due date, on it, and 7 and 14 days after).' : 'Reminders the school has sent you about fees.', `<a class="btn" href="#/fees">Back to fees</a>`)}
    ${rows.length ? `<ul class="list card-list">${rows.map((r) => {
      const [label, kind] = KIND[r.kind] || [r.kind, 'mute'];
      return `<li><div class="row between"><div class="grow-text"><div>${esc(r.text)}</div><small>Sent ${fdate(r.sentOn)}</small></div><div class="row">${badge(label, kind)}${r.invoiceId ? `<a class="btn sm" href="#/fees/invoice/${esc(r.invoiceId)}">Invoice</a>` : ''}</div></div></li>`;
    }).join('')}</ul>` : empty('No reminders yet', 'Reminders appear here when an invoice is about to fall due or is overdue.')}`;
}
