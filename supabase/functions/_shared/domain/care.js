// Care around the school day: absences parents report in advance (leave requests), the people a family authorises to
// collect a child (pick-up contacts), and the teacher's record of who collected each child (the pick-up log).
// Leave requests are informational: attendance stays the teacher's record (the register is pre-filled, never saved for
// them). A pick-up by someone not on the list is allowed only with a note and is audited (ids only, no names).

import { fail, newId } from './ids.js';
import { isISODate, compareISO, diffDays, addDays, formatDate, isHHMM } from './dates.js';
import { mustGet } from './people.js';
import { appendAudit } from './audit.js';
import { normalisePhone } from './import-people.js';

export const LEAVE_MAX_DAYS = 31;
export const LEAVE_REASON_MAX = 200;
export const PICKUP_CONTACTS_MAX = 6;
export const PICKUP_LATE_DAYS = 7; // a pick-up may be recorded up to a week late (a missed entry), never ahead
export const ERASED_REASON = "[erased at the guardian's request]";

const activeChild = (db, studentId) => {
  const s = mustGet(db, 'students', studentId, 'Student');
  if (s.status !== 'active') fail('VALIDATION', 'This child has left the school; their records are read-only');
  return s;
};
const words = (v, label, min, max) => {
  const t = String(v ?? '').trim().replace(/\s+/g, ' ');
  if (t.length < min) fail('VALIDATION', `${label} is required`);
  if (t.length > max) fail('VALIDATION', `${label} must be at most ${max} characters`);
  return t;
};
/** '+91-XXXXX-XXXXX' for any Indian mobile number as typed, or null. */
export function contactPhone(raw) {
  const n = normalisePhone(raw);
  return n ? `+91-${n.slice(3, 8)}-${n.slice(8)}` : null;
}

// ---------------------------------------------------------------- leave requests

/** The active request covering this child and date, or null. */
export const leaveOn = (db, studentId, date) => (db.leaveRequests || []).find(r => r.studentId === studentId && r.status === 'active'
  && compareISO(r.fromDate, date) <= 0 && compareISO(date, r.toDate) <= 0) || null;

export function requestLeave(db, { studentId, fromDate, toDate, reason } = {}, ctx, guardianId) {
  activeChild(db, studentId);
  if (!isISODate(fromDate) || !isISODate(toDate)) fail('VALIDATION', 'Choose the first and last day of the absence');
  if (compareISO(fromDate, ctx.today) < 0) fail('VALIDATION', 'An absence can be reported from today onwards; for a past day, message the teacher');
  if (compareISO(toDate, fromDate) < 0) fail('VALIDATION', 'The last day is before the first day');
  if (diffDays(fromDate, toDate) + 1 > LEAVE_MAX_DAYS) fail('VALIDATION', `An absence can be at most ${LEAVE_MAX_DAYS} days; report a longer one in parts or talk to the school`);
  const text = String(reason ?? '').trim().replace(/\s+/g, ' ');
  if (text.length > LEAVE_REASON_MAX) fail('VALIDATION', `The reason must be at most ${LEAVE_REASON_MAX} characters`);
  const clash = (db.leaveRequests || []).find(r => r.studentId === studentId && r.status === 'active'
    && compareISO(r.fromDate, toDate) <= 0 && compareISO(fromDate, r.toDate) <= 0);
  if (clash) fail('VALIDATION', `An absence ${clash.fromDate === clash.toDate ? `on ${formatDate(clash.fromDate)}` : `from ${formatDate(clash.fromDate)} to ${formatDate(clash.toDate)}`} is already reported for these days; withdraw it first to change it`);
  const r = { id: newId('lv'), studentId, guardianId, fromDate, toDate, reason: text, status: 'active', createdAt: ctx.now,
    seenBy: null, seenAt: null, withdrawnAt: null };
  db.leaveRequests.push(r);
  return r;
}

export function withdrawLeave(db, id, ctx) {
  const r = mustGet(db, 'leaveRequests', id, 'Absence');
  if (r.status !== 'active') fail('VALIDATION', 'This absence was already withdrawn');
  if (compareISO(r.toDate, ctx.today) < 0) fail('VALIDATION', 'This absence is over; it stays as reported');
  Object.assign(r, { status: 'withdrawn', withdrawnAt: ctx.now });
  return r;
}

export function markLeaveSeen(db, id, ctx) {
  const r = mustGet(db, 'leaveRequests', id, 'Absence');
  if (r.status !== 'active') fail('VALIDATION', 'This absence was withdrawn');
  if (!r.seenAt) Object.assign(r, { seenBy: ctx.actor.id, seenAt: ctx.now });
  return r;
}

// ---------------------------------------------------------------- pick-up contacts

export function addPickupContact(db, { studentId, name, relation, phone } = {}, ctx) {
  activeChild(db, studentId);
  const n = words(name, 'Name', 2, 80);
  const rel = words(relation, 'Relation to the child', 2, 40);
  const ph = contactPhone(phone);
  if (!ph) fail('VALIDATION', 'Enter a 10-digit Indian mobile number');
  const live = (db.pickupContacts || []).filter(c => c.studentId === studentId && c.status === 'active');
  if (live.length >= PICKUP_CONTACTS_MAX) fail('VALIDATION', `At most ${PICKUP_CONTACTS_MAX} people can be on the list; remove someone first`);
  if (live.some(c => c.phone === ph)) fail('VALIDATION', 'Someone with this phone number is already on the list');
  const c = { id: newId('pkc'), studentId, name: n, relation: rel, phone: ph, status: 'active', addedBy: ctx.actor.id, addedByRole: ctx.actor.role,
    addedAt: ctx.now, removedBy: null, removedAt: null };
  db.pickupContacts.push(c);
  appendAudit(db, ctx, { entity: 'pickupContact', entityId: c.id, action: 'add', summary: `pick-up person added for ${studentId}` });
  return c;
}

export function removePickupContact(db, id, ctx) {
  const c = mustGet(db, 'pickupContacts', id, 'Pick-up person');
  if (c.status !== 'active') fail('VALIDATION', 'This person was already removed from the list');
  // the number was kept only to check who collects the child; the name stays so older pick-up records still read
  Object.assign(c, { status: 'removed', phone: '', removedBy: ctx.actor.id, removedAt: ctx.now });
  appendAudit(db, ctx, { entity: 'pickupContact', entityId: c.id, action: 'remove', summary: `pick-up person removed for ${c.studentId}` });
  return c;
}

// ---------------------------------------------------------------- pick-up log

export const pickupId = (date, studentId) => `pck-${date}-${studentId}`;

/**
 * Who collected the child on `date` (one row per child and day; recording again corrects it).
 * collectedBy: {kind:'guardian', id} | {kind:'contact', id} | {kind:'other', name}; 'other' needs a note.
 * time: when the child was collected ('HH:MM', school time), needed for an earlier day; `at` is when it was recorded.
 * Names are stored only for 'other' (no row of its own); a guardian or contact is referred to by id.
 * Recording again keeps the earlier version in `history` and is audited ('correct').
 */
export function recordPickup(db, { studentId, date, collectedBy, note, time } = {}, ctx) {
  const s = activeChild(db, studentId);
  if (!isISODate(date)) fail('VALIDATION', `Invalid date: ${date}`);
  if (compareISO(date, ctx.today) > 0) fail('VALIDATION', 'A pick-up cannot be recorded ahead of time');
  if (compareISO(date, addDays(ctx.today, -PICKUP_LATE_DAYS)) < 0) fail('VALIDATION', `A pick-up can be recorded up to ${PICKUP_LATE_DAYS} days late`);
  const t = time === undefined || time === null || time === '' ? null : String(time);
  if (t !== null && !isHHMM(t)) fail('VALIDATION', 'Time must be HH:MM');
  if (t === null && compareISO(date, ctx.today) < 0) fail('VALIDATION', 'For an earlier day, enter the time the child was collected');
  const by = collectedBy || {};
  const text = String(note ?? '').trim().replace(/\s+/g, ' ');
  if (text.length > LEAVE_REASON_MAX) fail('VALIDATION', `The note must be at most ${LEAVE_REASON_MAX} characters`);
  let row;
  if (by.kind === 'guardian') {
    if (!(s.guardianIds || []).includes(by.id)) fail('VALIDATION', "That person is not one of this child's guardians");
    row = { kind: 'guardian', personId: by.id, name: null };
  } else if (by.kind === 'contact') {
    const c = (db.pickupContacts || []).find(x => x.id === by.id && x.studentId === studentId && x.status === 'active');
    if (!c) fail('VALIDATION', "That person is not on this child's pick-up list");
    row = { kind: 'contact', personId: c.id, name: null };
  } else if (by.kind === 'other') {
    row = { kind: 'other', personId: null, name: words(by.name, 'Name of the person', 2, 80) };
    if (!text) fail('VALIDATION', 'Someone not on the list: write how the family confirmed it (for example "mother phoned at 14:30")');
  } else {
    fail('VALIDATION', 'Choose who collected the child');
  }
  const id = pickupId(date, studentId);
  const prev = (db.pickups || []).find(p => p.id === id);
  // a correction keeps what was recorded before (oldest first), so a handover record is never silently rewritten
  const history = prev ? [...(prev.history || []), { kind: prev.kind, personId: prev.personId, name: prev.name, note: prev.note, time: prev.time, at: prev.at, recordedBy: prev.recordedBy }] : [];
  const p = { id, studentId, date, ...row, note: text, time: t, at: ctx.now, recordedBy: ctx.actor.id, correctedAt: prev ? ctx.now : null, history };
  if (prev) Object.assign(prev, p); else db.pickups.push(p);
  if (prev) appendAudit(db, ctx, { entity: 'pickup', entityId: id, action: 'correct', summary: `pick-up record corrected for ${studentId} (was ${history.at(-1).kind}, now ${row.kind})` });
  if (row.kind === 'other') appendAudit(db, ctx, { entity: 'pickup', entityId: id, action: 'otherPerson', summary: `${studentId} collected by someone not on the list (note recorded)` });
  return prev || p;
}
