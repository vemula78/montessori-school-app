// A4 termly report for reading and printing (browser "Save as PDF"). Bare route: #/print/report/:id.
// The report is the frozen copy made at generation and published by the principal; parents can open published
// reports of their own children only (the api refuses anything else). The public demo uses the school's real name,
// so every demo report is stamped DEMO, and an unpublished one is stamped as a draft.
import { esc, fdate, fdatetime, empty, notFoundOrThrow, DASH } from '../components.js';
import { isRealMode } from '../mode.js';
import { AREA_KEYS, AREA_LABEL, STATUS_LABEL, NARRATIVE_LABEL } from '../learn-labels.js';

export async function render(ctx) {
  const { api, db } = ctx;
  const r = await api.reports.get(ctx.params.id).catch(notFoundOrThrow);
  if (!r) { ctx.el.innerHTML = `${empty('Report not found')}<p><a class="btn" href="#/learning">Back to learning</a></p>`; return; }
  const s = await api.people.student(r.studentId).catch(notFoundOrThrow);
  const ay = (db.academicYears || []).find((a) => a.id === r.academicYearId);
  const school = db.school || {};
  // this route prints on A4, over print.css's A5 receipt page; removed again when the route is left
  const style = document.createElement('style');
  style.textContent = '@page { size: A4; margin: 14mm; }';
  document.head.appendChild(style);
  ctx.cleanup(() => style.remove());

  const published = r.status === 'published';
  const stamps = [!isRealMode() ? 'DEMO &mdash; NOT A REAL REPORT' : '', published ? '' : 'DRAFT &mdash; NOT PUBLISHED'].filter(Boolean);
  const area = (a) => {
    const lines = r.progress.filter((x) => x.area === a);
    const narr = r.narratives?.[a];
    if (!lines.length && !narr) return '';
    return `<section class="area"><h2>${esc(AREA_LABEL[a])}</h2>${narr ? `<p class="narr">${esc(narr)}</p>` : ''}
      ${lines.length ? `<div class="tablewrap"><table><thead><tr><th>Presentation</th><th>Where the child is</th><th>Date</th></tr></thead><tbody>${lines.map((x) => `<tr><td>${esc(x.name)}</td><td>${esc(STATUS_LABEL[x.status] || x.status)}</td><td class="nowrap">${fdate(x.date)}</td></tr>`).join('')}</tbody></table></div>` : ''}</section>`;
  };
  const areas = AREA_KEYS.map(area).join('');
  ctx.el.innerHTML = `
    <div class="no-print row between" style="max-width:794px;margin:0 auto 12px">
      <button class="btn" id="r-back">&larr; Back</button>
      <button class="btn primary" id="r-print">Print / Save as PDF</button>
    </div>
    <article class="report" aria-label="Termly report for ${esc(s ? s.firstName : 'the child')}, ${esc(r.termName)}">
      ${stamps.map((t) => `<div class="stamp">${t}</div>`).join('')}
      <h1>${esc(school.name || '')}</h1>
      <div class="addr">${esc(school.address || '')}${school.phone ? ' &middot; ' + esc(school.phone) : ''}</div>
      <div class="title">TERMLY LEARNING REPORT</div>
      <dl>
        <dt>Child</dt><dd>${esc(s ? `${s.firstName} ${s.lastName}`.trim() : DASH)}</dd>
        <dt>Programme</dt><dd>${esc(s?.programName || DASH)}</dd>
        <dt>Academic year</dt><dd>${esc(ay?.label || r.academicYearId)}</dd>
        <dt>Term</dt><dd>${esc(r.termName)} &middot; ${fdate(r.fromDate)} to ${fdate(r.toDate)}</dd>
        <dt>${published ? 'Published' : 'Status'}</dt><dd>${published ? fdatetime(r.publishedAt) : 'Draft'}</dd>
      </dl>
      ${r.narratives?.overall ? `<section class="area"><h2>${esc(NARRATIVE_LABEL.overall)}</h2><p class="narr">${esc(r.narratives.overall)}</p></section>` : ''}
      ${areas || '<p class="muted">No progress was recorded for this term.</p>'}
      ${r.observations.length ? `<section class="area"><h2>Observations shared during the term</h2><ul class="list obs-list">${r.observations.map((o) => `<li><small>${fdate(o.date)} &middot; ${esc(AREA_LABEL[o.area] || o.area)}</small><div>${esc(o.text)}</div></li>`).join('')}</ul></section>` : ''}
      <div class="sign"><span>Class teacher</span><span>Principal</span></div>
      <p class="note">Photos shared during the term stay in the app and are not part of this report.${!isRealMode() ? ' Prototype with fake data. Not a real report.' : ''}</p>
    </article>`;
  ctx.el.querySelector('#r-print').addEventListener('click', () => window.print());
  ctx.el.querySelector('#r-back').addEventListener('click', () => (history.length > 1 ? history.back() : ctx.go('/learning')));
}
