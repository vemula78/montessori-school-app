// Academic calendar: working days, events, derived birthdays.

import { fail, newId } from './ids.js';
import { isISODate, isWeekend, compareISO, daysInMonth, formatDate, addDays } from './dates.js';
import { byId, mustGet, activeStudents } from './people.js';
import { appendAudit } from './audit.js';

export const EVENT_TYPES = ['holiday', 'event', 'ptm', 'halfDay', 'workingSaturday'];

/** Event applies to programId when its programIds is empty (= all programs) or includes it.
 *  With no programId given, only school-wide events apply. */
export function appliesTo(ev, programId) {
  if (!ev.programIds || ev.programIds.length === 0) return true;
  return programId ? ev.programIds.includes(programId) : false;
}

export function covers(ev, date) {
  return compareISO(ev.startDate, date) <= 0 && compareISO(date, ev.endDate) <= 0;
}

/** Weekly offs and holidays are non-working; a 'workingSaturday' event overrides a weekly off. */
export function isWorkingDay(db, date, programId) {
  if (!isISODate(date)) fail('VALIDATION', `Invalid date: ${date}`);
  const evs = db.calendarEvents.filter(ev => covers(ev, date) && appliesTo(ev, programId));
  if (evs.some(ev => ev.type === 'holiday')) return false;
  if (isWeekend(date, db.school.weeklyOffs)) return evs.some(ev => ev.type === 'workingSaturday');
  return true;
}

/** Reason a date is not a working day (for UI messages), or null when it is one. */
export function nonWorkingReason(db, date, programId) {
  const hol = db.calendarEvents.find(ev => ev.type === 'holiday' && covers(ev, date) && appliesTo(ev, programId));
  if (hol) return `${formatDate(date)} is a holiday: ${hol.title}`;
  if (isWorkingDay(db, date, programId)) return null;
  return `${formatDate(date)} is a weekly off`;
}

export function nextWorkingDay(db, date, programId) {
  let d = date;
  for (let i = 0; i < 366; i++) {
    if (isWorkingDay(db, d, programId)) return d;
    d = addDays(d, 1);
  }
  fail('VALIDATION', `No working day within a year of ${date}`);
}

export function academicYearFor(db, date) {
  return db.academicYears.find(ay => covers({ startDate: ay.startDate, endDate: ay.endDate }, date)) || null;
}

/** Birthday of a child in a given year; 29-Feb falls on 28-Feb in non-leap years (documented decision). */
export function birthdayInYear(dob, year) {
  const [, m, d] = dob.split('-').map(Number);
  const day = m === 2 && d === 29 && daysInMonth(year, 2) === 28 ? 28 : d;
  return `${year}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Derived (never stored) birthday events for active students within [from, to]. */
export function birthdayEvents(db, from, to, { programId, studentIds } = {}) {
  const out = [];
  const y0 = Number(from.slice(0, 4)), y1 = Number(to.slice(0, 4));
  for (const s of activeStudents(db, programId)) {
    if (studentIds && !studentIds.includes(s.id)) continue;
    if (!isISODate(s.dob)) continue;
    for (let y = y0; y <= y1; y++) {
      const date = birthdayInYear(s.dob, y);
      if (compareISO(date, from) < 0 || compareISO(date, to) > 0) continue;
      out.push({
        id: `bday-${s.id}-${y}`, type: 'birthday', studentId: s.id, title: `${s.firstName} ${s.lastName} — birthday`,
        startDate: date, endDate: date, programIds: [s.programId], description: '', source: 'derived', importBatchId: null,
        leapDayShifted: date.slice(5) !== s.dob.slice(5),
      });
    }
  }
  return out;
}

/** Events overlapping [from, to] (a multi-day event spanning two months appears in both months). */
export function eventsOverlapping(events, from, to) {
  return events.filter(ev => compareISO(ev.startDate, to) <= 0 && compareISO(ev.endDate, from) >= 0);
}

/**
 * Stored events for an academic year plus derived birthdays.
 * @param {{academicYearId:string, programId?:string, types?:string[], from?:string, to?:string, birthdayStudentIds?:string[]}} q
 */
export function listEvents(db, { academicYearId, programId, types, from, to, birthdayStudentIds }) {
  const ay = mustGet(db, 'academicYears', academicYearId, 'Academic year');
  const lo = from || ay.startDate, hi = to || ay.endDate;
  // Selected by date overlap with the year, so an event filed under another year still shows where its dates fall.
  let evs = db.calendarEvents;
  if (programId) evs = evs.filter(ev => appliesTo(ev, programId));
  evs = eventsOverlapping(evs, lo, hi);
  if (!types || types.includes('birthday')) {
    evs = evs.concat(birthdayEvents(db, lo, hi, { programId, studentIds: birthdayStudentIds }));
  }
  if (types) evs = evs.filter(ev => types.includes(ev.type));
  return evs.sort((a, b) => compareISO(a.startDate, b.startDate) || a.title.localeCompare(b.title));
}

function checkEvent(db, ev) {
  if (!byId(db.academicYears, ev.academicYearId)) fail('VALIDATION', 'Unknown academic year');
  if (!EVENT_TYPES.includes(ev.type)) fail('VALIDATION', `Unknown event type: ${ev.type}`);
  if (!ev.title || !String(ev.title).trim()) fail('VALIDATION', 'Title is required');
  if (!isISODate(ev.startDate) || !isISODate(ev.endDate)) fail('VALIDATION', 'Start and end must be valid dates');
  if (compareISO(ev.endDate, ev.startDate) < 0) fail('VALIDATION', 'End date is before start date');
  for (const p of ev.programIds) if (!byId(db.programs, p)) fail('VALIDATION', `Unknown program: ${p}`);
}

export function createEvent(db, input, ctx) {
  const ev = {
    id: newId('evt'),
    academicYearId: input.academicYearId,
    type: input.type,
    title: String(input.title || '').trim(),
    startDate: input.startDate,
    endDate: input.endDate || input.startDate,
    programIds: input.programIds ? [...input.programIds] : [],
    description: input.description || '',
    source: 'manual',
    importBatchId: null,
  };
  checkEvent(db, ev);
  db.calendarEvents.push(ev);
  appendAudit(db, ctx, { entity: 'calendarEvent', entityId: ev.id, action: 'create', summary: `${ev.type} ${ev.startDate}..${ev.endDate}` });
  return ev;
}

export function updateEvent(db, id, patch, ctx) {
  const ev = mustGet(db, 'calendarEvents', id, 'Event');
  const next = { ...ev, ...patch, id: ev.id, source: ev.source, importBatchId: ev.importBatchId };
  if (patch.title !== undefined) next.title = String(patch.title).trim();
  checkEvent(db, next);
  Object.assign(ev, next);
  appendAudit(db, ctx, { entity: 'calendarEvent', entityId: id, action: 'update', summary: `fields: ${Object.keys(patch).join(',')}` });
  return ev;
}

export function removeEvent(db, id, ctx) {
  const ev = mustGet(db, 'calendarEvents', id, 'Event');
  db.calendarEvents = db.calendarEvents.filter(e => e.id !== id);
  appendAudit(db, ctx, { entity: 'calendarEvent', entityId: id, action: 'remove', summary: `${ev.type} "${ev.title}" ${ev.startDate}..${ev.endDate}` });
}
