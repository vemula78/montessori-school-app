// Promote levels for the new academic year (principal): Toddlers → Mont 1 → Mont 2 → Mont 3 (Mont 3 stays). Preview
// first (api.people.promotionPreview), untick a child to keep them at their level, then confirm
// (api.people.promoteLevels). Safe to run twice: a child already done for that year is not changed again.
import { esc, banner, empty, pageHead, badge, options, confirmDialog, attempt } from '../components.js';
import { LEVEL_LABEL, yearText } from '../eval-labels.js';

const OUTCOME = { promote: ['Moves up', 'clay'], final: ['Stays at Mont 3', 'mute'], noLevel: ['No level set', 'warn'], already: ['Already done for this year', 'ok'] };

let result = null; // the last run's counts, shown once on the next drawing

export async function render(ctx) {
  const { api, db, query } = ctx;
  const years = [...(db.academicYears || [])].sort((a, b) => (a.startDate < b.startDate ? -1 : 1));
  const cur = years.findIndex((a) => a.id === db.school.currentAcademicYearId);
  const ay = years.find((a) => a.id === query.ay) || years[cur + 1] || years[cur] || years[years.length - 1];
  if (!ay) { ctx.el.innerHTML = `${pageHead('Promote levels')}${empty('No academic year set up')}`; return; }
  const plan = await api.people.promotionPreview(ay.id);
  const prog = new Map((db.programs || []).map((p) => [p.id, p.name]));
  const shown = result && result.toAcademicYearId === ay.id ? result : null;
  result = null;
  const lv = (x) => (x ? LEVEL_LABEL[x] || x : '—');
  ctx.el.innerHTML = `${pageHead('Promote levels', `Progress Report levels for ${yearText(ay)}`, `<a class="btn" href="${esc(ctx.href('/evaluations'))}">&larr; Progress Reports</a>`)}
    ${shown ? banner('ok', `<strong>Done for ${esc(yearText(ay))}:</strong> ${esc(shown.promoted)} moved up, ${esc(shown.skipped)} kept at their level, ${esc(shown.final)} at Mont 3, ${esc(shown.noLevel)} without a level, ${esc(shown.already)} already done (${esc(shown.children)} children).`) : ''}
    <label class="field" style="max-width:280px"><span class="lbl">Promote to the academic year</span><select id="pl-ay">${options(years.map((a) => ({ value: a.id, label: a.label || a.id })), ay.id)}</select></label>
    <p class="muted">Each child moves up one level for the new year; Mont 3 stays Mont 3. Untick a child to keep them at their level. Progress reports already started keep the level they were started with. Running this again changes nothing for children already done.</p>
    <div class="grid cols-4" style="margin-bottom:12px">${[['promote', plan.promote], ['final', plan.final], ['noLevel', plan.noLevel], ['already', plan.already]].map(([k, n]) => `<div class="kpi"><div class="v">${esc(n)}</div><div class="l">${esc(OUTCOME[k][0].toLowerCase())}</div></div>`).join('')}</div>
    ${plan.rows.length ? `<form id="pl-form"><div class="tablewrap"><table><thead><tr><th>Move up</th><th>Child</th><th>Class</th><th>Level now</th><th>New level</th><th>Outcome</th></tr></thead><tbody>
      ${plan.rows.map((r) => `<tr><td>${r.outcome === 'promote' ? `<input type="checkbox" name="move" value="${esc(r.studentId)}" checked aria-label="Move ${esc(r.name)} up to ${esc(lv(r.to))}" style="width:22px;height:22px">` : ''}</td>
        <td>${esc(r.name)}</td><td>${esc(prog.get(r.programId) || '—')}</td><td>${esc(lv(r.from))}</td><td>${esc(r.outcome === 'promote' ? lv(r.to) : r.outcome === 'final' ? lv(r.from) : '—')}</td><td>${badge(...OUTCOME[r.outcome])}</td></tr>`).join('')}
      </tbody></table></div>
      <div class="sticky-actions"><button class="btn primary" type="submit"${plan.promote ? '' : ' disabled'}>Promote</button> <span class="muted" id="pl-count"></span></div></form>`
    : empty('No children attending')}`;

  ctx.el.querySelector('#pl-ay').addEventListener('change', (e) => ctx.setQuery({ ay: e.target.value }));
  const form = ctx.el.querySelector('#pl-form');
  if (!form) return;
  const promoteIds = plan.rows.filter((r) => r.outcome === 'promote').map((r) => r.studentId);
  const skipOf = () => { const on = new Set(new FormData(form).getAll('move')); return promoteIds.filter((id) => !on.has(id)); };
  const countEl = ctx.el.querySelector('#pl-count');
  const showCount = () => { const skip = skipOf().length; countEl.textContent = `${promoteIds.length - skip} will move up${skip ? `, ${skip} kept back` : ''}`; };
  if (promoteIds.length) showCount();
  form.addEventListener('change', showCount);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const skip = skipOf();
    const n = promoteIds.length - skip.length;
    if (!(await confirmDialog('Promote levels', `Move ${n} ${n === 1 ? 'child' : 'children'} up one level for ${yearText(ay)}${skip.length ? ` and keep ${skip.length} at their level` : ''}?`, { okLabel: 'Promote' }))) return;
    const r = await attempt(() => api.people.promoteLevels({ toAcademicYearId: ay.id, skip }), 'Levels updated');
    if (r.ok) { result = r.value; ctx.rerender(); }
  });
}
