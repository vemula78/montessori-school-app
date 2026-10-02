// Daily diary: teachers add observations / meals / sleep / health / activity; parents read their own child's day.
import { todayISO, addDays, isISODate } from '../../domain/dates.js';
import { esc, notifyQuota, empty, pageHead, fdate, ftime, fullName, options, formModal, DASH } from '../components.js';

const AREAS = { practicalLife: 'Practical life', sensorial: 'Sensorial', language: 'Language', math: 'Mathematics', culture: 'Culture' };
const ATE = { all: 'Ate everything', some: 'Ate some', none: 'Did not eat' };
const TYPES = { observation: 'Observation', meal: 'Meal', sleep: 'Sleep', health: 'Health', activity: 'Activity' };

function entryHtml(e) {
  const d = e.data || {};
  let body = '';
  switch (e.type) {
    case 'observation': body = `<strong>${esc(AREAS[d.area] || d.area || DASH)}</strong> &mdash; ${esc(d.text || DASH)}`; break;
    case 'meal': body = `<strong>${esc(d.meal === 'snack' ? 'Snack' : d.meal === 'lunch' ? 'Lunch' : d.meal || 'Meal')}</strong>: ${esc(ATE[d.ate] || d.ate || DASH)}${d.note ? ` &mdash; ${esc(d.note)}` : ''}`; break;
    case 'sleep': body = `<strong>Nap</strong> ${esc(d.from || DASH)} to ${esc(d.to || DASH)}`; break;
    case 'health': body = `<strong>Health</strong> &mdash; temperature ${d.temperatureC == null ? DASH : esc(d.temperatureC) + ' °C'}${d.note ? `, ${esc(d.note)}` : ''}`; break;
    default: body = `<strong>Activity</strong> &mdash; ${esc(d.text || DASH)}`;
  }
  return `<div class="diary-entry ${esc(e.type)}">${body}<div><small>${esc(TYPES[e.type] || e.type)} &middot; ${ftime(e.createdAt)}</small></div></div>`;
}

function typeFields(type) {
  switch (type) {
    case 'observation': return `<label class="field"><span class="lbl">Montessori area</span><select name="area">${options(Object.entries(AREAS).map(([value, label]) => ({ value, label })), 'practicalLife')}</select></label>
      <label class="field"><span class="lbl">What did you observe?</span><textarea name="text" required></textarea></label>`;
    case 'meal': return `<label class="field"><span class="lbl">Meal</span><select name="meal"><option value="snack">Snack</option><option value="lunch">Lunch</option></select></label>
      <label class="field"><span class="lbl">How much</span><select name="ate">${options(Object.entries(ATE).map(([value, label]) => ({ value, label })), 'all')}</select></label>
      <label class="field"><span class="lbl">Note (optional)</span><input name="note"></label>`;
    case 'sleep': return `<div class="grid cols-2"><label class="field"><span class="lbl">From</span><input type="time" name="from" required></label><label class="field"><span class="lbl">To</span><input type="time" name="to" required></label></div>`;
    case 'health': return `<label class="field"><span class="lbl">Temperature °C (leave blank if not taken)</span><input type="number" name="temperatureC" step="0.1" min="30" max="45"></label>
      <label class="field"><span class="lbl">Note</span><textarea name="note" required></textarea></label>`;
    default: return `<label class="field"><span class="lbl">Activity</span><textarea name="text" required></textarea></label>`;
  }
}

function buildData(type, v) {
  if (type === 'observation') return { area: v.area, text: (v.text || '').trim() };
  if (type === 'meal') return { meal: v.meal, ate: v.ate, note: (v.note || '').trim() };
  if (type === 'sleep') return { from: v.from, to: v.to };
  if (type === 'health') return { temperatureC: v.temperatureC === '' || v.temperatureC == null ? null : Number(v.temperatureC), note: (v.note || '').trim() };
  return { text: (v.text || '').trim() };
}

async function addEntry(ctx, student, date) {
  return formModal({
    title: `Add diary entry - ${student.firstName}`, submitLabel: 'Save entry',
    fieldsHtml: `<label class="field"><span class="lbl">Type</span><select name="type" id="d-type">${options(Object.entries(TYPES).map(([value, label]) => ({ value, label })), 'observation')}</select></label><div id="d-fields">${typeFields('observation')}</div>`,
    onOpen: (d) => {
      const sel = d.querySelector('#d-type');
      sel.addEventListener('change', () => { d.querySelector('#d-fields').innerHTML = typeFields(sel.value); });
    },
    onSubmit: async (v) => {
      await ctx.api.diary.add({ studentId: student.id, date, type: v.type, data: buildData(v.type, v) });
    },
  });
}

async function staffView(ctx) {
  const { api, db, persona, query } = ctx;
  const progs = persona.role === 'teacher' ? db.programs.filter((p) => (persona.programIds || []).includes(p.id)) : db.programs;
  if (!progs.length) { ctx.el.innerHTML = `${pageHead('Daily diary')}${empty('No programme assigned to you')}`; return; }
  const programId = progs.find((p) => p.id === query.program)?.id || progs[0].id;
  const today = todayISO();
  const date = isISODate(query.date) ? query.date : today;
  const students = (await api.people.students({ programId })).filter((s) => s.status === 'active');
  const entries = await api.diary.forProgramDate(programId, date);
  ctx.el.innerHTML = `${pageHead('Daily diary', progs.find((p) => p.id === programId).name)}
    <div class="row" style="margin-bottom:12px">
      ${progs.length > 1 ? `<select id="d-prog" style="width:auto" aria-label="Programme">${options(progs.map((p) => ({ value: p.id, label: p.name })), programId)}</select>` : ''}
      <button class="btn sm" id="d-prev" aria-label="Previous day">&larr;</button><input type="date" id="d-date" value="${esc(date)}" style="width:auto" aria-label="Date"><button class="btn sm" id="d-next" aria-label="Next day">&rarr;</button>
      <span class="muted">${fdate(date)}</span></div>
    <div class="stack">${students.length ? students.map((s) => {
      const mine = entries.filter((e) => e.studentId === s.id);
      return `<div class="card stack"><div class="row between"><div class="item-title">${esc(fullName(s))}</div><button class="btn sm primary" data-add="${esc(s.id)}">Add entry</button></div>
        ${mine.length ? mine.map(entryHtml).join('') : '<small class="muted">No entries for this day.</small>'}</div>`;
    }).join('') : empty('No children in this programme')}</div>`;
  const go = (patch) => ctx.setQuery({ program: programId, date, ...patch });
  ctx.el.querySelector('#d-prog')?.addEventListener('change', (e) => go({ program: e.target.value }));
  ctx.el.querySelector('#d-date').addEventListener('change', (e) => e.target.value && go({ date: e.target.value }));
  ctx.el.querySelector('#d-prev').addEventListener('click', () => go({ date: addDays(date, -1) }));
  ctx.el.querySelector('#d-next').addEventListener('click', () => go({ date: addDays(date, 1) }));
  ctx.el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-add]');
    if (!b) return;
    const s = students.find((x) => x.id === b.dataset.add);
    if (await addEntry(ctx, s, date)) ctx.rerender();
  });
}

async function parentView(ctx) {
  const { api, persona, query } = ctx;
  const kids = (await api.people.childrenOf(persona.guardianId)).filter((k) => k.status === 'active'); // children who left have no diary access
  if (!kids.length) { ctx.el.innerHTML = `${pageHead('Daily diary')}${empty('No children linked to this account')}`; return; }
  const kid = kids.find((k) => k.id === query.student) || kids[0];
  const today = todayISO();
  const date = isISODate(query.date) ? query.date : today;
  const entries = (await api.diary.forStudentDate(kid.id, date)).slice().sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  for (const e of entries) if (!e.parentReadAt) { try { await api.diary.markRead(e.id); } catch (err) { notifyQuota(err); /* read marker is not critical, but a full store must still raise the warning */ } }
  ctx.el.innerHTML = `${pageHead('Daily diary', fullName(kid))}
    <div class="row" style="margin-bottom:12px">
      ${kids.length > 1 ? `<div class="seg" role="tablist">${kids.map((k) => `<button role="tab" aria-pressed="${k.id === kid.id}" data-kid="${esc(k.id)}">${esc(k.firstName)}</button>`).join('')}</div>` : ''}
      <button class="btn sm" id="d-prev" aria-label="Previous day">&larr;</button><input type="date" id="d-date" value="${esc(date)}" style="width:auto" aria-label="Date"><button class="btn sm" id="d-next" aria-label="Next day">&rarr;</button>
      <span class="muted">${fdate(date)}</span></div>
    <div class="stack">${entries.length ? entries.map(entryHtml).join('') : empty('No diary entries for this day', 'Entries appear here as the teacher adds them.')}</div>`;
  const go = (patch) => ctx.setQuery({ student: kid.id, date, ...patch });
  ctx.el.querySelectorAll('[data-kid]').forEach((b) => b.addEventListener('click', () => go({ student: b.dataset.kid })));
  ctx.el.querySelector('#d-date').addEventListener('change', (e) => e.target.value && go({ date: e.target.value }));
  ctx.el.querySelector('#d-prev').addEventListener('click', () => go({ date: addDays(date, -1) }));
  ctx.el.querySelector('#d-next').addEventListener('click', () => go({ date: addDays(date, 1) }));
}

export async function render(ctx) {
  if (ctx.persona.role === 'parent') await parentView(ctx); else await staffView(ctx);
}
