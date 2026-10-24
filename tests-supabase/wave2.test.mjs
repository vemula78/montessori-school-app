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
