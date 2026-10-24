// Parent-teacher meetings (#88). For a calendar entry of type PTM the class teacher (own programme) or the principal
// publishes back-to-back time slots and sees who booked; a family books one slot per child (booking another moves it)
// and may cancel until the day before. Reached from the calendar, the home page's Coming up list and the parent's home.
import { todayISO, dateRange } from '../../domain/dates.js';
import { esc, badge, empty, pageHead, fdate, options, formModal, confirmDialog, attempt, fullName } from '../components.js';

const applies = (ev, pid) => !ev.programIds.length || ev.programIds.includes(pid);
const span = (e) => `${fdate(e.startDate)}${e.endDate !== e.startDate ? ` to ${fdate(e.endDate)}` : ''}`;
const when = (s, withDay = true) => `${withDay ? `${fdate(s.date)}, ` : ''}${s.start}-${s.end}`;
const events = (ctx) => ctx.api.calendar.events({ academicYearId: ctx.query.ay || undefined, types: ['ptm'] });
const back = (ctx) => `<p><a href="${esc(ctx.href('/ptm', { ay: ctx.query.ay }))}">&larr; Parent-teacher meetings</a></p>`;

async function index(ctx) {
  const { api, persona } = ctx;
  const today = todayISO();
  const evs = (await events(ctx)).filter((e) => e.endDate >= today).sort((a, b) => (a.startDate < b.startDate ? -1 : 1));
  const slots = (await api.ptm.slots({})).filter((s) => s.status === 'open');
  const parent = persona.role === 'parent';
  const items = evs.map((e) => {
    const s = slots.filter((x) => x.eventId === e.id);
    const mine = s.filter((x) => x.booking);
    const sub = parent
      ? (mine.length ? `Booked: ${mine.map((x) => `${x.booking.studentName} ${when(x, e.endDate !== e.startDate)}`).join('; ')}` : s.some((x) => !x.taken) ? 'Times are open: book one' : s.length ? 'All times are taken' : 'Times not published yet')
      : s.length ? `${s.filter((x) => x.taken).length} of ${s.length} times booked` : 'No times published yet';
    return `<li class="link"><a href="${esc(ctx.href(`/ptm/${e.id}`, { ay: ctx.query.ay }))}"><div class="item-title">${esc(e.title)}</div><small>${span(e)} &middot; ${esc(sub)}</small></a></li>`;
  });
  ctx.el.innerHTML = `${pageHead('Parent-teacher meetings', parent ? 'Book a time with your child’s teacher' : 'Publish meeting times and see who booked')}
    ${items.length ? `<ul class="list card-list">${items.join('')}</ul>` : empty('No meeting coming up', parent ? 'The school announces meetings on the calendar.' : 'Add a calendar entry of type PTM first (Calendar).')}`;
}

async function publishForm(ctx, ev, prog) {
  const { api, db, persona } = ctx;
  const today = todayISO();
  const days = dateRange(ev.startDate, ev.endDate).filter((d) => d >= today);
  const teachers = db.staff.filter((s) => s.role === 'teacher' && (s.programIds || []).includes(prog.id));
  let made = null;
  const ok = await formModal({
    title: `Meeting times: ${prog.name}`, submitLabel: 'Publish',
    fieldsHtml: `${days.length > 1 ? `<label class="field"><span class="lbl">Day</span><select name="date">${options(days.map((d) => ({ value: d, label: fdate(d) })), days[0])}</select></label>` : `<p>${esc(fdate(days[0]))}</p><input type="hidden" name="date" value="${esc(days[0])}">`}
      <div class="grid cols-2"><label class="field"><span class="lbl">From</span><input type="time" name="from" value="15:00" required></label>
      <label class="field"><span class="lbl">To</span><input type="time" name="to" value="17:00" required></label></div>
      <label class="field"><span class="lbl">Minutes per meeting</span><input type="number" name="minutes" value="15" min="5" max="60" step="5" inputmode="numeric" required></label>
      ${teachers.length ? `<label class="field"><span class="lbl">With</span><select name="teacherId">${options(teachers.map((t) => ({ value: t.id, label: fullName(t) })), persona.role === 'teacher' ? persona.staffId : '', { blank: 'The class teachers' })}</select></label>` : ''}
      <p class="help">Times follow each other from the start time. Each family books one per child.</p>`,
    onSubmit: async (v) => {
      made = await api.ptm.publishSlots({ eventId: ev.id, programId: prog.id, date: v.date, from: v.from, to: v.to, minutes: Number(v.minutes), teacherId: v.teacherId || null });
    },
  });
  return ok ? made : null;
}

async function staffDetail(ctx, ev) {
  const { api, db, persona } = ctx;
  const today = todayISO();
  const progs = db.programs.filter((p) => applies(ev, p.id) && (persona.role === 'admin' || (persona.programIds || []).includes(p.id)));
  const slots = await api.ptm.slots({ eventId: ev.id });
  const guardian = (id) => fullName(db.guardians.find((g) => g.id === id));
  const multiDay = ev.endDate !== ev.startDate;
  const cards = progs.map((p) => {
    const open = slots.filter((s) => s.programId === p.id && s.status === 'open');
    const booked = new Set(open.filter((s) => s.booking).map((s) => s.booking.studentId));
    const notBooked = db.students.filter((s) => s.programId === p.id && s.status === 'active' && !booked.has(s.id));
    const rows = open.map((s) => `<li><div class="row between"><div><strong>${esc(when(s, multiDay))}</strong>${s.teacherName ? ` <small>${esc(s.teacherName)}</small>` : ''}<br>
        ${s.booking ? `${esc(s.booking.studentName)} <small>(${esc(guardian(s.booking.guardianId))})</small>` : '<span class="muted">Free</span>'}</div>
        ${s.date >= today ? (s.booking ? `<button class="btn" data-unbook="${esc(s.id)}">Cancel booking</button>` : `<button class="btn ghost" data-cancel="${esc(s.id)}">Remove</button>`) : ''}</div></li>`);
    return `<div class="card stack"><div class="row between"><h3 style="margin:0">${esc(p.name)}</h3>${open.length ? badge(`${booked.size} of ${open.length} booked`, booked.size === open.length ? 'ok' : 'info') : ''}</div>
      ${rows.length ? `<ul class="list">${rows.join('')}</ul>` : empty('No times published yet')}
      ${open.length && notBooked.length ? `<small>Not booked yet: ${notBooked.map((s) => esc(fullName(s))).join(', ')}</small>` : ''}
      ${ev.endDate >= today ? `<div class="row"><button class="btn primary" data-publish="${esc(p.id)}">${open.length ? 'Add more times' : 'Publish times'}</button></div>` : ''}</div>`;
  });
  ctx.el.innerHTML = `${back(ctx)}${pageHead(ev.title, span(ev))}
    <div class="stack">${cards.join('') || empty('Not for your classes', 'This meeting is for other programmes.')}</div>`;
  ctx.el.addEventListener('click', async (e) => {
    const pub = e.target.closest('[data-publish]');
    const un = e.target.closest('[data-unbook]');
    const cx = e.target.closest('[data-cancel]');
    if (pub) {
      const made = await publishForm(ctx, ev, progs.find((p) => p.id === pub.dataset.publish));
      if (made) { ctx.toast(`${made.created} time${made.created === 1 ? '' : 's'} published`); ctx.rerender(); }
    } else if (un) {
      const s = slots.find((x) => x.id === un.dataset.unbook);
      if (!(await confirmDialog('Cancel booking', `Cancel the booking for ${s.booking?.studentName || 'this child'} at ${when(s)}? Tell the family; they can book another time.`, { okLabel: 'Cancel booking', kind: 'danger' }))) return;
      if ((await attempt(() => api.ptm.cancelBooking(s.id), 'Booking cancelled')).ok) ctx.rerender();
    } else if (cx) {
      if ((await attempt(() => api.ptm.cancelSlot(cx.dataset.cancel), 'Time removed')).ok) ctx.rerender();
    }
  });
}

async function parentDetail(ctx, ev) {
  const { api, persona } = ctx;
  const today = todayISO();
  const kids = (await api.people.childrenOf(persona.guardianId)).filter((k) => k.status === 'active' && applies(ev, k.programId));
  const slots = (await api.ptm.slots({ eventId: ev.id })).filter((s) => s.status === 'open');
  const multiDay = ev.endDate !== ev.startDate;
  const cards = kids.map((k) => {
    const mine = slots.find((s) => s.booking?.studentId === k.id);
    const forClass = slots.filter((s) => s.programId === k.programId && s.date >= today);
    const free = forClass.filter((s) => !s.taken);
    const canChange = !mine || mine.date > today;
    return `<div class="card stack"><h3 style="margin:0">${esc(fullName(k))}</h3>
      ${mine ? `<div class="banner ok"><strong>Booked:</strong> ${esc(when(mine))}${mine.teacherName ? ` with ${esc(mine.teacherName)}` : ''}</div>
        ${canChange ? `<div class="row"><button class="btn" data-unbook="${esc(mine.id)}">Cancel booking</button></div>` : '<small>A booking can be changed until the day before. To change it now, please call the school.</small>'}` : ''}
      ${!canChange ? '' : free.length ? `<div class="lbl" style="font-weight:800;font-size:.82rem">${mine ? 'Move to another time' : 'Choose a time'}</div>
        <div class="row">${free.map((s) => `<button class="btn${mine ? '' : ' primary'}" data-book="${esc(s.id)}" data-kid="${esc(k.id)}">${esc(when(s, multiDay))}</button>`).join('')}</div>`
        : mine ? '' : forClass.length ? '<p class="muted" style="margin:0">All times are taken. Please message the teacher.</p>' : '<p class="muted" style="margin:0">The teacher has not published the times yet.</p>'}</div>`;
  });
  ctx.el.innerHTML = `${back(ctx)}${pageHead(ev.title, span(ev))}
    ${ev.description ? `<p>${esc(ev.description)}</p>` : ''}
    <div class="stack">${cards.join('') || empty('Not for your children', 'This meeting is for other classes.')}</div>`;
  ctx.el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-book]');
    const un = e.target.closest('[data-unbook]');
    if (b) {
      const s = slots.find((x) => x.id === b.dataset.book);
      const kid = kids.find((k) => k.id === b.dataset.kid);
      const prev = slots.find((x) => x.booking?.studentId === kid.id);
      if (prev && !(await confirmDialog('Move the meeting', `Move ${kid.firstName}'s meeting from ${when(prev)} to ${when(s)}?`, { okLabel: 'Move' }))) return;
      if ((await attempt(() => api.ptm.book(s.id, kid.id), prev ? 'Meeting moved' : 'Booked')).ok) ctx.rerender();
    } else if (un) {
      const s = slots.find((x) => x.id === un.dataset.unbook);
      if (!(await confirmDialog('Cancel booking', `Cancel the meeting at ${when(s)}?`, { okLabel: 'Cancel booking', kind: 'danger' }))) return;
      if ((await attempt(() => api.ptm.cancelBooking(s.id), 'Booking cancelled')).ok) ctx.rerender();
    }
  });
}

export async function render(ctx) {
  if (!ctx.params.id) return index(ctx);
  const ev = (await events(ctx)).find((e) => e.id === ctx.params.id);
  if (!ev) { ctx.el.innerHTML = `${back(ctx)}${empty('Meeting not found', 'It may have been removed from the calendar.')}`; return; }
  return ctx.persona.role === 'parent' ? parentDetail(ctx, ev) : staffDetail(ctx, ev);
}
