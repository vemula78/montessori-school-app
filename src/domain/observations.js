// Observations of one child (staff-written notes on the child's work). Staff-only until a teacher shares one
// (sharedAt); parents see shared ones only — in the real app RLS enforces that, here the same rule is applied to the
// demo document. Shared text is frozen: a correction is a new observation (or an unshare within 24 hours).
// Who may see a child's learning records: the principal (all), a teacher (children of their programs), a parent
// (their own children). The accountant and the driver see none.

import { fail, newId } from './ids.js';
import { isISODate, compareISO, tsToMs } from './dates.js';
import { byId, mustGet } from './people.js';
import { appendAudit } from './audit.js';
import { OBSERVATION_AREAS } from './diary.js';

export const OBSERVATION_TEXT_MAX = 4000;
export const UNSHARE_WINDOW_MS = 24 * 3600_000;
export const STAFF_OBSERVATION_DAYS = 120; // the real app's snapshot window for staff (reports carry their own copies)

/** May persona p see this child's learning records (observations, photos, progress, reports)? */
export function learnerVisible(p, studentId) {
  if (!p) return false;
  if (p.role === 'admin') return true;
  if (p.role === 'teacher' || p.role === 'parent') return (p.studentIds || []).includes(studentId);
  return false;
}
export function mustSeeLearner(p, db, studentId) {
  if (!byId(db.students, studentId)) fail('NOT_FOUND', 'Student not found');
  if (!learnerVisible(p, studentId)) fail('NOT_ALLOWED', 'Not your student');
}

function cleanFields(db, { date, area, presentationId = null, text }, today) {
  if (!isISODate(date)) fail('VALIDATION', `Invalid date: ${date}`);
  if (compareISO(date, today) > 0) fail('VALIDATION', 'Observation date is in the future');
  if (!OBSERVATION_AREAS.includes(area)) fail('VALIDATION', `Unknown area: ${area}`);
  const t = String(text ?? '').trim();
  if (!t) fail('VALIDATION', 'Observation text is required');
  if (t.length > OBSERVATION_TEXT_MAX) fail('VALIDATION', `Observation text is longer than ${OBSERVATION_TEXT_MAX} characters`);
  let pid = null;
  if (presentationId) {
    const pr = byId(db.presentations || [], presentationId);
    if (!pr) fail('NOT_FOUND', 'Presentation not found');
    if (pr.area !== area) fail('VALIDATION', 'The presentation belongs to another area');
    pid = pr.id;
  }
  return { date, area, presentationId: pid, text: t };
}

export function addObservation(db, input = {}, ctx) {
  const s = mustGet(db, 'students', input.studentId, 'Student');
  if (s.status !== 'active') fail('VALIDATION', 'Student is not active');
  const f = cleanFields(db, input, ctx.today);
  if (f.presentationId && !byId(db.presentations, f.presentationId).active) fail('VALIDATION', 'That presentation is retired');
  const o = { id: newId('obs'), studentId: s.id, programId: s.programId, ...f, createdBy: ctx.actor.id, createdAt: ctx.now, sharedAt: null, sharedBy: null };
  db.observations.push(o);
  appendAudit(db, ctx, { entity: 'observation', entityId: o.id, action: 'add', summary: `observation for student ${s.id} (${f.area})` });
  return o;
}

/** Edit while unshared only: what a parent has seen never changes under them. */
export function editObservation(db, id, patch = {}, ctx) {
  const o = mustGet(db, 'observations', id, 'Observation');
  if (o.sharedAt) fail('VALIDATION', 'A shared observation cannot be edited; add a new one (or unshare it first)');
  const f = cleanFields(db, { date: o.date, area: o.area, presentationId: o.presentationId, text: o.text, ...patch }, ctx.today);
  Object.assign(o, f, { editedAt: ctx.now, editedBy: ctx.actor.id });
  appendAudit(db, ctx, { entity: 'observation', entityId: o.id, action: 'edit', summary: `observation edited (${o.area})` });
  return o;
}

export function shareObservation(db, id, ctx) {
  const o = mustGet(db, 'observations', id, 'Observation');
  if (o.sharedAt) return o;
  const s = byId(db.students, o.studentId);
  if (!s || s.status !== 'active') fail('VALIDATION', 'Student is not active');
  Object.assign(o, { sharedAt: ctx.now, sharedBy: ctx.actor.id });
  appendAudit(db, ctx, { entity: 'observation', entityId: o.id, action: 'share', summary: `observation shared with the family of student ${o.studentId}` });
  return o;
}

/** The mistake path: a teacher within 24 hours of sharing, the principal at any time. Audited. */
export function unshareObservation(db, id, ctx) {
  const o = mustGet(db, 'observations', id, 'Observation');
  if (!o.sharedAt) return o;
  if (ctx.actor.role !== 'admin' && tsToMs(ctx.now) - tsToMs(o.sharedAt) > UNSHARE_WINDOW_MS) fail('NOT_ALLOWED', 'Only the principal can unshare an observation after 24 hours');
  const was = o.sharedAt;
  Object.assign(o, { sharedAt: null, sharedBy: null });
  appendAudit(db, ctx, { entity: 'observation', entityId: o.id, action: 'unshare', summary: `observation unshared (had been shared at ${was})` });
  return o;
}

const byDateDesc = (a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.createdAt < b.createdAt ? 1 : -1);

/**
 * Observations a persona may see: list({studentId} | {programId}, from, to) — newest first, each with photoIds
 * (ready photos, derived; never stored) and the presentation's name. Parents: shared ones of their own children only.
 */
export function listObservations(db, p, { studentId, programId, from, to } = {}) {
  if (!p || !['admin', 'teacher', 'parent'].includes(p.role)) fail('NOT_ALLOWED', 'Not available to you');
  if (studentId) mustSeeLearner(p, db, studentId);
  return (db.observations || [])
    .filter(o => learnerVisible(p, o.studentId) && (p.role !== 'parent' || o.sharedAt)
      && (!studentId || o.studentId === studentId)
      && (!programId || byId(db.students, o.studentId)?.programId === programId)
      && (!from || o.date >= from) && (!to || o.date <= to))
    .sort(byDateDesc)
    .map(o => observationView(db, o));
}

export function observationView(db, o) {
  const pr = o.presentationId ? byId(db.presentations || [], o.presentationId) : null;
  return { ...o, presentationName: pr ? pr.name : null,
    photoIds: (db.photos || []).filter(x => x.observationId === o.id && x.status === 'ready').sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)).map(x => x.id) };
}
