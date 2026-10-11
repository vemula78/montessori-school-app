// Daily attendance for one programme. Non-working days are refused by the api (single source of truth).
import { todayISO, addDays, isISODate } from '../../domain/dates.js';
import { esc, empty, pageHead, fdate, fullName, options, attempt, indexBy, toast, DASH } from '../components.js';

const OPTS = [['present', 'P', 'p', 'Present'], ['absent', 'A', 'a', 'Absent'], ['late', 'L', 'l', 'Late'], ['leave', 'Lv', 'v', 'On leave']];

export async function render(ctx) {
  const { api, db, persona, query } = ctx;
  const progs = persona.role === 'teacher' ? db.programs.filter((p) => (persona.programIds || []).includes(p.id)) : db.programs;
  if (!progs.length) { ctx.el.innerHTML = `${pageHead('Attendance')}${empty('No programme assigned to you')}`; return; }
  const programId = progs.find((p) => p.id === query.program)?.id || progs[0].id;
  const today = todayISO();
  const date = isISODate(query.date) ? query.date : today;

  const [rows, working, leave] = await Promise.all([
    api.attendance.forDate(date, programId),
    api.calendar.isWorkingDay(date, programId),
    api.care.leave({ programId, from: date }).catch(() => []),
  ]);
  // absences parents reported: shown above the register; an unmarked child on one is pre-ticked "On leave" (not saved)
  const reported = leave.filter((r) => r.status === 'active');
  const leaveToday = new Map(reported.filter((r) => r.fromDate <= date && date <= r.toDate).map((r) => [r.studentId, r]));
  const stu = indexBy(db.students);

  let reason = '';
  if (!working) {
    try {
      const evs = await api.calendar.events({ academicYearId: db.school.currentAcademicYearId, programId });
      const h = evs.find((e) => e.type === 'holiday' && e.startDate <= date && date <= e.endDate);
      reason = h ? `Holiday: ${h.title}` : 'Weekly off';
    } catch { reason = 'Weekly off or holiday'; }
  }

  const prevWorking = async () => {
    let d = addDays(date, -1);
    for (let i = 0; i < 30; i++, d = addDays(d, -1)) if (await api.calendar.isWorkingDay(d, programId)) return d;
    return null;
  };

  // summary for the last 14 days (counts per student)
  const from = addDays(date, -13);
  const summaries = new Map();
  for (const r of rows) { try { summaries.set(r.studentId, await api.attendance.summary(r.studentId, from, date)); } catch { /* shown as dash */ } }
  const sc = (s, k) => { const o = s?.counts ?? s; return o && o[k] != null ? o[k] : DASH; };

  ctx.el.innerHTML = `${pageHead('Attendance', progs.find((p) => p.id === programId).name)}
    <div class="row" style="margin-bottom:12px">
      ${progs.length > 1 ? `<select id="a-prog" aria-label="Programme" style="width:auto">${options(progs.map((p) => ({ value: p.id, label: p.name })), programId)}</select>` : ''}
      <button class="btn sm" id="a-prev" aria-label="Previous day">&larr;</button>
      <input type="date" id="a-date" value="${esc(date)}" style="width:auto" aria-label="Date">
      <button class="btn sm" id="a-next" aria-label="Next day">&rarr;</button>
      ${date !== today ? '<button class="btn sm" id="a-today">Today</button>' : ''}
      <span class="muted">${fdate(date)}</span>
    </div>
    ${reported.length ? `<div class="card stack" style="margin-bottom:12px"><h2 style="margin:0">Absences reported by parents</h2><ul class="list">${reported.map((r) => `<li><div class="row between"><div><div class="item-title">${esc(fullName(stu.get(r.studentId)))}</div>
      <small>${fdate(r.fromDate)}${r.toDate !== r.fromDate ? ` to ${fdate(r.toDate)}` : ''}${r.reason ? ` &middot; ${esc(r.reason)}` : ''}</small></div>
      ${r.seenAt ? '<span class="badge ok">Seen</span>' : `<button class="btn sm" data-seen="${esc(r.id)}">Mark seen</button>`}</div></li>`).join('')}</ul></div>` : ''}
    ${working ? '' : `<div class="banner warn"><strong>${esc(reason)}.</strong> This is not a working day, so attendance cannot be saved.
      <div class="row" style="margin-top:6px"><button class="btn sm" id="a-lastwork">Go to previous working day</button></div></div>`}
    ${rows.length ? `
    <form id="a-form"><fieldset${working ? '' : ' disabled'} style="border:0;margin:0;padding:0;min-width:0"><div class="card flat" style="padding:0;overflow:hidden">
      ${rows.map((r) => {
        const s = stu.get(r.studentId);
        const sm = summaries.get(r.studentId);
        const lv = leaveToday.get(r.studentId);
        const pick = r.status || (lv ? 'leave' : null);
        return `<div class="att-row"><div><div class="item-title">${esc(fullName(s))}</div><small>last 14 days: ${sc(sm, 'present')} present, ${sc(sm, 'absent')} absent</small>${lv ? `<br><small><strong>Absence reported</strong>${lv.reason ? `: ${esc(lv.reason)}` : ''}${r.status ? '' : ' (pre-ticked; save to record)'}</small>` : ''}</div>
          <div class="att-opts" role="radiogroup" aria-label="Attendance for ${esc(fullName(s))}">${OPTS.map(([val, short, cls, label]) => `<label title="${label}"><input type="radio" name="st-${esc(r.studentId)}" value="${val}"${pick === val ? ' checked' : ''}><span class="${cls}">${short}</span></label>`).join('')}</div></div>`;
      }).join('')}
    </div>
    <div class="sticky-actions row"><button type="button" class="btn" id="a-allp">Mark all present</button><button type="submit" class="btn primary">Save attendance</button>
      <small>P present &middot; A absent &middot; L late &middot; Lv on leave</small></div></fieldset></form>` : empty('No children in this programme')}`;

  const go = (patch) => ctx.setQuery({ program: programId, date, ...patch });
  ctx.el.querySelector('#a-prog')?.addEventListener('change', (e) => go({ program: e.target.value }));
  ctx.el.querySelector('#a-date').addEventListener('change', (e) => e.target.value && go({ date: e.target.value }));
  ctx.el.querySelector('#a-prev').addEventListener('click', () => go({ date: addDays(date, -1) }));
  ctx.el.querySelector('#a-next').addEventListener('click', () => go({ date: addDays(date, 1) }));
  ctx.el.querySelector('#a-today')?.addEventListener('click', () => go({ date: today }));
  ctx.el.querySelector('#a-lastwork')?.addEventListener('click', async () => { const d = await prevWorking(); d ? go({ date: d }) : toast('No working day found in the last 30 days', 'bad'); });
  ctx.el.querySelector('#a-allp')?.addEventListener('click', () => rows.forEach((r) => {
    // children with a reported absence keep "On leave"; everyone else unmarked becomes present
    if (leaveToday.has(r.studentId) && !r.status) return;
    const i = ctx.el.querySelector(`input[name="st-${CSS.escape(r.studentId)}"][value="present"]`);
    if (i) i.checked = true;
  }));
  ctx.el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-seen]');
    if (b && (await attempt(() => api.care.markLeaveSeen(b.dataset.seen), 'Marked seen')).ok) ctx.rerender();
  });
  ctx.el.querySelector('#a-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const marks = rows.map((r) => ({ studentId: r.studentId, status: e.target.querySelector(`input[name="st-${CSS.escape(r.studentId)}"]:checked`)?.value })).filter((x) => x.status);
    if (!marks.length) { toast('Choose a status for at least one child', 'bad'); return; }
    const ok = await attempt(() => api.attendance.mark(date, marks), `Saved ${marks.length} record${marks.length === 1 ? '' : 's'}`);
    if (ok.ok) ctx.rerender();
  });
}
