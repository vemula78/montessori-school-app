// Per-child progress on presentations: append-only events, current state derived (latest seq per child and
// presentation). The real app's snapshot carries only that latest event per key (the same derivation in SQL:
// distinct on (student_id, presentation_id) order by seq desc); history is read on demand. Parents never see
// progress events: their view is the frozen copy inside a published termly report.
// Rules: forward only introduced → practising → mastered; the first event may be any status (a child may arrive
// already practising); a backward or repeated status needs correction:true and a reason; the date is not in the
// future and not before the previous event's unless it is a correction; the presentation must be active unless it
// is a correction; the child must be active.

import { fail, newId } from './ids.js';
import { isISODate, compareISO } from './dates.js';
import { byId, mustGet } from './people.js';
import { appendAudit } from './audit.js';
import { mustSeeLearner, learnerVisible } from './observations.js';

export const PROGRESS_STATUSES = ['introduced', 'practising', 'mastered'];
const rank = s => PROGRESS_STATUSES.indexOf(s);

/** Why prev → next is not allowed (null = allowed). prev null = no earlier event. */
export function transitionProblem(prev, next, correction = false) {
  if (!PROGRESS_STATUSES.includes(next)) return `unknown status: ${next}`;
  if (prev === null || prev === undefined) return null;
  if (rank(next) > rank(prev)) return null;
  if (correction) return null;
  return rank(next) === rank(prev) ? `already ${prev}; recording it again needs a correction with a reason` : `${prev} → ${next} goes backwards; it needs a correction with a reason`;
}

const keyOf = e => `${e.studentId}|${e.presentationId}`;

/** The event with the highest seq per (student, presentation). */
export function latestPerKey(events) {
  const m = new Map();
  for (const e of events || []) { const k = keyOf(e); const cur = m.get(k); if (!cur || e.seq > cur.seq) m.set(k, e); }
  return [...m.values()];
}

/** Current state: [{studentId, presentationId, status, date, seq}] sorted by student then presentation. */
export function deriveState(events) {
  return latestPerKey(events).map(e => ({ studentId: e.studentId, presentationId: e.presentationId, status: e.status, date: e.date, seq: e.seq }))
    .sort((a, b) => (a.studentId < b.studentId ? -1 : a.studentId > b.studentId ? 1 : a.presentationId < b.presentationId ? -1 : a.presentationId > b.presentationId ? 1 : 0));
}

/** Append one event (needs every earlier event of this child and presentation loaded). */
export function recordProgress(db, input = {}, ctx) {
  const { studentId, presentationId, status, date, note = '', correction = false, reason = null } = input;
  const s = mustGet(db, 'students', studentId, 'Student');
  if (s.status !== 'active') fail('VALIDATION', 'Student is not active');
  const pr = mustGet(db, 'presentations', presentationId, 'Presentation');
  if (correction !== true && correction !== false) fail('VALIDATION', 'correction must be true or false');
  const why = correction ? String(reason ?? '').trim() : '';
  if (correction && !why) fail('VALIDATION', 'A correction needs a reason');
  if (!pr.active && !correction) fail('VALIDATION', 'That presentation is retired (only a correction can be recorded)');
  if (!isISODate(date)) fail('VALIDATION', `Invalid date: ${date}`);
  if (compareISO(date, ctx.today) > 0) fail('VALIDATION', 'Progress date is in the future');
  const mine = db.progressEvents.filter(e => e.studentId === s.id && e.presentationId === pr.id);
  const prev = mine.reduce((a, e) => (!a || e.seq > a.seq ? e : a), null);
  const problem = transitionProblem(prev ? prev.status : null, status, correction);
  if (problem) fail('VALIDATION', problem);
  if (prev && !correction && compareISO(date, prev.date) < 0) fail('VALIDATION', `The date is before the previous record (${prev.date}); record a correction instead`);
  const n = String(note ?? '').trim();
  if (n.length > 1000) fail('VALIDATION', 'The note is longer than 1000 characters');
  const ev = { id: newId('prg'), studentId: s.id, presentationId: pr.id, seq: (prev ? prev.seq : 0) + 1, status, date, note: n, correction,
    reason: correction ? why : null, recordedBy: ctx.actor.id, recordedAt: ctx.now };
  db.progressEvents.push(ev);
  appendAudit(db, ctx, { entity: 'progress', entityId: ev.id, action: correction ? 'correct' : 'record', summary: `student ${s.id}, presentation ${pr.id}: ${status} (seq ${ev.seq})` });
  return ev;
}

/**
 * Current state for staff: state({studentId} | {programId}) → [{studentId, presentationId, status, date, seq, name,
 * area, retired}]. Retired presentations appear only where a child has history.
 */
export function progressState(db, p, { studentId, programId } = {}) {
  if (!p || !['admin', 'teacher'].includes(p.role)) fail('NOT_ALLOWED', 'Progress records are for staff; families see them in the termly report');
  if (studentId) mustSeeLearner(p, db, studentId);
  return deriveState((db.progressEvents || []).filter(e => learnerVisible(p, e.studentId)
    && (!studentId || e.studentId === studentId) && (!programId || byId(db.students, e.studentId)?.programId === programId)))
    .map(x => { const pr = byId(db.presentations || [], x.presentationId); return { ...x, name: pr ? pr.name : null, area: pr ? pr.area : null, retired: pr ? !pr.active : null }; });
}

/** Every event of one child and presentation, oldest first (demo: from the document; real app: remote.js reads the table). */
export function progressHistory(db, p, studentId, presentationId) {
  if (!p || !['admin', 'teacher'].includes(p.role)) fail('NOT_ALLOWED', 'Progress records are for staff; families see them in the termly report');
  mustSeeLearner(p, db, studentId);
  return (db.progressEvents || []).filter(e => e.studentId === studentId && e.presentationId === presentationId).sort((a, b) => a.seq - b.seq);
}
