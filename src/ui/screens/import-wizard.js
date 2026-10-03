// Data import wizard (real app), shared by the children and fee-dues imports.
//   1 choose a CSV  ->  2 match its columns to the app's fields  ->  3 check (preview, nothing saved)  ->  4 import
// Nothing is saved before step 4. Every row ends in exactly one of: will import / duplicate / quarantined,
// and rows in file = will import + duplicate + quarantined is shown at each step.
import { esc, money, fdate, fdatetime, badge, banner, empty, pageHead, options, readFileText, downloadText, confirmDialog, attempt, toast, errMessage, DASH } from '../components.js';

const MAX_ROWS = 5000;
const LABEL = {
  admissionNo: ['Admission number', 'Used to recognise a child, so the same file can be imported safely twice.'],
  firstName: ['Child first name'], lastName: ['Child last name'],
  dob: ['Date of birth', 'Day first: DD/MM/YYYY or DD-MM-YYYY, or YYYY-MM-DD.'],
  program: ['Programme / class', 'Must match one of the school’s programmes exactly.'],
  status: ['Status', 'active or left. Empty means active.'],
  route: ['Bus route', 'Optional. Needed only if a stop name appears on more than one route.'], stop: ['Bus stop', 'Optional.'],
  guardian1Name: ['Parent 1 name'], guardian1Relation: ['Parent 1 relation'], guardian1Phone: ['Parent 1 phone', '10-digit Indian mobile.'], guardian1Email: ['Parent 1 email'],
  guardian2Name: ['Parent 2 name'], guardian2Relation: ['Parent 2 relation'], guardian2Phone: ['Parent 2 phone'], guardian2Email: ['Parent 2 email'],
  installment: ['Instalment / term', 'For example Term 1.'],
  dueDate: ['Due date', 'Day first: DD/MM/YYYY, or YYYY-MM-DD.'],
  outstandingPaise: ['Outstanding amount (rupees)', 'In rupees, for example 12,500.00. Zero and negative amounts are not imported.'],
};
const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const csvText = (v) => csvCell(/^[=+\-@\t\r]/.test(String(v ?? '')) ? `'${v}` : v); // spreadsheet formula injection guard

export function makeImportScreen(kind) {
  const title = kind === 'children' ? 'Import children and families' : 'Import outstanding fees';

  return async function render(ctx) {
    const { api, persona } = ctx;
    const { fields, required } = await api.import.targetFields(kind); // the app's own field list, never hard-coded here
    let step = 'file';
    let fileName = '';
    let parsed = null;     // parseCsvObjects result
    let mapping = {};      // target field -> source header
    let staged = null;     // {batchId, counts}
    let preview = null;    // api.import.preview result
    let result = null;     // api.import.commit result
    let filter = 'all';
    let batches = null;

    const tabs = () => `<div class="seg" style="margin-bottom:14px">
      ${persona.role === 'admin' ? `<a href="#/import" ${kind === 'children' ? 'aria-current="page"' : ''}>Children and families</a>` : ''}
      <a href="#/import/fees" ${kind === 'fees' ? 'aria-current="page"' : ''}>Outstanding fees</a></div>`;

    const note = kind === 'children'
      ? 'Import the children first, then the outstanding fees. Siblings who share a parent phone or email are linked to one parent record automatically.'
      : 'Each outstanding amount becomes one “Opening balance” invoice for that child. Old receipts are not recreated. Import the children first.';

    const stepper = () => `<ol class="steps" aria-label="Progress">${[['file', 'Choose file'], ['map', 'Match columns'], ['preview', 'Check'], ['done', 'Imported']].map(([k, l], i) => `<li${k === step ? ' aria-current="step"' : ''}><span>${i + 1}</span>${esc(l)}</li>`).join('')}</ol>`;

    function draw() {
      ctx.el.innerHTML = `${pageHead(title, 'Upload a CSV, review the preview, then confirm. Nothing is saved until you confirm.')}${tabs()}${stepper()}<div id="im-body"></div>`;
      const body = ctx.el.querySelector('#im-body');
      ({ file: drawFile, map: drawMap, preview: drawPreview, done: drawDone }[step])(body);
    }

    // ---- 1. file
    function drawFile(body) {
      body.innerHTML = `<div class="card stack">
          <p class="muted" style="margin:0">${esc(note)}</p>
          <label class="field"><span class="lbl">CSV file</span><input type="file" id="im-file" accept=".csv,text/csv,text/plain"></label>
          <details><summary class="muted" style="cursor:pointer;font-weight:700">Or paste CSV text</summary><textarea id="im-text" style="margin-top:8px;font-family:monospace" placeholder="First row = column names"></textarea><div class="row" style="margin-top:8px"><button class="btn" id="im-paste">Use pasted text</button></div></details>
          <div class="help"><strong>From Excel:</strong> File &gt; Save As &gt; CSV UTF-8. The first row must hold the column names. At most ${MAX_ROWS.toLocaleString('en-IN')} rows per import. Dates are read day-first and are never guessed; phone numbers must be 10-digit Indian mobiles.</div>
          <div class="err" id="im-err" role="alert"></div>
        </div>
        <h2 style="margin-top:20px">Earlier imports</h2><div id="im-batches"><p class="muted">Loading...</p></div>`;
      body.querySelector('#im-file').addEventListener('change', async (e) => {
        const f = e.target.files[0];
        if (!f) return;
        let text;
        try { text = await readFileText(f); } catch (err) { body.querySelector('#im-err').textContent = `Could not read the file: ${errMessage(err)}`; return; }
        fileName = f.name; load(text, body);
      });
      body.querySelector('#im-paste').addEventListener('click', () => { fileName = 'pasted text'; load(body.querySelector('#im-text').value, body); });
      loadBatches(body.querySelector('#im-batches'));
    }

    async function loadBatches(host) {
      try { batches = (await api.import.batches()).filter((b) => b.kind === kind); } catch (e) { host.innerHTML = banner('warn', `Earlier imports could not be listed: ${esc(errMessage(e))}`); return; }
      host.innerHTML = batches.length
        ? `<div class="tablewrap"><table><thead><tr><th>When</th><th>Status</th><th class="r">Rows</th><th>Result</th></tr></thead><tbody>${batches.slice(0, 10).map((b) => `<tr><td class="nowrap">${fdatetime(b.createdAt)}</td><td>${badge(b.status, b.status === 'committed' ? 'ok' : 'mute')}</td><td class="r num">${esc(b.inputRows)}</td><td><small>${b.result ? `imported ${esc(b.result.ok)}, duplicates ${esc(b.result.duplicate)}, quarantined ${esc(b.result.quarantined)}` : 'not imported (checked only)'}</small></td></tr>`).join('')}</tbody></table></div>`
        : '<p class="muted">No earlier imports of this kind.</p>';
    }

    async function load(text, body) {
      const err = body.querySelector('#im-err');
      if (!String(text).trim()) { err.textContent = 'The file is empty.'; return; }
      let p;
      try { p = await api.import.parseCsv(text); } catch (e) { err.textContent = errMessage(e); return; }
      if (!p.headers.length || !p.rows.length) { err.textContent = 'No data rows found. The first row must hold column names, followed by at least one row of data.'; return; }
      if (p.rows.length > MAX_ROWS) { err.textContent = `This file has ${p.rows.length.toLocaleString('en-IN')} rows; the limit is ${MAX_ROWS.toLocaleString('en-IN')} per import. Split it and import in parts.`; return; }
      try { mapping = await api.import.suggestMapping(kind, p.headers); } catch { mapping = {}; /* the user maps by hand */ }
      parsed = p; step = 'map'; draw();
    }

    // ---- 2. map
    function drawMap(body) {
      const sample = (h) => parsed.rows.map((r) => r.values[h]).filter((v) => v).slice(0, 2).join(' | ');
      body.innerHTML = `<div class="card stack">
          <div class="row between"><div><strong>${esc(fileName)}</strong><br><small>${esc(parsed.rows.length)} data rows, ${esc(parsed.headers.length)} columns</small></div><button class="btn sm ghost" id="im-restart">Choose another file</button></div>
          ${parsed.problems.length ? banner('warn', `<strong>${esc(parsed.problems.length)} line${parsed.problems.length === 1 ? '' : 's'} need attention:</strong> ${parsed.problems.slice(0, 3).map((x) => `line ${esc(x.line)} - ${esc(x.reason)}`).join('; ')}${parsed.problems.length > 3 ? '; ...' : ''}. Affected rows are quarantined, not dropped.`) : ''}
          <p class="muted" style="margin:0">Say which column of your file holds each piece of information. The app guessed from the column names; check every line. Fields marked * are required.</p>
          <div class="map-list">
            ${fields.map((f) => `<div class="map-row"><div><strong>${esc(LABEL[f][0])}</strong>${required.includes(f) ? ' <span style="color:var(--berry)" aria-label="required">*</span>' : ''}${LABEL[f][1] ? `<br><small>${esc(LABEL[f][1])}</small>` : ''}</div>
              <div><select data-field="${esc(f)}" aria-label="Column for ${esc(LABEL[f][0])}">${options(parsed.headers.map((h) => ({ value: h, label: h })), mapping[f] || '', { blank: required.includes(f) ? 'Choose a column' : 'Not in my file' })}</select>
              <small>Example: <span data-sample="${esc(f)}">${esc(mapping[f] ? sample(mapping[f]) : '') || DASH}</span></small></div></div>`).join('')}
          </div>
          <div class="err" id="im-err" role="alert"></div>
          <div class="row"><button class="btn primary" id="im-check">Check the file</button><small>This only checks; nothing is saved yet.</small></div>
        </div>`;
      body.querySelector('#im-restart').addEventListener('click', () => { parsed = null; mapping = {}; step = 'file'; draw(); });
      body.querySelectorAll('[data-field]').forEach((sel) => sel.addEventListener('change', () => {
        if (sel.value) mapping[sel.dataset.field] = sel.value; else delete mapping[sel.dataset.field];
        body.querySelector(`[data-sample="${sel.dataset.field}"]`).textContent = (sel.value && sample(sel.value)) || DASH;
      }));
      body.querySelector('#im-check').addEventListener('click', async () => {
        const err = body.querySelector('#im-err');
        const missing = required.filter((f) => !mapping[f]);
        if (missing.length) { err.textContent = `Choose a column for: ${missing.map((f) => LABEL[f][0]).join(', ')}.`; return; }
        err.textContent = '';
        const btn = body.querySelector('#im-check');
        btn.disabled = true;
        try {
          staged = await api.import.stage({ kind, mapping: { ...mapping }, rows: parsed.rows });
          preview = await api.import.preview(staged.batchId);
          filter = 'all'; step = 'preview'; draw();
        } catch (e) { err.textContent = errMessage(e); btn.disabled = false; }
      });
    }

    // ---- 3. preview
    const STATUS = { ok: ['Will import', 'ok'], duplicate: ['Duplicate - skipped', 'mute'], quarantined: ['Quarantined', 'bad'] };
    function detail(r) {
      const t = r.target;
      const raw = parsed?.rows[r.rowNo - 1]?.values || {};
      const g = (f) => (mapping[f] ? raw[mapping[f]] : '') || '';
      if (kind === 'children') return t ? `${esc(t.admissionNo)} &middot; ${esc(`${t.firstName} ${t.lastName}`.trim())} &middot; born ${fdate(t.dob)}` : `${esc(g('admissionNo') || DASH)} &middot; ${esc(`${g('firstName')} ${g('lastName')}`.trim() || DASH)}`;
      return t ? `${esc(t.admissionNo)} &middot; ${esc(t.installment)} &middot; due ${fdate(t.dueDate)} &middot; ${money(t.outstandingPaise)}` : `${esc(g('admissionNo') || DASH)} &middot; ${esc(g('installment') || DASH)}`;
    }
    function drawPreview(body) {
      const c = preview.counts;
      const shown = preview.rows.filter((r) => filter === 'all' || (filter === 'problems' ? r.status !== 'ok' : r.status === filter));
      body.innerHTML = `<div class="grid cols-4" style="margin-bottom:12px">
          <div class="kpi"><div class="v">${esc(c.inputRows)}</div><div class="l">rows in file</div></div>
          <div class="kpi good"><div class="v">${esc(c.ok)}</div><div class="l">will import</div></div>
          <div class="kpi"><div class="v">${esc(c.duplicate)}</div><div class="l">duplicates (skipped)</div></div>
          <div class="kpi ${c.quarantined ? 'bad' : ''}"><div class="v">${esc(c.quarantined)}</div><div class="l">quarantined (not imported)</div></div>
        </div>
        <p class="muted">Rows in file ${esc(c.inputRows)} = will import ${esc(c.ok)} + duplicates ${esc(c.duplicate)} + quarantined ${esc(c.quarantined)}. ${kind === 'children' ? `Parent records: ${esc(preview.guardians?.new ?? DASH)} new, ${esc(preview.guardians?.merged ?? DASH)} matched to a parent already counted (siblings or existing).` : `Outstanding to be carried over: <strong>${money(preview.sourceOutstandingPaise)}</strong> across ${esc(c.ok)} rows.`}</p>
        ${c.quarantined ? banner('warn', 'Quarantined rows are <strong>not</strong> imported. Fix them in your file and import again - rows already imported are recognised and skipped, so this is safe.') : ''}
        <div class="row" style="margin-bottom:10px"><div class="seg">${[['all', 'All'], ['ok', 'Will import'], ['duplicate', 'Duplicates'], ['quarantined', 'Quarantined']].map(([v, l]) => `<button data-f="${v}" aria-pressed="${filter === v}">${l}</button>`).join('')}</div>
          ${c.quarantined || c.duplicate ? '<button class="btn sm" id="im-dl">Download problem rows (CSV)</button>' : ''}</div>
        ${shown.length ? `<div class="tablewrap"><table><thead><tr><th>Line</th><th>Row</th><th>Status</th><th>Reason</th></tr></thead><tbody>
          ${shown.slice(0, 300).map((r) => `<tr class="${r.status === 'quarantined' ? 'row-bad' : ''}"><td class="num">${esc(r.line)}</td><td>${detail(r)}</td><td>${badge(STATUS[r.status][0], STATUS[r.status][1])}</td><td>${esc(r.reason || DASH)}</td></tr>`).join('')}
          </tbody></table></div>${shown.length > 300 ? `<small class="muted">Showing the first 300 of ${esc(shown.length)} rows. Download the problem rows for the full list.</small>` : ''}` : empty('No rows in this view')}
        <div class="sticky-actions row"><button class="btn primary" id="im-go"${c.ok ? '' : ' disabled'}>Import ${esc(c.ok)} row${c.ok === 1 ? '' : 's'}</button><button class="btn" id="im-back">Back to columns</button></div>`;
      body.querySelectorAll('[data-f]').forEach((b) => b.addEventListener('click', () => { filter = b.dataset.f; drawPreview(body); }));
      body.querySelector('#im-back').addEventListener('click', () => { step = 'map'; draw(); });
      body.querySelector('#im-dl')?.addEventListener('click', () => downloadProblems(preview.rows));
      body.querySelector('#im-go').addEventListener('click', doImport);
    }

    function downloadProblems(rows) {
      const bad = rows.filter((r) => r.status !== 'ok');
      const head = ['Line', 'Status', 'Reason', ...parsed.headers];
      const lines = [head.map(csvCell).join(',')].concat(bad.map((r) => [r.line, r.status, r.reason || '', ...parsed.headers.map((h) => parsed.rows[r.rowNo - 1]?.values[h] ?? '')].map(csvText).join(',')));
      downloadText(`import-problems_${kind}.csv`, lines.join('\r\n'), 'text/csv');
    }

    async function doImport() {
      const n = preview.counts.ok;
      if (!(await confirmDialog('Import', `Import ${n} row${n === 1 ? '' : 's'} now? This creates real records. Quarantined rows and duplicates are skipped.`, { okLabel: `Import ${n}` }))) return;
      const r = await attempt(() => api.import.commit(staged.batchId));
      if (!r.ok) return;
      result = r.value; step = 'done'; draw();
    }

    // ---- 4. done
    function drawDone(body) {
      const r = result;
      const ties = r.inputRows === r.ok + r.quarantined + r.duplicate;
      const rec = kind === 'fees' ? r.openingBalancePaise === r.sourceOutstandingPaise : true;
      body.innerHTML = `${banner(ties && rec ? 'ok' : 'bad', `<strong>Import finished.</strong> Rows in file ${esc(r.inputRows)} = imported ${esc(r.ok)} + duplicates ${esc(r.duplicate)} + quarantined ${esc(r.quarantined)}${ties ? '.' : ' - <strong>these do not add up; tell the developer.</strong>'}`)}
        <div class="grid cols-4" style="margin-bottom:12px">
          ${kind === 'children'
            ? `<div class="kpi good"><div class="v">${esc(r.created?.students ?? DASH)}</div><div class="l">children added</div></div>
               <div class="kpi good"><div class="v">${esc(r.created?.guardians ?? DASH)}</div><div class="l">parent records added</div></div>
               <div class="kpi"><div class="v">${esc(r.merged?.guardians ?? DASH)}</div><div class="l">matched to an existing parent</div></div>`
            : `<div class="kpi good"><div class="v">${esc(r.created?.invoices ?? DASH)}</div><div class="l">opening-balance invoices</div></div>
               <div class="kpi ${rec ? 'good' : 'bad'}"><div class="v">${money(r.openingBalancePaise)}</div><div class="l">carried over</div></div>
               <div class="kpi"><div class="v">${money(r.sourceOutstandingPaise)}</div><div class="l">outstanding in your file</div></div>`}
        </div>
        ${kind === 'fees' && !rec ? banner('bad', '<strong>The carried-over total does not equal the total in your file.</strong> Do not rely on these balances; tell the developer.') : ''}
        <div class="row">
          ${r.quarantined || r.duplicate ? '<button class="btn" id="im-dl">Download problem rows (CSV)</button>' : ''}
          ${kind === 'children' ? '<a class="btn primary" href="#/import/fees">Import outstanding fees next</a><a class="btn" href="#/invites">Issue invite codes</a>' : '<a class="btn primary" href="#/fees">Open fees</a>'}
          <button class="btn ghost" id="im-again">Import another file</button></div>`;
      body.querySelector('#im-dl')?.addEventListener('click', () => downloadProblems(r.rows?.length ? r.rows : preview.rows));
      body.querySelector('#im-again').addEventListener('click', () => { parsed = null; mapping = {}; staged = null; preview = null; result = null; step = 'file'; draw(); });
    }

    draw();
  };
}
