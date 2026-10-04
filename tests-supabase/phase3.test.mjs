// Phase 3 through the real Edge Functions and Storage (local stack, fake data): photo upload grants and checks,
// signed viewing, deletion, consent withdrawal (whole and per child), the orphan sweep, report publishing, request-id
// replay, and the cron steps photosConsentSweep / retention / photosCleanup.
// Families: grd-02 = parent-bus (stu-03 Toddler, stu-04 Primary A); grd-01 = parent-siblings (stu-01 Primary A,
// stu-02 Primary B); grd-03 (stu-06 Primary A) for retention. teacher-pa teaches Primary A; teacher-pb is linked here.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { local, signIn, fn, command, rest, rpcAs, restAs, psql } from './helpers.mjs';
import { CONSENT_VERSION } from '../src/domain/commands.js';

let admin, tpa, tpb, parentBus, parentSib;
const fixture = name => readFileSync(new URL(`../tests/fixtures/${name}`, import.meta.url));
const ok = (r, what = '') => { assert.equal(r.status, 200, `${what} ${JSON.stringify(r.data)}`); return r.data.result; };
const cron = steps => fn('cron-daily', { steps }, null, { 'X-Cron-Secret': local().env.CRON_SECRET });
const today = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const jwtPayload = t => JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString('utf8'));
const objectCount = path => Number(psql(`select count(*) from storage.objects where bucket_id = 'child-photos' and name = '${path}'`));
const photoStatus = id => psql(`select status from photos where id = '${id}'`);

async function put(grant, file, type = 'image/jpeg') {
  const res = await fetch(`${local().url}/storage/v1${grant.signedPath}`, { method: 'PUT', headers: { apikey: local().anon, 'Content-Type': type }, body: fixture(file) });
  return { status: res.status, data: await res.json().catch(() => null) };
}
async function newObservation(who, studentId, text = 'Fake note: worked with the pink tower.') {
  return ok(await command(who.token, 'observations.add', { studentId, date: today(), area: 'sensorial', text }), 'observations.add');
}
/** observation + registered + uploaded (+ completed when asked) photo */
async function photoFor(who, studentId, { file = 'tiny.jpg', complete = true } = {}) {
  const o = await newObservation(who, studentId);
  const reg = ok(await command(who.token, 'photos.register', { observationId: o.id, soloConfirmed: true }), 'register');
  assert.equal((await put(reg.upload, file)).status, 200);
  const done = complete ? await command(who.token, 'photos.complete', reg.photo.id) : null;
  return { o, reg, done, id: reg.photo.id, path: reg.upload.path };
}

before(async () => {
  psql(`update staff_contacts set email = 'teacher-pb@example.com' where staff_id = 'stf-teacher-pb'`);
  [admin, tpa, tpb, parentBus, parentSib] = await Promise.all(['principal@example.com', 'teacher-pa@example.com', 'teacher-pb@example.com', 'parent-bus@example.com', 'parent-siblings@example.com'].map(signIn));
  assert.equal(psql(`select role from app_users where user_id = '${tpb.userId}'`), 'teacher', 'teacher-pb linked by the auth trigger');
});

test('register → a one-path upload grant (≤ 2 h) → PUT tiny.jpg → complete → ready; a PNG is refused by the bucket', async () => {
  const o = await newObservation(tpa, 'stu-04');
  const reg = ok(await command(tpa.token, 'photos.register', { observationId: o.id, soloConfirmed: true }));
  assert.equal(reg.photo.status, 'pending');
  assert.equal(reg.upload.path, `stu-04/${reg.photo.id}.jpg`);
  const p = jwtPayload(reg.upload.token);
  assert.ok(p.exp - p.iat <= 7200 && p.exp * 1000 > Date.now(), `upload token lives ≤ 2 h (${p.exp - p.iat} s)`);
  assert.equal(p.url, `child-photos/${reg.upload.path}`, 'the token is for this one path');
  const png = await put(reg.upload, 'tiny.png', 'image/png');
  assert.ok(png.status >= 400 && png.data.statusCode === '415' && png.data.code === 'InvalidMimeType', JSON.stringify(png)); // Storage answers HTTP 400 carrying 415
  assert.equal((await put(reg.upload, 'tiny.jpg')).status, 200);
  const done = ok(await command(tpa.token, 'photos.complete', reg.photo.id), 'complete');
  assert.equal(done.photo.status, 'ready');
  assert.deepEqual([done.photo.width, done.photo.height], [8, 6]);
  assert.match(psql(`select doc->>'sha256' from photos where id = '${reg.photo.id}'`), /^[0-9a-f]{64}$/);
  assert.equal(psql(`select count(*) from app.command_requests where result::text like '%${reg.upload.token.slice(-20)}%'`), '0', 'no token in the replay store');
  assert.equal(psql(`select count(*) from audit_log where doc::text like '%token=%'`), '0', 'no signed URL in the audit log');
});

test('a file with EXIF: complete → 422, object deleted, row rejected; another teacher cannot complete someone else\'s upload', async () => {
  const x = await photoFor(tpa, 'stu-04', { file: 'tiny-exif.jpg', complete: false });
  const other = await command(tpb.token, 'photos.complete', x.id);
  assert.equal(other.status, 403);
  assert.equal(objectCount(x.path), 1, 'nothing touched for a refused caller');
  const r = await command(tpa.token, 'photos.complete', x.id);
  assert.equal(r.status, 422, JSON.stringify(r.data));
  assert.match(r.data.error.message, /EXIF/);
  assert.equal(objectCount(x.path), 0, 'object deleted');
  assert.equal(photoStatus(x.id), 'rejected');
});

test('viewing: parent 403 before share, 200 after (≤ 120 s URL, the bytes); other family and other program 403', async () => {
  const x = await photoFor(tpa, 'stu-04');
  assert.equal(x.done.status, 200, JSON.stringify(x.done.data));
  const before = await command(parentBus.token, 'photos.viewUrl', x.id);
  assert.equal(before.status, 403, JSON.stringify(before.data));
  ok(await command(tpa.token, 'observations.share', x.o.id), 'share');
  const v = ok(await command(parentBus.token, 'photos.viewUrl', x.id), 'viewUrl');
  assert.ok(!('path' in v) && v.signedPath.startsWith('/object/sign/child-photos/'));
  const p = jwtPayload(new URL(`http://x${v.signedPath}`).searchParams.get('token'));
  assert.ok(p.exp - p.iat <= 120, `view URL lives ≤ 120 s (${p.exp - p.iat})`);
  const res = await fetch(`${local().url}/storage/v1${v.signedPath}`);
  assert.equal(res.status, 200);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), fixture('tiny.jpg'));
  assert.equal((await command(parentSib.token, 'photos.viewUrl', x.id)).status, 403, 'another family');
  assert.equal((await command(tpb.token, 'photos.viewUrl', x.id)).status, 403, 'a teacher of another program');
  assert.equal(psql(`select count(*) from app.command_requests where name = 'photos.viewUrl'`), '0', 'viewUrl is never stored');
  const snap = (await rpcAs(parentBus.token, 'my_snapshot')).data;
  assert.ok(snap.photos.some(ph => ph.id === x.id), 'the parent\'s snapshot lists the shared ready photo');
  assert.ok(!snap.observations.some(o => !o.sharedAt), 'and no unshared observation');
});

test('photos.remove deletes the object at once; the row stays as evidence (deleted)', async () => {
  const x = await photoFor(tpa, 'stu-04');
  assert.equal(objectCount(x.path), 1);
  assert.equal((await command(parentBus.token, 'photos.remove', x.id)).status, 403);
  const r = ok(await command(tpa.token, 'photos.remove', x.id, 'blurred'));
  assert.equal(r.objectDeleted, true);
  assert.equal(objectCount(x.path), 0);
  const res = await fetch(`${local().url}/storage/v1/object/authenticated/child-photos/${x.path}`, { headers: { apikey: local().service, Authorization: `Bearer ${local().service}` } });
  assert.ok([400, 404].includes(res.status), `object gone (${res.status})`);
  assert.equal(photoStatus(x.id), 'deleted');
});

test('a replayed photos.register (same request id) returns the stored copy without a token and adds no row', async () => {
  const o = await newObservation(tpa, 'stu-04');
  const body = { name: 'photos.register', args: [{ observationId: o.id, soloConfirmed: true }], requestId: `p3-${randomUUID()}` };
  const first = ok(await fn('command', body, tpa.token));
  assert.ok(first.upload.token);
  const again = ok(await fn('command', body, tpa.token));
  assert.equal(again.upload, null);
  assert.equal(again.uploadWithheld, true);
  assert.equal(again.photo.id, first.photo.id);
  assert.equal(psql(`select count(*) from photos where doc->>'observationId' = '${o.id}'`), '1');
});

test('per-child photo consent: siblings may differ; a child outside the family is refused; withdrawing for one child deletes only that child\'s photos', async () => {
  const st = ok(await command(parentSib.token, 'consent.give', { purposes: [], perChild: { 'stu-01': ['photos'] }, version: CONSENT_VERSION }));
  assert.ok(st.byChild['stu-01'].includes('photos'));
  assert.equal((await command(parentSib.token, 'consent.give', { purposes: [], perChild: { 'stu-03': ['photos'] }, version: CONSENT_VERSION })).status, 403);
  const a = await photoFor(tpa, 'stu-01');
  const b = await photoFor(tpb, 'stu-02');
  assert.deepEqual([photoStatus(a.id), photoStatus(b.id)], ['ready', 'ready']);
  const w = ok(await command(parentSib.token, 'consent.withdraw', 'photos', { studentIds: ['stu-02'] }));
  assert.ok(!w.byChild['stu-02'].includes('photos') && w.byChild['stu-01'].includes('photos'));
  assert.deepEqual([photoStatus(a.id), photoStatus(b.id)], ['ready', 'deleting']);
  const reg = await command(tpb.token, 'photos.register', { observationId: b.o.id, soloConfirmed: true });
  assert.equal(reg.status, 422, 'no new photo without consent');
  assert.match(reg.data.error.message, /photo consent/);
});

test('an object uploaded but never completed is swept after the grace; its pending row becomes rejected', async () => {
  const x = await photoFor(tpa, 'stu-04', { complete: false });
  const r0 = await cron(['photosCleanup']);
  assert.equal(r0.status, 200, JSON.stringify(r0.data));
  assert.equal(objectCount(x.path), 1, 'inside the grace: untouched');
  psql(`update storage.objects set created_at = now() - interval '3 hours' where bucket_id = 'child-photos' and name = '${x.path}';
        update photos set doc = jsonb_set(doc, '{createdAt}', to_jsonb(to_char((now() - interval '3 hours') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))) where id = '${x.id}';`);
  const r = await cron(['photosCleanup']);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const rep = r.data.report.photosCleanup;
  assert.ok(rep.pendingAbandoned >= 1 && rep.orphanObjectsDeleted >= 1, JSON.stringify(rep));
  assert.equal(objectCount(x.path), 0);
  assert.equal(photoStatus(x.id), 'rejected');
});

test('consent.withdraw(photos) by the parent → rows deleting; cron photosCleanup → deleted and objects gone', async () => {
  const x = await photoFor(tpa, 'stu-04');
  ok(await command(parentBus.token, 'consent.withdraw', 'photos'));
  const ready = psql(`select count(*) from photos where student_id in ('stu-03', 'stu-04') and status in ('ready', 'pending')`);
  assert.equal(ready, '0', 'no live photo of the family is left');
  assert.equal(photoStatus(x.id), 'deleting');
  assert.equal(objectCount(x.path), 1, 'the object goes with the cron step');
  const r = await cron(['photosConsentSweep', 'photosCleanup']);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.report.photosCleanup.finished >= 1, JSON.stringify(r.data.report));
  assert.ok(r.data.report.photosConsentSweep && !r.data.report.photosConsentSweep.error, JSON.stringify(r.data.report.photosConsentSweep));
  assert.equal(photoStatus(x.id), 'deleted');
  assert.equal(objectCount(x.path), 0);
  assert.equal(psql(`select count(*) from storage.objects o join photos p on o.name = p.doc->>'path' where p.student_id in ('stu-03', 'stu-04')`), '0');
  ok(await command(parentBus.token, 'consent.give', { purposes: ['photos'], version: CONSENT_VERSION }), 'give it back for later files');
});

test('reports.publish: teacher 403, principal 200; the parent then sees it in the snapshot', async () => {
  const r = ok(await command(tpa.token, 'reports.generate', { studentId: 'stu-04', academicYearId: 'AY2026-27', termName: 'Term 3', fromDate: '2026-09-01', toDate: today() }));
  ok(await command(tpa.token, 'reports.saveNarratives', r.id, { narratives: { overall: 'Fake narrative.' }, revision: r.revision }));
  ok(await command(tpa.token, 'reports.submit', r.id));
  assert.equal((await command(tpa.token, 'reports.publish', r.id)).status, 403);
  assert.ok(!(await rpcAs(parentBus.token, 'my_snapshot')).data.reports.some(x => x.id === r.id), 'not visible before publication');
  assert.equal(ok(await command(admin.token, 'reports.publish', r.id)).status, 'published');
  const snap = (await rpcAs(parentBus.token, 'my_snapshot')).data;
  assert.equal(snap.reports.find(x => x.id === r.id)?.narratives.overall, 'Fake narrative.');
  assert.ok(snap.reports.every(x => x.status === 'published'));
  assert.deepEqual(snap.progressEvents, []);
});

test('cron retention: nothing decided → nothing deleted, due reported; photos period set and a child left long enough → the photos expire', async () => {
  for (const purpose of ['app_account', 'photos']) await rest('POST', 'consents', { id: `cns-p3-grd-03-stu-06-${purpose}`, doc: { id: `cns-p3-grd-03-stu-06-${purpose}`, guardianId: 'grd-03', studentId: 'stu-06', purpose, version: CONSENT_VERSION, withdrawnAt: null } }, 'return=minimal');
  const x = await photoFor(tpa, 'stu-06');
  assert.equal(photoStatus(x.id), 'ready');
  ok(await command(admin.token, 'people.updateStudent', { studentId: 'stu-06', status: 'left', leftOn: '2026-01-15' }));
  const none = await cron(['retention']);
  assert.equal(none.status, 200, JSON.stringify(none.data));
  const r0 = none.data.report.retention;
  assert.equal(r0.purged.requested, 0);
  assert.ok(Object.values(r0.due).every(c => c.months === null && c.due === 0), JSON.stringify(r0.due));
  assert.equal(photoStatus(x.id), 'ready');
  const prev = ok(await command(admin.token, 'admin.setRetention', { photosMonthsAfterLeaving: 6 }));
  assert.equal(prev.photosMonthsAfterLeaving, 6);
  const preview = ok(await command(admin.token, 'retention.preview'));
  assert.ok(preview.categories.photos.due >= 1);
  const r = await cron(['retention', 'photosCleanup']);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.report.retention.purged.expired >= 1, JSON.stringify(r.data.report.retention));
  assert.equal(photoStatus(x.id), 'expired');
  assert.equal(objectCount(x.path), 0);
  assert.equal(psql(`select count(*) from observations where id = '${x.o.id}'`), '1', 'observations stay: their period is not decided');
  ok(await command(admin.token, 'admin.setRetention', {}), 'back to undecided');
  ok(await command(admin.token, 'people.updateStudent', { studentId: 'stu-06', status: 'active' }));
});

test('cron-daily (all steps) reports photosConsentSweep, retention and photosCleanup counts', async () => {
  const r = await cron(null);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  for (const k of ['photosConsentSweep', 'retention', 'photosCleanup']) assert.ok(r.data.report[k] && !r.data.report[k].error, `${k}: ${JSON.stringify(r.data.report[k])}`);
});

// ================================================================ audit fixes (C2–C6)
test('C2 teachers read no consent rows; photos.consentStatus answers per child for their own program only', async () => {
  assert.deepEqual((await restAs(tpa.token, 'consents?select=id')).data, []);
  const m = ok(await command(tpa.token, 'photos.consentStatus', { programId: 'prog-primary-a' }));
  assert.equal(m['stu-04'], true);
  assert.ok(Object.values(m).every(v => typeof v === 'boolean'));
  assert.equal((await command(tpa.token, 'photos.consentStatus', { programId: 'prog-toddler' })).status, 403);
  assert.equal((await command(parentBus.token, 'photos.consentStatus', { studentIds: ['stu-04'] })).status, 403);
  assert.equal(psql(`select count(*) from app.command_requests where name = 'photos.consentStatus'`), '0', 'readOnly: never stored');
});

test('C3/C4 a second guardian using the app without photo consent: nobody can view the shared photo, and a pending upload is rejected and deleted on complete', async () => {
  const a = await photoFor(tpa, 'stu-04');
  ok(await command(tpa.token, 'observations.share', a.o.id));
  ok(await command(parentBus.token, 'photos.viewUrl', a.id), 'visible while consent holds');
  const b = await photoFor(tpa, 'stu-04', { complete: false });
  // grd-21 becomes a second guardian of stu-04 and gives app_account only
  assert.equal((await rest('POST', 'student_guardians', { student_id: 'stu-04', guardian_id: 'grd-21', ord: 9 }, 'return=minimal')).status, 201);
  const second = await signIn(`p3-c3-${randomUUID().slice(0, 8)}@example.com`);
  assert.equal((await rest('POST', 'app_users', { user_id: second.userId, role: 'parent', guardian_id: 'grd-21', status: 'active' }, 'return=minimal')).status, 201);
  try {
    ok(await command(second.token, 'consent.give', { purposes: ['app_account'], version: CONSENT_VERSION }));
    assert.equal((await command(parentBus.token, 'photos.viewUrl', a.id)).status, 403, 'the first guardian no longer gets a URL');
    assert.equal((await command(second.token, 'photos.viewUrl', a.id)).status, 403, 'nor the second');
    assert.ok(!(await rpcAs(parentBus.token, 'my_snapshot')).data.photos.some(p => p.id === a.id), 'and the row is hidden by RLS');
    assert.deepEqual((await restAs(parentBus.token, `photos?id=eq.${a.id}&select=id`)).data, []);
    const c = await command(tpa.token, 'photos.complete', b.id);
    assert.equal(c.status, 422, JSON.stringify(c.data));
    assert.match(c.data.error.message, /photo consent no longer holds/);
    assert.equal(photoStatus(b.id), 'rejected');
    assert.equal(objectCount(b.path), 0, 'the uploaded object was deleted');
  } finally {
    await rest('DELETE', `student_guardians?student_id=eq.stu-04&guardian_id=eq.grd-21`);
  }
  ok(await command(parentBus.token, 'photos.viewUrl', a.id), 'visible again once the second link is gone');
});

test('C5 re-uploading with an old grant after removal: the next photosCleanup deletes the object (terminal rows get no grace)', async (t) => {
  const x = await photoFor(tpa, 'stu-04');
  ok(await command(tpa.token, 'photos.remove', x.id));
  assert.equal(objectCount(x.path), 0);
  const again = await put(x.reg.upload, 'tiny.jpg');
  t.diagnostic(`Storage answered a reused upload grant after deletion with HTTP ${again.status}: ${JSON.stringify(again.data)}`);
  assert.equal(again.status, 200, 'Storage cannot revoke a signed upload token: the object comes back');
  assert.equal(objectCount(x.path), 1);
  const r = await cron(['photosCleanup']);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.report.photosCleanup.orphanObjectsDeleted >= 1, JSON.stringify(r.data.report.photosCleanup));
  assert.equal(objectCount(x.path), 0);
  assert.equal(photoStatus(x.id), 'deleted');
});

test('C6 cron-daily answers 500 {ok:false, failedSteps} when a step fails, after running every step', async () => {
  psql('revoke execute on function public.photo_objects() from service_role;');
  try {
    const r = await cron(['invites', 'photosCleanup']);
    assert.equal(r.status, 500, JSON.stringify(r.data));
    assert.equal(r.data.ok, false);
    assert.deepEqual(r.data.failedSteps, ['photosCleanup']);
    assert.ok(r.data.report.invites && !r.data.report.invites.error, 'the other steps still ran');
  } finally {
    psql('grant execute on function public.photo_objects() to service_role;');
  }
  const fine = await cron(['photosCleanup']);
  assert.equal(fine.status, 200);
  assert.equal(fine.data.ok, true);
});
