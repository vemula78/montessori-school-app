// Care features: whole-class diary entries, parent leave requests, authorised pick-up people and the pick-up log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSeed } from '../src/seed/seed-data.js';
import { COMMANDS, execute, personaFor } from '../src/domain/commands.js';

const NOW = new Date(Date.UTC(2026, 9, 2, 5, 0, 0)); // Friday 02-Oct-2026
const TODAY = '2026-10-02';
// the demo seed has sample absences, pick-up people and pick-ups; these tests start from none
const seed = () => Object.assign(buildSeed(NOW), { leaveRequests: [], pickupContacts: [], pickups: [] });
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

// ---------------------------------------------------------------- leave requests
const PARENT_01 = { role: 'parent', guardianId: 'grd-01' }; // Neel stu-01 (Primary A), Vivaan stu-02 (Primary B)
const PARENT_02 = { role: 'parent', guardianId: 'grd-02' }; // stu-03, stu-04
const DRIVER = { role: 'driver', staffId: 'stf-driver-1' };

test('leave.request: a parent reports an absence for their own child; dates, length, overlap and reason are checked', () => {
  const db = seed();
  const r = run(db, PARENT_01, 'leave.request', [{ studentId: 'stu-01', fromDate: '2026-10-05', toDate: '2026-10-06', reason: '  Family wedding  ' }]);
  assert.equal(r.status, 'active');
  assert.equal(r.guardianId, 'grd-01');
  assert.equal(r.reason, 'Family wedding');
  assert.equal(db.leaveRequests.length, db.leaveRequests.filter(x => x.id).length);
  const bad = (args, code = 'VALIDATION') => assert.throws(() => run(db, PARENT_01, 'leave.request', [args]), { code });
  bad({ studentId: 'stu-01', fromDate: '2026-10-01', toDate: '2026-10-01' }); // past
  bad({ studentId: 'stu-01', fromDate: '2026-10-09', toDate: '2026-10-08' }); // reversed
  bad({ studentId: 'stu-01', fromDate: '2026-10-08', toDate: '2026-11-08' }); // 32 days
  bad({ studentId: 'stu-01', fromDate: '2026-10-06', toDate: '2026-10-07' }); // overlaps the first
  bad({ studentId: 'stu-01', fromDate: '2026-10-12', toDate: '2026-10-12', reason: 'x'.repeat(201) });
  bad({ studentId: 'stu-03', fromDate: '2026-10-12', toDate: '2026-10-12' }, 'NOT_ALLOWED'); // not my child
  for (const who of [TEACHER_PA, ADMIN, ACCOUNTANT, DRIVER]) assert.throws(() => run(db, who, 'leave.request', [{ studentId: 'stu-01', fromDate: '2026-10-12', toDate: '2026-10-12' }]), { code: 'NOT_ALLOWED' });
  // the same day is fine for the sibling, and today itself is allowed
  run(db, PARENT_01, 'leave.request', [{ studentId: 'stu-02', fromDate: TODAY, toDate: TODAY }]);
});

test('leave: the teacher marks it seen (own programme only); a parent withdraws it until it is over', () => {
  const db = seed();
  const r = run(db, PARENT_01, 'leave.request', [{ studentId: 'stu-01', fromDate: '2026-10-05', toDate: '2026-10-05' }]);
  assert.throws(() => run(db, TEACHER_PB, 'leave.markSeen', [r.id]), { code: 'NOT_ALLOWED' });
  assert.throws(() => run(db, PARENT_01, 'leave.markSeen', [r.id]), { code: 'NOT_ALLOWED' });
  const seen = run(db, TEACHER_PA, 'leave.markSeen', [r.id]);
  assert.equal(seen.seenBy, 'stf-teacher-pa');
  const at = seen.seenAt;
  run(db, ADMIN, 'leave.markSeen', [r.id]);
  assert.equal(db.leaveRequests.find(x => x.id === r.id).seenAt, at, 'seen once; a second look does not move it');
  assert.throws(() => run(db, PARENT_02, 'leave.withdraw', [r.id]), { code: 'NOT_ALLOWED' }, "another family's request");
  assert.equal(run(db, PARENT_01, 'leave.withdraw', [r.id]).status, 'withdrawn');
  assert.throws(() => run(db, PARENT_01, 'leave.withdraw', [r.id]), { code: 'VALIDATION' });
  assert.throws(() => run(db, TEACHER_PA, 'leave.markSeen', [r.id]), { code: 'VALIDATION' });
  const over = run(db, PARENT_01, 'leave.request', [{ studentId: 'stu-01', fromDate: TODAY, toDate: TODAY }]);
  assert.throws(() => run(db, PARENT_01, 'leave.withdraw', [over.id], '2026-10-03'), { code: 'VALIDATION' }, 'over: it stays as reported');
});

// ---------------------------------------------------------------- pick-up contacts and log
test('pickup.addContact / removeContact: the family (or the principal) keeps the list; phone, size and duplicates are checked', () => {
  const db = seed();
  const auditBefore = db.auditLog.length;
  const c = run(db, PARENT_01, 'pickup.addContact', [{ studentId: 'stu-01', name: ' Rani  Notrealsen ', relation: 'Grandmother', phone: '90000 00301' }]);
  assert.equal(c.name, 'Rani Notrealsen');
  assert.equal(c.phone, '+91-90000-00301', 'stored in one readable format');
  assert.equal(c.addedByRole, 'parent');
  assert.throws(() => run(db, PARENT_01, 'pickup.addContact', [{ studentId: 'stu-01', name: 'Other Person', relation: 'Uncle', phone: '+91 9000000301' }]), { code: 'VALIDATION' }, 'same phone');
  assert.throws(() => run(db, PARENT_01, 'pickup.addContact', [{ studentId: 'stu-01', name: 'Other Person', relation: 'Uncle', phone: '12345' }]), { code: 'VALIDATION' });
  assert.throws(() => run(db, PARENT_01, 'pickup.addContact', [{ studentId: 'stu-01', name: 'A', relation: 'Uncle', phone: '9000000302' }]), { code: 'VALIDATION' });
  for (let i = 2; i <= 6; i++) run(db, ADMIN, 'pickup.addContact', [{ studentId: 'stu-01', name: `Person ${i} Notrealsen`, relation: 'Neighbour', phone: `90000003${String(i).padStart(2, '0')}` }]);
  assert.throws(() => run(db, PARENT_01, 'pickup.addContact', [{ studentId: 'stu-01', name: 'Seventh Person', relation: 'Uncle', phone: '9000000399' }]), { code: 'VALIDATION' }, 'at most 6');
  for (const who of [TEACHER_PA, ACCOUNTANT, DRIVER, PARENT_02]) assert.throws(() => run(db, who, 'pickup.addContact', [{ studentId: 'stu-01', name: 'X Y', relation: 'Uncle', phone: '9000000398' }]), { code: 'NOT_ALLOWED' });
  assert.throws(() => run(db, PARENT_02, 'pickup.removeContact', [c.id]), { code: 'NOT_ALLOWED' });
  const gone = run(db, PARENT_01, 'pickup.removeContact', [c.id]);
  assert.equal(gone.status, 'removed');
  assert.equal(gone.phone, '', 'the number is not kept once the person is off the list');
  assert.equal(gone.name, 'Rani Notrealsen', 'the name stays for older pick-up records');
  assert.throws(() => run(db, PARENT_01, 'pickup.removeContact', [c.id]), { code: 'VALIDATION' });
  const audits = db.auditLog.slice(auditBefore);
  assert.equal(audits.length, 7, 'six adds and one removal are audited');
  assert.ok(audits.every(a => !/Rani|Person|9000/.test(a.summary)), 'audit rows carry ids, not names or phones');
});

test('pickup.record: guardian, listed person or someone else with a note; one row per child and day; teacher of the programme only', () => {
  const db = seed();
  const c = run(db, PARENT_01, 'pickup.addContact', [{ studentId: 'stu-01', name: 'Rani Notrealsen', relation: 'Grandmother', phone: '9000000301' }]);
  const p1 = run(db, TEACHER_PA, 'pickup.record', [{ studentId: 'stu-01', date: TODAY, collectedBy: { kind: 'guardian', id: 'grd-01' } }]);
  assert.equal(p1.kind, 'guardian');
  assert.equal(p1.name, null, 'no copy of a guardian name');
  const p2 = run(db, TEACHER_PA, 'pickup.record', [{ studentId: 'stu-01', date: TODAY, collectedBy: { kind: 'contact', id: c.id } }]);
  assert.equal(p2.id, p1.id, 'recording again corrects the same row');
  assert.ok(p2.correctedAt);
  assert.equal(db.pickups.filter(p => p.studentId === 'stu-01' && p.date === TODAY).length, 1);
  assert.throws(() => run(db, TEACHER_PA, 'pickup.record', [{ studentId: 'stu-01', date: TODAY, collectedBy: { kind: 'guardian', id: 'grd-02' } }]), { code: 'VALIDATION' });
  assert.throws(() => run(db, TEACHER_PA, 'pickup.record', [{ studentId: 'stu-01', date: TODAY, collectedBy: { kind: 'other', name: 'Driver Uncle' } }]), { code: 'VALIDATION' }, 'someone else needs a note');
  const before = db.auditLog.length;
  const p3 = run(db, TEACHER_PA, 'pickup.record', [{ studentId: 'stu-01', date: TODAY, collectedBy: { kind: 'other', name: 'Family Driver' }, note: 'Mother phoned at 14:30' }]);
  assert.equal(p3.name, 'Family Driver');
  assert.equal(db.auditLog.length, before + 1, 'someone not on the list is audited');
  assert.ok(!db.auditLog.at(-1).summary.includes('Family Driver'));
  assert.throws(() => run(db, TEACHER_PA, 'pickup.record', [{ studentId: 'stu-01', date: '2026-10-03', collectedBy: { kind: 'guardian', id: 'grd-01' } }]), { code: 'VALIDATION' }, 'not ahead of time');
  assert.throws(() => run(db, TEACHER_PA, 'pickup.record', [{ studentId: 'stu-01', date: '2026-09-24', collectedBy: { kind: 'guardian', id: 'grd-01' } }]), { code: 'VALIDATION' }, 'at most a week late');
  assert.throws(() => run(db, TEACHER_PA, 'pickup.record', [{ studentId: 'stu-01', date: '2026-09-25', collectedBy: { kind: 'guardian', id: 'grd-01' } }]), { code: 'VALIDATION' }, 'an earlier day needs the time collected');
  assert.throws(() => run(db, TEACHER_PA, 'pickup.record', [{ studentId: 'stu-01', date: '2026-09-25', collectedBy: { kind: 'guardian', id: 'grd-01' }, time: '25:00' }]), { code: 'VALIDATION' });
  assert.equal(run(db, TEACHER_PA, 'pickup.record', [{ studentId: 'stu-01', date: '2026-09-25', collectedBy: { kind: 'guardian', id: 'grd-01' }, time: '15:40' }]).time, '15:40');
  for (const who of [TEACHER_PB, ACCOUNTANT, DRIVER, PARENT_01]) assert.throws(() => run(db, who, 'pickup.record', [{ studentId: 'stu-01', date: TODAY, collectedBy: { kind: 'guardian', id: 'grd-01' } }]), { code: 'NOT_ALLOWED' });
  run(db, PARENT_01, 'pickup.removeContact', [c.id]);
  assert.throws(() => run(db, TEACHER_PA, 'pickup.record', [{ studentId: 'stu-01', date: TODAY, collectedBy: { kind: 'contact', id: c.id } }]), { code: 'VALIDATION' }, 'a removed person cannot be chosen');
});

// ---------------------------------------------------------------- privacy: export, erasure, retention
import { guardianExport } from '../src/domain/export.js';
import { retentionPlan, purgeRetention, PURGEABLE } from '../src/domain/retention.js';
import { SLICES } from '../src/domain/commands.js';
import { ERASED_REASON } from '../src/domain/care.js';

test("a family's data export holds their children's absences, pick-up people and pick-ups (not other families')", () => {
  const db = seed();
  run(db, PARENT_01, 'leave.request', [{ studentId: 'stu-01', fromDate: '2026-10-05', toDate: '2026-10-05', reason: 'Wedding' }]);
  run(db, PARENT_02, 'leave.request', [{ studentId: 'stu-04', fromDate: '2026-10-05', toDate: '2026-10-05' }]);
  run(db, PARENT_01, 'pickup.addContact', [{ studentId: 'stu-01', name: 'Rani Notrealsen', relation: 'Grandmother', phone: '9000000301' }]);
  run(db, TEACHER_PA, 'pickup.record', [{ studentId: 'stu-01', date: TODAY, collectedBy: { kind: 'guardian', id: 'grd-01' } }]);
  const x = guardianExport(db, 'grd-01');
  assert.deepEqual(x.absencesReported.map(r => r.studentId), ['stu-01']);
  assert.equal(x.pickupPeople.length, 1);
  assert.equal(x.pickups.length, 1);
  assert.ok(SLICES.export.reads.includes('pickups') && SLICES.export.reads.includes('leaveRequests') && SLICES.export.reads.includes('pickupContacts'));
});

test('erasure scrubs the absence reasons the guardian wrote and keeps the rows (the child record)', () => {
  const db = seed();
  db.appUsers = []; db.invites = []; db.erasureRequests = []; db.importBatches = []; db.importRows = [];
  const r = run(db, PARENT_01, 'leave.request', [{ studentId: 'stu-01', fromDate: '2026-10-05', toDate: '2026-10-05', reason: 'Grandfather in hospital' }]);
  const out = run(db, ADMIN, 'people.anonymiseGuardian', ['grd-01']);
  assert.equal(db.leaveRequests.find(x => x.id === r.id).reason, ERASED_REASON);
  assert.equal(out.erased.leaveReasons, 1);
  assert.ok(SLICES.erasure.writes.includes('leaveRequests'));
  assert.equal(run(db, ADMIN, 'people.anonymiseGuardian', ['grd-01']).erased.leaveReasons, 0, 'a re-run finds nothing more to scrub');
});

test('retention: once the attendance period after leaving is over, absences, pick-ups and pick-up people of that child go too', () => {
  const db = seed();
  const kid = db.students.find(s => s.id === 'stu-01');
  run(db, PARENT_01, 'leave.request', [{ studentId: 'stu-01', fromDate: '2026-10-05', toDate: '2026-10-05' }]);
  const c = run(db, PARENT_01, 'pickup.addContact', [{ studentId: 'stu-01', name: 'Rani Notrealsen', relation: 'Grandmother', phone: '9000000301' }]);
  run(db, TEACHER_PA, 'pickup.record', [{ studentId: 'stu-01', date: TODAY, collectedBy: { kind: 'contact', id: c.id } }]);
  run(db, PARENT_02, 'leave.request', [{ studentId: 'stu-04', fromDate: '2026-10-05', toDate: '2026-10-05' }]);
  Object.assign(kid, { status: 'left', leftOn: '2026-10-02' });
  db.school.retention.attendanceMonthsAfterLeaving = 12;
  assert.equal(retentionPlan(db, '2027-10-01').categories.attendance.due, 0, 'not yet');
  const plan = retentionPlan(db, '2027-10-02').categories.attendance;
  assert.equal(plan.deletes.leaveRequests.length, 1);
  assert.equal(plan.deletes.pickups.length, 1);
  assert.equal(plan.deletes.pickupContacts.length, 1);
  const res = purgeRetention(db, { deletes: plan.deletes }, { actor: { role: 'system', id: 'cron' }, now: '2027-10-02T00:00:00.000Z', today: '2027-10-02' });
  assert.equal(res.requested, res.expired + Object.values(res.deleted).reduce((s, n) => s + n, 0) + res.skipped, 'counts reconcile');
  assert.equal(db.leaveRequests.filter(r => r.studentId === 'stu-01').length + db.pickups.length + db.pickupContacts.length, 0);
  assert.equal(db.leaveRequests.filter(r => r.studentId === 'stu-04').length, 1, "another child's absence stays");
  for (const col of ['leaveRequests', 'pickups', 'pickupContacts']) assert.ok(PURGEABLE.includes(col) && SLICES.retention.reads.includes(col));
});

// ---------------------------------------------------------------- schema v4
import { migrate } from '../src/store/storage.js';
import { SCHEMA_VERSION, COLLECTIONS } from '../src/store/schema.js';
import { validateDb } from '../src/domain/validate.js';

test('schema v4: migrate v3 → v4 adds the three care collections empty and changes nothing else; validate checks the new rows', () => {
  assert.equal(SCHEMA_VERSION, 4);
  for (const c of ['leaveRequests', 'pickupContacts', 'pickups']) assert.ok(COLLECTIONS.includes(c));
  const v3 = seed();
  for (const c of ['leaveRequests', 'pickupContacts', 'pickups']) delete v3[c];
  v3.schemaVersion = 3;
  const before = JSON.stringify({ ...v3, schemaVersion: 4 });
  const m = migrate(structuredClone(v3));
  const { leaveRequests, pickupContacts, pickups, ...rest } = m;
  assert.deepEqual([leaveRequests, pickupContacts, pickups], [[], [], []]);
  assert.equal(JSON.stringify(rest), before);
  const db = seed();
  run(db, PARENT_01, 'leave.request', [{ studentId: 'stu-01', fromDate: '2026-10-05', toDate: '2026-10-05' }]);
  run(db, TEACHER_PA, 'pickup.record', [{ studentId: 'stu-01', date: TODAY, collectedBy: { kind: 'guardian', id: 'grd-01' } }]);
  assert.deepEqual(validateDb(db).filter(v => v.severity !== 'warning'), []);
  db.pickups[0].id = 'pck-wrong';
  db.leaveRequests[0].studentId = 'stu-nope';
  const codes = validateDb(db).map(v => v.code);
  assert.ok(codes.includes('BAD_PICKUP_KEY') && codes.includes('BAD_REF'));
});

import { diffChanges } from '../supabase/functions/_shared/slices.js';
test("the server's change diff lets retention delete every purgeable collection and nothing more; care commands only upsert", () => {
  const db = seed();
  const before = structuredClone(db);
  run(db, PARENT_01, 'leave.request', [{ studentId: 'stu-01', fromDate: '2026-10-05', toDate: '2026-10-05' }]);
  const ch = diffChanges(before, db, SLICES.care.writes);
  assert.equal(ch.upserts.leaveRequests.length, 1);
  assert.deepEqual(ch.deletes, {});
  for (const col of PURGEABLE) {
    const a = { [col]: [{ id: 'x1', date: '2026-01-01', studentId: 's' }] }, b = { [col]: [] };
    assert.ok(diffChanges(a, b, SLICES.retention.writes).deletes[col], `${col} deletable by retention`);
  }
});
