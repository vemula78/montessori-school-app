// Parent-teacher meeting slots (#88). For a calendar event of type 'ptm', a teacher (their own programme) or the principal
// publishes slots for a day: from, to, minutes per slot. A parent books one slot per child and event (booking another
// moves it), and may cancel until the day before. Slots with a booking cannot be cancelled by staff (the family moves
// first). In the real app a slot's booking is kept apart (ptm_bookings) so a parent sees that a slot is taken but never
// by whom (migration 0011); here every slot carries `booking` and the reads apply the same rule.

import { fail, newId } from './ids.js';
import { isISODate, isHHMM, compareISO } from './dates.js';
import { mustGet, byId, fullName } from './people.js';
import { appendAudit } from './audit.js';
import { appliesTo } from './calendar.js';

export const PTM_MINUTES = { min: 5, max: 60 };
export const PTM_MAX_SLOTS = 60;

const toMin = t => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
const toHHMM = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const overlaps = (a, b) => toMin(a.start) < toMin(b.end) && toMin(b.start) < toMin(a.end);

/** publishSlots({eventId, programId, date?, from, to, minutes, teacherId?}) → {created, slots}. */
export function publishSlots(db, { eventId, programId, date, from, to, minutes, teacherId = null } = {}, ctx) {
  const ev = mustGet(db, 'calendarEvents', eventId, 'Calendar event');
  if (ev.type !== 'ptm') fail('VALIDATION', 'Slots are published for a parent-teacher meeting');
  mustGet(db, 'programs', programId, 'Program');
  if (!appliesTo(ev, programId)) fail('VALIDATION', 'This meeting is not for that programme');
  const day = date || ev.startDate;
  if (!isISODate(day) || compareISO(day, ev.startDate) < 0 || compareISO(day, ev.endDate) > 0) fail('VALIDATION', 'Choose a day of the meeting');
  if (compareISO(day, ctx.today) < 0) fail('VALIDATION', 'That day is over');
  if (!isHHMM(from) || !isHHMM(to) || to <= from) fail('VALIDATION', 'Give a start and an end time (HH:MM, the end after the start)');
  if (!Number.isInteger(minutes) || minutes < PTM_MINUTES.min || minutes > PTM_MINUTES.max) fail('VALIDATION', `Minutes per slot from ${PTM_MINUTES.min} to ${PTM_MINUTES.max}`);
  if (teacherId !== null) {
    const t = mustGet(db, 'staff', teacherId, 'Teacher');
    if (t.role !== 'teacher' || !(t.programIds || []).includes(programId)) fail('VALIDATION', `${fullName(t)} does not teach this programme`);
  }
  const fresh = [];
  for (let m = toMin(from); m + minutes <= toMin(to); m += minutes) fresh.push({ start: toHHMM(m), end: toHHMM(m + minutes) });
  if (!fresh.length) fail('VALIDATION', 'No whole slot fits between those times');
  if (fresh.length > PTM_MAX_SLOTS) fail('VALIDATION', `At most ${PTM_MAX_SLOTS} slots at once`);
  const clash = db.ptmSlots.find(x => x.status === 'open' && x.programId === programId && x.date === day && (x.teacherId ?? null) === teacherId && fresh.some(f => overlaps(f, x)));
  if (clash) fail('VALIDATION', `Slots already exist from ${clash.start} on that day; cancel them first`);
  const slots = fresh.map(f => ({ id: newId('ptm'), eventId: ev.id, programId, date: day, start: f.start, end: f.end, teacherId, status: 'open', booking: null,
    createdBy: ctx.actor.id, createdAt: ctx.now, cancelledAt: null }));
  db.ptmSlots.push(...slots);
  appendAudit(db, ctx, { entity: 'ptm', entityId: ev.id, action: 'publishSlots', summary: `${slots.length} slot(s) for ${programId} on ${day}` });
  return { created: slots.length, slots };
}

/** cancelSlot(slotId) — staff; not while a family has booked it. */
export function cancelSlot(db, slotId, ctx) {
  const s = mustGet(db, 'ptmSlots', slotId, 'Slot');
  if (s.status !== 'open') fail('VALIDATION', 'This slot was already cancelled');
  if (s.booking) fail('VALIDATION', 'A family has booked this slot; ask them to move it first');
  Object.assign(s, { status: 'cancelled', cancelledAt: ctx.now });
  return s;
}

/** book(slotId, studentId) — a parent; one slot per child and meeting (booking another moves the child there). */
export function bookSlot(db, slotId, studentId, ctx, guardianId) {
  const slot = mustGet(db, 'ptmSlots', slotId, 'Slot');
  const child = mustGet(db, 'students', studentId, 'Student');
  if (child.status !== 'active') fail('VALIDATION', 'This child has left the school');
  if (slot.status !== 'open') fail('VALIDATION', 'This slot was cancelled');
  if (slot.programId !== child.programId) fail('VALIDATION', "This slot is for another programme");
  if (compareISO(slot.date, ctx.today) < 0) fail('VALIDATION', 'That day is over');
  if (slot.booking && slot.booking.studentId !== studentId) fail('VALIDATION', 'Someone has just booked this slot; choose another');
  if (slot.booking) return slot;
  const prev = db.ptmSlots.find(x => x.eventId === slot.eventId && x.booking && x.booking.studentId === studentId);
  if (prev) prev.booking = null;
  slot.booking = { studentId, guardianId, bookedAt: ctx.now };
  appendAudit(db, ctx, { entity: 'ptm', entityId: slot.id, action: prev ? 'move' : 'book', summary: `slot ${slot.date} ${slot.start} booked for ${studentId}${prev ? ` (moved from ${prev.start})` : ''}` });
  return slot;
}

/** cancelBooking(slotId) — the family until the day before; staff at any time. */
export function cancelBooking(db, slotId, ctx) {
  const slot = mustGet(db, 'ptmSlots', slotId, 'Slot');
  if (!slot.booking) fail('VALIDATION', 'This slot is not booked');
  if (ctx.actor.role === 'parent' && compareISO(slot.date, ctx.today) <= 0) fail('VALIDATION', 'A booking can be cancelled until the day before; please call the school');
  const who = slot.booking.studentId;
  slot.booking = null;
  appendAudit(db, ctx, { entity: 'ptm', entityId: slot.id, action: 'cancelBooking', summary: `booking of ${who} cancelled` });
  return slot;
}

/**
 * Slots as a persona may see them: staff of the programme see who booked; a parent sees their own children's bookings
 * and only "taken" for others. list({eventId?, programId?, date?}).
 */
export function slotsFor(db, p, { eventId, programId, date } = {}) {
  const parentKids = p.role === 'parent' ? db.students.filter(s => p.studentIds.includes(s.id)) : [];
  const progs = p.role === 'parent' ? new Set(parentKids.map(s => s.programId)) : p.role === 'teacher' ? new Set(p.programIds) : null;
  return (db.ptmSlots || []).filter(s => (!progs || progs.has(s.programId)) && (!eventId || s.eventId === eventId) && (!programId || s.programId === programId) && (!date || s.date === date))
    .sort((a, b) => compareISO(a.date, b.date) || compareISO(a.start, b.start) || (a.teacherId || '').localeCompare(b.teacherId || ''))
    .map(s => {
      const mine = s.booking && (p.role !== 'parent' || p.studentIds.includes(s.booking.studentId));
      const b = mine ? { ...s.booking, studentName: fullName(byId(db.students, s.booking.studentId)) } : null;
      return { ...s, booking: b, taken: Boolean(s.booking || s.booked), teacherName: s.teacherId ? fullName(byId(db.staff, s.teacherId)) : null };
    });
}
