// Settings: backup / restore, reset to demo data, storage usage, damaged-copy recovery, school details.
import { esc, money, fdate, pageHead, downloadText, readFileText, confirmDialog, attempt, toast, errMessage, DASH } from '../components.js';
import { isRealMode } from '../mode.js';

const CORRUPT_PREFIX = 'montessori.db.corrupt.';
const kb = (n) => (n == null ? DASH : n < 1024 * 1024 ? `${(Number(n) / 1024).toFixed(1)} KB` : `${(Number(n) / 1024 / 1024).toFixed(2)} MB`);

function corruptCopies() {
  const out = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(CORRUPT_PREFIX)) out.push({ key: k, bytes: (localStorage.getItem(k) || '').length });
    }
  } catch { /* storage unavailable */ }
  return out.sort((a, b) => (a.key < b.key ? 1 : -1));
}

export async function render(ctx) {
  if (isRealMode()) return (await import('./settings-real.js')).render(ctx); // browser-storage tools below are demo-only
  const { api, db } = ctx;
  const infoRes = await attempt(() => api.admin.storageInfo());
  const info = infoRes.ok ? infoRes.value : null;
  const used = info?.bytesUsed ?? null;
  const quota = info?.approxQuotaBytes ?? null;
  const pctRaw = used != null && quota ? Math.min(100, Math.round((Number(used) / Number(quota)) * 100)) : null;
  const pct = Number.isFinite(pctRaw) ? pctRaw : null;
  const copies = corruptCopies();
  const rule = db.school.lateFeeRule;
  const ay = db.academicYears.find((a) => a.id === db.school.currentAcademicYearId);

  ctx.el.innerHTML = `${pageHead('Settings')}
    <div class="stack">
    ${copies.length ? `<div class="banner warn"><strong>Damaged earlier data was preserved.</strong> The app never deletes it automatically. Download it to keep, or delete it once you are sure.
      <ul class="list" style="margin-top:8px">${copies.map((c) => `<li><div class="row between"><div><code>${esc(c.key)}</code> <small>${esc(kb(c.bytes))}</small></div><div class="row"><button class="btn sm" data-dl="${esc(c.key)}">Download</button><button class="btn sm ghost" data-rm="${esc(c.key)}">Delete</button></div></div></li>`).join('')}</ul></div>` : ''}
    <div class="card stack"><h2>Storage</h2>
      <div>${esc(kb(used))} used${quota ? ` of about ${esc(kb(quota))}` : ''}${pct != null ? ` (${esc(pct)}%)` : ''}</div>
      ${pct != null ? `<div class="progress" role="progressbar" aria-valuenow="${esc(pct)}" aria-valuemin="0" aria-valuemax="100"><i style="width:${esc(pct)}%"></i></div>` : ''}
      <small>Everything lives in this browser's local storage (key <code>montessori.db.v2</code>). Clearing site data erases it - export a backup first.</small></div>
    <div class="card stack"><h2>Backup and restore</h2>
      <div class="row"><button class="btn primary" id="s-export">Export JSON backup</button>
        <label class="btn" style="cursor:pointer">Import JSON...<input type="file" id="s-import" accept="application/json,.json" style="display:none"></label></div>
      <small>Import replaces all current data with the file's contents (after validation).</small></div>
    <div class="card stack"><h2>Reset</h2><p style="margin:0">Replace everything with the original demo data. This is recorded in the audit log.</p>
      <div><button class="btn danger" id="s-reset">Reset to demo data</button></div></div>
    <div class="card stack"><h2>School details</h2>
      <dl style="display:grid;grid-template-columns:150px 1fr;gap:4px 10px;margin:0">
        <dt class="muted">Name</dt><dd style="margin:0">${esc(db.school.name)}</dd>
        <dt class="muted">Address</dt><dd style="margin:0">${esc(db.school.address)}</dd>
        <dt class="muted">Phone</dt><dd style="margin:0">${esc(db.school.phone)}</dd>
        <dt class="muted">Academic year</dt><dd style="margin:0">${esc(ay?.label || DASH)} ${ay ? `(${fdate(ay.startDate)} to ${fdate(ay.endDate)})` : ''}</dd>
        <dt class="muted">Weekly offs</dt><dd style="margin:0">${(db.school.weeklyOffs || []).map((d) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d]).join(', ') || DASH}</dd>
        <dt class="muted">Late fee rule</dt><dd style="margin:0">${rule ? `${esc(rule.graceDays)} grace days, ${rule.mode === 'perDay' ? `${money(rule.amountPaise)} per day${rule.capPaise != null ? `, capped at ${money(rule.capPaise)}` : ''}` : `${money(rule.amountPaise)} flat`}${rule.shiftDueToWorkingDay ? ', due date moves to the next working day' : ''}` : DASH}</dd>
      </dl></div>
    <div class="card stack"><h2>About this prototype</h2>
      <ul style="margin:0;padding-left:18px">
        <li>All people, schools and amounts are fake demo data.</li>
        <li>There is no server: bus tracking is live only between tabs of the same browser.</li>
        <li>Map tiles load from tile.openstreetmap.org (tile coordinates only - no child data). Production must self-host or pay for tiles.</li>
        <li>Online payment is a mock. No money moves.</li></ul></div>
    </div>`;

  ctx.el.querySelector('#s-export').addEventListener('click', async () => {
    const r = await attempt(() => api.admin.exportJson());
    if (r.ok) { downloadText(`montessori-demo-backup_${new Date().toISOString().slice(0, 10)}.json`, r.value, 'application/json'); toast('Backup downloaded'); }
  });
  ctx.el.querySelector('#s-import').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    if (!(await confirmDialog('Import backup', `Replace ALL current data with "${f.name}"? Export a backup first if you want to keep the current state.`, { okLabel: 'Import and replace', kind: 'danger' }))) return;
    let text;
    try { text = await readFileText(f); } catch (err) { toast(`Could not read the file: ${errMessage(err)}`, 'bad'); return; }
    if ((await attempt(() => api.admin.importJson(text), 'Backup imported')).ok) ctx.rerender();
  });
  ctx.el.querySelector('#s-reset').addEventListener('click', async () => {
    if (!(await confirmDialog('Reset to demo data', 'Replace everything with the original demo data? Export a backup first if you need the current state.', { okLabel: 'Reset', kind: 'danger' }))) return;
    if ((await attempt(() => api.admin.resetToSeed(), 'Reset to demo data')).ok) ctx.rerender();
  });
  ctx.el.addEventListener('click', async (e) => {
    const dl = e.target.closest('[data-dl]');
    const rm = e.target.closest('[data-rm]');
    try {
      if (dl) downloadText(`${dl.dataset.dl}.json`, localStorage.getItem(dl.dataset.dl) || '', 'application/json');
      if (rm && await confirmDialog('Delete damaged copy', `Permanently delete ${rm.dataset.rm}? This cannot be undone.`, { okLabel: 'Delete', kind: 'danger' })) {
        localStorage.removeItem(rm.dataset.rm);
        toast('Deleted');
        ctx.rerender();
      }
    } catch { toast('Browser storage is not accessible', 'bad'); }
  });
}
