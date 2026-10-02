import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyDb } from '../src/store/schema.js';
import { previewHolidayCsv, importHolidays, parseCsv } from '../src/domain/holiday-csv.js';
import { isWorkingDay, listEvents, birthdayInYear, eventsOverlapping, createEvent } from '../src/domain/calendar.js';

const ctx = { actor: { role: 'admin', id: 'stf-adm' }, now: '2026-10-02T05:00:00.000Z', today: '2026-10-02' };

function fixture() {
  const db = createEmptyDb();
  db.school.currentAcademicYearId = 'AY2026-27';
  db.academicYears.push({ id: 'AY2026-27', label: '2026-27', startDate: '2026-06-01', endDate: '2027-05-31' });
  db.programs.push({ id: 'P-TOD', name: 'Toddler Community', ageRange: '1.5-3', teacherIds: [] },
    { id: 'P-PA', name: 'Primary A', ageRange: '3-6', teacherIds: [] }, { id: 'P-PB', name: 'Primary B', ageRange: '3-6', teacherIds: [] });
  const s = (id, programId, dob) => ({ id, firstName: id, lastName: 'Demoson', dob, programId, admissionNo: id, status: 'active', guardianIds: [], routeId: null, stopId: null, feeCategory: 'regular', healthNotes: null });
  db.students.push(s('LEAP', 'P-PA', '2024-02-29'), s('OCT', 'P-TOD', '2024-10-15'));
  db.calendarEvents.push({ id: 'X1', academicYearId: 'AY2026-27', type: 'holiday', title: 'Existing Break', startDate: '2026-12-25', endDate: '2026-12-25', programIds: [], description: '', source: 'manual', importBatchId: null });
  return db;
}

const CSV = '﻿Title,Start Date,End Date,Type,Programs\r\n'
  + '"Independence Day, national",15-08-2026,,holiday,\r\n'        // quoted comma, DD-MM-YYYY
  + 'Gandhi Jayanti,02/10/2026,,holiday,\r\n'                      // DD/MM/YYYY
  + 'Winter break,24-Dec-2026,02-Jan-2027,holiday,all\r\n'          // DD-MMM-YYYY, range across months/years
  + '\r\n'                                                          // blank line ignored
  + 'Bad date,31-02-2026,,holiday,\r\n'                             // impossible date → rejected
  + 'Backwards,10-11-2026,05-11-2026,holiday,\r\n'                  // end < start → rejected
  + 'Gandhi Jayanti,2026-10-02,,holiday,\r\n'                       // in-file duplicate
  + 'Existing break,2026-12-25,,holiday,\r\n'                       // duplicate vs existing (normalised title)
  + 'Next year day,2027-06-15,,holiday,\r\n'                        // outside AY
  + 'Primary PTM,2026-11-14,,ptm,Primary A;Primary B\r\n'           // program-specific
  + 'Toddler rest day,2026-11-16,,holiday,Toddler Community\r\n'
  + 'Mystery,2026-11-20,,picnic,\r\n';                              // unknown type → rejected

test('CSV parser: BOM, CRLF, quotes, blank lines', () => {
  const recs = parseCsv(CSV);
  assert.equal(recs[0].fields[0], 'Title');
  assert.equal(recs[1].fields[0], 'Independence Day, national');
  assert.equal(recs.length, 12); // header + 11 data rows; blank line skipped
  assert.equal(recs[4].line, 6); // line numbers survive the blank line
});

test('preview: statuses, reasons with line numbers, reconciling counts', () => {
  const db = fixture();
  const p = previewHolidayCsv(db, CSV, 'AY2026-27');
  const by = t => p.rows.find(r => r.title === t);
  assert.equal(by('Independence Day, national').startDate, '2026-08-15');
  assert.equal(by('Winter break').endDate, '2027-01-02');
  const bad = by('Bad date');
  assert.equal(bad.status, 'rejected');
  assert.equal(bad.line, 6);
  assert.match(bad.reason, /invalid date/);
  assert.equal(by('Backwards').status, 'rejected');
  assert.match(by('Backwards').reason, /before start/);
  assert.equal(by('Mystery').status, 'rejected');
  const gj = p.rows.filter(r => r.title === 'Gandhi Jayanti');
  assert.deepEqual(gj.map(r => r.status), ['ok', 'duplicate']);
  assert.equal(by('Existing break').status, 'duplicate');
  assert.equal(by('Next year day').status, 'outsideYear');
  assert.deepEqual(by('Primary PTM').programIds, ['P-PA', 'P-PB']);
  const c = p.counts;
  assert.deepEqual(c, { inputRows: 11, ok: 5, duplicate: 2, outsideYear: 1, rejected: 3 });
  assert.equal(c.inputRows, c.ok + c.duplicate + c.outsideYear + c.rejected);
});

test('import: inputRows === imported + skippedDuplicate + rejected; outside-year only when ticked; idempotent', () => {
  const db = fixture();
  const p = previewHolidayCsv(db, CSV, 'AY2026-27');
  const r = importHolidays(db, p, { includeOutsideYear: false }, ctx);
  assert.deepEqual([r.inputRows, r.imported, r.skippedDuplicate, r.rejected], [11, 5, 2, 4]);
  assert.equal(r.inputRows, r.imported + r.skippedDuplicate + r.rejected);
  assert.ok(r.rejectedRows.some(x => /not included/.test(x.reason)));
  assert.equal(db.calendarEvents.filter(e => e.importBatchId === r.importBatchId).length, 5);
  assert.equal(db.auditLog.at(-1).action, 'import');
  // same preview again: everything already present
  const again = importHolidays(db, p, { includeOutsideYear: false }, ctx);
  assert.equal(again.imported, 0);
  assert.equal(again.inputRows, again.imported + again.skippedDuplicate + again.rejected);
  // ticking "include" imports the outside-year row
  const db2 = fixture();
  const r2 = importHolidays(db2, previewHolidayCsv(db2, CSV, 'AY2026-27'), { includeOutsideYear: true }, ctx);
  assert.deepEqual([r2.imported, r2.rejected], [6, 3]);
});

test('headerless file uses positional columns (date, title, …)', () => {
  const db = fixture();
  const p = previewHolidayCsv(db, '01-11-2026,Rajyotsava\n', 'AY2026-27');
  assert.equal(p.rows[0].title, 'Rajyotsava');
  assert.equal(p.rows[0].startDate, '2026-11-01');
  assert.equal(p.counts.ok, 1);
});

test('range expands; program-specific isWorkingDay; weekly offs', () => {
  const db = fixture();
  importHolidays(db, previewHolidayCsv(db, CSV, 'AY2026-27'), {}, ctx);
  for (const d of ['2026-12-24', '2026-12-31', '2027-01-01', '2027-01-02']) assert.equal(isWorkingDay(db, d, 'P-PA'), false, d);
  assert.equal(isWorkingDay(db, '2027-01-04', 'P-PA'), true); // Monday after break
  // Toddler-only holiday on Mon 16-Nov
  assert.equal(isWorkingDay(db, '2026-11-16', 'P-TOD'), false);
  assert.equal(isWorkingDay(db, '2026-11-16', 'P-PA'), true);
  assert.equal(isWorkingDay(db, '2026-11-16'), true); // no program → only school-wide events apply
  assert.equal(isWorkingDay(db, '2026-11-14', 'P-PA'), false); // Saturday
  createEvent(db, { academicYearId: 'AY2026-27', type: 'workingSaturday', title: 'Annual day prep', startDate: '2026-11-21', programIds: ['P-PA'] }, ctx);
  assert.equal(isWorkingDay(db, '2026-11-21', 'P-PA'), true);
  assert.equal(isWorkingDay(db, '2026-11-21', 'P-PB'), false);
});

test('program filter hides other programs\' events; multi-day event appears in both months', () => {
  const db = fixture();
  importHolidays(db, previewHolidayCsv(db, CSV, 'AY2026-27'), {}, ctx);
  const tod = listEvents(db, { academicYearId: 'AY2026-27', programId: 'P-TOD', types: ['holiday', 'ptm'] });
  assert.ok(!tod.some(e => e.title === 'Primary PTM'));
  assert.ok(tod.some(e => e.title === 'Toddler rest day'));
  const all = db.calendarEvents;
  const dec = eventsOverlapping(all, '2026-12-01', '2026-12-31').map(e => e.title);
  const jan = eventsOverlapping(all, '2027-01-01', '2027-01-31').map(e => e.title);
  assert.ok(dec.includes('Winter break') && jan.includes('Winter break'));
});

test('birthdays are derived (never stored); 29-Feb falls on 28-Feb in non-leap years', () => {
  const db = fixture();
  assert.equal(birthdayInYear('2024-02-29', 2027), '2027-02-28');
  assert.equal(birthdayInYear('2024-02-29', 2028), '2028-02-29');
  const evs = listEvents(db, { academicYearId: 'AY2026-27', types: ['birthday'] });
  assert.deepEqual(evs.map(e => [e.studentId, e.startDate]), [['OCT', '2026-10-15'], ['LEAP', '2027-02-28']]);
  assert.equal(evs.find(e => e.studentId === 'LEAP').leapDayShifted, true);
  assert.equal(db.calendarEvents.some(e => e.type === 'birthday'), false);
  // scoping hook: only the listed children
  assert.equal(listEvents(db, { academicYearId: 'AY2026-27', types: ['birthday'], birthdayStudentIds: ['OCT'] }).length, 1);
});
