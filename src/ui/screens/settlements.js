// Online settlements (real app): import the payment provider's settlement CSV, then reconcile it against the
// ledger. Every unmatched row on either side is listed; nothing is summarised away.
import { todayISO, addDays, isISODate } from '../../domain/dates.js';
import { esc, money, fdate, badge, banner, empty, pageHead, downloadText, readFileText, attempt, toast, errMessage, DASH } from '../components.js';

const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const csvText = (v) => csvCell(/^[=+\-@\t\r]/.test(String(v ?? '')) ? `'${v}` : v); // spreadsheet formula injection guard

function importResultHtml(r) {
  const rejected = r.rejected || [];
  const ties = r.inputRows === r.imported + r.duplicate + rejected.length;
  return `${banner(ties ? 'ok' : 'bad', `<strong>Import finished.</strong> Rows in file ${esc(r.inputRows)} = new ${esc(r.imported)} + already imported ${esc(r.duplicate)} + rejected ${esc(rejected.length)}${ties ? '.' : ' - <strong>these do not add up; tell the developer.</strong>'}`)}
    ${rejected.length ? `<div class="tablewrap"><table><thead><tr><th>Line</th><th>Why it was rejected</th></tr></thead><tbody>${rejected.map((x) => `<tr class="row-bad"><td class="num">${esc(x.line)}</td><td>${esc(x.reason)}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
}

function reportHtml(rep) {
  const t = rep.totals;
  const money0 = (v) => (v == null ? DASH : money(v));
  const rows = rep.rows || [];
  return `
    ${t.identityOk ? banner('ok', 'Every settlement line balances: payments gross = net + fee + tax; refunds debited = refund + fee + tax.') : banner('bad', `<strong>${esc(t.identityMismatches.length)} settlement line${t.identityMismatches.length === 1 ? '' : 's'} that do not balance (payment: gross = net + fee + tax; refund: debit = refund + fee + tax):</strong> ${t.identityMismatches.map((m) => `line ${esc(m.line)}`).join(', ')}.`)}
    ${t.amountMismatches ? banner('bad', `<strong>${esc(t.amountMismatches)} matched row${t.amountMismatches === 1 ? '' : 's'} where the settled amount differs from the ledger.</strong> See the flagged rows.`) : ''}
    <div class="grid cols-4" style="margin:12px 0">
      <div class="kpi"><div class="v">${esc(t.ledgerPayments)}</div><div class="l">online payments in the ledger</div></div>
      <div class="kpi"><div class="v">${esc(t.settlementLines)}</div><div class="l">settlement lines imported</div></div>
      <div class="kpi good"><div class="v">${esc(t.matchedRows)}</div><div class="l">matched rows</div></div>
      <div class="kpi ${t.unmatchedLedger || t.unmatchedSettlement ? 'bad' : ''}"><div class="v">${esc(t.unmatchedLedger)} / ${esc(t.unmatchedSettlement)}</div><div class="l">unmatched: ledger / settlement</div></div>
    </div>
    <div class="grid cols-4" style="margin-bottom:14px">
      <div class="kpi"><div class="v">${money0(t.grossPaise)}</div><div class="l">gross settled</div></div>
      <div class="kpi"><div class="v">${money0(t.feePaise)}</div><div class="l">provider fee</div></div>
      <div class="kpi"><div class="v">${money0(t.taxPaise)}</div><div class="l">tax on fee</div></div>
      <div class="kpi good"><div class="v">${money0(t.netPaise)}</div><div class="l">net to bank${t.refundDebitPaise ? ` (after ${money0(t.refundDebitPaise)} refunds)` : ''}</div></div>
    </div>
    <h2>Matched</h2>
    ${rows.length ? `<div class="tablewrap"><table><thead><tr><th>Receipt</th><th>Child</th><th>Paid on</th><th class="r">Ledger</th><th>Settlement</th><th>Settled</th><th class="r">Gross</th><th class="r">Fee</th><th class="r">Tax</th><th class="r">Net</th></tr></thead><tbody>
      ${rows.map((r) => `<tr class="${r.amountMatches ? '' : 'row-bad'}"><td class="nowrap">${r.kind === 'refund' ? badge('Refund', 'warn') + ' ' + esc((r.voucherNumbers || []).join(', ') || DASH) : esc(r.receiptNumber || DASH)}</td><td>${esc(r.studentName || DASH)}</td><td class="nowrap">${r.paidOn ? fdate(r.paidOn) : DASH}</td><td class="r num">${money0(r.ledgerPaise)}</td>
        <td><span class="num">${esc(r.settlementId || DASH)}</span>${r.utr ? `<br><small>UTR ${esc(r.utr)}</small>` : ''}</td><td class="nowrap">${r.settledOn ? fdate(r.settledOn) : DASH}</td>
        <td class="r num">${money0(r.grossPaise)}</td><td class="r num">${money0(r.feePaise)}</td><td class="r num">${money0(r.taxPaise)}</td><td class="r num">${money0(r.netPaise)}${r.amountMatches ? '' : `<br><small>${esc(r.reason || 'differs from ledger')}</small>`}</td></tr>`).join('')}
      </tbody></table></div>` : empty('Nothing matched yet', 'Import a settlement report above, or widen the dates.')}
    <h2 style="margin-top:20px">In the ledger but not in any settlement (${esc(rep.unmatchedLedger.length)})</h2>
    ${rep.unmatchedLedger.length ? `<div class="tablewrap"><table><thead><tr><th>Receipt / refund</th><th>Paid on</th><th class="r">Amount</th><th>Why listed</th></tr></thead><tbody>
      ${rep.unmatchedLedger.map((u) => `<tr class="row-bad"><td class="nowrap">${u.kind === 'refund' ? esc((u.voucherNumbers || []).join(', ') || u.gatewayRefundId) : esc(u.receiptNumber || DASH)}</td><td class="nowrap">${u.paidOn ? fdate(u.paidOn) : DASH}</td><td class="r num">${money0(u.amountPaise)}</td><td>${esc(u.reason || DASH)}${u.status === 'cancelled' ? ' ' + badge('cancelled receipt', 'mute') : ''}</td></tr>`).join('')}
      </tbody></table></div>` : '<p class="muted">None - every online payment in this period is in an imported settlement.</p>'}
    <h2 style="margin-top:20px">In a settlement but not in the ledger (${esc(rep.unmatchedSettlement.length)})</h2>
    ${rep.unmatchedSettlement.length ? `<div class="tablewrap"><table><thead><tr><th>Line</th><th>Provider reference</th><th>Settlement</th><th class="r">Gross</th><th>Why listed</th></tr></thead><tbody>
      ${rep.unmatchedSettlement.map((u) => `<tr class="row-bad"><td class="num">${esc(u.line ?? DASH)}</td><td class="num">${esc(u.entityId || DASH)}</td><td class="num">${esc(u.settlementId || DASH)}</td><td class="r num">${money0(u.grossPaise)}</td><td>${esc(u.reason || DASH)}</td></tr>`).join('')}
      </tbody></table></div>` : '<p class="muted">None - every settlement line matches a ledger entry.</p>'}`;
}

let lastImport = null; // result of the last import in this page view, shown above the report after the redraw

export async function render(ctx) {
  const { api, query } = ctx;
  ctx.cleanup(() => { lastImport = null; }); // leaving the page forgets the result
  const today = todayISO();
  const from = isISODate(query.from) ? query.from : addDays(today, -60);
  const to = isISODate(query.to) ? query.to : today;
  let rep = null, repErr = null;
  try { rep = await api.fees.settlementReport({ from, to }); } catch (e) { repErr = e; }

  ctx.el.innerHTML = `${pageHead('Online settlements', 'Match the payment provider’s settlement report with the ledger', '<a class="btn" href="#/reports">Back to reports</a>')}
    <div class="card stack">
      <h2 style="margin:0">1. Import a settlement report</h2>
      <p class="muted" style="margin:0">In the payment provider’s dashboard open Settlements (or Reports), download the settlement report as CSV, then choose it here. Importing the same file again is safe: lines already imported are skipped and counted.</p>
      <label class="field"><span class="lbl">Settlement CSV file</span><input type="file" id="st-file" accept=".csv,text/csv,text/plain"></label>
      <details><summary class="muted" style="cursor:pointer;font-weight:700">Or paste CSV text</summary><textarea id="st-text" style="margin-top:8px;font-family:monospace" placeholder="entity_id,type,settlement_id,..."></textarea></details>
      <div class="row"><button class="btn primary" id="st-go">Import</button></div>
      <div id="st-result">${lastImport ? importResultHtml(lastImport) : ''}</div>
    </div>
    <h2 style="margin-top:22px">2. Reconciliation</h2>
    <div class="row" style="margin-bottom:10px"><label class="row" style="gap:6px"><span style="font-weight:800;font-size:.82rem">Paid from</span><input type="date" id="st-from" value="${esc(from)}" style="width:auto"></label>
      <label class="row" style="gap:6px"><span style="font-weight:800;font-size:.82rem">to</span><input type="date" id="st-to" value="${esc(to)}" style="width:auto"></label>
      ${rep ? '<button class="btn sm" id="st-csv">Export CSV</button>' : ''}</div>
    ${repErr ? banner('bad', `<strong>The reconciliation is unavailable.</strong> ${esc(errMessage(repErr))} Do not treat the figures as zero.`) : reportHtml(rep)}`;

  const go = (patch) => ctx.setQuery({ from, to, ...patch });
  ctx.el.querySelector('#st-from').addEventListener('change', (e) => e.target.value && go({ from: e.target.value }));
  ctx.el.querySelector('#st-to').addEventListener('change', (e) => e.target.value && go({ to: e.target.value }));
  ctx.el.querySelector('#st-file').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try { ctx.el.querySelector('#st-text').value = await readFileText(f); } catch (err) { toast(`Could not read the file: ${errMessage(err)}`, 'bad'); }
  });
  ctx.el.querySelector('#st-go').addEventListener('click', async () => {
    const text = ctx.el.querySelector('#st-text').value;
    if (!text.trim()) { toast('Choose a file or paste the CSV text first', 'bad'); return; }
    const r = await attempt(() => api.fees.importSettlementCsv(text));
    if (!r.ok) return;
    lastImport = r.value;
    await render(ctx); // redraw with the new figures and the import result
  });
  ctx.el.querySelector('#st-csv')?.addEventListener('click', () => {
    const head = ['Kind', 'Receipt/Voucher', 'Child', 'Paid on', 'Ledger', 'Settlement', 'UTR', 'Settled on', 'Gross', 'Fee', 'Tax', 'Net', 'Matches ledger'];
    const rp = (p) => (p == null ? '' : (p / 100).toFixed(2));
    const lines = [head.map(csvCell).join(',')].concat(rep.rows.map((r) => [r.kind, r.kind === 'refund' ? (r.voucherNumbers || []).join(' ') : r.receiptNumber, r.studentName || '', r.paidOn || '', rp(r.ledgerPaise), r.settlementId, r.utr || '', r.settledOn || '', rp(r.grossPaise), rp(r.feePaise), rp(r.taxPaise), rp(r.netPaise), r.amountMatches ? 'yes' : 'NO'].map(csvText).join(',')));
    downloadText(`settlements_${from}_to_${to}.csv`, lines.join('\r\n'), 'text/csv');
  });
}
