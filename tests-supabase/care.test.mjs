// Care through the real command function (local stack, fake data): absences reported by a parent reach the teacher,
// pick-up people and the pick-up log, the whole-class diary entry, and the refusals for roles that may not.
// Families: grd-02 = parent-bus (stu-03 Toddler, stu-04 Primary A); grd-01 = parent-siblings (stu-01 Primary A, stu-02 Primary B).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { signIn, command, rpcAs, psql } from './helpers.mjs';

let tpa, acct, parentBus, parentSib;
const ok = (r, what = '') => { assert.equal(r.status, 200, `${what} ${JSON.stringify(r.data)}`); return r.data.result; };
const refused = (r, what = '') => { assert.equal(r.status, 403, `${what} ${JSON.stringify(r.data)}`); assert.equal(r.data.error.code, 'NOT_ALLOWED', what); };
const istToday = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const plusDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const snapshot = async who => (await rpcAs(who.token, 'my_snapshot')).data;

before(async () => {
  [tpa, acct, parentBus, parentSib] = await Promise.all(['teacher-pa@example.com', 'accountant@example.com', 'parent-bus@example.com', 'parent-siblings@example.com'].map(signIn));
});

test('an absence a parent reports reaches the teacher (not another family); the teacher marks it seen; the parent withdraws it', async () => {
  const day = plusDays(istToday(), 25); // clear of the seed's sample absences
  const r = ok(await command(parentBus.token, 'leave.request', { studentId: 'stu-04', fromDate: day, toDate: day, reason: 'Fake: family visit' }), 'leave.request');
  assert.equal(r.guardianId, 'grd-02');
  assert.ok((await snapshot(tpa)).leaveRequests.some(x => x.id === r.id), "in the teacher's snapshot");
  assert.ok(!(await snapshot(parentSib)).leaveRequests.some(x => x.id === r.id), "not in another family's");
  refused(await command(parentSib.token, 'leave.request', { studentId: 'stu-04', fromDate: day, toDate: day }), 'another family');
  refused(await command(tpa.token, 'leave.request', { studentId: 'stu-04', fromDate: day, toDate: day }), 'a teacher');
  assert.equal(ok(await command(tpa.token, 'leave.markSeen', r.id)).seenBy, 'stf-teacher-pa');
  assert.equal(ok(await command(parentBus.token, 'leave.withdraw', r.id)).status, 'withdrawn');
  assert.equal(psql(`select status from leave_requests where id = '${r.id}'`), 'withdrawn');
});

test('pick-up: the family adds a person; the teacher records who collected the child; the accountant may do neither', async () => {
  const c = ok(await command(parentBus.token, 'pickup.addContact', { studentId: 'stu-04', name: 'Fake Demoson', relation: 'Aunt', phone: '9000000388' }), 'addContact');
  assert.equal(c.phone, '+91-90000-00388');
  refused(await command(acct.token, 'pickup.addContact', { studentId: 'stu-04', name: 'Fake Demoson', relation: 'Aunt', phone: '9000000387' }), 'accountant');
  const today = istToday();
  const p = ok(await command(tpa.token, 'pickup.record', { studentId: 'stu-04', date: today, collectedBy: { kind: 'contact', id: c.id }, time: '15:30' }), 'record');
  assert.equal(p.id, `pck-${today}-stu-04`);
  refused(await command(acct.token, 'pickup.record', { studentId: 'stu-04', date: today, collectedBy: { kind: 'guardian', id: 'grd-02' } }), 'accountant');
  assert.ok((await snapshot(parentBus)).pickups.some(x => x.id === p.id), 'the family sees who collected their child');
  const removed = ok(await command(parentBus.token, 'pickup.removeContact', c.id), 'removeContact');
  assert.equal(removed.phone, '');
  assert.equal(psql(`select doc->>'phone' from pickup_contacts where id = '${c.id}'`), '');
});

test('whole-class diary: one write adds an entry for every ticked child of the programme', async () => {
  const today = istToday();
  const kids = psql(`select string_agg(id, ',' order by id) from students where program_id = 'prog-primary-a' and doc->>'status' = 'active'`).split(',');
  const before = Number(psql(`select count(*) from diary_entries where date = '${today}' and doc->>'type' = 'activity'`));
  const r = ok(await command(tpa.token, 'diary.addMany', { programId: 'prog-primary-a', date: today, studentIds: kids, type: 'activity', data: { text: 'Fake: songs in the circle.' } }), 'addMany');
  assert.equal(r.added, kids.length);
  assert.equal(Number(psql(`select count(*) from diary_entries where date = '${today}' and doc->>'type' = 'activity'`)), before + kids.length, 'every row reached the database');
  refused(await command(tpa.token, 'diary.addMany', { programId: 'prog-primary-b', date: today, studentIds: ['stu-02'], type: 'activity', data: { text: 'x' } }), 'another programme');
});
