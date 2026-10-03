// Child attendance: one record per (date, student); marking is blocked on non-working days.

import { fail } from './ids.js';
import { isISODate, compareISO, dateRange } from './dates.js';
import { mustGet, activeStudents, sortByName, fullName } from './people.js';
import { isWorkingDay, nonWorkingReason } from './calendar.js';
import { appendAudit } from './audit.js';

export const ATTENDANCE_STATUSES = ['present', 'absent', 'late', 'leave'];

export function attendanceForDate(db, date, programId) {
  if (!isISODate(date)) fail('VALIDATION', `Invalid date: ${date}`);
  return sortByName(activeStudents(db, programId)).map(s => {
    const rec = db.attendance.find(a => a.date === date && a.studentId === s.id);
    return { studentId: s.id, name: fullName(s), status: rec ? rec.status : null, markedBy: rec ? rec.markedBy : null, markedAt: rec ? rec.markedAt : null };
  });
}

/** Upsert; a changed status overwrites and is audit-logged. Whole batch is rejected if any entry is invalid. */
export function markAttendance(db, date, entries, ctx) {
  if (!isISODate(date)) fail('VALIDATION', `Invalid date: ${date}`);
  if (compareISO(date, ctx.today) > 0) fail('VALIDATION', 'Cannot mark attendance for a future date');
  if (!Array.isArray(entries) || !entries.length) fail('VALIDATION', 'Nothing to mark');
  for (const e of entries) {
    const s = mustGet(db, 'students', e.studentId, 'Student');
    if (s.status !== 'active') fail('VALIDATION', `Student ${s.id} is not active`);
    if (!ATTENDANCE_STATUSES.includes(e.status)) fail('VALIDATION', `Unknown status: ${e.status}`);
    if (!isWorkingDay(db, date, s.programId)) fail('NOT_WORKING_DAY', nonWorkingReason(db, date, s.programId));
  }
  let created = 0, changed = 0, unchanged = 0;
  for (const e of entries) {
    const rec = db.attendance.find(a => a.date === date && a.studentId === e.studentId);
    if (!rec) {
      db.attendance.push({ date, studentId: e.studentId, status: e.status, markedBy: ctx.actor.id, markedAt: ctx.now });
      created++;
    } else if (rec.status !== e.status) {
      appendAudit(db, ctx, { entity: 'attendance', entityId: `${date}|${e.studentId}`, action: 'remark', summary: `${rec.status} → ${e.status}` });
      Object.assign(rec, { status: e.status, markedBy: ctx.actor.id, markedAt: ctx.now });
      changed++;
    } else unchanged++;
  }
  return { input: entries.length, created, changed, unchanged };
}

/** Counts over working days of the student's program in [from, to]; unmarked = working days with no record. */
export function attendanceSummary(db, studentId, from, to) {
  const s = mustGet(db, 'students', studentId, 'Student');
  if (!isISODate(from) || !isISODate(to) || compareISO(to, from) < 0) fail('VALIDATION', 'Invalid date range');
  const out = { studentId, from, to, workingDays: 0, present: 0, absent: 0, late: 0, leave: 0, unmarked: 0 };
  for (const d of dateRange(from, to)) {
    if (!isWorkingDay(db, d, s.programId)) continue;
    out.workingDays++;
    const rec = db.attendance.find(a => a.date === d && a.studentId === studentId);
    if (rec) out[rec.status]++; else out.unmarked++;
  }
  return out;
}
