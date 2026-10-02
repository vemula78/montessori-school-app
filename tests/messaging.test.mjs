import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyDb } from '../src/store/schema.js';
import { memoryBackend } from '../src/store/storage.js';
import { createApi } from '../src/api/index.js';
import * as M from '../src/domain/messaging.js';

const ctx = (role, id, now = '2026-10-02T05:00:00.000Z') => ({ actor: { role, id }, now, today: '2026-10-02' });

/**
 * G-SIB has K1 (Primary A) and K2 (Primary B); K3 (Primary A) has two guardians G-M and G-F;
 * K4 (Toddler) has G-T.
 */
function fixture() {
  const db = createEmptyDb();
  db.school.name = 'Fixture School (Demo)';
  db.school.currentAcademicYearId = 'AY2026-27';
  db.academicYears.push({ id: 'AY2026-27', label: '2026-27', startDate: '2026-06-01', endDate: '2027-05-31' });
  db.programs.push({ id: 'PA', name: 'Primary A', ageRange: '3-6', teacherIds: ['T-A'] }, { id: 'PB', name: 'Primary B', ageRange: '3-6', teacherIds: ['T-B'] },
    { id: 'PT', name: 'Toddler Community', ageRange: '1.5-3', teacherIds: [] });
  db.staff.push({ id: 'ADM', firstName: 'Ada', lastName: 'Placeholdar', role: 'admin', programIds: [], phone: '+91-90000-00001' },
    { id: 'T-A', firstName: 'Tia', lastName: 'Mockherjee', role: 'teacher', programIds: ['PA'], phone: '+91-90000-00002' },
    { id: 'T-B', firstName: 'Tom', lastName: 'Specimenova', role: 'teacher', programIds: ['PB'], phone: '+91-90000-00003' });
  const g = (id, studentIds) => ({ id, firstName: id, lastName: 'Sampleraj', relation: 'parent', phone: '+91-90000-00100', email: `${id}@example.com`, studentIds });
  db.guardians.push(g('G-SIB', ['K1', 'K2']), g('G-M', ['K3']), g('G-F', ['K3']), g('G-T', ['K4']));
  const s = (id, programId, guardianIds) => ({ id, firstName: id, lastName: 'Sampleraj', dob: '2022-01-01', programId, admissionNo: id, status: 'active', guardianIds, routeId: null, stopId: null, feeCategory: 'regular', healthNotes: null });
  db.students.push(s('K1', 'PA', ['G-SIB']), s('K2', 'PB', ['G-SIB']), s('K3', 'PA', ['G-M', 'G-F']), s('K4', 'PT', ['G-T']));
  return db;
}

test('school audience: each guardian exactly once', () => {
  const db = fixture();
  const n = M.sendNotice(db, { title: 'Hello', body: 'Welcome', audience: { scope: 'school' } }, ctx('admin', 'ADM'));
  const rs = db.noticeReceipts.filter(r => r.noticeId === n.id);
  assert.deepEqual(rs.map(r => r.guardianId).sort(), ['G-F', 'G-M', 'G-SIB', 'G-T']);
  assert.deepEqual(rs.find(r => r.guardianId === 'G-SIB').studentIds, ['K1', 'K2']);
});

test('program audience with a sibling guardian across both programs → one receipt with two children', () => {
  const db = fixture();
  const n = M.sendNotice(db, { title: 'Field trip', body: 'Consent please', audience: { scope: 'program', programIds: ['PA', 'PB'] }, requiresAck: true }, ctx('admin', 'ADM'));
  const rec = M.noticeRecipients(db, n.id);
  const sib = rec.filter(r => r.guardianId === 'G-SIB');
  assert.equal(sib.length, 1);
  assert.deepEqual(sib[0].studentIds, ['K1', 'K2']);
  assert.ok(!rec.some(r => r.guardianId === 'G-T'));
  // student with two guardians → two receipts; one acknowledging does not mark the other
  assert.equal(rec.filter(r => r.guardianId === 'G-M' || r.guardianId === 'G-F').length, 2);
  M.acknowledgeNotice(db, n.id, 'G-M', ctx('parent', 'G-M'));
  const after = M.noticeRecipients(db, n.id);
  assert.ok(after.find(r => r.guardianId === 'G-M').ackAt);
  assert.equal(after.find(r => r.guardianId === 'G-F').ackAt, null);
  M.markNoticeRead(db, n.id, 'G-SIB', ctx('parent', 'G-SIB'));
  assert.deepEqual(M.noticeStats(db, n.id), { recipientCount: 3, readCount: 2, ackCount: 1 });
  assert.throws(() => M.markNoticeRead(db, n.id, 'G-T', ctx('parent', 'G-T')), { code: 'NOT_FOUND' });
});

test('readAt is set only when the other party opens the thread', () => {
  const db = fixture();
  const { thread } = M.openThread(db, { guardianId: 'G-SIB', studentId: 'K1', subject: 'Lunch', body: 'Question about lunch' }, ctx('parent', 'G-SIB'));
  assert.equal(thread.programId, 'PA');
  M.markThreadRead(db, thread.id, ctx('parent', 'G-SIB', '2026-10-02T05:01:00.000Z')); // sender's own view
  assert.equal(M.threadMessages(db, thread.id)[0].readAt, null);
  M.markThreadRead(db, thread.id, ctx('teacher', 'T-A', '2026-10-02T05:02:00.000Z'));
  assert.equal(M.threadMessages(db, thread.id)[0].readAt, '2026-10-02T05:02:00.000Z');
  M.replyThread(db, thread.id, 'Noted', ctx('teacher', 'T-A', '2026-10-02T05:03:00.000Z'));
  assert.equal(M.threadView(db, thread, 'parent').unreadCount, 1);
  assert.equal(M.threadView(db, thread, 'teacher').unreadCount, 0);
  assert.throws(() => M.openThread(db, { guardianId: 'G-T', studentId: 'K1', subject: 'x', body: 'y' }, ctx('parent', 'G-T')), { code: 'VALIDATION' });
});

test('api scoping: parent sees own notices/threads; teacher sees own programs only', async () => {
  const sessionBackend = memoryBackend();
  let t = Date.UTC(2026, 9, 2, 5, 0);
  const api = createApi({ backend: memoryBackend(), sessionBackend, seedFn: fixture, clock: () => new Date(t += 1000) });
  await api.ready();
  const as = role => api.session.set(api.session.personas().find(p => p.id === `persona-${role}`).id);

  as('ADM');
  await api.notices.send({ title: 'PA+PB', body: 'x', audience: { scope: 'program', programIds: ['PA', 'PB'] }, requiresAck: true });
  await api.notices.send({ title: 'Toddlers', body: 'y', audience: { scope: 'program', programIds: ['PT'] } });

  as('G-SIB');
  const mine = await api.notices.list();
  assert.deepEqual(mine.map(n => n.title), ['PA+PB']);
  assert.deepEqual(mine[0].receipt.studentIds, ['K1', 'K2']);
  await api.notices.acknowledge(mine[0].id);
  const th = await api.threads.open({ studentId: 'K1', subject: 'Nap', body: 'How was the nap?' });
  await api.threads.open({ studentId: 'K2', subject: 'Shoes', body: 'Lost shoes' });
  await assert.rejects(api.threads.open({ studentId: 'K3', subject: 'x', body: 'y' }), { code: 'NOT_ALLOWED' });
  assert.equal((await api.threads.list()).length, 2);

  as('G-T');
  assert.deepEqual((await api.notices.list()).map(n => n.title), ['Toddlers']);
  assert.equal((await api.threads.list()).length, 0);
  await assert.rejects(api.threads.get(th.id), { code: 'NOT_ALLOWED' });
  await assert.rejects(api.notices.send({ title: 'x', body: 'y', audience: { scope: 'school' } }), { code: 'NOT_ALLOWED' });

  as('T-A');
  const ta = await api.threads.list();
  assert.deepEqual(ta.map(x => x.subject), ['Nap']); // Primary A only; Primary B thread hidden
  await api.threads.markRead(th.id);
  await api.threads.reply(th.id, 'Slept well');
  await assert.rejects(api.notices.send({ title: 'x', body: 'y', audience: { scope: 'program', programIds: ['PB'] } }), { code: 'NOT_ALLOWED' });
  await assert.rejects(api.notices.send({ title: 'x', body: 'y', audience: { scope: 'school' } }), { code: 'NOT_ALLOWED' });
  const sent = await api.notices.send({ title: 'PA only', body: 'z', audience: { scope: 'program', programIds: ['PA'] } });
  const rec = await api.notices.recipients(sent.id);
  assert.deepEqual(rec.map(r => r.guardianId).sort(), ['G-F', 'G-M', 'G-SIB']);
  assert.deepEqual((await api.people.students()).map(s => s.id).sort(), ['K1', 'K3']);

  as('ADM');
  const recips = await api.notices.recipients((await api.notices.list()).find(n => n.title === 'PA+PB').id);
  assert.ok(recips.find(r => r.guardianId === 'G-SIB').ackAt);

  as('G-SIB');
  const view = await api.threads.get(th.id);
  assert.ok(view.messages[0].readAt, 'parent message read after the teacher opened it');
  assert.equal(view.messages[1].readAt, null);
});
