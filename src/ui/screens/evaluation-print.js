// The annual Progress Report as the school's template lays it out, for reading and printing on A4 (browser "Save as
// PDF"). Bare route: #/print/evaluation/:id. Parents (either guardian with an account) reach published reports of
// their own children only (the api refuses anything else); staff reach every report of their class, a draft stamped.
// Signature images arrive as Blobs from the api and are shown through object URLs only, revoked when the page is left.
// The footer comes from the school's settings (Settings > School details): an empty setting is left out, never filled in.
import { esc, fdate, empty, notFoundOrThrow, DASH } from '../components.js';
import { isRealMode } from '../mode.js';
import { RATING_LABEL } from '../eval-labels.js';

const CULTURAL = 'Cultural Studies';

/** The report sheet's HTML. urls: one object URL (or null) per d.signers entry. */
export function sheetHtml(d, urls, { demo = false, staff = false } = {}) {
  const h = d.header;
  const stamps = [demo ? 'DEMO &mdash; NOT A REAL REPORT' : '', d.draft ? 'DRAFT &mdash; NOT PUBLISHED' : ''].filter(Boolean);
  let prevGroup = null;
  const tables = d.sections.map((s) => {
    const groupRow = s.group && s.group !== prevGroup ? `<tr class="grp"><th colspan="2">${esc(s.group)}</th></tr>` : '';
    prevGroup = s.group || null;
    const cultural = s.title === CULTURAL;
    return `<table class="evr-t">
      <thead>${groupRow}<tr class="sec"><th>${esc(s.title)}${cultural ? '*' : ''}</th><th class="sc">${esc(s.scale).replace('/', '/<wbr>')}</th></tr></thead>
      <tbody>${s.items.map((it) => `<tr><td>${esc(it.label)}</td><td class="sc">${it.rating ? esc(RATING_LABEL[it.rating] || it.rating) : DASH}</td></tr>`).join('')}</tbody></table>
      ${cultural ? `<p class="evr-note">${esc(d.footnote)}</p>` : ''}`;
  }).join('');
  const sig = (role) => d.signers.map((x, i) => ({ ...x, url: urls[i] })).filter((x) => x.role === role);
  const sigCell = (role, label) => `<div class="evr-signer"><div class="evr-sigimgs">${sig(role).filter((x) => x.url).map((x) => `<img src="${esc(x.url)}" alt="Signature of ${esc(x.name || label)}">`).join('')}</div><span>${esc(label)}</span></div>`;
  const f = d.school.footer || {};
  const footParts = [f.address, (f.phones || []).filter(Boolean).join(' / '), f.email, f.website].map((x) => String(x || '').trim()).filter(Boolean);
  const unsigned = d.signers.filter((x, i) => !urls[i]).map((x) => x.name || (x.role === 'director' ? 'the director' : DASH));
  return `${staff && unsigned.length ? `<div class="no-print banner warn" style="max-width:794px;margin:0 auto 12px">No signature on file for: ${esc(unsigned.join(', '))}. Upload them on the Signatures page; the report prints without them.</div>` : ''}
    <article class="evr" aria-label="Progress report for ${esc(h.name)}, ${esc(h.year)}">
      ${stamps.map((t) => `<div class="stamp">${t}</div>`).join('')}
      <header class="evr-head">
        ${d.school.name ? `<div class="evr-school">${esc(d.school.name)}</div>` : ''}
        <div class="evr-level">${esc(h.levelTitle)}</div>
        <div class="evr-title">${esc(h.title)}</div>
        <div class="evr-year">YEAR: ${esc(h.year)}</div>
      </header>
      <table class="evr-id"><tbody>
        <tr><th>Name</th><td>${esc(h.name)}</td></tr>
        <tr><th>Date of Birth</th><td>${fdate(h.dob)}</td></tr>
        <tr><th>Admission Number</th><td>${esc(h.admissionNo || DASH)}</td></tr></tbody></table>
      ${tables}
      <table class="evr-t evr-att"><thead><tr class="sec"><th colspan="2">Attendance</th></tr></thead><tbody>
        <tr><td>Total working days</td><td class="sc">${esc(d.attendance.workingDays ?? DASH)}</td></tr>
        <tr><td>Days present</td><td class="sc">${esc(d.attendance.present ?? DASH)}</td></tr></tbody></table>
      <div class="evr-remarks"><div class="evr-rh">General Remarks</div><p>${esc(d.remarks || '')}</p></div>
      <div class="evr-sign">${sigCell('teacher', 'Signature of Teachers')}${sigCell('centerHead', 'Signature of Center Head')}${sigCell('director', 'Signature of Director')}</div>
      ${footParts.length ? `<footer class="evr-foot">${footParts.map((x) => esc(x)).join(' &middot; ')}</footer>` : ''}
      ${demo ? '<p class="evr-demo">Prototype with fake data. Not a real report.</p>' : ''}
    </article>`;
}

export async function render(ctx) {
  const { api, persona } = ctx;
  const d = await api.evaluations.printData(ctx.params.id).catch(notFoundOrThrow);
  const backTo = persona.role === 'parent' ? '/learning' : '/evaluations';
  if (!d) { ctx.el.innerHTML = `${empty('Progress report not found')}<p><a class="btn" href="#${esc(backTo)}">Back</a></p>`; return; }
  // this route prints on A4, over print.css's A5 receipt page; removed again when the route is left
  const style = document.createElement('style');
  style.textContent = '@page { size: A4; margin: 12mm; }';
  document.head.appendChild(style);
  ctx.cleanup(() => style.remove());
  const urls = d.signers.map((x) => (x.blob ? URL.createObjectURL(x.blob) : null));
  ctx.cleanup(() => urls.forEach((u) => { if (u) URL.revokeObjectURL(u); }));
  ctx.el.innerHTML = `
    <div class="no-print row between" style="max-width:794px;margin:0 auto 12px">
      <button class="btn" id="r-back">&larr; Back</button>
      <button class="btn primary" id="r-print">Print / Save as PDF</button>
    </div>
    ${sheetHtml(d, urls, { demo: !isRealMode(), staff: persona.role !== 'parent' })}`;
  ctx.el.querySelector('#r-print').addEventListener('click', () => window.print());
  ctx.el.querySelector('#r-back').addEventListener('click', () => (history.length > 1 ? history.back() : ctx.go(backTo)));
}
