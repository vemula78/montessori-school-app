// Going home: the teacher records who collected each child (guardians and the family's pick-up list are shown with their
// phone numbers). Someone not on the list needs a note of how the family confirmed it; the principal sees it in the audit log.
import { todayISO, addDays, isISODate } from '../../domain/dates.js';
import { esc, empty, pageHead, fdate, ftime, fullName, badge, options, formModal, toast } from '../components.js';

const LATE_DAYS = 7; // as the domain allows (PICKUP_LATE_DAYS)
const nowHHMM = () => { const d = new Date(); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const whenOf = (p) => (p.time ? esc(p.time) : ftime(p.at));
const ATT = { present: ['Present', 'ok'], late: ['Late', 'warn'], absent: ['Absent', 'bad'], leave: ['On leave', 'mute'] };

function collectedName(p, who) {
  if (!p) return '';
  if (p.kind === 'other') return `${p.name} (not on the list)`;
  if (p.kind === 'contact') return who.contacts.find((c) => c.id === p.personId)?.name || 'a person on the list';
  return who.guardians.find((g) => g.id === p.personId)?.name || 'a guardian';
}

async function record(ctx, s, who, date, current) {
  const opt = (value, title, sub, checked) => `<label class="check" style="align-items:flex-start"><input type="radio" name="by" value="${esc(value)}"${checked ? ' checked' : ''} required>
    <span><strong>${esc(title)}</strong><br><small>${esc(sub)}</small></span></label>`;
  const cur = current ? `${current.kind}:${current.personId || ''}` : '';
  const people = [
    ...who.guardians.map((g) => opt(`guardian:${g.id}`, g.name, `${g.relation || 'Guardian'}${g.phone ? ` · ${g.phone}` : ''}`, cur === `guardian:${g.id}`)),
    ...who.contacts.map((c) => opt(`contact:${c.id}`, c.name, `${c.relation} · ${c.phone}`, cur === `contact:${c.id}`)),
    opt('other:', 'Someone not on the list', 'Only after the family has confirmed it', current?.kind === 'other'),
  ].join('');
  return formModal({
    title: `Who collected ${s.firstName}?`, submitLabel: 'Record',
    fieldsHtml: `<fieldset class="field" style="border:0;padding:0;margin:0 0 12px"><legend class="lbl" style="font-size:.82rem;font-weight:800">${fdate(date)}</legend>${people}</fieldset>
      <div id="p-other" class="stack"${current?.kind === 'other' ? '' : ' hidden'}>
        <div class="banner warn"><strong>Not on the family's list.</strong> Hand the child over only after a guardian has confirmed it, and write how.</div>
        <label class="field"><span class="lbl">Name of the person</span><input name="name" maxlength="80" value="${esc(current?.kind === 'other' ? current.name : '')}"></label>
      </div>
      <div class="grid cols-2"><label class="field"><span class="lbl">Time collected</span><input type="time" name="time" value="${esc(current?.time || (date === todayISO() ? nowHHMM() : ''))}"${date === todayISO() ? '' : ' required'}></label>
      <label class="field"><span class="lbl">Note</span><input name="note" maxlength="200" value="${esc(current?.note || '')}" placeholder="For example: mother phoned at 14:30"></label></div>`,
    onOpen: (d) => {
      const box = d.querySelector('#p-other');
      d.querySelectorAll('input[name="by"]').forEach((r) => r.addEventListener('change', () => { box.hidden = !d.querySelector('input[value="other:"]').checked; }));
    },
    onSubmit: async (v) => {
      if (!v.by) throw new Error('Choose who collected the child');
      const [kind, id] = String(v.by).split(':');
      const collectedBy = kind === 'other' ? { kind, name: v.name } : { kind, id };
      await ctx.api.care.recordPickup({ studentId: s.id, date, collectedBy, note: v.note, time: v.time });
      toast(`Recorded for ${s.firstName}`);
    },
  });
}

export async function render(ctx) {
  const { api, db, persona, query } = ctx;
  const progs = persona.role === 'teacher' ? db.programs.filter((p) => (persona.programIds || []).includes(p.id)) : db.programs;
  if (!progs.length) { ctx.el.innerHTML = `${pageHead('Going home')}${empty('No programme assigned to you')}`; return; }
  const programId = progs.find((p) => p.id === query.program)?.id || progs[0].id;
  const today = todayISO();
  const earliest = addDays(today, -LATE_DAYS);
  const date = isISODate(query.date) && query.date <= today && query.date >= earliest ? query.date : today;
  const students = (await api.people.students({ programId })).filter((s) => s.status === 'active');
  const [att, log, leave] = await Promise.all([
    api.attendance.forDate(date, programId).catch(() => null),
    api.care.pickups({ programId, date }),
    api.care.leave({ programId, from: date }),
  ]);
  const who = new Map();
  for (const s of students) who.set(s.id, await api.care.whoMayCollect(s.id));
  const status = new Map((att || []).map((r) => [r.studentId, r.status]));
  const byKid = new Map(log.map((p) => [p.studentId, p]));
  const onLeave = new Set(leave.filter((r) => r.status === 'active' && r.fromDate <= date && date <= r.toDate).map((r) => r.studentId));
  const away = (id) => status.get(id) === 'absent' || status.get(id) === 'leave' || (!status.get(id) && onLeave.has(id));
  const due = students.filter((s) => !away(s.id) && !byKid.has(s.id)).length;

  ctx.el.innerHTML = `${pageHead('Going home', progs.find((p) => p.id === programId).name)}
    <div class="row" style="margin-bottom:12px">
      ${progs.length > 1 ? `<select id="g-prog" aria-label="Programme" style="width:auto">${options(progs.map((p) => ({ value: p.id, label: p.name })), programId)}</select>` : ''}
      <button class="btn sm" id="g-prev" aria-label="Previous day"${date <= earliest ? ' disabled' : ''}>&larr;</button>
      <span class="muted">${fdate(date)}</span>
      <button class="btn sm" id="g-next" aria-label="Next day"${date >= today ? ' disabled' : ''}>&rarr;</button>
      ${date !== today ? '<button class="btn sm" id="g-today">Today</button>' : ''}
    </div>
    <p class="muted" style="margin:0 0 10px">${due ? `${esc(due)} child${due === 1 ? '' : 'ren'} still to record.` : 'Everyone who came is recorded.'} Tap a child to record who collected them.</p>
    <div class="stack">${students.length ? students.map((s) => {
      const st = status.get(s.id);
      const p = byKid.get(s.id);
      const head = st ? badge(...ATT[st]) : onLeave.has(s.id) ? badge('Absence reported', 'mute') : badge('Not marked', 'mute');
      const w = who.get(s.id);
      return `<div class="card stack"><div class="row between"><div class="item-title">${esc(fullName(s))}</div>${head}</div>
        ${p ? `<div class="row between"><span>Collected by <strong>${esc(collectedName(p, w))}</strong> at ${whenOf(p)}${p.note ? `<br><small>${esc(p.note)}</small>` : ''}</span><button class="btn sm" data-rec="${esc(s.id)}">Change</button></div>`
          : away(s.id) ? '<small class="muted">Not in school today.</small>'
          : `<div class="row between"><small class="muted">${esc(w.guardians.length + w.otherGuardians)} guardian${w.guardians.length + w.otherGuardians === 1 ? '' : 's'}, ${esc(w.contacts.length)} other${w.contacts.length === 1 ? '' : 's'} on the list</small><button class="btn sm primary" data-rec="${esc(s.id)}">Record pick-up</button></div>`}
      </div>`;
    }).join('') : empty('No children in this programme')}</div>`;

  const go = (patch) => ctx.setQuery({ program: programId, date, ...patch });
  ctx.el.querySelector('#g-prog')?.addEventListener('change', (e) => go({ program: e.target.value }));
  ctx.el.querySelector('#g-prev').addEventListener('click', () => go({ date: addDays(date, -1) }));
  ctx.el.querySelector('#g-next').addEventListener('click', () => go({ date: addDays(date, 1) }));
  ctx.el.querySelector('#g-today')?.addEventListener('click', () => go({ date: today }));
  ctx.el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-rec]');
    if (!b) return;
    const s = students.find((x) => x.id === b.dataset.rec);
    if (await record(ctx, s, who.get(s.id), date, byKid.get(s.id))) ctx.rerender();
  });
}
