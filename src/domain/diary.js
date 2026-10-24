// Daily diary entries per child (meal, sleep, health, activity; 'observation' entries written before Phase 3 stay valid).

import { fail, newId } from './ids.js';
import { isISODate, compareISO, isHHMM, tsToMs } from './dates.js';
import { mustGet, activeStudents } from './people.js';
import { appendAudit } from './audit.js';

export const DIARY_TYPES = ['observation', 'meal', 'sleep', 'health', 'activity', 'toilet', 'needs'];
// wave 2 (#83): 'toilet' (a nappy change or toilet visit; offered for the toddlers' level) and 'needs' (please send …,
// which the family acknowledges)
export const TODDLER_TYPES = ['toilet'];
export const TOILET_KINDS = ['wet', 'dry', 'bowel', 'toilet'];
export const NEED_ITEMS = ['spareClothes', 'nappies', 'wipes', 'other'];
export const OBSERVATION_AREAS = ['practicalLife', 'sensorial', 'language', 'math', 'culture'];
export const DIARY_CHANGE_WINDOW_MS = 24 * 3600_000; // the teacher who wrote an entry may correct or remove it this long; the principal always

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
    case 'toilet': {
      if (!isHHMM(d.time)) fail('VALIDATION', 'Give the time (HH:MM)');
      if (!TOILET_KINDS.includes(d.kind)) fail('VALIDATION', `Unknown kind: ${d.kind}`);
      const note = d.note ? String(d.note).trim() : '';
      if (note.length > 200) fail('VALIDATION', 'The note must be at most 200 characters');
      return { time: d.time, kind: d.kind, note };
    }
    case 'needs': {
      const items = Array.isArray(d.items) ? [...new Set(d.items)] : [];
      if (!items.length) fail('VALIDATION', 'Choose what the family should send');
      for (const it of items) if (!NEED_ITEMS.includes(it)) fail('VALIDATION', `Unknown item: ${it}`);
      const note = d.note ? String(d.note).trim() : '';
      if (items.includes('other') && !note) fail('VALIDATION', 'Say what else to send');
      if (note.length > 200) fail('VALIDATION', 'The note must be at most 200 characters');
      return { items, note };
    }
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
  const entry = { id: newId('dia'), studentId, date, type, data: cleanData(type, data), createdBy: ctx.actor.id, createdAt: ctx.now, parentReadAt: null,
    ...(type === 'needs' ? { ackAt: null, ackBy: null } : {}) };
  db.diaryEntries.push(entry);
  return entry;
}

/**
 * One entry of the same type and content for several children of one programme (lunch, nap, a class activity), in one
 * write: every child and the entry are checked first, so either all entries are added or none.
 * overrides (meals only): {studentId: {ate}} for a ticked child who ate a different amount than the rest.
 */
export function addDiaryEntries(db, { programId, studentIds, date, type, data, overrides = null }, ctx) {
  if (!Array.isArray(studentIds) || !studentIds.length) fail('VALIDATION', 'Choose at least one child');
  if (new Set(studentIds).size !== studentIds.length) fail('VALIDATION', 'A child is listed twice');
  const inProgram = new Set(activeStudents(db, programId).map(s => s.id));
  for (const id of studentIds) if (!inProgram.has(id)) fail('VALIDATION', 'Every child must be an active child of this programme');
  const over = overrides || {};
  if (typeof over !== 'object' || Array.isArray(over)) fail('VALIDATION', 'overrides must be an object');
  for (const [id, o] of Object.entries(over)) {
    if (type !== 'meal') fail('VALIDATION', 'Only a meal can differ per child');
    if (!studentIds.includes(id)) fail('VALIDATION', 'A different amount is given for a child who is not ticked');
    if (!o || typeof o !== 'object' || Object.keys(o).some(k => k !== 'ate')) fail('VALIDATION', 'Only the amount eaten can differ per child');
  }
  const draft = { diaryEntries: [], students: db.students };
  const entries = studentIds.map(studentId => addDiaryEntry(draft, { studentId, date, type, data: over[studentId] ? { ...data, ate: over[studentId].ate } : data }, ctx));
  db.diaryEntries.push(...entries);
  return { added: entries.length, entries };
}

const byCreated = (a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0);

export function diaryForStudentDate(db, studentId, date) {
  return db.diaryEntries.filter(e => e.studentId === studentId && e.date === date).sort(byCreated);
}

export function diaryForProgramDate(db, programId, date) {
  const ids = new Set(activeStudents(db, programId).map(s => s.id));
  return db.diaryEntries.filter(e => ids.has(e.studentId) && e.date === date).sort(byCreated);
}

/** The teacher who wrote the entry within 24 hours of writing it, or the principal at any time. */
function mayChange(e, ctx) {
  if (e.type === 'observation') fail('VALIDATION', 'Observations written in the diary before Learning existed cannot be changed');
  if (ctx.actor.role === 'admin') return;
  if (e.createdBy !== ctx.actor.id) fail('NOT_ALLOWED', 'Only the teacher who wrote this entry, or the principal, can change it');
  if (tsToMs(ctx.now) - tsToMs(e.createdAt) > DIARY_CHANGE_WINDOW_MS) fail('NOT_ALLOWED', 'An entry can be changed within 24 hours of writing it; after that, ask the principal');
}

/** Correct a slip (the amount eaten, a nap time, a temperature): the type stays; what was there before is kept in history. Audited. */
export function correctDiaryEntry(db, id, { data } = {}, ctx) {
  const e = mustGet(db, 'diaryEntries', id, 'Diary entry');
  mayChange(e, ctx);
  if (mustGet(db, 'students', e.studentId, 'Student').status !== 'active') fail('VALIDATION', 'Student is not active');
  const clean = cleanData(e.type, data);
  if (JSON.stringify(clean) === JSON.stringify(e.data)) return e;
  e.history = [...(e.history || []), { data: e.data, at: e.correctedAt || e.createdAt, by: e.correctedBy || e.createdBy }];
  Object.assign(e, { data: clean, correctedAt: ctx.now, correctedBy: ctx.actor.id });
  appendAudit(db, ctx, { entity: 'diaryEntry', entityId: e.id, action: 'correct', summary: `diary entry corrected for ${e.studentId} (${e.type}, ${e.date})` });
  return e;
}

/** Remove an entry written in error (the wrong child, the wrong type). It leaves the family's diary at once. Audited. */
export function removeDiaryEntry(db, id, ctx) {
  const e = mustGet(db, 'diaryEntries', id, 'Diary entry');
  mayChange(e, ctx);
  db.diaryEntries.splice(db.diaryEntries.indexOf(e), 1);
  appendAudit(db, ctx, { entity: 'diaryEntry', entityId: e.id, action: 'remove', summary: `diary entry removed for ${e.studentId} (${e.type}, ${e.date})` });
  return { removed: e.id };
}

/** A parent says they will send what a 'needs' entry asks for (once; it also counts as read). */
export function acknowledgeNeed(db, entryId, ctx) {
  const e = mustGet(db, 'diaryEntries', entryId, 'Diary entry');
  if (e.type !== 'needs') fail('VALIDATION', 'Only a "please send" entry is acknowledged');
  if (!e.parentReadAt) e.parentReadAt = ctx.now;
  if (!e.ackAt) Object.assign(e, { ackAt: ctx.now, ackBy: ctx.actor.id });
  return e;
}

export function markDiaryRead(db, entryId, ctx) {
  const e = mustGet(db, 'diaryEntries', entryId, 'Diary entry');
  if (!e.parentReadAt) e.parentReadAt = ctx.now;
  return e;
}
