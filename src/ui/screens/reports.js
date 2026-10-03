// Reports: outstanding / defaulters, collection day book, numeric reconciliation.
import { todayISO, addDays, isISODate } from '../../domain/dates.js';
import { esc, money, fdate, badge, empty, pageHead, options, downloadText, indexBy, fullName, DASH } from '../components.js';
import { isRealMode } from '../mode.js';

const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
// spreadsheet formula injection: a text cell starting with = + - @ tab or CR gets a leading apostrophe
const csvText = (v) => csvCell(/^[=+\-@\t\r]/.test(String(v ?? '')) ? `'${v}` : v);
const rupeesPlain = (p) => (p == null ? '' : (p / 100).toFixed(2));
const MODE = { cash: 'Cash', upi: 'UPI', cheque: 'Cheque', bank: 'Bank', 'online-mock': 'Online (mock)', online: 'Online', credit: 'Credit' };

// Only the reconciliation checks decide ok/bad. A difference between this year's report and the all-years total is
// just prior-year balances, which is legitimate.
function reconBanner(recon, t) {
  const allOk = recon.checks.every((c) => c.ok);
  const prior = recon.school.outstanding - t.balancePaise;
  return `<div class="banner ${allOk ? 'ok' : 'bad'}">${allOk ? 'All reconciliation checks pass.' : '<strong>Reconciliation checks are failing</strong> - see the Reconciliation tab.'} All academic years: <strong>${money(recon.school.outstanding)}</strong> = this year's report <strong>${money(t.balancePaise)}</strong>${prior ? ` + other years <strong>${money(prior)}</strong>` : ''}.</div>`;
}

async function outstanding(ctx, host) {
  const { api, db, query } = ctx;
  const ayId = db.school.currentAcademicYearId;
  const programId = query.program || '';
  const asOf = isISODate(query.asof) ? query.asof : todayISO();
  const defaultersOnly = query.def === '1';
  const rep = await api.fees.outstandingReport({ academicYearId: ayId, programId: programId || undefined, asOfDate: asOf });
  const rows = rep.rows.filter((r) => !defaultersOnly || (r.overdueDays > 0 && r.balancePaise > 0));
  const t = rep.totals;
  let recon = null;
  let reconErr = null;
  if (!programId) { try { recon = await api.fees.reconcile(); } catch (e) { reconErr = e; } }
  const tot = rows.reduce((a, r) => { for (const k of ['invoicedPaise', 'concessionPaise', 'lateFeePaise', 'paidPaise', 'balancePaise']) a[k] += r[k]; return a; }, { invoicedPaise: 0, concessionPaise: 0, lateFeePaise: 0, paidPaise: 0, balancePaise: 0 });

  host.innerHTML = `<div class="row" style="margin-bottom:10px">
      <select id="rp-prog" style="width:auto" aria-label="Programme">${options(db.programs.map((p) => ({ value: p.id, label: p.name })), programId, { blank: 'All programmes' })}</select>
      <label class="row" style="gap:6px"><span style="font-weight:800;font-size:.82rem">As of</span><input type="date" id="rp-asof" value="${esc(asOf)}" style="width:auto"></label>
      <label class="check"><input type="checkbox" id="rp-def"${defaultersOnly ? ' checked' : ''}> Defaulters only (overdue)</label>
      <button class="btn sm" id="rp-csv">Export CSV</button></div>
    <div class="grid cols-4" style="margin-bottom:12px">
      <div class="kpi"><div class="v">${money(t.invoicedPaise)}</div><div class="l">invoiced</div></div>
      <div class="kpi good"><div class="v">${money(t.paidPaise)}</div><div class="l">paid (net of refunds)</div></div>
      <div class="kpi ${t.balancePaise ? 'bad' : ''}"><div class="v">${money(t.balancePaise)}</div><div class="l">outstanding</div></div>
      <div class="kpi"><div class="v">${esc(t.defaulters)}</div><div class="l">children overdue</div></div></div>
    ${reconErr ? `<div class="banner bad"><strong>Reconciliation could not be computed.</strong> ${esc(reconErr.message || reconErr)} Figures on this page cannot be cross-checked.</div>` : ''}
    ${recon ? reconBanner(recon, t) : ''}
    ${rows.length ? `<div class="tablewrap"><table><thead><tr><th>Child</th><th>Programme</th><th class="r">Invoiced</th><th class="r">Concessions</th><th class="r">Late fees</th><th class="r">Paid</th><th class="r">Balance</th><th class="r">Overdue</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td><a href="#/fees/student/${esc(r.studentId)}">${esc(r.name)}</a></td><td>${esc(r.program)}</td><td class="r num">${money(r.invoicedPaise)}</td><td class="r num">${money(r.concessionPaise)}</td><td class="r num">${money(r.lateFeePaise)}</td><td class="r num">${money(r.paidPaise)}</td><td class="r num"><strong>${money(r.balancePaise)}</strong></td><td class="r">${r.overdueDays > 0 && r.balancePaise > 0 ? badge(`${r.overdueDays} d`, 'bad') : DASH}</td></tr>`).join('')}
      </tbody><tfoot><tr><td colspan="2">Total (${rows.length} shown)</td><td class="r num">${money(tot.invoicedPaise)}</td><td class="r num">${money(tot.concessionPaise)}</td><td class="r num">${money(tot.lateFeePaise)}</td><td class="r num">${money(tot.paidPaise)}</td><td class="r num">${money(tot.balancePaise)}</td><td></td></tr></tfoot></table></div>` : empty(defaultersOnly ? 'No defaulters' : 'No invoices in this view')}`;

  const go = (patch) => ctx.setQuery({ tab: 'outstanding', ...patch });
  host.querySelector('#rp-prog').addEventListener('change', (e) => go({ program: e.target.value }));
  host.querySelector('#rp-asof').addEventListener('change', (e) => e.target.value && go({ asof: e.target.value }));
  host.querySelector('#rp-def').addEventListener('change', (e) => go({ def: e.target.checked ? '1' : '' }));
  host.querySelector('#rp-csv').addEventListener('click', () => {
    const head = ['Child', 'Programme', 'Invoiced', 'Concessions', 'Late fees', 'Paid', 'Balance', 'Days overdue'];
    const lines = [head.map(csvCell).join(',')].concat(rows.map((r) => [csvText(r.name), csvText(r.program), ...[rupeesPlain(r.invoicedPaise), rupeesPlain(r.concessionPaise), rupeesPlain(r.lateFeePaise), rupeesPlain(r.paidPaise), rupeesPlain(r.balancePaise), r.overdueDays].map(csvCell)].join(',')));
    downloadText(`outstanding_${asOf}.csv`, lines.join('\r\n'), 'text/csv');
  });
}

async function collection(ctx, host) {
  const { api, db, query } = ctx;
  const today = todayISO();
  const from = isISODate(query.from) ? query.from : addDays(today, -30);
  const to = isISODate(query.to) ? query.to : today;
  const pays = (await api.fees.payments({ from, to })).slice().sort((a, b) => (a.paidOn < b.paidOn ? -1 : a.paidOn > b.paidOn ? 1 : a.receiptNumber < b.receiptNumber ? -1 : 1));
  const stu = indexBy(db.students);
  const validAll = pays.filter((p) => p.status === 'valid');
  const valid = validAll.filter((p) => p.mode !== 'credit'); // money actually collected
  const creditApplied = validAll.filter((p) => p.mode === 'credit'); // internal transfers of credit already collected
  const refunds = db.refunds.filter((r) => r.date >= from && r.date <= to);
  const sum = (a, k = 'amountPaise') => a.reduce((s, x) => s + x[k], 0);
  const byMode = new Map();
  for (const p of valid) byMode.set(p.mode, (byMode.get(p.mode) || 0) + p.amountPaise);
  host.innerHTML = `<div class="row" style="margin-bottom:10px"><label class="row" style="gap:6px"><span style="font-weight:800;font-size:.82rem">From</span><input type="date" id="cl-from" value="${esc(from)}" style="width:auto"></label>
      <label class="row" style="gap:6px"><span style="font-weight:800;font-size:.82rem">To</span><input type="date" id="cl-to" value="${esc(to)}" style="width:auto"></label></div>
    <div class="grid cols-4" style="margin-bottom:12px">
      <div class="kpi good"><div class="v">${money(sum(valid))}</div><div class="l">collected (${valid.length} valid receipts)</div></div>
      <div class="kpi"><div class="v">${money(sum(creditApplied))}</div><div class="l">credit applied (${creditApplied.length}) - not new money</div></div>
      <div class="kpi"><div class="v">${money(sum(refunds))}</div><div class="l">refunded (${refunds.length})</div></div>
      <div class="kpi"><div class="v">${money(sum(valid) - sum(refunds))}</div><div class="l">net</div></div>
      <div class="kpi"><div class="v">${pays.length - validAll.length}</div><div class="l">cancelled receipts</div></div></div>
    ${byMode.size ? `<p class="muted">By mode: ${[...byMode].map(([m, a]) => `${esc(MODE[m] || m)} ${money(a)}`).join(' &middot; ')}</p>` : ''}
    ${pays.length ? `<div class="tablewrap"><table><thead><tr><th>Date</th><th>Receipt</th><th>Child</th><th>Mode</th><th class="r">Amount</th><th>Status</th></tr></thead><tbody>
      ${pays.map((p) => `<tr class="${p.status === 'cancelled' ? 'row-mute' : ''}"><td>${fdate(p.paidOn)}</td><td><a href="#/print/receipt/${esc(p.id)}">${esc(p.receiptNumber)}</a></td><td>${esc(fullName(stu.get(p.studentId)))}</td><td>${esc(MODE[p.mode] || p.mode)}</td><td class="r num">${money(p.amountPaise)}</td><td>${p.status === 'valid' ? badge('Valid', 'ok') : badge('Cancelled', 'mute')}</td></tr>`).join('')}
      </tbody><tfoot><tr><td colspan="4">Total collected (excludes credit applied)</td><td class="r num">${money(sum(valid))}</td><td></td></tr></tfoot></table></div>` : empty('No payments in this period')}
    ${refunds.length ? `<h2 style="margin-top:18px">Refunds</h2><div class="tablewrap"><table><thead><tr><th>Date</th><th>Voucher</th><th class="r">Amount</th><th>Reason</th></tr></thead><tbody>${refunds.map((r) => `<tr><td>${fdate(r.date)}</td><td>${esc(r.voucherNumber)}</td><td class="r num">${money(r.amountPaise)}</td><td>${esc(r.reason)}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
  const go = (patch) => ctx.setQuery({ tab: 'collection', from, to, ...patch });
  host.querySelector('#cl-from').addEventListener('change', (e) => e.target.value && go({ from: e.target.value }));
  host.querySelector('#cl-to').addEventListener('change', (e) => e.target.value && go({ to: e.target.value }));
}

async function reconcile(ctx, host) {
  const r = await ctx.api.fees.reconcile();
  const allOk = r.checks.every((c) => c.ok);
  const s = r.school;
  host.innerHTML = `<div class="banner ${allOk ? 'ok' : 'bad'}"><strong>${allOk ? 'All checks pass.' : `${r.checks.filter((c) => !c.ok).length} of ${r.checks.length} checks failing.`}</strong> Each check is computed twice by independent paths; mismatches are listed, never summarised.</div>
    <div class="stack">${r.checks.map((c) => `<div class="card tight"><div class="row between"><div class="item-title">${c.ok ? badge('OK', 'ok') : badge('FAIL', 'bad')} ${esc(c.name)}</div><span class="num muted">expected ${money(c.expected)} &middot; actual ${money(c.actual)}</span></div>
      ${c.byAcademicYear ? `<small>${c.byAcademicYear.map((x) => `${esc(x.academicYearId)} ${money(x.balancePaise)}`).join(' + ')}</small>` : ''}
      ${c.mismatches?.length ? `<ul style="margin:6px 0 0;padding-left:18px;font-size:.85rem">${c.mismatches.map((m) => `<li>${esc(JSON.stringify(m))}</li>`).join('')}</ul>` : ''}</div>`).join('')}</div>
    <h2 style="margin-top:20px">School-wide ledger</h2>
    <div class="tablewrap"><table><tbody>
      ${[['Invoiced (lines, incl. late fees)', s.invoiced], ['Late fees (included above)', s.lateFees], ['Concessions', s.concessions], ['Paid (valid allocations)', s.paid], ['Refunded', s.refunded], ['Outstanding = invoiced - concessions - paid + refunded', s.outstanding], ['Credit on account (unused)', s.credit], ...(s.externalReceivedPaise != null ? [['Collected from outside (cash, UPI, cheque, bank, online)', s.externalReceivedPaise], ['Credit applied (internal transfer, not new money)', s.receivedValid - s.externalReceivedPaise]] : [['Received (valid payments, incl. credit applied)', s.receivedValid]]), ['Credit created by valid payments', s.creditCreated]].map(([l, v]) => `<tr><td>${esc(l)}</td><td class="r num">${money(v)}</td></tr>`).join('')}
    </tbody></table></div>
    <h2 style="margin-top:20px">Per child</h2>
    <div class="tablewrap"><table><thead><tr><th>Child</th><th class="r">Invoiced</th><th class="r">Concessions</th><th class="r">Late fees</th><th class="r">Paid</th><th class="r">Refunded</th><th class="r">Credit</th><th class="r">Outstanding</th></tr></thead><tbody>
      ${r.perStudent.map((p) => `<tr><td>${esc(p.name)}</td><td class="r num">${money(p.invoiced)}</td><td class="r num">${money(p.concessions)}</td><td class="r num">${money(p.lateFees)}</td><td class="r num">${money(p.paid)}</td><td class="r num">${money(p.refunded)}</td><td class="r num">${money(p.credit)}</td><td class="r num"><strong>${money(p.outstanding)}</strong></td></tr>`).join('')}
    </tbody></table></div>`;
}

export async function render(ctx) {
  const tab = ['outstanding', 'collection', 'reconcile'].includes(ctx.query.tab) ? ctx.query.tab : 'outstanding';
  ctx.el.innerHTML = `${pageHead('Reports')}
    <div class="seg" style="margin-bottom:14px"><a href="${ctx.href('/reports', { tab: 'outstanding' })}" ${tab === 'outstanding' ? 'aria-current="page"' : ''}>Outstanding</a><a href="${ctx.href('/reports', { tab: 'collection' })}" ${tab === 'collection' ? 'aria-current="page"' : ''}>Collection day book</a><a href="${ctx.href('/reports', { tab: 'reconcile' })}" ${tab === 'reconcile' ? 'aria-current="page"' : ''}>Reconciliation</a>${isRealMode() ? '<a href="#/reports/settlements">Online settlements</a>' : ''}</div>
    <div id="rp-body"></div>`;
  const host = ctx.el.querySelector('#rp-body');
  await ({ outstanding, collection, reconcile }[tab])(ctx, host);
}
