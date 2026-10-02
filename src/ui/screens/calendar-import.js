// Holiday-list CSV import: choose file -> preview with counts -> confirm. Nothing is written until confirmed.
import { esc, badge, empty, pageHead, options, readFileText, attempt, toast, errMessage, fdate, indexBy, DASH } from '../components.js';

const STATUS = {
  ok: ['Will import', 'ok'], duplicate: ['Duplicate - skipped', 'mute'], outsideYear: ['Outside academic year', 'warn'], rejected: ['Rejected', 'bad'],
};

export async function render(ctx) {
  const { api, db } = ctx;
  const years = await api.calendar.academicYears();
  const progs = indexBy(db.programs);
  let ayId = (years.find((y) => y.id === db.school.currentAcademicYearId) || years[0])?.id;
  let text = '';
  let preview = null;
  let result = null;

  const draw = () => {
    ctx.el.innerHTML = `${pageHead('Import holiday list', 'Upload a CSV, review the preview, then confirm', '<a class="btn" href="#/calendar">Back to calendar</a>')}
      <div class="card stack">
        <label class="field"><span class="lbl">Academic year</span><select id="i-ay">${options(years.map((y) => ({ value: y.id, label: y.label || y.id })), ayId)}</select></label>
        <label class="field"><span class="lbl">CSV file</span><input type="file" id="i-file" accept=".csv,text/csv,text/plain"></label>
        <details><summary class="muted" style="cursor:pointer;font-weight:700">Or paste CSV text</summary><textarea id="i-text" style="margin-top:8px;font-family:monospace" placeholder="title,start_date,end_date,type,programs">${esc(text)}</textarea></details>
        <div class="help"><strong>Dates are read day-first:</strong> DD-MM-YYYY and DD/MM/YYYY mean day, then month - never guessed. Also accepted: YYYY-MM-DD and DD-MMM-YYYY. Columns: title, start date, end date (optional), type (optional, default holiday), programmes (optional; separate several with | or ;). Quoted titles may contain commas.</div>
        <div class="row"><button class="btn primary" id="i-prev">Preview</button></div>
      </div>
      ${preview ? previewHtml() : ''}${result ? resultHtml() : ''}`;
    ctx.el.querySelector('#i-ay').addEventListener('change', (e) => { ayId = e.target.value; preview = null; result = null; draw(); });
    ctx.el.querySelector('#i-file').addEventListener('change', async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      try { text = await readFileText(f); } catch (err) { toast(`Could not read the file: ${errMessage(err)}`, 'bad'); return; }
      await runPreview();
    });
    ctx.el.querySelector('#i-prev').addEventListener('click', async () => {
      text = ctx.el.querySelector('#i-text').value || text;
      await runPreview();
    });
    ctx.el.querySelector('#i-go')?.addEventListener('click', doImport);
  };

  async function runPreview() {
    result = null;
    if (!text.trim()) { preview = null; draw(); return; }
    const r = await attempt(() => api.calendar.previewHolidayCsv(text, ayId));
    preview = r.ok ? r.value : null;
    draw();
  }

  async function doImport() {
    const include = ctx.el.querySelector('#i-out')?.checked || false;
    const r = await attempt(() => api.calendar.importHolidays(preview, { includeOutsideYear: include }), 'Import complete');
    if (r.ok) { result = r.value; preview = null; text = ''; draw(); }
  }

  function previewHtml() {
    const c = preview.counts;
    const importable = c.ok;
    return `<h2 style="margin-top:18px">Preview</h2>
      <div class="grid cols-4" style="margin-bottom:12px">
        <div class="kpi"><div class="v">${esc(c.inputRows)}</div><div class="l">rows in file</div></div>
        <div class="kpi good"><div class="v">${esc(c.ok)}</div><div class="l">will import</div></div>
        <div class="kpi"><div class="v">${esc(c.duplicate)}</div><div class="l">duplicates (skipped)</div></div>
        <div class="kpi ${c.rejected ? 'bad' : ''}"><div class="v">${esc(c.rejected)}</div><div class="l">rejected</div></div>
      </div>
      ${c.outsideYear ? `<div class="banner warn"><label class="check"><input type="checkbox" id="i-out"> Include ${esc(c.outsideYear)} row${c.outsideYear === 1 ? '' : 's'} outside the academic year</label><small>Unticked rows are not imported and are counted as rejected in the result.</small></div>` : ''}
      ${preview.rows.length ? `<div class="tablewrap"><table><thead><tr><th>Line</th><th>Title</th><th>Dates</th><th>Type</th><th>Applies to</th><th>Status</th></tr></thead><tbody>
        ${preview.rows.map((r) => `<tr class="${r.status === 'rejected' ? 'row-bad' : ''}"><td class="num">${esc(r.line)}</td><td>${esc(r.title || DASH)}</td>
          <td class="nowrap">${r.startDate ? fdate(r.startDate) : DASH}${r.endDate && r.endDate !== r.startDate ? ' to ' + fdate(r.endDate) : ''}</td>
          <td>${esc(r.type)}</td><td>${r.programIds.length ? r.programIds.map((id) => esc(progs.get(id)?.name || id)).join(', ') : 'Whole school'}</td>
          <td>${badge(STATUS[r.status][0], STATUS[r.status][1])}${r.reason ? `<div><small>${esc(r.reason)}</small></div>` : ''}</td></tr>`).join('')}
      </tbody></table></div>` : empty('No data rows found in the file')}
      <div class="sticky-actions row"><button class="btn primary" id="i-go"${importable || c.outsideYear ? '' : ' disabled'}>Confirm import</button><small>Counts reconcile: rows in file = imported + duplicates + rejected.</small></div>`;
  }

  function resultHtml() {
    return `<div class="banner ok" style="margin-top:18px"><strong>Import finished.</strong>
      Rows in file ${esc(result.inputRows)} = imported ${esc(result.imported)} + duplicates skipped ${esc(result.skippedDuplicate)} + rejected ${esc(result.rejected)}.
      <a href="#/calendar">View the calendar</a></div>
      ${result.rejectedRows?.length ? `<ul class="list card-list">${result.rejectedRows.map((r) => `<li>Line ${esc(r.line)}: ${esc(r.reason)}</li>`).join('')}</ul>` : ''}`;
  }

  draw();
}
