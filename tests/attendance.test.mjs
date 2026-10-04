import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyDb } from '../src/store/schema.js';
import * as A from '../src/domain/attendance.js';
import * as D from '../src/domain/diary.js';

const ctx = (today = '2026-10-09', id = 'T-A') => ({ actor: { role: 'teacher', id }, now: `${today}T04:00:00.000Z`, today });

function fixture() {
  const db = createEmptyDb();
  db.school.currentAcademicYearId = 'AY2026-27';
  db.academicYears.push({ id: 'AY2026-27', label: '2026-27', startDate: '2026-06-01', endDate: '2027-05-31' });
  db.programs.push({ id: 'PA', name: 'Primary A', ageRange: '3-6', teacherIds: ['T-A'] }, { id: 'PT', name: 'Toddler Community', ageRange: '1.5-3', teacherIds: [] });
  const s = (id, first, programId) => ({ id, firstName: first, lastName: 'Specimenova', dob: '2022-01-01', programId, admissionNo: id, status: 'active', guardianIds: [], routeId: null, stopId: null, feeCategory: 'regular', healthNotes: null });
  db.students.push(s('K1', 'Asha', 'PA'), s('K2', 'Bala', 'PA'), s('K3', 'Chitra', 'PT'));
  db.calendarEvents.push(
    { id: 'H1', academicYearId: 'AY2026-27', type: 'holiday', title: 'Sample holiday', startDate: '2026-10-02', endDate: '2026-10-02', programIds: [], description: '', source: 'manual', importBatchId: null },
    { id: 'H2', academicYearId: 'AY2026-27', type: 'holiday', title: 'Toddler rest day', startDate: '2026-10-07', endDate: '2026-10-07', programIds: ['PT'], description: '', source: 'manual', importBatchId: null },
  );
  return db;
}

test('marking on a holiday or weekly off throws NOT_WORKING_DAY with the reason', () => {
  const db = fixture();
  assert.throws(() => A.markAttendance(db, '2026-10-02', [{ studentId: 'K1', status: 'present' }], ctx()), { code: 'NOT_WORKING_DAY', message: /holiday: Sample holiday/ });
  assert.throws(() => A.markAttendance(db, '2026-10-03', [{ studentId: 'K1', status: 'present' }], ctx()), { code: 'NOT_WORKING_DAY', message: /weekly off/ });
  // program-specific holiday blocks Toddler only
  assert.throws(() => A.markAttendance(db, '2026-10-07', [{ studentId: 'K3', status: 'present' }], ctx()), { code: 'NOT_WORKING_DAY' });
  assert.equal(A.markAttendance(db, '2026-10-07', [{ studentId: 'K1', status: 'present' }], ctx()).created, 1);
  assert.throws(() => A.markAttendance(db, '2026-10-12', [{ studentId: 'K1', status: 'present' }], ctx()), { code: 'VALIDATION' }); // future
  assert.equal(db.attendance.length, 1);
});

test('one record per (date, student); re-mark overwrites with an audit row', () => {
  const db = fixture();
  const r1 = A.markAttendance(db, '2026-10-05', [{ studentId: 'K1', status: 'present' }, { studentId: 'K2', status: 'absent' }], ctx());
  assert.deepEqual([r1.input, r1.created, r1.changed, r1.unchanged], [2, 2, 0, 0]);
  const r2 = A.markAttendance(db, '2026-10-05', [{ studentId: 'K1', status: 'present' }, { studentId: 'K2', status: 'late' }], ctx());
  assert.deepEqual([r2.input, r2.created, r2.changed, r2.unchanged], [2, 0, 1, 1]);
  assert.equal(db.attendance.filter(a => a.date === '2026-10-05').length, 2);
  assert.equal(db.attendance.find(a => a.studentId === 'K2').status, 'late');
  assert.equal(db.auditLog.length, 1);
  assert.equal(db.auditLog[0].summary, 'absent → late');
  const day = A.attendanceForDate(db, '2026-10-06', 'PA');
  assert.deepEqual(day.map(x => [x.studentId, x.status]), [['K1', null], ['K2', null]]);
  assert.throws(() => A.markAttendance(db, '2026-10-05', [{ studentId: 'K1', status: 'here' }], ctx()), { code: 'VALIDATION' });
});

test('summary counts over working days only', () => {
  const db = fixture();
  A.markAttendance(db, '2026-10-05', [{ studentId: 'K1', status: 'present' }], ctx());
  A.markAttendance(db, '2026-10-06', [{ studentId: 'K1', status: 'absent' }], ctx());
  A.markAttendance(db, '2026-10-07', [{ studentId: 'K1', status: 'late' }], ctx());
  A.markAttendance(db, '2026-10-08', [{ studentId: 'K1', status: 'leave' }], ctx());
  // 01-Oct (Thu) .. 09-Oct (Fri): working days = 01, 05, 06, 07, 08, 09 (02 holiday, 03/04 weekend)
  const s = A.attendanceSummary(db, 'K1', '2026-10-01', '2026-10-09');
  assert.deepEqual(s, { studentId: 'K1', from: '2026-10-01', to: '2026-10-09', workingDays: 6, present: 1, absent: 1, late: 1, leave: 1, unmarked: 2 });
  assert.equal(s.workingDays, s.present + s.absent + s.late + s.leave + s.unmarked);
});

test('diary entries validate per type and parentReadAt is set once', () => {
  const db = fixture();
  // Phase 3: new observations go to Learning, never the parent-visible diary
  assert.throws(() => D.addDiaryEntry(db, { studentId: 'K1', date: '2026-10-09', type: 'observation', data: { area: 'sensorial', text: 'Pink tower, 10 cubes' } }, ctx()), /Learning/);
  const e = D.addDiaryEntry(db, { studentId: 'K1', date: '2026-10-09', type: 'activity', data: { text: 'Pink tower, 10 cubes' } }, ctx());
  D.addDiaryEntry(db, { studentId: 'K1', date: '2026-10-09', type: 'meal', data: { meal: 'lunch', ate: 'some' } }, ctx());
  assert.throws(() => D.addDiaryEntry(db, { studentId: 'K1', date: '2026-10-09', type: 'sleep', data: { from: '13:00', to: '12:00' } }, ctx()), { code: 'VALIDATION' });
  assert.throws(() => D.addDiaryEntry(db, { studentId: 'K1', date: '2026-10-09', type: 'observation', data: { area: 'sports', text: 'x' } }, ctx()), { code: 'VALIDATION' });
  assert.equal(D.diaryForStudentDate(db, 'K1', '2026-10-09').length, 2);
  assert.equal(D.diaryForProgramDate(db, 'PA', '2026-10-09').length, 2);
  assert.equal(D.diaryForProgramDate(db, 'PT', '2026-10-09').length, 0);
  D.markDiaryRead(db, e.id, { ...ctx(), actor: { role: 'parent', id: 'G1' }, now: '2026-10-09T10:00:00.000Z' });
  D.markDiaryRead(db, e.id, { ...ctx(), actor: { role: 'parent', id: 'G1' }, now: '2026-10-09T11:00:00.000Z' });
  assert.equal(db.diaryEntries[0].parentReadAt, '2026-10-09T10:00:00.000Z');
});
