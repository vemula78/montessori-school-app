// Learning > Curriculum: the school's list of presentations. The principal loads the starter list, imports the
// school's own CSV (preview first; counts must add up), adds, renames, retires and restores. Teachers read it.
// Nothing is ever deleted: a retired presentation stays for the history that refers to it.
import { esc, badge, banner, empty, options, formModal, confirmDialog, attempt, readFileText, errMessage, toast, DASH } from '../components.js';
import { AREA_KEYS, AREA_LABEL } from '../learn-labels.js';

const STATUS = { ok: ['Will import', 'ok'], duplicate: ['Duplicate - skipped', 'mute'], rejected: ['Rejected', 'bad'] };
const ages = (p) => (p.ageFromMonths == null && p.ageToMonths == null ? DASH
  : `${p.ageFromMonths == null ? '' : esc(p.ageFromMonths)}&ndash;${p.ageToMonths == null ? '' : esc(p.ageToMonths)} months`);

export async function renderCurriculum(ctx, host) {
  const { api, persona, query } = ctx;
  const admin = persona.role === 'admin';
  const area = AREA_KEYS.includes(query.area) ? query.area : 'practicalLife';
  let all = await api.curriculum.list({});
  let importOpen = false, text = '', preview = null, result = null, starter = null;

  const reload = async () => { all = await api.curriculum.list({}); };
  const summary = () => AREA_KEYS.map((a) => { const l = all.filter((p) => p.area === a); return `${esc(AREA_LABEL[a])} ${esc(l.filter((p) => p.active).length)}`; }).join(' &middot; ');

  function draw() {
    const rows = all.filter((p) => p.area === area);
    host.innerHTML = `<div class="stack">
      <div class="row between"><p class="muted" style="margin:0">${all.length ? `${esc(all.filter((p) => p.active).length)} active presentations: ${summary()}` : 'No presentations yet.'}</p>
        ${admin ? `<div class="row"><button class="btn primary" id="c-add">Add presentation</button><button class="btn" id="c-starter">Load starter list</button><button class="btn" id="c-import">Import CSV</button></div>` : ''}</div>
      ${starter ? banner('ok', `Starter list: ${esc(starter.inputRows)} rows = ${esc(starter.added)} added + ${esc(starter.skippedExisting)} already in the app.`) : ''}
      ${admin && importOpen ? importPanel() : ''}${result ? resultHtml() : ''}
      <div class="seg" role="tablist" aria-label="Area">${AREA_KEYS.map((a) => `<a href="${esc(ctx.href('/learning', { tab: 'curriculum', area: a, program: query.program }))}"${a === area ? ' aria-current="page"' : ''}>${esc(AREA_LABEL[a])}</a>`).join('')}</div>
      <label class="field" style="margin:0"><span class="lbl">Filter by name</span><input id="c-q" type="search" placeholder="Type to filter" autocomplete="off"></label>
      <div class="lbox" id="c-list">${rows.length ? rows.map((p) => `<div class="lrow${p.active ? '' : ' retired'}" data-name="${esc(p.name.toLowerCase())}"><div><div class="lname">${esc(p.name)}</div>
        <small>${ages(p)}${p.active ? '' : ' &middot; retired'}${p.source === 'manual' ? ' &middot; added by the school' : p.source === 'import' ? ' &middot; imported' : ''}</small>${p.description ? `<div><small>${esc(p.description)}</small></div>` : ''}</div>
        ${admin ? `<div class="row"><button class="btn" data-edit="${esc(p.id)}">Edit</button><button class="btn" data-${p.active ? 'retire' : 'restore'}="${esc(p.id)}">${p.active ? 'Retire' : 'Restore'}</button></div>` : ''}</div>`).join('')
        : empty('No presentations in this area', admin ? 'Load the starter list or import your own CSV.' : 'The principal sets up the curriculum.')}</div></div>`;
    wire();
  }

  function importPanel() {
    return `<div class="card stack"><h3>Import your own list (CSV)</h3>
      <label class="field"><span class="lbl">CSV file</span><input type="file" id="i-file" accept=".csv,text/csv,text/plain"></label>
      <details><summary class="muted" style="cursor:pointer;font-weight:700">Or paste CSV text</summary><textarea id="i-text" style="margin-top:8px;font-family:monospace" placeholder="area,name,sequence,age_from_months,age_to_months,description">${esc(text)}</textarea></details>
      <div class="help">First row is a header with at least <strong>area</strong> and <strong>name</strong>. Optional: sequence, age_from_months, age_to_months, description. Area is practicalLife, sensorial, language, math or culture. A row that repeats one already in the app is skipped, never changed. See <code>data/curriculum-sample.csv</code> for an example.</div>
      <div class="row"><button class="btn primary" id="i-prev">Preview</button><button class="btn" id="i-close">Close</button></div>
      ${preview ? previewHtml() : ''}</div>`;
  }

  function previewHtml() {
    const c = preview.counts;
    const lines = [
      ...preview.rows.map((r) => ({ line: r.line, kind: 'ok', area: r.presentation.area, name: r.presentation.name, ages: ages(r.presentation) })),
      ...preview.duplicates.map((r) => ({ line: r.line, kind: 'duplicate', reason: r.reason })),
      ...preview.rejected.map((r) => ({ line: r.line, kind: 'rejected', reason: r.reason })),
    ].sort((a, b) => a.line - b.line);
    return `<div class="grid cols-4">
        <div class="kpi"><div class="v">${esc(c.inputRows)}</div><div class="l">rows in file</div></div>
        <div class="kpi good"><div class="v">${esc(c.imported)}</div><div class="l">will import</div></div>
        <div class="kpi"><div class="v">${esc(c.skippedDuplicate)}</div><div class="l">duplicates (skipped)</div></div>
        <div class="kpi ${c.rejected ? 'bad' : ''}"><div class="v">${esc(c.rejected)}</div><div class="l">rejected</div></div></div>
      ${lines.length ? `<div class="tablewrap"><table><thead><tr><th>Line</th><th>Presentation</th><th>Status</th></tr></thead><tbody>${lines.map((r) => `<tr class="${r.kind === 'rejected' ? 'row-bad' : ''}"><td class="num">${esc(r.line)}</td>
        <td>${r.name ? `${esc(r.name)}<div><small>${esc(AREA_LABEL[r.area] || r.area)} &middot; ${r.ages}</small></div>` : DASH}</td>
        <td>${badge(STATUS[r.kind][0], STATUS[r.kind][1])}${r.reason ? `<div><small>${esc(r.reason)}</small></div>` : ''}</td></tr>`).join('')}</tbody></table></div>` : empty('No data rows found in the file')}
      <div class="row"><button class="btn primary" id="i-go"${c.imported ? '' : ' disabled'}>Confirm import</button><small>Counts reconcile: rows in file = imported + duplicates + rejected.</small></div>`;
  }

  function resultHtml() {
    return `<div class="banner ok"><strong>Import finished.</strong> Rows in file ${esc(result.inputRows)} = imported ${esc(result.imported)} + duplicates skipped ${esc(result.skippedDuplicate)} + rejected ${esc(result.rejected)}.</div>
      ${result.rejectedRows?.length ? `<ul class="list card-list">${result.rejectedRows.map((r) => `<li>Line ${esc(r.line)}: ${esc(r.reason)}</li>`).join('')}</ul>` : ''}`;
  }

  async function runPreview() {
    result = null;
    if (!text.trim()) { preview = null; draw(); return; }
    const r = await attempt(() => api.curriculum.previewCsv(text));
    preview = r.ok ? r.value : null;
    draw();
  }

  function form(p = null) {
    return formModal({
      title: p ? 'Edit presentation' : 'Add presentation', submitLabel: p ? 'Save changes' : 'Add',
      fieldsHtml: `<label class="field"><span class="lbl">Area</span><select name="area">${options(AREA_KEYS.map((a) => ({ value: a, label: AREA_LABEL[a] })), p ? p.area : area)}</select></label>
        <label class="field"><span class="lbl">Name</span><input name="name" value="${esc(p ? p.name : '')}" maxlength="120" required></label>
        <div class="grid cols-3"><label class="field"><span class="lbl">Order</span><input type="number" name="sequence" min="0" step="1" value="${esc(p ? p.sequence : '')}"></label>
        <label class="field"><span class="lbl">Age from (months)</span><input type="number" name="ageFromMonths" min="0" step="1" value="${esc(p?.ageFromMonths ?? '')}"></label>
        <label class="field"><span class="lbl">Age to (months)</span><input type="number" name="ageToMonths" min="0" step="1" value="${esc(p?.ageToMonths ?? '')}"></label></div>
        <label class="field"><span class="lbl">Description (optional)</span><textarea name="description" maxlength="500" style="min-height:60px">${esc(p ? p.description : '')}</textarea></label>
        ${p ? '<div class="help">Renaming keeps the history: progress records and reports follow the presentation, not its name.</div>' : ''}`,
      onSubmit: async (v) => {
        const num = (x) => (x === '' || x == null ? null : Number(x));
        await api.curriculum.save({ ...(p ? { id: p.id } : {}), area: v.area, name: v.name, sequence: num(v.sequence), ageFromMonths: num(v.ageFromMonths), ageToMonths: num(v.ageToMonths), description: v.description || '' });
      },
    });
  }

  function wire() {
    host.querySelector('#c-q')?.addEventListener('input', (e) => {
      const q = e.target.value.trim().toLowerCase();
      host.querySelectorAll('#c-list [data-name]').forEach((r) => r.classList.toggle('hide', !!q && !r.dataset.name.includes(q)));
    });
    host.querySelector('#c-add')?.addEventListener('click', async () => { if (await form()) { await reload(); draw(); } });
    host.querySelector('#c-starter')?.addEventListener('click', async () => {
      const r = await attempt(() => api.curriculum.loadStarter());
      if (r.ok) { starter = r.value; await reload(); draw(); }
    });
    host.querySelector('#c-import')?.addEventListener('click', () => { importOpen = !importOpen; draw(); });
    host.querySelector('#i-close')?.addEventListener('click', () => { importOpen = false; preview = null; draw(); });
    host.querySelector('#i-file')?.addEventListener('change', async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      try { text = await readFileText(f); } catch (err) { toast(`Could not read the file: ${errMessage(err)}`, 'bad'); return; }
      await runPreview();
    });
    host.querySelector('#i-prev')?.addEventListener('click', async () => { text = host.querySelector('#i-text')?.value || text; await runPreview(); });
    host.querySelector('#i-go')?.addEventListener('click', async () => {
      const r = await attempt(() => api.curriculum.importCsv(text), 'Import complete');
      if (r.ok) { result = r.value; preview = null; text = ''; importOpen = false; starter = null; await reload(); draw(); }
    });
    host.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', async () => { if (await form(all.find((p) => p.id === b.dataset.edit))) { await reload(); draw(); } }));
    host.querySelectorAll('[data-retire]').forEach((b) => b.addEventListener('click', async () => {
      if (await confirmDialog('Retire presentation', 'It disappears from the forms but stays in every child’s history and report. You can restore it.', { okLabel: 'Retire' }) && (await attempt(() => api.curriculum.retire(b.dataset.retire), 'Retired')).ok) { await reload(); draw(); }
    }));
    host.querySelectorAll('[data-restore]').forEach((b) => b.addEventListener('click', async () => {
      if ((await attempt(() => api.curriculum.restore(b.dataset.restore), 'Restored')).ok) { await reload(); draw(); }
    }));
  }

  draw();
}
