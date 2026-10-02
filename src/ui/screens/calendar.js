// Month grid with Holidays / Events / Birthdays filters and a programme filter.
import { todayISO, daysInMonth, dayOfWeek, isWeekend, MONTHS, compareISO } from '../../domain/dates.js';
import { esc, icon, badge, empty, pageHead, fdate, options, formModal, confirmDialog, attempt, indexBy } from '../components.js';

const pad = (n) => String(n).padStart(2, '0');
const CAT = { holiday: 'holiday', birthday: 'birthday' }; // everything else = 'event'
const catOf = (e) => CAT[e.type] || 'event';
const TYPE_LABEL = { holiday: 'Holiday', event: 'Event', ptm: 'PTM', halfDay: 'Half day', workingSaturday: 'Working Saturday', birthday: 'Birthday' };
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function monthShift(ym, delta) {
  let [y, m] = ym.split('-').map(Number);
  m += delta;
  while (m < 1) { m += 12; y -= 1; }
  while (m > 12) { m -= 12; y += 1; }
  return `${y}-${pad(m)}`;
}

async function eventForm(ctx, ayId, existing) {
  const progs = ctx.db.programs;
  const e = existing || { type: 'event', title: '', startDate: todayISO(), endDate: todayISO(), programIds: [], description: '' };
  const fields = `
    <label class="field"><span class="lbl">Type</span><select name="type">${options(['event', 'holiday', 'ptm', 'halfDay', 'workingSaturday'].map((t) => ({ value: t, label: TYPE_LABEL[t] })), e.type)}</select></label>
    <label class="field"><span class="lbl">Title</span><input name="title" required value="${esc(e.title)}" maxlength="120"></label>
    <div class="grid cols-2"><label class="field"><span class="lbl">Start date</span><input type="date" name="startDate" required value="${esc(e.startDate)}"></label>
    <label class="field"><span class="lbl">End date (inclusive)</span><input type="date" name="endDate" required value="${esc(e.endDate)}"></label></div>
    <fieldset class="field" style="border:0;padding:0;margin:0 0 12px"><legend class="lbl" style="font-size:.82rem;font-weight:800">Applies to</legend>
      <small>Leave all unticked for the whole school.</small>
      ${progs.map((p) => `<label class="check sm"><input type="checkbox" name="programIds" value="${esc(p.id)}"${e.programIds.includes(p.id) ? ' checked' : ''}> ${esc(p.name)}</label>`).join('')}</fieldset>
    <label class="field"><span class="lbl">Description (optional)</span><textarea name="description">${esc(e.description || '')}</textarea></label>`;
  return formModal({
    title: existing ? 'Edit calendar entry' : 'Add calendar entry', fieldsHtml: fields,
    onSubmit: async (v) => {
      const payload = { type: v.type, title: v.title.trim(), startDate: v.startDate, endDate: v.endDate || v.startDate, programIds: [].concat(v.programIds || []), description: (v.description || '').trim() };
      if (existing) await ctx.api.calendar.update(existing.id, payload);
      else await ctx.api.calendar.create({ ...payload, academicYearId: ayId });
    },
  });
}

export async function render(ctx) {
  const { api, db, persona, query } = ctx;
  const years = await api.calendar.academicYears();
  if (!years.length) { ctx.el.innerHTML = `${pageHead('Calendar')}${empty('No academic year set up')}`; return; }
  const ay = years.find((y) => y.id === query.ay) || years.find((y) => y.id === db.school.currentAcademicYearId) || years[0];
  const today = todayISO();

  let month = query.month;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month || '')) month = today >= ay.startDate && today <= ay.endDate ? today.slice(0, 7) : ay.startDate.slice(0, 7);
  const [y, m] = month.split('-').map(Number);
  const first = `${month}-01`;
  const last = `${month}-${pad(daysInMonth(y, m))}`;
  const canPrev = monthShift(month, -1) >= ay.startDate.slice(0, 7);
  const canNext = monthShift(month, 1) <= ay.endDate.slice(0, 7);

  const cats = new Set((query.t || 'holiday,event,birthday').split(',').filter(Boolean));
  const admin = persona.role === 'admin';
  // teachers and parents may only filter by their own programmes; other roles see all
  const scoped = persona.role === 'teacher' || persona.role === 'parent';
  const myProgIds = scoped ? (persona.programIds || []) : db.programs.map((p) => p.id);
  const offered = persona.role === 'driver' ? [] : db.programs.filter((p) => myProgIds.includes(p.id));
  const programId = offered.some((p) => p.id === query.program) ? query.program : '';

  let all;
  if (programId || !scoped) all = await api.calendar.events({ academicYearId: ay.id, programId: programId || undefined });
  else {
    // "all my programmes" = union over the persona's own programmes (never an unscoped fetch)
    const seen = new Map();
    for (const pid of myProgIds) for (const e of await api.calendar.events({ academicYearId: ay.id, programId: pid })) seen.set(e.id, e);
    all = [...seen.values()].sort((a, b) => (a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : 0));
  }
  if (persona.role === 'parent') { const mine = new Set(persona.studentIds || []); all = all.filter((e) => e.type !== 'birthday' || mine.has(e.studentId)); }
  const shown = all.filter((e) => cats.has(catOf(e)));
  const inMonth = shown.filter((e) => compareISO(e.startDate, last) <= 0 && compareISO(e.endDate, first) >= 0);

  // grid
  const lead = dayOfWeek(first);
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push('<div class="day out"></div>');
  for (let d = 1; d <= daysInMonth(y, m); d++) {
    const iso = `${month}-${pad(d)}`;
    const evs = inMonth.filter((e) => e.startDate <= iso && iso <= e.endDate);
    const hol = all.some((e) => e.type === 'holiday' && e.startDate <= iso && iso <= e.endDate && (!e.programIds.length || e.programIds.includes(programId)));
    // same rule as domain isWorkingDay(date, programId): school-wide events always apply; programme-specific ones only for that programme
    const wsat = all.some((e) => e.type === 'workingSaturday' && e.startDate <= iso && iso <= e.endDate && (!e.programIds.length || (programId && e.programIds.includes(programId))));
    const off = hol || (isWeekend(iso, db.school.weeklyOffs) && !wsat);
    cells.push(`<div class="day${off ? ' off' : ''}${iso === today ? ' today' : ''}" title="${esc(evs.map((e) => e.title).join('; '))}">
      <div class="dn"><span>${d}</span></div>
      ${evs.slice(0, 3).map((e) => `<span class="ev ${esc(e.type)}">${esc(e.title)}</span>`).join('')}${evs.length > 3 ? `<span class="ev" style="background:none">+${evs.length - 3}</span>` : ''}</div>`);
  }

  const q = (patch) => ctx.href('/calendar', { ay: ay.id, month, t: [...cats].join(','), program: programId, ...patch });
  const chip = (cat, label) => {
    const next = new Set(cats);
    next.has(cat) ? next.delete(cat) : next.add(cat);
    return `<a class="chip" aria-pressed="${cats.has(cat)}" href="${esc(q({ t: [...next].join(',') || 'none' }))}"><span class="dot ${cat === 'event' ? 'event' : cat}"></span>${label}</a>`;
  };

  const progs = indexBy(db.programs);
  const list = inMonth.map((e) => {
    const scope = e.type === 'birthday' ? '' : e.programIds.length ? e.programIds.map((id) => badge(progs.get(id)?.name || id, 'info')).join(' ') : badge('Whole school', 'mute');
    const editable = admin && e.source !== 'derived' && e.type !== 'birthday';
    return `<li><div class="row"><span class="dot ${esc(e.type)}"></span><div class="grow"><div class="item-title">${esc(e.title)}</div>
      <small>${fdate(e.startDate)}${e.endDate !== e.startDate ? ' to ' + fdate(e.endDate) : ''} &middot; ${esc(TYPE_LABEL[e.type] || e.type)}${e.source === 'import' ? ' &middot; imported' : ''}${e.leapDayShifted ? ' &middot; born 29 Feb, shown on 28 Feb in non-leap years' : ''}</small></div>
      ${scope}${editable ? `<button class="btn sm" data-edit="${esc(e.id)}">Edit</button><button class="btn sm ghost" data-del="${esc(e.id)}">Delete</button>` : ''}</div></li>`;
  });

  ctx.el.innerHTML = `${pageHead('Calendar', `${ay.label || ay.id}`, admin ? `<a class="btn" href="#/calendar/import">${icon('upload', 'sm')} Import CSV</a><button class="btn primary" id="c-add">${icon('plus', 'sm')} Add entry</button>` : '')}
    <div class="row" style="margin-bottom:10px">
      ${chip('holiday', 'Holidays')}${chip('event', 'Events')}${chip('birthday', 'Birthdays')}
      ${offered.length ? `<label class="row" style="gap:6px"><span class="lbl" style="font-weight:800;font-size:.82rem">Programme</span>
        <select id="c-prog" style="width:auto;min-height:38px">${options(offered.map((p) => ({ value: p.id, label: p.name })), programId, { blank: scoped ? 'All my programmes' : 'All programmes' })}</select></label>` : ''}
      ${years.length > 1 ? `<select id="c-ay" style="width:auto;min-height:38px" aria-label="Academic year">${options(years.map((a) => ({ value: a.id, label: a.label || a.id })), ay.id)}</select>` : ''}
    </div>
    <div class="row between" style="margin-bottom:8px">
      ${canPrev ? `<a class="btn sm" href="${esc(q({ month: monthShift(month, -1) }))}">&larr; ${MONTHS[Number(monthShift(month, -1).slice(5)) - 1]}</a>` : '<span></span>'}
      <h2 style="margin:0">${MONTHS[m - 1]} ${y}</h2>
      ${canNext ? `<a class="btn sm" href="${esc(q({ month: monthShift(month, 1) }))}">${MONTHS[Number(monthShift(month, 1).slice(5)) - 1]} &rarr;</a>` : '<span></span>'}
    </div>
    <div class="cal" role="grid" aria-label="${MONTHS[m - 1]} ${y}">${DOW.map((d) => `<div class="dow">${d}</div>`).join('')}${cells.join('')}</div>
    <p class="muted" style="font-size:.8rem;margin-top:6px">Shaded days are weekly offs or holidays${programId ? ` for ${esc(progs.get(programId)?.name || '')}` : ' for the whole school'}. Birthdays on 29 Feb are shown on 28 Feb in non-leap years.</p>
    <h2 style="margin-top:16px">This month</h2>
    ${list.length ? `<ul class="list card-list">${list.join('')}</ul>` : empty('Nothing in this view', cats.size ? 'No entries for this month and filters.' : 'All filters are off.')}`;

  ctx.el.querySelector('#c-prog')?.addEventListener('change', (e) => ctx.setQuery({ program: e.target.value }));
  ctx.el.querySelector('#c-ay')?.addEventListener('change', (e) => ctx.setQuery({ ay: e.target.value, month: '' }));
  ctx.el.querySelector('#c-add')?.addEventListener('click', async () => { if (await eventForm(ctx, ay.id)) ctx.rerender(); });
  ctx.el.addEventListener('click', async (e) => {
    const ed = e.target.closest('[data-edit]');
    const dl = e.target.closest('[data-del]');
    if (ed) { const ev = all.find((x) => x.id === ed.dataset.edit); if (ev && await eventForm(ctx, ay.id, ev)) ctx.rerender(); }
    if (dl) {
      const ev = all.find((x) => x.id === dl.dataset.del);
      if (ev && await confirmDialog('Delete calendar entry', `Delete "${ev.title}"? This is recorded in the audit log.`, { okLabel: 'Delete', kind: 'danger' })) {
        if ((await attempt(() => api.calendar.remove(ev.id), 'Deleted')).ok) ctx.rerender();
      }
    }
  });
}
