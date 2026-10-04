// Daily diary entries per child (meal, sleep, health, activity; 'observation' entries written before Phase 3 stay valid).

import { fail, newId } from './ids.js';
import { isISODate, compareISO, isHHMM } from './dates.js';
import { mustGet, activeStudents } from './people.js';

export const DIARY_TYPES = ['observation', 'meal', 'sleep', 'health', 'activity'];
export const OBSERVATION_AREAS = ['practicalLife', 'sensorial', 'language', 'math', 'culture'];

const text = (v, label) => { if (!v || !String(v).trim()) fail('VALIDATION', `${label} is required`); return String(v).trim(); };

function cleanData(type, d = {}) {
  switch (type) {
    case 'observation':
      if (!OBSERVATION_AREAS.includes(d.area)) fail('VALIDATION', `Unknown area: ${d.area}`);
      return { area: d.area, text: text(d.text, 'Observation') };
    case 'meal':
      if (!['snack', 'lunch'].includes(d.meal)) fail('VALIDATION', `Unknown meal: ${d.meal}`);
      if (!['all', 'some', 'none'].includes(d.ate)) fail('VALIDATION', `Unknown amount eaten: ${d.ate}`);
      return { meal: d.meal, ate: d.ate, note: d.note ? String(d.note) : '' };
    case 'sleep':
      if (!isHHMM(d.from) || !isHHMM(d.to) || d.to <= d.from) fail('VALIDATION', 'Sleep needs valid from/to times (HH:MM, to after from)');
      return { from: d.from, to: d.to };
    case 'health': {
      const t = d.temperatureC;
      if (t !== null && t !== undefined && t !== '' && !(Number.isFinite(t) && t >= 30 && t <= 45)) fail('VALIDATION', 'Temperature must be 30–45 °C or left blank');
      return { temperatureC: t === '' || t === undefined ? null : t, note: text(d.note, 'Health note') };
    }
    case 'activity':
      return { text: text(d.text, 'Activity') };
    default:
      fail('VALIDATION', `Unknown diary type: ${type}`);
  }
}

export function addDiaryEntry(db, { studentId, date, type, data }, ctx) {
  // the diary is parent-visible: observations live in Learning (staff-only until shared); old entries stay readable
  if (type === 'observation') fail('VALIDATION', 'Observations are recorded under Learning now (staff-only until shared), not in the diary');
  const s = mustGet(db, 'students', studentId, 'Student');
  if (s.status !== 'active') fail('VALIDATION', 'Student is not active');
  if (!isISODate(date)) fail('VALIDATION', `Invalid date: ${date}`);
  if (compareISO(date, ctx.today) > 0) fail('VALIDATION', 'Diary date is in the future');
  const entry = { id: newId('dia'), studentId, date, type, data: cleanData(type, data), createdBy: ctx.actor.id, createdAt: ctx.now, parentReadAt: null };
  db.diaryEntries.push(entry);
  return entry;
}

const byCreated = (a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0);

export function diaryForStudentDate(db, studentId, date) {
  return db.diaryEntries.filter(e => e.studentId === studentId && e.date === date).sort(byCreated);
}

export function diaryForProgramDate(db, programId, date) {
  const ids = new Set(activeStudents(db, programId).map(s => s.id));
  return db.diaryEntries.filter(e => ids.has(e.studentId) && e.date === date).sort(byCreated);
}

export function markDiaryRead(db, entryId, ctx) {
  const e = mustGet(db, 'diaryEntries', entryId, 'Diary entry');
  if (!e.parentReadAt) e.parentReadAt = ctx.now;
  return e;
}
