// Late fees due (real app): the nightly job works out which open invoices owe a late fee; nothing is added
// until the accountant ticks them here and confirms. Applying is one explicit, audited step.
import { esc, money, fdate, banner, empty, pageHead, confirmDialog, attempt, errMessage } from '../components.js';

let lastResult = null;

export async function render(ctx) {
  const { api, db } = ctx;
  ctx.cleanup(() => { lastResult = null; });
  const ayId = db.school.currentAcademicYearId;
  let all;
  try { all = await api.fees.invoices({ academicYearId: ayId }); } catch (e) {
    ctx.el.innerHTML = `${pageHead('Late fees due')}${banner('bad', `<strong>Late fees could not be worked out.</strong> ${esc(errMessage(e))}`)}`;
    return;
  }
  const due = all.filter((i) => i.status !== 'cancelled' && i.status !== 'paid' && i.balancePaise > 0 && (i.lateFeeDuePaise || 0) > 0)
    .sort((a, b) => (a.effectiveDueDate < b.effectiveDueDate ? -1 : a.effectiveDueDate > b.effectiveDueDate ? 1 : a.number < b.number ? -1 : 1));
  const total = due.reduce((s, i) => s + i.lateFeeDuePaise, 0);

  ctx.el.innerHTML = `${pageHead('Late fees due', 'Open invoices past the grace period. Late fees are never added automatically.', '<a class="btn" href="#/fees">Back to fees</a>')}
    ${lastResult ? resultHtml(lastResult) : ''}
    ${due.length ? `
      <div class="grid cols-3" style="margin-bottom:12px">
        <div class="kpi"><div class="v">${esc(due.length)}</div><div class="l">invoices with a late fee due</div></div>
        <div class="kpi bad"><div class="v">${money(total)}</div><div class="l">total late fees due</div></div>
        <div class="kpi"><div class="v" id="lf-sel">${money(total)}</div><div class="l">selected (<span id="lf-n">${esc(due.length)}</span>)</div></div>
      </div>
      <div class="tablewrap"><table><thead><tr><th><input type="checkbox" id="lf-all" checked aria-label="Select all"></th><th>Invoice</th><th>Child</th><th>Effective due</th><th class="r">Balance</th><th class="r">Late fee due</th></tr></thead><tbody>
        ${due.map((i) => `<tr><td><input type="checkbox" class="lf-row" value="${esc(i.id)}" data-fee="${esc(i.lateFeeDuePaise)}" checked aria-label="Select ${esc(i.number)}"></td><td class="nowrap"><a href="#/fees/invoice/${esc(i.id)}">${esc(i.number)}</a></td>
          <td>${esc(i.studentName)}<br><small>${esc(i.programName)}</small></td><td class="nowrap">${fdate(i.effectiveDueDate)}<br><small>${esc(i.overdueDays)} days late</small></td><td class="r num">${money(i.balancePaise)}</td><td class="r num"><strong>${money(i.lateFeeDuePaise)}</strong></td></tr>`).join('')}
      </tbody></table></div>
      <div class="sticky-actions row"><button class="btn primary" id="lf-apply">Apply to selected invoices</button><small>Each one gets a late-fee line and an audit entry. A waiver can still remove it later.</small></div>`
      : empty('No late fees due', 'Nothing is overdue beyond the grace period as of today.')}`;

  const rows = () => [...ctx.el.querySelectorAll('.lf-row')];
  const sync = () => {
    const on = rows().filter((r) => r.checked);
    ctx.el.querySelector('#lf-sel').textContent = money(on.reduce((s, r) => s + Number(r.dataset.fee), 0));
    ctx.el.querySelector('#lf-n').textContent = String(on.length);
    ctx.el.querySelector('#lf-apply').disabled = on.length === 0;
  };
  ctx.el.querySelector('#lf-all')?.addEventListener('change', (e) => { rows().forEach((r) => { r.checked = e.target.checked; }); sync(); });
  ctx.el.querySelectorAll('.lf-row').forEach((r) => r.addEventListener('change', sync));
  ctx.el.querySelector('#lf-apply')?.addEventListener('click', async () => {
    const ids = rows().filter((r) => r.checked).map((r) => r.value);
    if (!ids.length) return;
    if (!(await confirmDialog('Apply late fees', `Add the late fee to ${ids.length} invoice${ids.length === 1 ? '' : 's'}? Each change is recorded in the audit log.`, { okLabel: 'Apply late fees' }))) return;
    const r = await attempt(() => api.fees.applyLateFees({ invoiceIds: ids }));
    if (!r.ok) return;
    lastResult = { asked: ids.length, ...r.value };
    await render(ctx);
  });
}

function resultHtml(r) {
  const applied = Array.isArray(r.applied) ? r.applied.length : Number(r.applied) || 0;
  const skipped = r.skipped || [];
  const ties = r.asked === applied + skipped.length;
  return `${banner(ties ? 'ok' : 'bad', `<strong>Done.</strong> Selected ${esc(r.asked)} = applied ${esc(applied)} + skipped ${esc(skipped.length)}${ties ? '.' : ' - <strong>these do not add up; tell the developer.</strong>'}`)}
    ${skipped.length ? `<div class="tablewrap" style="margin-bottom:12px"><table><thead><tr><th>Invoice</th><th>Why it was skipped</th></tr></thead><tbody>${skipped.map((s) => `<tr class="row-bad"><td>${esc(s.invoiceId)}</td><td>${esc(s.reason)}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
}
