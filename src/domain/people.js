// Lookups over students, guardians, staff and programs.

import { fail } from './ids.js';
import { compareISO } from './dates.js';

export const fullName = p => (p ? `${p.firstName} ${p.lastName}` : '—');

export function byId(list, id) {
  return list.find(x => x.id === id) || null;
}

export function mustGet(db, collection, id, label = collection) {
  const x = byId(db[collection], id);
  if (!x) fail('NOT_FOUND', `${label} not found: ${id}`);
  return x;
}

export function activeStudents(db, programId) {
  return db.students.filter(s => s.status === 'active' && (!programId || s.programId === programId));
}

export function childrenOf(db, guardianId) {
  const g = byId(db.guardians, guardianId);
  if (!g) return [];
  return g.studentIds.map(id => byId(db.students, id)).filter(Boolean);
}

export function guardiansOf(db, studentId) {
  const s = byId(db.students, studentId);
  if (!s) return [];
  return s.guardianIds.map(id => byId(db.guardians, id)).filter(Boolean);
}

/** Active students sharing at least one guardian with studentId (excluding the student). */
export function siblingsOf(db, studentId) {
  const s = byId(db.students, studentId);
  if (!s) return [];
  const ids = new Set();
  for (const g of guardiansOf(db, studentId)) for (const sid of g.studentIds) if (sid !== studentId) ids.add(sid);
  return [...ids].map(id => byId(db.students, id)).filter(x => x && x.status === 'active');
}

/** Eldest by dob (earliest date), ties broken by id. */
export function isEldestSibling(db, studentId) {
  const s = byId(db.students, studentId);
  const sibs = siblingsOf(db, studentId);
  return sibs.every(o => {
    const c = compareISO(s.dob, o.dob);
    return c < 0 || (c === 0 && s.id < o.id);
  });
}

export function sortByName(list) {
  return [...list].sort((a, b) => fullName(a).localeCompare(fullName(b)));
}
