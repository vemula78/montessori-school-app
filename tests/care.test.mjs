// Care features: whole-class diary entries, parent leave requests, authorised pick-up people and the pick-up log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSeed } from '../src/seed/seed-data.js';
import { COMMANDS, execute, personaFor } from '../src/domain/commands.js';

const NOW = new Date(Date.UTC(2026, 9, 2, 5, 0, 0)); // Friday 02-Oct-2026
const TODAY = '2026-10-02';
const seed = () => buildSeed(NOW);
const ctxOf = (p, today = TODAY) => ({ actor: { role: p.role, id: p.staffId || p.guardianId }, now: `${today}T05:00:00.000Z`, today });
const as = (db, link) => personaFor(db, link);
const run = (db, link, name, args, today) => { const p = as(db, link); return execute(name, db, args, ctxOf(p, today), p); };
const TEACHER_PA = { role: 'teacher', staffId: 'stf-teacher-pa' };
const TEACHER_PB = { role: 'teacher', staffId: 'stf-teacher-pb' };
const ADMIN = { role: 'admin', staffId: 'stf-principal' };
const ACCOUNTANT = { role: 'accountant', staffId: 'stf-accountant' };
const primaryA = db => db.programs.find(p => p.name === 'Primary A').id;
const kidsOf = (db, pid) => db.students.filter(s => s.programId === pid && s.status === 'active').map(s => s.id);

// ---------------------------------------------------------------- whole-class diary
test('diary.addMany: one entry per ticked child in one write; count in = count out', () => {
  const db = seed();
  const pid = primaryA(db);
  const ids = kidsOf(db, pid);
  const before = db.diaryEntries.length;
  const r = run(db, TEACHER_PA, 'diary.addMany', [{ programId: pid, date: TODAY, studentIds: ids, type: 'meal', data: { meal: 'lunch', ate: 'all' } }]);
  assert.equal(r.added, ids.length);
  assert.equal(db.diaryEntries.length - before, ids.length);
  assert.deepEqual(new Set(r.entries.map(e => e.studentId)), new Set(ids));
  assert.ok(r.entries.every(e => e.type === 'meal' && e.data.meal === 'lunch' && e.date === TODAY));
});

test('diary.addMany is all-or-nothing and refuses children outside the programme, other teachers, empty lists and duplicates', () => {
  const db = seed();
  const pid = primaryA(db);
  const ids = kidsOf(db, pid);
  const other = db.students.find(s => s.programId !== pid && s.status === 'active').id;
  const before = JSON.stringify(db.diaryEntries);
  assert.throws(() => run(db, TEACHER_PA, 'diary.addMany', [{ programId: pid, date: TODAY, studentIds: [...ids, other], type: 'activity', data: { text: 'Songs' } }]), { code: 'NOT_ALLOWED' }, "another programme's child");
  assert.throws(() => run(db, ADMIN, 'diary.addMany', [{ programId: pid, date: TODAY, studentIds: [...ids, other], type: 'activity', data: { text: 'Songs' } }]), { code: 'VALIDATION' }, 'the principal too: one programme per entry');
  assert.throws(() => run(db, TEACHER_PB, 'diary.addMany', [{ programId: pid, date: TODAY, studentIds: ids, type: 'activity', data: { text: 'Songs' } }]), { code: 'NOT_ALLOWED' });
  assert.throws(() => run(db, ACCOUNTANT, 'diary.addMany', [{ programId: pid, date: TODAY, studentIds: ids, type: 'activity', data: { text: 'Songs' } }]), { code: 'NOT_ALLOWED' });
  assert.throws(() => run(db, TEACHER_PA, 'diary.addMany', [{ programId: pid, date: TODAY, studentIds: [], type: 'activity', data: { text: 'Songs' } }]), { code: 'VALIDATION' });
  assert.throws(() => run(db, TEACHER_PA, 'diary.addMany', [{ programId: pid, date: TODAY, studentIds: [ids[0], ids[0]], type: 'activity', data: { text: 'Songs' } }]), { code: 'VALIDATION' });
  assert.throws(() => run(db, TEACHER_PA, 'diary.addMany', [{ programId: pid, date: TODAY, studentIds: ids, type: 'activity', data: { text: ' ' } }]), { code: 'VALIDATION' }, 'the entry itself is validated');
  assert.equal(JSON.stringify(db.diaryEntries), before, 'nothing was written by any refused call');
  assert.equal(COMMANDS['diary.addMany'].slice, 'classroom');
  assert.ok(!COMMANDS['diary.addMany'].serverOnly, 'runs in both modes');
  run(db, ADMIN, 'diary.addMany', [{ programId: pid, date: TODAY, studentIds: ids.slice(0, 1), type: 'activity', data: { text: 'Songs' } }]);
});
