// Wave 2 through the real command function and Storage (local stack, fake data). Part A: the annual Progress Report —
// a teacher completes and submits a report, the principal publishes it, either guardian sees it and nobody else does;
// signatures travel with their command, are checked from their bytes, stored privately, replaced and deleted; a parent
// receives the signature images of a published report of their own child only, as short-lived signed paths.
// Families: grd-02 = parent-bus (stu-03 Toddler, stu-04 Primary A: Ira, a draft 2026-27 report in the seed);
// grd-01 = parent-siblings (stu-01, stu-02). teacher-pa teaches Primary A.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { local, signIn, fn, command, rpcAs, restAs, psql } from './helpers.mjs';
import { rubricItems } from '../src/domain/evaluations.js';

let admin, tpa, acct, parentBus, parentSib;
const fixture = name => readFileSync(new URL(`../tests/fixtures/${name}`, import.meta.url));
const ok = (r, what = '') => { assert.equal(r.status, 200, `${what} ${JSON.stringify(r.data)}`); return r.data.result; };
const refused = (r, status, codeName, what = '') => { assert.equal(r.status, status, `${what} ${JSON.stringify(r.data)}`); assert.equal(r.data.error.code, codeName, what); };
const snapshot = async who => (await rpcAs(who.token, 'my_snapshot')).data;
// what RLS lets this sign-in read of the evaluations table (a direct read: quicker than a parent's whole snapshot)
const evaluationsOf = async who => { const r = await restAs(who.token, 'evaluations?select=id,status&order=id'); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data; };
const withFile = (who, name, args, bytes, requestId = `t-${randomUUID()}`) => fn('command', { name, args, requestId, file: { base64: Buffer.from(bytes).toString('base64') } }, who.token);
const objects = () => Number(psql(`select count(*) from storage.objects where bucket_id = 'signatures'`));
const AY = 'AY2026-27';
const IRA = `evl-${AY}-stu-04`;

before(async () => {
  [admin, tpa, acct, parentBus, parentSib] = await Promise.all(['principal@example.com', 'teacher-pa@example.com', 'accountant@example.com', 'parent-bus@example.com', 'parent-siblings@example.com'].map(signIn));
});

test('a progress report: the teacher completes and submits it (stale revision refused), the principal publishes it, the family alone sees it', async () => {
  const draft = (await snapshot(tpa)).evaluations.find(e => e.id === IRA);
  assert.equal(draft.status, 'draft');
  assert.ok(!(await evaluationsOf(parentBus)).some(e => e.id === IRA), 'a draft is not the family\'s');
  const missing = await command(tpa.token, 'evaluations.submit', IRA);
  refused(missing, 422, 'VALIDATION', 'submit with items not rated');
  assert.ok(missing.data.error.details.missing.length > 0, 'the missing items are listed');
  const all = Object.fromEntries(rubricItems(draft.level).map(i => [i.key, i.values[1]]));
  refused(await command(tpa.token, 'evaluations.save', IRA, { ratings: all, revision: draft.revision - 1 }), 409, 'CONFLICT', 'stale revision');
  refused(await command(parentBus.token, 'evaluations.save', IRA, { ratings: all, revision: draft.revision }), 403, 'NOT_ALLOWED', 'a parent');
  const saved = ok(await command(tpa.token, 'evaluations.save', IRA, { ratings: all, remarks: 'Fake remark for the test.', revision: draft.revision }), 'save');
  assert.equal(saved.missing, 0);
  assert.equal(saved.attendance.source, 'register');
  ok(await command(tpa.token, 'evaluations.submit', IRA, { revision: saved.revision }), 'submit');
  refused(await command(tpa.token, 'evaluations.publish', IRA), 403, 'NOT_ALLOWED', 'a teacher cannot publish');
  const pub = ok(await command(admin.token, 'evaluations.publish', IRA), 'publish');
  assert.equal(pub.status, 'published');
  assert.deepEqual(pub.signers.teacherIds, ['stf-teacher-float', 'stf-teacher-pa']);
  assert.ok((await evaluationsOf(parentBus)).some(e => e.id === IRA && e.status === 'published'), 'the family sees it');
  assert.ok((await snapshot(parentBus)).evaluations.some(e => e.id === IRA), 'in the family\'s snapshot too');
  assert.ok(!(await evaluationsOf(parentSib)).some(e => e.id === IRA), 'another family does not');
  assert.equal((await evaluationsOf(acct)).length, 0, 'the accountant sees none');
  assert.equal(psql(`select status from evaluations where id = '${IRA}'`), 'published');
});

test('signatures: the image travels with the command, is checked from its bytes, kept privately; a teacher only their own; a replay stores nothing twice', async () => {
  const before = objects();
  refused(await withFile(tpa, 'signatures.upload', [{ owner: { kind: 'staff', staffId: 'stf-principal' } }], fixture('tiny.png')), 403, 'NOT_ALLOWED', 'someone else\'s');
  refused(await withFile(tpa, 'signatures.upload', [{ owner: { kind: 'staff', staffId: 'stf-teacher-pa' } }], fixture('tiny-exif.jpg')), 422, 'VALIDATION', 'a JPEG with EXIF');
  refused(await withFile(tpa, 'signatures.upload', [{ owner: { kind: 'staff', staffId: 'stf-teacher-pa' } }], Buffer.from('%PDF-1.4 not a picture')), 422, 'VALIDATION', 'a PDF');
  refused(await command(tpa.token, 'signatures.upload', { owner: { kind: 'staff', staffId: 'stf-teacher-pa' } }), 422, 'VALIDATION', 'no file');
  assert.equal(objects(), before, 'nothing refused was stored');
  const rid = `t-${randomUUID()}`;
  const first = ok(await withFile(tpa, 'signatures.upload', [{ owner: { kind: 'staff', staffId: 'stf-teacher-pa' } }], fixture('tiny.png'), rid), 'upload');
  assert.equal(first.signature.mime, 'image/png');
  assert.equal(first.signature.path, undefined, 'no storage path in the answer');
  const again = ok(await withFile(tpa, 'signatures.upload', [{ owner: { kind: 'staff', staffId: 'stf-teacher-pa' } }], fixture('tiny.png'), rid), 'replay');
  assert.equal(again.signature.id, first.signature.id);
  assert.equal(objects(), before + 1, 'the replay left no second object');
  const path = psql(`select doc->>'path' from signatures where id = '${first.signature.id}'`);
  assert.match(path, /^sig\/[0-9a-f-]{36}\.png$/);
  assert.equal(psql(`select count(*) from storage.objects where bucket_id = 'signatures' and name = '${path}'`), '1');
  // replacing: the old object is deleted at once and its row says so
  const second = ok(await withFile(tpa, 'signatures.upload', [{ owner: { kind: 'staff', staffId: 'stf-teacher-pa' } }], fixture('tiny.png')), 'replace');
  assert.equal(second.replaced, first.signature.id);
  assert.equal(psql(`select count(*) from storage.objects where bucket_id = 'signatures' and name = '${path}'`), '0', 'old object deleted');
  assert.notEqual(psql(`select doc->>'objectDeletedAt' from signatures where id = '${first.signature.id}'`), '');
  // the principal may upload the director's
  ok(await withFile(admin, 'signatures.upload', [{ owner: { kind: 'director' } }], fixture('tiny.png')), 'director');
  // previews: the owner and the principal; never a parent
  const view = ok(await command(tpa.token, 'signatures.viewUrl', second.signature.id), 'viewUrl');
  assert.match(view.signedPath, /^\/object\/sign\/signatures\//);
  const res = await fetch(`${local().url}/storage/v1${view.signedPath}`);
  assert.equal(res.status, 200);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), fixture('tiny.png'));
  refused(await command(parentBus.token, 'signatures.viewUrl', second.signature.id), 403, 'NOT_ALLOWED', 'a parent');
  const anon = await fetch(`${local().url}/storage/v1/object/public/signatures/${path}`);
  assert.ok(anon.status >= 400, 'no public URL');
});

test('print: a parent gets the signature images of their own child\'s PUBLISHED report only, as short-lived signed paths', async () => {
  const r = ok(await command(parentBus.token, 'evaluations.signatures', IRA), 'signatures for the print');
  assert.deepEqual(r.map(x => x.role).sort(), ['director', 'teacher']);
  for (const x of r) {
    assert.equal(x.path, undefined);
    assert.ok(Date.parse(x.expiresAt) - Date.now() <= 61000, 'a minute at most');
    const res = await fetch(`${local().url}/storage/v1${x.signedPath}`);
    assert.equal(res.status, 200);
  }
  refused(await command(parentSib.token, 'evaluations.signatures', IRA), 403, 'NOT_ALLOWED', 'another family');
  refused(await command(parentSib.token, 'evaluations.signatures', `evl-${AY}-stu-15`), 403, 'NOT_ALLOWED', 'not their child');
  refused(await command(acct.token, 'evaluations.signatures', IRA), 403, 'NOT_ALLOWED', 'the accountant');
  ok(await command(admin.token, 'evaluations.unpublish', IRA, 'Fake: correction in a test'), 'unpublish');
  refused(await command(parentBus.token, 'evaluations.signatures', IRA), 404, 'NOT_FOUND', 'unpublished again');
  ok(await command(tpa.token, 'evaluations.signatures', IRA), 'staff still preview it');
});

test('signatures: removing deletes the object; cron filesCleanup reports it ran clean', async () => {
  const id = psql(`select id from signatures where staff_id = 'stf-teacher-pa' and status = 'ready'`);
  const path = psql(`select doc->>'path' from signatures where id = '${id}'`);
  ok(await command(tpa.token, 'signatures.remove', { owner: { kind: 'staff', staffId: 'stf-teacher-pa' } }), 'remove');
  assert.equal(psql(`select count(*) from storage.objects where bucket_id = 'signatures' and name = '${path}'`), '0');
  const cron = await fn('cron-daily', { steps: ['filesCleanup'] }, null, { 'X-Cron-Secret': local().env.CRON_SECRET });
  assert.equal(cron.status, 200, JSON.stringify(cron.data));
  assert.deepEqual(cron.data.report.filesCleanup.errors, []);
});

test('levels and school settings through the command function: the principal only', async () => {
  refused(await command(tpa.token, 'admin.setSchoolDetails', { directorName: 'Fake Exampleton' }), 403, 'NOT_ALLOWED');
  const r = ok(await command(admin.token, 'admin.setSchoolDetails', { directorName: 'Asha Exampleton' }), 'setSchoolDetails');
  assert.equal(r.directorName, 'Asha Exampleton');
  assert.equal(psql(`select doc->>'directorName' from school`), 'Asha Exampleton');
  const s = ok(await command(admin.token, 'people.updateStudent', { studentId: 'stu-08', level: 'mont1' }), 'level');
  assert.equal(s.level, 'mont1');
  refused(await command(tpa.token, 'people.updateStudent', { studentId: 'stu-08', level: 'mont2' }), 403, 'NOT_ALLOWED');
  const started = ok(await command(tpa.token, 'evaluations.startClass', { programId: 'prog-primary-a', academicYearId: AY }), 'startClass');
  assert.equal(started.started + started.skippedExisting + started.skippedNoLevel, started.children);
  assert.equal(Number(psql(`select count(*) from evaluations where academic_year_id = '${AY}' and student_id in (select id from students where program_id = 'prog-primary-a' and status = 'active')`)), started.children - started.skippedNoLevel);
});

// ================================================================ B. other wave-2 features

test('#78 health: a parent sets allergies for their own child; it reaches student_health and the teacher, never the student document or the driver', async () => {
  const driver = await signIn('driver1@example.com');
  refused(await command(parentSib.token, 'health.set', { studentId: 'stu-04', allergies: 'x' }), 403, 'NOT_ALLOWED', 'another family');
  refused(await command(tpa.token, 'health.set', { studentId: 'stu-04', allergies: 'x' }), 403, 'NOT_ALLOWED', 'a teacher');
  const h = ok(await command(parentBus.token, 'health.set', { studentId: 'stu-04', allergies: 'Fake: sesame', medical: 'Fake: none' }), 'health.set');
  assert.equal(h.updatedByRole, 'parent');
  assert.equal(psql(`select alerts->>'allergies' from student_health where student_id = 'stu-04'`), 'Fake: sesame');
  assert.equal(psql(`select doc ? 'healthAlerts' from students where id = 'stu-04'`), 'f');
  assert.equal((await snapshot(tpa)).students.find(s => s.id === 'stu-04').healthAlerts.allergies, 'Fake: sesame');
  const asDriver = (await restAs(driver.token, 'student_health?select=student_id')).data;
  assert.deepEqual(asDriver, [], 'the driver reads no health row');
  assert.match(psql(`select doc->>'summary' from audit_log where entity = 'student' and doc->>'action' = 'health' order by ts desc limit 1`), /^allergies, medical alerts changed by a parent$/);
});

test('#8 #68 the driver: absence dates without reasons, the route children\'s pick-up people, and who received a child at a drop', async () => {
  const driver = await signIn('driver1@example.com');
  const day = new Date(Date.now() + 330 * 60000 + 20 * 86400000).toISOString().slice(0, 10);
  const lv = ok(await command(parentSib.token, 'leave.request', { studentId: 'stu-01', fromDate: day, toDate: day, reason: 'Fake: a private reason' }), 'leave.request');
  const snap = await snapshot(driver);
  const mine = snap.leaveRequests.find(r => r.id === lv.id);
  assert.deepEqual([mine.studentId, mine.fromDate, mine.reason], ['stu-01', day, null]);
  assert.ok(!JSON.stringify(snap).includes('a private reason'), 'no reason anywhere in the driver\'s snapshot');
  const contacts = snap.pickupContacts;
  assert.ok(contacts.length > 0 && contacts.every(c => snap.students.some(s => s.id === c.studentId && s.routeId === 'route-1')), 'route-1 children\'s people only');
  const active = JSON.parse(psql(`select coalesce(json_agg(id), '[]') from trips where route_id = 'route-1' and status = 'active'`));
  for (const t of active) await command(driver.token, 'transport.endTrip', t);
  const trip = ok(await command(driver.token, 'transport.startTrip', { routeId: 'route-1', direction: 'pickup', simulated: true }), 'startTrip');
  const neelPerson = contacts.find(c => c.studentId === 'stu-01');
  const ev = ok(await command(driver.token, 'transport.markChild', trip.id, { studentId: 'stu-01', type: 'dropped', receivedBy: { kind: 'contact', id: neelPerson.id } }), 'markChild');
  assert.deepEqual(ev.receivedBy, { kind: 'contact', contactId: neelPerson.id });
  refused(await command(driver.token, 'transport.markChild', trip.id, { studentId: 'stu-03', type: 'dropped', receivedBy: { kind: 'contact', id: neelPerson.id } }), 422, 'VALIDATION', "someone on another child's list");
  assert.equal(psql(`select doc->'receivedBy'->>'contactId' from trip_child_events where trip_id = '${trip.id}' and student_id = 'stu-01'`), neelPerson.id);
  ok(await command(driver.token, 'transport.endTrip', trip.id), 'endTrip');
  ok(await command(parentSib.token, 'leave.withdraw', lv.id), 'withdraw');
});

test('#21 #29 several diary entries removed and several children\'s progress recorded in one write each, all or none', async () => {
  const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
  const kids = ['stu-01', 'stu-04', 'stu-06'];
  const added = ok(await command(tpa.token, 'diary.addMany', { programId: 'prog-primary-a', date: today, studentIds: kids, type: 'activity', data: { text: 'Fake: whole class' } }), 'addMany');
  const ids = added.entries.map(e => e.id);
  const byAdmin = ok(await command(admin.token, 'diary.add', { studentId: 'stu-01', date: today, type: 'activity', data: { text: 'Fake: by the principal' } }), 'diary.add');
  refused(await command(tpa.token, 'diary.removeMany', [...ids, byAdmin.id]), 403, 'NOT_ALLOWED', "one entry is someone else's");
  assert.equal(psql(`select count(*) from diary_entries where id in (${ids.map(i => `'${i}'`).join(',')})`), '3', 'nothing removed');
  assert.equal(ok(await command(tpa.token, 'diary.removeMany', ids), 'removeMany').removed, 3);
  assert.equal(psql(`select count(*) from diary_entries where id in (${ids.map(i => `'${i}'`).join(',')})`), '0');
  const pres = psql(`select id from presentations p where (doc->>'active')::boolean and not exists (select 1 from progress_events e where e.presentation_id = p.id) order by id limit 1`);
  const entries = ['stu-06', 'stu-09'].map(studentId => ({ studentId, presentationId: pres, status: 'introduced', date: today }));
  refused(await command(tpa.token, 'progress.recordMany', { entries: [...entries, { studentId: 'stu-02', presentationId: pres, status: 'introduced', date: today }] }), 403, 'NOT_ALLOWED', 'a child of another programme');
  assert.equal(psql(`select count(*) from progress_events where presentation_id = '${pres}'`), '0', 'nothing recorded');
  assert.equal(ok(await command(tpa.token, 'progress.recordMany', { entries }), 'recordMany').recorded, 2);
  assert.equal(psql(`select count(*) from progress_events where presentation_id = '${pres}'`), '2');
});

test('closing a staff record closes the sign-in at once (snapshot revoked, commands refused); reopening restores it', async () => {
  psql(`update staff_contacts set email = 'teacher-pb@example.com' where staff_id = 'stf-teacher-pb'`);
  const tpb = await signIn('teacher-pb@example.com');
  assert.equal((await snapshot(tpb)).status, 'active');
  ok(await command(admin.token, 'setup.setStaffActive', { staffId: 'stf-teacher-pb', active: false }), 'close');
  assert.equal((await snapshot(tpb)).status, 'revoked');
  assert.equal((await restAs(tpb.token, 'students?select=id')).data.length, 0, 'RLS: nothing');
  refused(await command(tpb.token, 'diary.add', { studentId: 'stu-02', date: '2026-10-01', type: 'activity', data: { text: 'x' } }), 403, 'NOT_ALLOWED', 'a command');
  ok(await command(admin.token, 'setup.setStaffActive', { staffId: 'stf-teacher-pb', active: true }), 'reopen');
  ok(await command(admin.token, 'setup.saveStaff', { id: 'stf-teacher-pb', programIds: ['prog-primary-b'] }), 'classes back');
  assert.equal((await snapshot(tpb)).status, 'active');
});

test('#12 #84 notice files: uploaded with the command (checked from the bytes, ≤ 2 MB), attached when sent, served to the notice\'s families only, never after withdrawal; a correction that drops a file deletes it', async () => {
  const pdf = (n = 2000) => Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(n, 0x20), Buffer.from('\n%%EOF')]);
  const objectOf = id => psql(`select count(*) from storage.objects where bucket_id = 'notice-files' and name = (select doc->>'path' from notice_files where id = '${id}')`);
  refused(await withFile(parentBus, 'notices.uploadFile', [{ name: 'x.pdf' }], pdf()), 403, 'NOT_ALLOWED', 'a parent');
  refused(await withFile(tpa, 'notices.uploadFile', [{ name: 'x.svg' }], Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), 422, 'VALIDATION', 'not a PDF/JPEG/PNG');
  refused(await withFile(tpa, 'notices.uploadFile', [{ name: 'big.pdf' }], pdf(2 * 1024 * 1024)), 422, 'VALIDATION', 'over 2 MB');
  const big = ok(await withFile(tpa, 'notices.uploadFile', [{ name: 'Term plan.pdf' }], pdf(1536 * 1024)), 'a 1.5 MB file');
  const png = ok(await withFile(tpa, 'notices.uploadFile', [{ name: 'poster.png' }], fixture('tiny.png')), 'png');
  assert.deepEqual([big.status, big.mime], ['staged', 'application/pdf']);
  assert.equal(objectOf(big.id), '1');
  refused(await command(parentBus.token, 'notices.fileUrl', big.id), 403, 'NOT_ALLOWED', 'a staged file is its uploader\'s');
  const n = ok(await command(tpa.token, 'notices.send', { title: 'Fake circular', body: 'Fake body', audience: { scope: 'program', programIds: ['prog-primary-a'] }, attachmentIds: [big.id, png.id] }), 'send');
  assert.deepEqual(n.attachments.map(a => a.name), ['Term plan.pdf', 'poster.png']);
  const url = ok(await command(parentBus.token, 'notices.fileUrl', png.id), 'fileUrl (Ira is in Primary A)');
  const res = await fetch(`${local().url}/storage/v1${url.signedPath}`);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), fixture('tiny.png'));
  assert.ok(Date.parse(url.expiresAt) - Date.now() <= 61000);
  refused(await command(acct.token, 'notices.uploadFile', { name: 'x' }), 403, 'NOT_ALLOWED', 'the accountant does not upload');
  // a correction dropping the PDF deletes its object; the old wording is kept
  const c = ok(await command(tpa.token, 'notices.correct', n.id, { body: 'Fixed body', reason: 'Fake: wrong date', attachmentIds: [png.id] }), 'correct');
  assert.deepEqual(c.filesRemoved, [big.id]);
  assert.equal(objectOf(big.id), '0', 'the dropped file is gone from storage');
  assert.equal(psql(`select doc->'history'->0->>'body' from notices where id = '${n.id}'`), 'Fake body');
  ok(await command(tpa.token, 'notices.withdraw', n.id, 'Fake: sent by mistake'), 'withdraw');
  refused(await command(parentBus.token, 'notices.fileUrl', png.id), 404, 'NOT_FOUND', 'withdrawn');
  ok(await command(tpa.token, 'notices.fileUrl', png.id), 'staff still open it');
  // a staged file never sent is removed by the nightly job after 24 hours
  const stale = ok(await withFile(tpa, 'notices.uploadFile', [{ name: 'old.pdf' }], pdf()), 'stale');
  psql(`update notice_files set doc = jsonb_set(doc, '{uploadedAt}', to_jsonb('2026-01-01T00:00:00.000Z'::text)) where id = '${stale.id}'`);
  const cron = await fn('cron-daily', { steps: ['filesCleanup'] }, null, { 'X-Cron-Secret': local().env.CRON_SECRET });
  assert.equal(cron.status, 200, JSON.stringify(cron.data));
  assert.ok(cron.data.report.filesCleanup.stagedFilesExpired >= 1);
  assert.equal(psql(`select status from notice_files where id = '${stale.id}'`), 'removed');
  assert.equal(objectOf(stale.id), '0');
});

test('#85 running late: the route\'s driver sends an important notice to that route\'s families only', async () => {
  const driver = await signIn('driver1@example.com');
  refused(await command(tpa.token, 'transport.runningLate', { routeId: 'route-1', kind: 'late10' }), 403, 'NOT_ALLOWED', 'a teacher');
  refused(await command(driver.token, 'transport.runningLate', { routeId: 'route-2', kind: 'late10' }), 403, 'NOT_ALLOWED', 'another route');
  const n = ok(await command(driver.token, 'transport.runningLate', { routeId: 'route-1', kind: 'breakdown' }), 'runningLate');
  assert.equal(n.important, true);
  const kids = psql(`select string_agg(distinct x.student_id, ',' order by x.student_id) from notice_receipt_students x where x.notice_id = '${n.id}'`).split(',');
  const route1 = psql(`select string_agg(id, ',' order by id) from students where route_id = 'route-1' and status = 'active'`).split(',');
  assert.deepEqual(kids, route1);
  assert.equal((await restAs(tpa.token, `notices?id=eq.${n.id}&select=id`)).data.length, 0, 'teachers do not read bus-route notices');
});

test('#11 a parent writes to the fee office: the accountant reads and answers it; the teacher never sees it', async () => {
  const t = ok(await command(parentBus.token, 'threads.open', { studentId: 'stu-04', subject: 'Fake: fee question', body: 'Fake body', to: 'accountant' }), 'open');
  assert.equal(t.to, 'accountant');
  ok(await command(acct.token, 'threads.reply', t.id, 'Fake answer from the office'), 'reply');
  refused(await command(tpa.token, 'threads.reply', t.id, 'x'), 403, 'NOT_ALLOWED', 'the teacher');
  assert.equal((await restAs(tpa.token, `threads?id=eq.${t.id}&select=id`)).data.length, 0);
  assert.equal((await restAs(acct.token, `messages?thread_id=eq.${t.id}&select=id`)).data.length, 2);
});

test('#83 a "please send" entry reaches the family, who acknowledge it once', async () => {
  const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
  const e = ok(await command(tpa.token, 'diary.add', { studentId: 'stu-04', date: today, type: 'needs', data: { items: ['spareClothes'], note: '' } }), 'needs');
  refused(await command(parentSib.token, 'diary.acknowledge', e.id), 403, 'NOT_ALLOWED', 'another family');
  const a = ok(await command(parentBus.token, 'diary.acknowledge', e.id), 'acknowledge');
  assert.equal(a.ackBy, 'grd-02');
  assert.equal(psql(`select doc->>'ackBy' from diary_entries where id = '${e.id}'`), 'grd-02');
});

test('#81 a UPI payment the family reports becomes a receipt only when the accountant confirms it', async () => {
  const inv = JSON.parse(psql(`select row_to_json(x) from (select i.id, i.number from invoices i where i.student_id = 'stu-02' and i.status in ('issued', 'partiallyPaid') order by i.due_date limit 1) x`));
  refused(await command(parentSib.token, 'fees.claimUpi', { studentId: 'stu-02', invoiceIds: [inv.id], amountPaise: 999999999, reference: 'FAKEUTR9001', paidOn: new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10) }), 422, 'INVALID_AMOUNT', 'more than is open');
  const paidOn = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
  const c = ok(await command(parentSib.token, 'fees.claimUpi', { studentId: 'stu-02', invoiceIds: [inv.id], amountPaise: 150000, reference: 'FAKEUTR9001', paidOn }), 'claim');
  assert.equal(psql(`select count(*) from payments where doc->>'reference' = 'FAKEUTR9001'`), '0', 'no receipt yet');
  refused(await command(parentBus.token, 'fees.claimUpi', { studentId: 'stu-02', invoiceIds: [inv.id], amountPaise: 100, reference: 'FAKEUTR9002', paidOn }), 403, 'NOT_ALLOWED', 'not their child');
  refused(await command(parentSib.token, 'fees.confirmClaim', c.id), 403, 'NOT_ALLOWED', 'a parent cannot confirm');
  const r = ok(await command(acct.token, 'fees.confirmClaim', c.id), 'confirm');
  assert.deepEqual([r.claim.status, r.payment.mode, r.payment.amountPaise], ['confirmed', 'upi', 150000]);
  assert.equal(psql(`select doc->>'receiptNumber' from payments where doc->>'reference' = 'FAKEUTR9001'`), r.payment.receiptNumber);
  const c2 = ok(await command(parentSib.token, 'fees.claimUpi', { studentId: 'stu-02', invoiceIds: [inv.id], amountPaise: 100, reference: 'FAKEUTR9003', paidOn }), 'second claim');
  assert.equal(ok(await command(acct.token, 'fees.rejectClaim', c2.id, 'Fake: not in the statement'), 'reject').status, 'rejected');
  assert.ok((await restAs(parentSib.token, 'payment_claims?select=id,status')).data.some(x => x.id === c2.id && x.status === 'rejected'));
});

test('#88 meeting slots: the teacher publishes, families book (one per child; again moves it), and see others only as taken', async () => {
  const ev = psql(`select id from calendar_events where doc->>'type' = 'ptm' and doc->>'title' like 'Parent-teacher meeting - Primary A (sample)%' limit 1`);
  const r = ok(await command(tpa.token, 'ptm.publishSlots', { eventId: ev, programId: 'prog-primary-a', from: '10:00', to: '11:00', minutes: 30 }), 'publish');
  assert.equal(r.created, 2);
  refused(await command(parentBus.token, 'ptm.publishSlots', { eventId: ev, programId: 'prog-primary-a', from: '12:00', to: '13:00', minutes: 30 }), 403, 'NOT_ALLOWED', 'a parent');
  ok(await command(parentBus.token, 'ptm.book', r.slots[0].id, 'stu-04'), 'book');
  ok(await command(parentBus.token, 'ptm.book', r.slots[1].id, 'stu-04'), 'book again moves it');
  assert.equal(psql(`select string_agg(slot_id, ',') from ptm_bookings where student_id = 'stu-04'`), r.slots[1].id);
  refused(await command(parentSib.token, 'ptm.book', r.slots[1].id, 'stu-01'), 422, 'VALIDATION', 'taken');
  const seen = (await snapshot(parentSib)).ptmSlots.find(x => x.id === r.slots[1].id);
  assert.deepEqual([seen.booked, seen.booking], [true, null], 'taken, never by whom');
  refused(await command(parentSib.token, 'ptm.cancelBooking', r.slots[1].id), 403, 'NOT_ALLOWED', 'not their booking');
  ok(await command(parentBus.token, 'ptm.cancelBooking', r.slots[1].id), 'cancel');
  ok(await command(tpa.token, 'ptm.cancelSlot', r.slots[1].id), 'staff cancel a free slot');
});
