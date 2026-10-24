// Allergies and medical alerts (wave 2, #78), beside the existing free-text health note. The principal or a parent of
// the child sets them; every change is audited with the field names only (never the text). Read by the principal, the
// child's teachers (register, diary and pick-up badges) and the child's parents; never by the driver or the accountant.
// In the real app they live in student_health (alerts jsonb, notes text), never in the student document, so the roles
// that read students (driver, accountant) cannot see them (migration 0011).
// Student fields: healthNotes (string|null, as before) and healthAlerts ({allergies, medical, updatedAt, updatedBy,
// updatedByRole} | null).

import { fail } from './ids.js';
import { mustGet, fullName, activeStudents, sortByName } from './people.js';
import { appendAudit } from './audit.js';

export const HEALTH_TEXT_MAX = 500;
const clean = (v, label) => {
  const t = String(v ?? '').trim().replace(/[ \t]+/g, ' ');
  if (t.length > HEALTH_TEXT_MAX) fail('VALIDATION', `${label} must be at most ${HEALTH_TEXT_MAX} characters`);
  return t;
};

/** The child's health details as a screen shows them. */
export function healthView(s) {
  const a = s.healthAlerts || null;
  return { studentId: s.id, name: fullName(s), allergies: a ? a.allergies : '', medical: a ? a.medical : '', notes: s.healthNotes || '',
    updatedAt: a ? a.updatedAt : null, updatedByRole: a ? a.updatedByRole : null };
}
export const hasHealthAlert = s => Boolean((s.healthAlerts && (s.healthAlerts.allergies || s.healthAlerts.medical)) || s.healthNotes);

/** setHealth({studentId, allergies?, medical?, notes?}) — each given field replaces the stored one; '' clears it. */
export function setHealth(db, { studentId, allergies, medical, notes } = {}, ctx) {
  const s = mustGet(db, 'students', studentId, 'Student');
  if (s.status !== 'active') fail('VALIDATION', 'This child has left the school; their records are read-only');
  if (allergies === undefined && medical === undefined && notes === undefined) fail('VALIDATION', 'Nothing to change');
  const cur = s.healthAlerts || { allergies: '', medical: '' };
  const next = { allergies: allergies === undefined ? cur.allergies : clean(allergies, 'Allergies'), medical: medical === undefined ? cur.medical : clean(medical, 'Medical alerts') };
  const changed = [];
  if (next.allergies !== cur.allergies) changed.push('allergies');
  if (next.medical !== cur.medical) changed.push('medical alerts');
  if (notes !== undefined) {
    const n = clean(notes, 'The health note') || null;
    if (n !== (s.healthNotes || null)) changed.push('health note');
    s.healthNotes = n;
  }
  s.healthAlerts = next.allergies || next.medical ? { ...next, updatedAt: ctx.now, updatedBy: ctx.actor.id, updatedByRole: ctx.actor.role } : null;
  appendAudit(db, ctx, { entity: 'student', entityId: s.id, action: 'health', summary: changed.length ? `${changed.join(', ')} changed by ${ctx.actor.role === 'parent' ? 'a parent' : 'the school'}` : 'no change' });
  return healthView(s);
}

/** Active children of a programme (or all, for the principal) with any allergy, alert or health note: the badge list. */
export function healthAlerts(db, studentIds, programId = null) {
  const ids = new Set(studentIds);
  return sortByName(activeStudents(db, programId || undefined).filter(s => ids.has(s.id) && hasHealthAlert(s))).map(healthView);
}
