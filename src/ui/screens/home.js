// Role-specific landing page. A failed read is shown as "unavailable" (a dash), never as an empty or healthy result.
import { todayISO } from '../../domain/dates.js';
import { esc, icon, money, fdate, badge, empty, fullName, indexBy, errMessage, DASH } from '../components.js';

const tile = (href, ic, label, sub = '') => `<a class="card link" href="${esc(href)}"><div class="row">${icon(ic)}<div class="grow"><div class="item-title">${esc(label)}</div>${sub ? `<small>${esc(sub)}</small>` : ''}</div></div></a>`;
const TYPE_LABEL = { holiday: 'Holiday', event: 'Event', ptm: 'PTM', halfDay: 'Half day', workingSaturday: 'Working Saturday', birthday: 'Birthday' };
const kpi = (label, value, cls = '') => `<div class="kpi ${cls}"><div class="v">${value}</div><div class="l">${esc(label)}</div></div>`;
const unavailable = (what) => `<div class="banner warn">${esc(what)} could not be loaded.</div>`;

// Returns {evs} or {error}. Teachers and parents only ever fetch their own programmes' events.
async function upcomingEvents(ctx, limit = 6) {
  const today = todayISO();
  const ayId = ctx.db.school.currentAcademicYearId;
  if (!ayId) return { evs: [] };
  const { persona, api } = ctx;
  const scoped = persona.role === 'teacher' || persona.role === 'parent';
  try {
    let evs;
    if (!scoped) evs = await api.calendar.events({ academicYearId: ayId });
    else {
      const seen = new Map();
      for (const pid of persona.programIds || []) for (const e of await api.calendar.events({ academicYearId: ayId, programId: pid })) seen.set(e.id, e);
      evs = [...seen.values()];
    }
    const mine = new Set(persona.studentIds || []);
    return {
      evs: evs
        .filter((e) => e.endDate >= today)
        .filter((e) => e.type !== 'birthday' || persona.role !== 'parent' || mine.has(e.studentId))
        .sort((a, b) => (a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : 0))
        .slice(0, limit),
    };
  } catch (e) { return { error: e }; }
}

function eventList(res) {
  if (res.error) return empty('Calendar unavailable', errMessage(res.error));
  const evs = res.evs;
  if (!evs.length) return empty('Nothing coming up', 'No events or holidays on the calendar yet.');
  return `<ul class="list card-list">${evs.map((e) => `<li><div class="row"><span class="dot ${esc(e.type)}"></span><div class="grow"><div class="item-title">${esc(e.title)}</div><small>${fdate(e.startDate)}${e.endDate !== e.startDate ? ' to ' + fdate(e.endDate) : ''}</small></div>${badge(TYPE_LABEL[e.type] || e.type, 'mute')}</div></li>`).join('')}</ul>`;
}

async function parentHome(ctx) {
  const { api, db, persona } = ctx;
  const today = todayISO();
  const g = db.guardians.find((x) => x.id === persona.guardianId);
  const kids = await api.people.childrenOf(persona.guardianId);
  const progs = indexBy(db.programs);
  const receipts = db.noticeReceipts.filter((r) => r.guardianId === persona.guardianId);
  const notices = indexBy(db.notices);
  const pending = receipts.filter((r) => notices.get(r.noticeId)?.requiresAck && !r.ackAt);
  const evs = await upcomingEvents(ctx);

  const cards = [];
  for (const k of kids) {
    if (k.status !== 'active') {
      cards.push(`<div class="card"><div class="row"><span class="avatar">${esc((k.firstName[0] || '') + (k.lastName[0] || ''))}</span><div class="grow"><div class="item-title">${esc(fullName(k))}</div><small>${esc(progs.get(k.programId)?.name || DASH)}</small></div>${badge('Left', 'mute')}</div></div>`);
      continue;
    }
    const att = db.attendance.find((a) => a.date === today && a.studentId === k.id);
    const diaryToday = db.diaryEntries.filter((d) => d.studentId === k.id && d.date === today).length;
    let balance = null;
    try { balance = (await api.fees.invoices({ studentId: k.id })).filter((i) => i.status !== 'cancelled').reduce((s, i) => s + (i.balancePaise || 0), 0); } catch { /* unavailable: shown as a dash */ }
    const attBadge = att ? badge(att.status, att.status === 'present' ? 'ok' : att.status === 'absent' ? 'bad' : 'warn') : badge('Not marked yet', 'mute');
    cards.push(`<div class="card stack">
      <div class="row"><span class="avatar">${esc((k.firstName[0] || '') + (k.lastName[0] || ''))}</span><div class="grow"><div class="item-title">${esc(fullName(k))}</div><small>${esc(progs.get(k.programId)?.name || DASH)}</small></div>${attBadge}</div>
      <div class="grid cols-3">
        <a class="kpi" href="#/diary?student=${esc(k.id)}" style="text-decoration:none;color:inherit"><div class="v">${esc(diaryToday)}</div><div class="l">diary entries today</div></a>
        <a class="kpi" href="#/fees/student/${esc(k.id)}" style="text-decoration:none;color:inherit"><div class="v">${money(balance)}</div><div class="l">${api.mode === 'demo' ? 'sample fees due' : 'fees due'}</div></a>
        <a class="kpi" href="#/bus" style="text-decoration:none;color:inherit"><div class="v">${k.routeId ? 'Bus' : DASH}</div><div class="l">${k.routeId ? 'tracking' : 'no bus'}</div></a>
      </div></div>`);
  }
  return `
    <div class="page-head"><div><h1>Hello${g ? ', ' + esc(g.firstName) : ''}</h1><div class="sub">${fdate(today)}</div></div></div>
    ${pending.length ? `<div class="banner warn"><div class="row between"><span><strong>${esc(pending.length)} notice${pending.length === 1 ? ' needs' : 's need'} your acknowledgement.</strong></span><a class="btn sm" href="#/notices">Open notices</a></div></div>` : ''}
    <div class="stack">${cards.join('') || empty('No children linked to this account')}</div>
    <h2 style="margin-top:20px">Coming up</h2>${eventList(evs)}
    <h2 style="margin-top:20px">Quick links</h2>
    <div class="grid cols-2">${tile('#/notices', 'bell', 'Notices')}${tile('#/messages', 'chat', 'Messages')}${tile('#/calendar', 'calendar', 'Calendar')}${tile('#/diary', 'book', 'Daily diary')}${tile('#/learning', 'learn', 'Learning', 'Shared observations and termly reports')}</div>`;
}

async function teacherHome(ctx) {
  const { api, db, persona } = ctx;
  const today = todayISO();
  const progs = indexBy(db.programs);
  const rows = [];
  for (const pid of persona.programIds || []) {
    let list = null;
    let working = null; // null = unknown
    try { list = await api.attendance.forDate(today, pid); } catch { /* unavailable */ }
    try { working = await api.calendar.isWorkingDay(today, pid); } catch { /* unknown */ }
    const marked = list ? list.filter((r) => r.status).length : null;
    const absent = list ? list.filter((r) => r.status === 'absent').length : null;
    const head = working === false ? badge('Not a working day', 'mute') : list ? badge(`${marked}/${list.length} marked`, marked === list.length && list.length ? 'ok' : 'warn') : badge('Register unavailable', 'bad');
    rows.push(`<div class="card stack"><div class="row between"><h3>${esc(progs.get(pid)?.name || pid)}</h3>${head}</div>
      <div class="grid cols-3">${kpi('children', list ? list.length : DASH)}${kpi('absent today', absent ?? DASH, absent ? 'bad' : '')}${kpi('unmarked', list ? list.length - marked : DASH)}</div>
      <div class="row"><a class="btn primary sm" href="#/attendance?program=${esc(pid)}">Attendance</a><a class="btn sm" href="#/diary?program=${esc(pid)}">Daily diary</a><a class="btn" href="#/learning?program=${esc(pid)}">Observations</a></div></div>`);
  }
  const myThreads = db.threads.filter((t) => (persona.programIds || []).includes(t.programId));
  const unread = db.messages.filter((m) => myThreads.some((t) => t.id === m.threadId) && m.senderRole === 'parent' && !m.readAt).length;
  const evs = await upcomingEvents(ctx);
  const me = db.staff.find((x) => x.id === persona.staffId);
  return `
    <div class="page-head"><div><h1>Good day, ${esc(me?.firstName || 'teacher')}</h1><div class="sub">${fdate(today)}</div></div></div>
    ${unread ? `<div class="banner"><div class="row between"><span><strong>${esc(unread)} unread parent message${unread === 1 ? '' : 's'}.</strong></span><a class="btn sm" href="#/messages">Open messages</a></div></div>` : ''}
    <div class="stack">${rows.join('') || empty('No programme assigned')}</div>
    <h2 style="margin-top:20px">Coming up</h2>${eventList(evs)}`;
}

async function adminHome(ctx) {
  const { api, db } = ctx;
  const today = todayISO();
  const ayId = db.school.currentAcademicYearId;
  const students = await api.people.students();
  let present = 0, marked = 0, attFail = 0;
  for (const p of db.programs) {
    try { const l = await api.attendance.forDate(today, p.id); marked += l.filter((r) => r.status).length; present += l.filter((r) => r.status === 'present' || r.status === 'late').length; } catch { attFail += 1; }
  }
  let outstanding = null;
  try {
    const r = await api.fees.outstandingReport({ academicYearId: ayId, asOfDate: today });
    outstanding = r.totals?.balancePaise ?? r.rows.reduce((s, x) => s + (x.balancePaise || 0), 0);
  } catch { /* unavailable: shown as a dash */ }
  let active = 0, busFail = 0;
  try {
    for (const r of await api.transport.routes()) { try { if (await api.transport.activeTrip(r.id)) active += 1; } catch { busFail += 1; } }
  } catch { busFail += 1; }
  const evs = await upcomingEvents(ctx);
  return `
    <div class="page-head"><div><h1>School overview</h1><div class="sub">${fdate(today)} &middot; ${esc(db.academicYears.find((a) => a.id === ayId)?.label || DASH)}</div></div></div>
    ${attFail || busFail ? unavailable(`${attFail ? 'Some attendance registers' : ''}${attFail && busFail ? ' and ' : ''}${busFail ? 'Some bus data' : ''}`) : ''}
    <div class="grid cols-4">
      ${kpi('active children', esc(students.filter((s) => s.status === 'active').length))}
      ${kpi('present today', attFail ? DASH : marked ? `${present}/${marked}` : DASH)}
      ${kpi('fees outstanding', money(outstanding), outstanding ? 'bad' : '')}
      ${kpi('buses on the road', busFail ? DASH : esc(active))}
    </div>
    <h2 style="margin-top:20px">Coming up</h2>${eventList(evs)}
    <h2 style="margin-top:20px">Go to</h2>
    <div class="grid cols-3">${tile('#/notices', 'bell', 'Notices', 'Send and track acknowledgements')}${tile('#/calendar', 'calendar', 'Calendar', 'Holidays, events, CSV import')}${tile('#/attendance', 'check', 'Attendance')}${tile('#/learning', 'learn', 'Learning', 'Observations, progress, reports, curriculum')}${tile('#/bus', 'bus', 'Bus fleet')}${tile('#/fees', 'rupee', 'Fees')}${tile('#/reports', 'chart', 'Reports')}</div>`;
}

async function accountantHome(ctx) {
  const { api, db } = ctx;
  const today = todayISO();
  const ayId = db.school.currentAcademicYearId;
  let rows = null, totals = {};
  try { const r = await api.fees.outstandingReport({ academicYearId: ayId, asOfDate: today }); rows = r.rows; totals = r.totals || {}; } catch { /* unavailable */ }
  const outstanding = rows ? (totals.balancePaise ?? rows.reduce((s, x) => s + (x.balancePaise || 0), 0)) : null;
  const overdue = rows ? rows.filter((r) => (r.overdueDays || 0) > 0 && r.balancePaise > 0).length : null;
  // collected = money actually received today; applying existing credit is an internal transfer, not new money
  let collected = null;
  try { collected = (await api.fees.payments({ from: today, to: today })).filter((p) => p.status === 'valid' && p.mode !== 'credit').reduce((s, p) => s + p.amountPaise, 0); } catch { /* unavailable */ }
  return `
    <div class="page-head"><div><h1>Accounts</h1><div class="sub">${fdate(today)}</div></div></div>
    ${rows === null || collected === null ? unavailable('Some fee figures') : ''}
    <div class="grid cols-3">${kpi('outstanding', money(outstanding), outstanding ? 'bad' : '')}${kpi('children with overdue fees', overdue ?? DASH, overdue ? 'bad' : '')}${kpi('collected today', money(collected), 'good')}</div>
    <h2 style="margin-top:20px">Go to</h2>
    <div class="grid cols-2">${tile('#/fees', 'rupee', 'Invoices & payments', 'Record payments, print receipts')}${tile('#/fees/structures', 'receipt', 'Fee structures', 'Generate invoices by term')}${tile('#/reports', 'chart', 'Reports', 'Outstanding, day book, reconciliation')}${tile('#/audit', 'shield', 'Audit log')}</div>`;
}

async function driverHome(ctx) {
  const { api, persona } = ctx;
  const routes = await api.transport.routes();
  const mine = routes.filter((r) => r.driverId === persona.staffId);
  const cards = [];
  for (const r of mine) {
    let t = null;
    let failed = false;
    try { t = await api.transport.activeTrip(r.id); } catch { failed = true; }
    cards.push(`<div class="card stack"><div class="row between"><h3>${esc(r.name)}</h3>${failed ? badge('Status unavailable', 'bad') : t ? badge(t.simulated ? 'Trip active (simulated)' : 'Trip active', 'ok') : badge('No active trip', 'mute')}</div>
      <div class="muted">Bus ${esc(r.busNo)} &middot; ${esc(r.stops.length)} stops</div><a class="btn primary" href="#/bus">${t ? 'Open trip' : 'Start a trip'}</a></div>`);
  }
  const me = ctx.db.staff.find((x) => x.id === persona.staffId);
  return `<div class="page-head"><div><h1>Hello, ${esc(me?.firstName || 'driver')}</h1><div class="sub">${fdate(todayISO())}</div></div></div>
    <div class="stack">${cards.join('') || empty('No route assigned to this driver')}</div>`;
}

export async function render(ctx) {
  const by = { parent: parentHome, teacher: teacherHome, admin: adminHome, accountant: accountantHome, driver: driverHome };
  const fn = by[ctx.persona.role];
  ctx.el.innerHTML = fn ? await fn(ctx) : empty('Nothing here yet');
}
