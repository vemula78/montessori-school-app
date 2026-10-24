// Daily diary: teachers add meals / sleep / health / activity; parents read their own child's day.
// Observations moved to Learning (staff-only until shared). Old diary entries of type 'observation' are still shown.
import { todayISO, addDays, isISODate, nowHHMM, tsToMs } from '../../domain/dates.js';
import { esc, notifyQuota, empty, pageHead, fdate, ftime, fdatetime, fullName, options, formModal, openModal, attempt, toast, badge, DASH } from '../components.js';
import { loadAlerts, alertsUnavailable, healthBadge, wireHealthBadges } from '../health-alerts.js';

const AREAS = { practicalLife: 'Practical life', sensorial: 'Sensorial', language: 'Language', math: 'Mathematics', culture: 'Culture' };
const ATE = { all: 'Ate everything', some: 'Ate some', none: 'Did not eat' };
const TYPES = { observation: 'Observation', meal: 'Meal', sleep: 'Sleep', health: 'Health', activity: 'Activity', toilet: 'Toilet', needs: 'Please send' };
const ADD_TYPES = { meal: 'Meal', sleep: 'Sleep', health: 'Health', activity: 'Activity' }; // the diary is parent-visible by design: observations are written in Learning
// toileting is offered for toddlers only; "please send" for every child (#83)
const addTypes = (toddler) => Object.entries({ ...ADD_TYPES, ...(toddler ? { toilet: 'Toilet / nappy' } : {}), needs: 'Please send (ask the family)' })
  .map(([value, label]) => ({ value, label }));
const isToddler = (s, programName = '') => s.level === 'toddlers' || (!s.level && /toddler/i.test(programName));
const TOILET = { wet: 'Wet nappy', dry: 'Dry nappy', bowel: 'Bowel movement', toilet: 'Used the toilet' };
const NEED_ITEMS = { spareClothes: 'spare clothes', nappies: 'nappies', wipes: 'wipes', other: 'something else' };
const needsText = (d) => [...(d.items || []).filter((i) => i !== 'other').map((i) => NEED_ITEMS[i] || i), ...(d.note ? [d.note] : [])].join(', ') || DASH;
const SNAPSHOT_DAYS = 30; // the real app loads diary entries of the last 30 days (my_snapshot, migration 0003)
const CHANGE_WINDOW_MS = 24 * 3600_000; // as the domain allows (DIARY_CHANGE_WINDOW_MS)
const NEEDS = [['lunch', 'Lunch'], ['sleep', 'Nap'], ['snack', 'Snack']];
const mealNow = () => (nowHHMM() >= '11:00' ? 'lunch' : 'snack');

function entryHtml(e, actions = '') {
  const d = e.data || {};
  let body = '';
  switch (e.type) {
    case 'observation': body = `<strong>${esc(AREAS[d.area] || d.area || DASH)}</strong> &mdash; ${esc(d.text || DASH)}`; break;
    case 'meal': body = `<strong>${esc(d.meal === 'snack' ? 'Snack' : d.meal === 'lunch' ? 'Lunch' : d.meal || 'Meal')}</strong>: ${esc(ATE[d.ate] || d.ate || DASH)}${d.note ? ` &mdash; ${esc(d.note)}` : ''}`; break;
    case 'sleep': body = `<strong>Nap</strong> ${esc(d.from || DASH)} to ${esc(d.to || DASH)}`; break;
    case 'health': body = `<strong>Health</strong> &mdash; ${[d.temperatureC == null ? '' : `temperature ${esc(d.temperatureC)} °C`, d.note ? esc(d.note) : ''].filter(Boolean).join(', ') || DASH}`; break;
    case 'toilet': body = `<strong>${esc(TOILET[d.kind] || d.kind || 'Toilet')}</strong> at ${esc(d.time || DASH)}${d.note ? ` &mdash; ${esc(d.note)}` : ''}`; break;
    case 'needs': body = `<strong>Please send to school:</strong> ${esc(needsText(d))}`; break;
    default: body = `<strong>Activity</strong> &mdash; ${esc(d.text || DASH)}`;
  }
  return `<div class="diary-entry ${esc(e.type)}">${body}<div><small>${esc(TYPES[e.type] || e.type)} &middot; ${ftime(e.createdAt)}${e.correctedAt ? ' &middot; corrected' : ''}</small></div>${actions}</div>`;
}

/** Staff see whether the family has answered a "please send" request. */
const needsStatus = (e) => `<div>${e.ackAt ? badge(`Family will send it (${fdatetime(e.ackAt)})`, 'ok') : badge('Family has not answered yet', 'warn')}</div>`;
/** The parent's answer to a "please send" request: one tap, once. */
const needsAnswer = (e) => (e.type !== 'needs' ? '' : e.ackAt ? `<div>${badge(`You said you will send it (${fdatetime(e.ackAt)})`, 'ok')}</div>`
  : `<div class="row" style="margin-top:6px"><button class="btn sm primary" data-ack="${esc(e.id)}">I will send it</button></div>`);

// d: the values to start from (an entry being corrected; the last nap times); a meal starts on lunch from 11:00
function typeFields(type, d = {}) {
  switch (type) {
    case 'meal': return `<label class="field"><span class="lbl">Meal</span><select name="meal">${options([{ value: 'snack', label: 'Snack' }, { value: 'lunch', label: 'Lunch' }], d.meal || mealNow())}</select></label>
      <label class="field"><span class="lbl">How much</span><select name="ate">${options(Object.entries(ATE).map(([value, label]) => ({ value, label })), d.ate || 'all')}</select></label>
      <label class="field"><span class="lbl">Note (optional)</span><input name="note" value="${esc(d.note || '')}"></label>`;
    case 'sleep': return `<div class="grid cols-2"><label class="field"><span class="lbl">From</span><input type="time" name="from" value="${esc(d.from || '')}" required></label><label class="field"><span class="lbl">To</span><input type="time" name="to" value="${esc(d.to || '')}" required></label></div>`;
    case 'health': return `<label class="field"><span class="lbl">Temperature °C (leave blank if not taken)</span><input type="number" name="temperatureC" step="0.1" min="30" max="45" value="${esc(d.temperatureC ?? '')}"></label>
      <label class="field"><span class="lbl">Note</span><textarea name="note" required>${esc(d.note || '')}</textarea></label>`;
    case 'toilet': return `<div class="grid cols-2"><label class="field"><span class="lbl">Time</span><input type="time" name="time" value="${esc(d.time || nowHHMM())}" required></label>
      <label class="field"><span class="lbl">What</span><select name="kind">${options(Object.entries(TOILET).map(([value, label]) => ({ value, label })), d.kind || 'wet')}</select></label></div>
      <label class="field"><span class="lbl">Note (optional)</span><input name="note" maxlength="200" value="${esc(d.note || '')}"></label>`;
    case 'needs': return `<fieldset class="field" style="border:0;padding:0;margin:0 0 12px"><legend class="lbl" style="font-size:.82rem;font-weight:800">Ask the family to send</legend>
      ${Object.entries(NEED_ITEMS).map(([k, l]) => `<label class="check sm"><input type="checkbox" name="items" value="${esc(k)}"${(d.items || []).includes(k) ? ' checked' : ''}> ${esc(l[0].toUpperCase() + l.slice(1))}</label>`).join('')}</fieldset>
      <label class="field"><span class="lbl">Note (needed for "something else")</span><input name="note" maxlength="200" value="${esc(d.note || '')}" placeholder="For example: a warm sweater"></label>
      <small>The family is told in the app and taps "I will send it".</small>`;
    default: return `<label class="field"><span class="lbl">Activity</span><textarea name="text" required>${esc(d.text || '')}</textarea></label>`;
  }
}

function buildData(type, v) {
  if (type === 'meal') return { meal: v.meal, ate: v.ate, note: (v.note || '').trim() };
  if (type === 'sleep') return { from: v.from, to: v.to };
  if (type === 'health') return { temperatureC: v.temperatureC === '' || v.temperatureC == null ? null : Number(v.temperatureC), note: (v.note || '').trim() };
  if (type === 'toilet') return { time: v.time, kind: v.kind, note: (v.note || '').trim() };
  if (type === 'needs') return { items: [].concat(v.items || []), note: (v.note || '').trim() };
  return { text: (v.text || '').trim() };
}

// On a weekly off or holiday the diary is empty by design: say why, and offer the last school day (as attendance does).
async function dayOffNote(ctx, date, programId) {
  const { api, db } = ctx;
  if (await api.calendar.isWorkingDay(date, programId).catch(() => true)) return '';
  let reason = 'Weekly off';
  try {
    const evs = await api.calendar.events({ academicYearId: db.school.currentAcademicYearId, programId });
    const h = evs.find((e) => e.type === 'holiday' && e.startDate <= date && date <= e.endDate);
    if (h) reason = `Holiday: ${h.title}`;
  } catch { reason = 'Weekly off or holiday'; }
  return `<div class="banner warn"><strong>${esc(reason)}.</strong> There is no school on ${fdate(date)}.
    <div class="row" style="margin-top:6px"><button class="btn sm" id="d-lastwork">Go to previous school day</button></div></div>`;
}

function wireLastWork(ctx, date, programId, go) {
  ctx.el.querySelector('#d-lastwork')?.addEventListener('click', async () => {
    let d = addDays(date, -1);
    for (let i = 0; i < 30; i++, d = addDays(d, -1)) if (await ctx.api.calendar.isWorkingDay(d, programId)) { go({ date: d }); return; }
    toast('No school day found in the last 30 days', 'bad');
  });
}

async function addEntry(ctx, student, date, toddler) {
  return formModal({
    title: `Add diary entry - ${student.firstName}`, submitLabel: 'Save entry',
    fieldsHtml: `<label class="field"><span class="lbl">Type</span><select name="type" id="d-type">${options(addTypes(toddler), 'meal')}</select></label><div id="d-fields">${typeFields('meal')}</div>`,
    onOpen: (d) => {
      const sel = d.querySelector('#d-type');
      sel.addEventListener('change', () => { d.querySelector('#d-fields').innerHTML = typeFields(sel.value); });
    },
    onSubmit: async (v) => {
      await ctx.api.diary.add({ studentId: student.id, date, type: v.type, data: buildData(v.type, v) });
    },
  });
}

function correctEntry(ctx, e, student) {
  return formModal({
    title: `Correct diary entry - ${student.firstName}`, submitLabel: 'Save correction',
    fieldsHtml: `<p class="muted" style="margin-top:0">${esc(TYPES[e.type] || e.type)}, ${fdate(e.date)}. The family sees the corrected entry. For the wrong child or the wrong type, remove it and add a new one.</p>${typeFields(e.type, e.data || {})}`,
    onSubmit: async (v) => { await ctx.api.diary.correct(e.id, { data: buildData(e.type, v) }); },
  });
}

/** Remove one entry, or every entry saved with it as one whole-class entry. Resolves true when something was removed. */
async function removeEntry(ctx, e, student, entries) {
  const twins = entries.filter((x) => x.id !== e.id && x.createdAt === e.createdAt && x.createdBy === e.createdBy && x.type === e.type);
  const choice = await openModal({
    title: 'Remove diary entry',
    body: `<p>${twins.length ? `This was saved for ${esc(twins.length + 1)} children together. Remove it only for ${esc(student.firstName)}, or for all of them?` : `Remove this entry from ${esc(student.firstName)}'s diary? The family will no longer see it.`}</p>`,
    actions: [{ label: 'Cancel', value: null }, ...(twins.length ? [{ label: `Only ${student.firstName}`, value: 'one' }, { label: `All ${twins.length + 1} children`, kind: 'danger', value: 'all' }] : [{ label: 'Remove', kind: 'danger', value: 'one' }])],
  });
  if (!choice) return false;
  // for all of them in one write: either every entry goes or none does
  const ids = choice === 'all' ? [e.id, ...twins.map((x) => x.id)] : [e.id];
  const r = await attempt(() => (ids.length > 1 ? ctx.api.diary.removeMany(ids) : ctx.api.diary.remove(e.id)));
  if (r.ok) toast(`Removed ${ids.length} entr${ids.length === 1 ? 'y' : 'ies'}`);
  return r.ok;
}

// The same entry for the whole class (lunch, nap, a circle activity); children absent or on leave start unticked, and so
// do children whose parent reported an absence, while the register has nothing for them.
const AWAY = { leave: 'on leave', absent: 'absent', reported: 'reported absent' };
async function addForClass(ctx, programId, students, date, toddler) {
  // the nap times of the last whole-class nap this week, so the usual nap needs no typing
  let nap = {};
  for (let d = date, i = 0; i < 7 && !nap.from; i++, d = addDays(d, -1)) {
    try { nap = (await ctx.api.diary.forProgramDate(programId, d)).filter((e) => e.type === 'sleep').at(-1)?.data || {}; } catch { break; }
  }
  const away = new Map();
  let marked = new Map();
  try { marked = new Map((await ctx.api.attendance.forDate(date, programId)).filter((r) => r.status).map((r) => [r.studentId, r.status])); } catch { /* register unavailable */ }
  try {
    for (const r of await ctx.api.care.leave({ programId, from: date })) if (r.status === 'active' && r.fromDate <= date && !marked.has(r.studentId)) away.set(r.studentId, 'reported');
  } catch { /* absences unavailable */ }
  for (const [id, st] of marked) if (st === 'absent' || st === 'leave') away.set(id, st);
  // for a meal, a child who ate differently keeps the tick and gets their own amount in the same save
  const ateOne = (s) => `<span data-ate-one><select name="ate-${esc(s.id)}" style="width:auto" aria-label="How much ${esc(s.firstName)} ate">${options(Object.entries(ATE).map(([value, label]) => ({ value, label })), '', { blank: 'As above' })}</select></span>`;
  const kids = students.map((s) => `<div class="row between"><label class="check sm"><input type="checkbox" name="studentIds" value="${esc(s.id)}"${away.has(s.id) ? '' : ' checked'}> ${esc(fullName(s))}${away.has(s.id) ? ` <small class="muted">(${AWAY[away.get(s.id)]})</small>` : ''}</label>${ateOne(s)}</div>`).join('');
  return formModal({
    title: 'Diary entry for the whole class', submitLabel: 'Save for ticked children',
    fieldsHtml: `<label class="field"><span class="lbl">Type</span><select name="type" id="d-type">${options(addTypes(toddler), 'meal')}</select></label><div id="d-fields">${typeFields('meal')}</div>
      <fieldset class="field" style="border:0;padding:0;margin:0 0 12px"><legend class="lbl" style="font-size:.82rem;font-weight:800">Children</legend>
        <small>Untick a child to leave them out. For a meal, choose a different amount next to a child who ate differently.</small>${kids}</fieldset>`,
    onOpen: (d) => {
      const sel = d.querySelector('#d-type');
      sel.addEventListener('change', () => {
        d.querySelector('#d-fields').innerHTML = typeFields(sel.value, sel.value === 'sleep' ? nap : {});
        d.querySelectorAll('[data-ate-one]').forEach((x) => { x.hidden = sel.value !== 'meal'; });
      });
    },
    onSubmit: async (v) => {
      const studentIds = [].concat(v.studentIds || []);
      if (!studentIds.length) throw new Error('Tick at least one child');
      const overrides = {};
      if (v.type === 'meal') for (const id of studentIds) { const a = v[`ate-${id}`]; if (a && a !== v.ate) overrides[id] = { ate: a }; }
      const r = await ctx.api.diary.addMany({ programId, date, studentIds, type: v.type, data: buildData(v.type, v), ...(Object.keys(overrides).length ? { overrides } : {}) });
      toast(`Saved for ${r.added} child${r.added === 1 ? '' : 'ren'}`);
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
  const earliest = api.mode === 'supabase' ? addDays(today, -SNAPSHOT_DAYS) : null; // older days are not loaded in the real app
  const students = (await api.people.students({ programId })).filter((s) => s.status === 'active');
  const entries = await api.diary.forProgramDate(programId, date);
  const dayOff = await dayOffNote(ctx, date, programId);
  const alerts = await loadAlerts(api, programId);
  const progName = progs.find((p) => p.id === programId).name;
  const toddler = new Set(students.filter((s) => isToddler(s, progName)).map((s) => s.id));
  // who still needs a lunch, nap or snack entry: the children marked present or late
  const att = await api.attendance.forDate(date, programId).catch(() => null);
  const here = new Set((att || []).filter((r) => r.status === 'present' || r.status === 'late').map((r) => r.studentId));
  const has = (sid, k) => entries.some((e) => e.studentId === sid && (k === 'sleep' ? e.type === 'sleep' : e.type === 'meal' && e.data?.meal === k));
  const missing = here.size && NEEDS.some(([k]) => k === query.missing) ? query.missing : '';
  const shown = missing ? students.filter((s) => here.has(s.id) && !has(s.id, missing)) : students;
  const summary = here.size ? `<div class="row" style="margin-bottom:12px"><small class="muted">In class:</small>${NEEDS.map(([k, l]) => {
    const n = [...here].filter((id) => has(id, k)).length;
    return `<button class="chip${missing === k ? ' on' : ''}" data-missing="${esc(k)}" aria-pressed="${missing === k}" title="Show the children without this entry">${esc(l)} ${esc(n)}/${esc(here.size)}</button>`;
  }).join('')}${missing ? '<button class="chip" data-missing="">Show everyone</button>' : ''}</div>` : '';
  const canChange = (e) => e.type !== 'observation' && (persona.role === 'admin' || (e.createdBy === persona.staffId && Date.now() - tsToMs(e.createdAt) <= CHANGE_WINDOW_MS));
  const actions = (e) => `${e.type === 'needs' ? needsStatus(e) : ''}${canChange(e) ? `<div class="row" style="margin-top:6px"><button class="btn sm" data-fix="${esc(e.id)}">Correct</button><button class="btn sm" data-rm="${esc(e.id)}">Remove</button></div>` : ''}`;
  ctx.el.innerHTML = `${pageHead('Daily diary', progs.find((p) => p.id === programId).name)}
    <p class="muted" style="margin:0 0 10px">Meals, naps, health and activities. Observations and photos are in <a href="#/learning">Learning</a> and stay staff-only until you share them.</p>
    <div class="row" style="margin-bottom:12px">
      ${progs.length > 1 ? `<select id="d-prog" style="width:auto" aria-label="Programme">${options(progs.map((p) => ({ value: p.id, label: p.name })), programId)}</select>` : ''}
      <button class="btn sm" id="d-prev" aria-label="Previous day"${earliest && date <= earliest ? ' disabled' : ''}>&larr;</button><input type="date" id="d-date" value="${esc(date)}" max="${esc(today)}"${earliest ? ` min="${esc(earliest)}"` : ''} style="width:auto" aria-label="Date"><button class="btn sm" id="d-next" aria-label="Next day"${date >= today ? ' disabled' : ''}>&rarr;</button>
      <span class="muted">${fdate(date)}</span>${students.length ? '<button class="btn sm primary" id="d-class">Whole class</button>' : ''}</div>
    ${earliest && date < earliest ? `<div class="banner warn"><strong>Older days are not loaded in the app.</strong> Entries of ${fdate(date)} are kept and are in the data export.</div>` : ''}
    ${dayOff}${alertsUnavailable(alerts)}${summary}
    <div class="stack">${students.length ? (shown.length ? shown.map((s) => {
      const mine = entries.filter((e) => e.studentId === s.id);
      return `<div class="card stack"><div class="row between"><div class="item-title">${esc(fullName(s))} ${healthBadge(alerts.map.get(s.id))}</div><button class="btn sm primary" data-add="${esc(s.id)}">Add entry</button></div>
        ${mine.length ? mine.map((e) => entryHtml(e, actions(e))).join('') : '<small class="muted">No entries for this day.</small>'}</div>`;
    }).join('') : empty('Everyone in class has this entry')) : empty('No children in this programme')}</div>`;
  const go = (patch) => ctx.setQuery({ program: programId, date, ...patch });
  ctx.el.querySelector('#d-prog')?.addEventListener('change', (e) => go({ program: e.target.value }));
  ctx.el.querySelector('#d-date').addEventListener('change', (e) => e.target.value && go({ date: e.target.value }));
  ctx.el.querySelector('#d-prev').addEventListener('click', () => go({ date: addDays(date, -1) }));
  ctx.el.querySelector('#d-next').addEventListener('click', () => { if (date < today) go({ date: addDays(date, 1) }); });
  wireLastWork(ctx, date, programId, go);
  wireHealthBadges(ctx.el, alerts.map);
  ctx.el.querySelector('#d-class')?.addEventListener('click', async () => { if (await addForClass(ctx, programId, students, date, toddler.size > 0)) ctx.rerender(); });
  ctx.el.addEventListener('click', async (e) => {
    const m = e.target.closest('[data-missing]');
    if (m) { go({ missing: m.dataset.missing }); return; }
    const f = e.target.closest('[data-fix]') || e.target.closest('[data-rm]');
    if (f) {
      const en = entries.find((x) => x.id === (f.dataset.fix || f.dataset.rm));
      const s = students.find((x) => x.id === en?.studentId);
      if (en && s && (f.dataset.fix ? await correctEntry(ctx, en, s) : await removeEntry(ctx, en, s, entries))) ctx.rerender();
      return;
    }
    const b = e.target.closest('[data-add]');
    if (!b) return;
    const s = students.find((x) => x.id === b.dataset.add);
    if (await addEntry(ctx, s, date, toddler.has(s.id))) ctx.rerender();
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
  const dayOff = entries.length ? '' : await dayOffNote(ctx, date, kid.programId);
  ctx.el.innerHTML = `${pageHead('Daily diary', fullName(kid))}
    ${kids.length > 1 ? `<div class="seg" role="tablist" style="margin-bottom:10px">${kids.map((k) => `<button role="tab" aria-pressed="${k.id === kid.id}" data-kid="${esc(k.id)}">${esc(k.firstName)}</button>`).join('')}</div>` : ''}
    <div class="row" style="margin-bottom:12px">
      <button class="btn sm" id="d-prev" aria-label="Previous day">&larr;</button><input type="date" id="d-date" value="${esc(date)}" style="width:auto" aria-label="Date"><button class="btn sm" id="d-next" aria-label="Next day">&rarr;</button>
      <span class="muted">${fdate(date)}</span></div>
    ${dayOff || `<div class="stack">${entries.length ? entries.map((e) => entryHtml(e, needsAnswer(e))).join('') : empty('No diary entries for this day', 'Entries appear here as the teacher adds them.')}</div>`}`;
  const go = (patch) => ctx.setQuery({ student: kid.id, date, ...patch });
  ctx.el.querySelectorAll('[data-kid]').forEach((b) => b.addEventListener('click', () => go({ student: b.dataset.kid })));
  ctx.el.querySelector('#d-date').addEventListener('change', (e) => e.target.value && go({ date: e.target.value }));
  ctx.el.querySelector('#d-prev').addEventListener('click', () => go({ date: addDays(date, -1) }));
  ctx.el.querySelector('#d-next').addEventListener('click', () => go({ date: addDays(date, 1) }));
  wireLastWork(ctx, date, kid.programId, go);
  ctx.el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-ack]');
    if (!b) return;
    b.disabled = true; // a double tap answers once
    if ((await attempt(() => api.diary.acknowledge(b.dataset.ack), 'The teacher can see you will send it')).ok) ctx.rerender(); else b.disabled = false;
  });
  // read receipts after the day is on screen, all in one call; not critical, but a full store must still raise the warning
  const unread = entries.filter((e) => !e.parentReadAt).map((e) => e.id);
  if (unread.length) api.diary.markReadMany(unread).catch((err) => { notifyQuota(err); console.error(err); });
}

export async function render(ctx) {
  if (ctx.persona.role === 'parent') await parentView(ctx); else await staffView(ctx);
}
