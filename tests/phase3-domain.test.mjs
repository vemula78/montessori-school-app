// Phase 3 domain: progress rules, photo consent and lifecycle, curriculum commands, termly reports, enrolment changes,
// retention, the registry/slice wiring, push targets, the access export and the JPEG check. Fake data only.
// Server halves: supabase/tests/rls.test.sql (RLS), tests-supabase/phase3.test.mjs (Edge Functions).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { buildSeed } from '../src/seed/seed-data.js';
import { COMMANDS, SLICES, execute, personaFor, ctxFor, guardSlices, photoConsentFor, systemPersona, CONSENT_VERSION, CONSENT_PURPOSES } from '../src/domain/commands.js';
import { PROGRESS_STATUSES, transitionProblem, deriveState, latestPerKey } from '../src/domain/progress.js';
import { PHOTO_CAP, PHOTO_MAX_BYTES, objectProblem } from '../src/domain/photos.js';
import { listObservations } from '../src/domain/observations.js';
import { listReports, getReport } from '../src/domain/reports.js';
import { addMonths, retentionPlan, PURGEABLE } from '../src/domain/retention.js';
import { previewCurriculumCsv } from '../src/domain/curriculum.js';
import { guardianExport } from '../src/domain/export.js';
import { diffChanges } from '../supabase/functions/_shared/slices.js';
import { pushMessages } from '../supabase/functions/_shared/notify.js';
import { inspectJpeg } from '../supabase/functions/_shared/jpeg.js';
import { parseCsvObjects } from '../src/domain/csv.js';
import * as I from '../src/domain/import-people.js';

const NOW = new Date(Date.UTC(2026, 9, 2, 5, 0, 0));
const TODAY = '2026-10-02';
const at = (iso = `${TODAY}T05:00:00.000Z`) => iso;
const fixture = name => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

/** The seed with the learning records emptied and consents set by each test: results do not depend on seed content. */
function base() {
  const db = buildSeed(NOW);
  Object.assign(db, { observations: [], photos: [], progressEvents: [], reports: [], consents: [] });
  return db;
}
const admin = db => personaFor(db, { role: 'admin', staffId: 'stf-principal' });
const teacherPA = db => personaFor(db, { role: 'teacher', staffId: 'stf-teacher-pa' });
const teacherT = db => db.staff.filter(s => s.role === 'teacher').map(s => personaFor(db, { role: 'teacher', staffId: s.id })).find(p => p.programIds.includes('prog-toddler') && !p.programIds.includes('prog-primary-a'));
const parent = (db, g) => personaFor(db, { role: 'parent', guardianId: g });
const run = (db, p, name, ...args) => execute(name, db, args, ctxFor(p, at(), TODAY), p);
const runAt = (db, p, now, name, ...args) => execute(name, db, args, ctxFor(p, now, now.slice(0, 10)), p);
const consent = (db, guardianId, studentId, purpose, extra = {}) => db.consents.push({ id: `cns-t-${guardianId}-${studentId}-${purpose}-${db.consents.length}`, guardianId, studentId, purpose,
  version: CONSENT_VERSION, textHash: null, givenAt: at(), withdrawnAt: null, evidence: { method: 'test' }, ...extra });
const presentationIn = (db, area, n = 0) => db.presentations.filter(p => p.area === area && p.active)[n];
const okInfo = (extra = {}) => ({ mime: 'image/jpeg', bytes: 1000, width: 1280, height: 960, hasExif: false, hasXmp: false, sha256: 'a'.repeat(64), ...extra });

// ---------------------------------------------------------------- progress
test('progress transition matrix: forward always; backward or repeat only as a correction; first event any status', () => {
  for (const next of PROGRESS_STATUSES) {
    assert.equal(transitionProblem(null, next, false), null, `first event ${next}`);
    for (const prev of PROGRESS_STATUSES) {
      const forward = PROGRESS_STATUSES.indexOf(next) > PROGRESS_STATUSES.indexOf(prev);
      assert.equal(transitionProblem(prev, next, false) === null, forward, `${prev} → ${next} without correction`);
      assert.equal(transitionProblem(prev, next, true), null, `${prev} → ${next} as a correction`);
    }
  }
  assert.match(transitionProblem('introduced', 'bogus', true), /unknown status/);
});

test('progress.record: forward chain, refused backward, correction needs a reason, dates and retired presentations', () => {
  const db = base(); const t = teacherPA(db);
  const pr = presentationIn(db, 'practicalLife');
  const rec = (i, p = t) => run(db, p, 'progress.record', { studentId: 'stu-01', presentationId: pr.id, ...i });
  assert.equal(rec({ status: 'introduced', date: '2026-09-01' }).seq, 1);
  assert.equal(rec({ status: 'practising', date: '2026-09-10' }).seq, 2);
  assert.throws(() => rec({ status: 'introduced', date: '2026-09-11' }), /backwards/);
  assert.throws(() => rec({ status: 'practising', date: '2026-09-11' }), /already practising/);
  assert.throws(() => rec({ status: 'mastered', date: '2026-09-05' }), /before the previous record/);
  assert.throws(() => rec({ status: 'mastered', date: '2026-10-03' }), /future/);
  assert.throws(() => rec({ status: 'introduced', date: '2026-09-11', correction: true }), /needs a reason/);
  const c = rec({ status: 'introduced', date: '2026-09-05', correction: true, reason: 'recorded on the wrong child' });
  assert.equal(c.seq, 3); assert.equal(c.reason, 'recorded on the wrong child');
  run(db, admin(db), 'curriculum.retire', pr.id);
  assert.throws(() => rec({ status: 'practising', date: '2026-09-12' }), /retired/);
  assert.equal(rec({ status: 'practising', date: '2026-09-12', correction: true, reason: 'late entry' }).seq, 4);
  assert.throws(() => rec({ status: 'mastered', date: '2026-09-13' }, parent(db, 'grd-01')), { code: 'NOT_ALLOWED' });
  assert.throws(() => rec({ status: 'mastered', date: '2026-09-13' }, teacherT(db)), { code: 'NOT_ALLOWED' }, 'another program');
  run(db, admin(db), 'people.updateStudent', { studentId: 'stu-01', status: 'left', leftOn: '2026-09-30' });
  assert.throws(() => rec({ status: 'mastered', date: '2026-09-13' }, admin(db)), /not active/);
});

test('deriveState over full history equals deriveState over latest-per-key; seq is contiguous per key', () => {
  const db = base(); const t = teacherPA(db);
  const kids = ['stu-01', 'stu-04', 'stu-06'];
  const prs = [presentationIn(db, 'math'), presentationIn(db, 'language'), presentationIn(db, 'sensorial')];
  let day = 1;
  for (let i = 0; i < 30; i++) {
    const studentId = kids[i % 3], presentationId = prs[(i * 7) % 3].id;
    const prev = latestPerKey(db.progressEvents.filter(e => e.studentId === studentId && e.presentationId === presentationId))[0];
    const r = prev ? PROGRESS_STATUSES.indexOf(prev.status) : -1;
    const status = r < 2 ? PROGRESS_STATUSES[r + 1] : 'practising';
    run(db, t, 'progress.record', { studentId, presentationId, status, date: `2026-09-${String(Math.min(28, day++)).padStart(2, '0')}`, ...(r === 2 ? { correction: true, reason: 'reassessed' } : {}) });
  }
  assert.deepEqual(deriveState(db.progressEvents), deriveState(latestPerKey(db.progressEvents)));
  const byKey = new Map();
  for (const e of db.progressEvents) { const k = `${e.studentId}|${e.presentationId}`; byKey.set(k, [...(byKey.get(k) || []), e.seq]); }
  for (const [k, seqs] of byKey) assert.deepEqual(seqs, seqs.map((_, i) => i + 1), `${k} seq contiguous from 1`);
  assert.ok(byKey.size >= 3);
});

// ---------------------------------------------------------------- photo consent
test('photoConsentFor truth table: per child, every app-account guardian, current version', () => {
  const db = base();
  // stu-10 has two guardians (grd-06, grd-07); stu-01 and stu-02 are siblings (grd-01)
  assert.deepEqual(db.students.find(s => s.id === 'stu-10').guardianIds, ['grd-06', 'grd-07']);
  assert.equal(photoConsentFor(db, 'stu-10'), false, 'no guardian with app consent');
  consent(db, 'grd-06', 'stu-10', 'photos');
  assert.equal(photoConsentFor(db, 'stu-10'), false, 'photos alone, nobody with the app');
  consent(db, 'grd-06', 'stu-10', 'app_account');
  assert.equal(photoConsentFor(db, 'stu-10'), true, 'the one app guardian consents');
  consent(db, 'grd-07', 'stu-10', 'app_account');
  assert.equal(photoConsentFor(db, 'stu-10'), false, 'the second app guardian has not consented to photos');
  consent(db, 'grd-07', 'stu-10', 'photos', { version: 'v1' });
  assert.equal(photoConsentFor(db, 'stu-10'), false, 'an old-version photo consent does not count');
  consent(db, 'grd-07', 'stu-10', 'photos');
  assert.equal(photoConsentFor(db, 'stu-10'), true, 'both consent');
  db.consents.find(c => c.guardianId === 'grd-06' && c.purpose === 'photos').withdrawnAt = at();
  assert.equal(photoConsentFor(db, 'stu-10'), false, 'one withdrew');
  consent(db, 'grd-01', 'stu-01', 'app_account'); consent(db, 'grd-01', 'stu-01', 'photos'); consent(db, 'grd-01', 'stu-02', 'app_account');
  assert.equal(photoConsentFor(db, 'stu-01'), true);
  assert.equal(photoConsentFor(db, 'stu-02'), false, "a sibling's photo consent does not count");
  consent(db, 'grd-99', 'stu-02', 'app_account');
  assert.equal(photoConsentFor(db, 'stu-02'), false, 'a stray row of a non-guardian changes nothing');
  assert.equal(photoConsentFor(db, 'stu-nope'), false);
  assert.ok(CONSENT_PURPOSES.includes('photos'));
});

test('consent.give perChild: photos for one sibling only; a child outside the family refused; app account never per child', () => {
  const db = base(); Object.assign(db, { invites: [], appUsers: [], erasureRequests: [] });
  const p = parent(db, 'grd-01'); // stu-01 and stu-02
  const give = a => run(db, p, 'consent.give', { version: CONSENT_VERSION, ...a });
  assert.throws(() => give({ purposes: [], perChild: { 'stu-01': ['photos'] } }), /app account purpose is required/);
  const st = give({ purposes: ['app_account'], perChild: { 'stu-01': ['photos'] } });
  assert.equal(st.purposes.app_account.given, true);
  assert.equal(st.purposes.photos.given, false, 'not every child');
  assert.deepEqual(st.byChild, { 'stu-01': ['app_account', 'photos'], 'stu-02': ['app_account'] });
  assert.equal(photoConsentFor(db, 'stu-01'), true);
  assert.equal(photoConsentFor(db, 'stu-02'), false, 'the sibling stays without photo consent');
  assert.throws(() => give({ purposes: [], perChild: { 'stu-03': ['photos'] } }), { code: 'NOT_ALLOWED' }, 'another family\'s child');
  assert.throws(() => give({ purposes: [], perChild: { 'stu-02': ['app_account'] } }), /all your children together/);
  assert.throws(() => give({ purposes: [], perChild: { 'stu-02': ['selfies'] } }), /Unknown purpose/);
  assert.throws(() => give({ purposes: [], perChild: ['stu-02'] }), /perChild must be/);
  const n = db.consents.length;
  give({ purposes: [], perChild: { 'stu-01': ['photos'] } });
  assert.equal(db.consents.length, n, 'giving again adds nothing');
  give({ purposes: ['push'], perChild: { 'stu-02': ['photos'] } });
  assert.equal(photoConsentFor(db, 'stu-02'), true);
  assert.ok(db.consents.filter(c => c.purpose === 'push').length === 2, 'purposes still apply to every child');
  // an optional purpose for a child needs that child's app account consent at this version
  const db2 = base(); Object.assign(db2, { invites: [], appUsers: [], erasureRequests: [] });
  const p2 = parent(db2, 'grd-01');
  consent(db2, 'grd-01', 'stu-01', 'app_account'); consent(db2, 'grd-01', 'stu-02', 'app_account', { version: 'v1' });
  assert.throws(() => run(db2, p2, 'consent.give', { version: CONSENT_VERSION, purposes: [], perChild: { 'stu-02': ['photos'] } }), /app account purpose/);
  assert.equal(db2.consents.length, 2, 'nothing written by a refused call');
});

test('consent.withdraw(photos, {studentIds}) withdraws for that child only and sends only that child\'s photos to deleting', () => {
  const db = base(); Object.assign(db, { invites: [], appUsers: [], erasureRequests: [] });
  const p = parent(db, 'grd-01');
  run(db, p, 'consent.give', { version: CONSENT_VERSION, purposes: ['app_account', 'photos'] });
  run(db, admin(db), 'people.updateStudent', { studentId: 'stu-02', programId: 'prog-primary-a' }); // both children with teacher-pa
  const t = teacherPA(db);
  const ph = {};
  for (const sid of ['stu-01', 'stu-02']) {
    const o = run(db, t, 'observations.add', { studentId: sid, date: TODAY, area: 'culture', text: 'Matched the continent map.' });
    ph[sid] = run(db, t, 'photos.register', { observationId: o.id, soloConfirmed: true }).photo.id;
  }
  const p1 = parent(db, 'grd-01');
  assert.throws(() => run(db, p1, 'consent.withdraw', 'photos', { studentIds: ['stu-03'] }), { code: 'NOT_ALLOWED' });
  assert.throws(() => run(db, p1, 'consent.withdraw', 'app_account', { studentIds: ['stu-01'] }), /Only photo consent/);
  const st = run(db, p1, 'consent.withdraw', 'photos', { studentIds: ['stu-02'] });
  assert.deepEqual(st.byChild['stu-02'], ['app_account']);
  assert.deepEqual(st.byChild['stu-01'], ['app_account', 'photos']);
  assert.equal(db.photos.find(x => x.id === ph['stu-02']).status, 'deleting');
  assert.equal(db.photos.find(x => x.id === ph['stu-01']).status, 'pending', 'the sibling\'s photo is untouched');
  assert.equal(photoConsentFor(db, 'stu-01'), true);
});

// ---------------------------------------------------------------- photos
function withObservation({ consentGiven = true } = {}) {
  const db = base(); const t = teacherPA(db);
  if (consentGiven) { consent(db, 'grd-02', 'stu-04', 'app_account'); consent(db, 'grd-02', 'stu-04', 'photos'); }
  const o = run(db, t, 'observations.add', { studentId: 'stu-04', date: TODAY, area: 'sensorial', text: 'Built the pink tower without help.' });
  return { db, t, o };
}

test('photos.register: needs consent, the solo confirmation and room under the cap; the server chooses the path', () => {
  const { db, t, o } = withObservation({ consentGiven: false });
  assert.throws(() => run(db, t, 'photos.register', { observationId: o.id, soloConfirmed: true }), /photo consent/);
  consent(db, 'grd-02', 'stu-04', 'app_account'); consent(db, 'grd-02', 'stu-04', 'photos');
  assert.throws(() => run(db, t, 'photos.register', { observationId: o.id }), /only this child/);
  assert.throws(() => run(db, t, 'photos.register', { observationId: o.id, soloConfirmed: 'yes' }), /only this child/);
  const r = run(db, t, 'photos.register', { observationId: o.id, soloConfirmed: true, path: '../other-child/x.jpg' });
  assert.equal(r.photo.status, 'pending');
  assert.equal(r.path, `stu-04/${r.photo.id}.jpg`, 'path chosen by the server');
  assert.equal(r.upload, null, 'the grant is added by the command function, never by the domain');
  assert.deepEqual(COMMANDS['photos.register'].storedResult({ ...r, upload: { token: 'secret' } }).upload, null, 'a replay copy never holds the token');
  assert.throws(() => run(db, teacherT(db), 'photos.register', { observationId: o.id, soloConfirmed: true }), { code: 'NOT_ALLOWED' });
  assert.throws(() => run(db, parent(db, 'grd-02'), 'photos.register', { observationId: o.id, soloConfirmed: true }), { code: 'NOT_ALLOWED' });
  for (let i = db.photos.length; i < PHOTO_CAP; i++) db.photos.push({ ...db.photos[0], id: `pho-fill-${i}`, status: i % 2 ? 'ready' : 'pending' });
  db.photos.push({ ...db.photos[0], id: 'pho-gone', status: 'deleted' });
  assert.throws(() => run(db, t, 'photos.register', { observationId: o.id, soloConfirmed: true }), new RegExp(`${PHOTO_CAP} photos`));
});

test('photos.complete: ready only for a JPEG within size and dimensions and without metadata; refusals are committed as rejected', () => {
  const { db, t, o } = withObservation();
  const reg = () => run(db, t, 'photos.register', { observationId: o.id, soloConfirmed: true }).photo.id;
  const complete = (id, objectInfo, p = t) => execute('photos.complete', db, [id], { ...ctxFor(p, at(), TODAY), objectInfo }, p);
  const cases = [
    [{ bytes: PHOTO_MAX_BYTES + 1 }, /larger than 400 KiB/],
    [{ width: 1601 }, /1600 px/],
    [{ height: 2000 }, /1600 px/],
    [{ mime: 'image/png' }, /not a JPEG/],
    [{ hasExif: true }, /EXIF/],
    [{ reason: 'damaged JPEG (cut short)' }, /cut short/],
  ];
  for (const [extra, re] of cases) {
    const id = reg();
    const r = complete(id, okInfo({ ...extra, objectDeleted: true }));
    assert.match(r.failure.message, re);
    assert.equal(r.failure.code, 'VALIDATION');
    assert.equal(db.photos.find(x => x.id === id).status, 'rejected');
    assert.ok(db.photos.find(x => x.id === id).objectDeletedAt, 'the object was deleted before the row was rejected');
  }
  const id = reg();
  assert.throws(() => complete(id, { missing: true }), /No uploaded file/);
  assert.equal(db.photos.find(x => x.id === id).status, 'pending', 'a missing object changes nothing (retry the upload)');
  assert.throws(() => complete(id, undefined), /not verified/);
  assert.throws(() => complete(id, okInfo(), admin(db)) && complete(id, okInfo(), teacherT(db)), { code: 'NOT_ALLOWED' });
  const ok = complete(id, okInfo());
  assert.equal(ok.failure, undefined);
  assert.equal(ok.photo.status, 'ready');
  assert.equal(objectProblem(okInfo()), null);
  assert.equal(complete(id, okInfo()).photo.status, 'ready', 'completing twice is harmless');
});

test('photos.remove → deleting → finishDelete → deleted; only staff of the child; system steps refuse users', () => {
  const { db, t, o } = withObservation();
  const id = run(db, t, 'photos.register', { observationId: o.id, soloConfirmed: true }).photo.id;
  assert.throws(() => run(db, parent(db, 'grd-02'), 'photos.remove', id), { code: 'NOT_ALLOWED' });
  assert.equal(run(db, t, 'photos.remove', id).photo.status, 'deleting');
  assert.throws(() => run(db, admin(db), 'photos.finishDelete', { photoIds: [id] }), { code: 'NOT_ALLOWED' });
  const sys = systemPersona('test');
  assert.deepEqual(execute('photos.finishDelete', db, [{ photoIds: [id, 'pho-none'] }], { actor: { role: 'system', id: 'test' }, now: at(), today: TODAY }, sys), { finished: 1, skipped: 1 });
  assert.equal(db.photos.find(x => x.id === id).status, 'deleted');
});

test('consent.withdraw(photos) marks every live photo of the child deleting in the same change; the sweep finds the rest', () => {
  const { db, t, o } = withObservation();
  const ids = [0, 1].map(() => run(db, t, 'photos.register', { observationId: o.id, soloConfirmed: true }).photo.id);
  execute('photos.complete', db, [ids[0]], { ...ctxFor(t, at(), TODAY), objectInfo: okInfo() }, t);
  db.consents.push(...[]); Object.assign(db, { invites: [], appUsers: [], erasureRequests: [] });
  const p = parent(db, 'grd-02');
  const st = run(db, p, 'consent.withdraw', 'photos');
  assert.equal(st.purposes.photos.given, false);
  assert.deepEqual(ids.map(id => db.photos.find(x => x.id === id).status), ['deleting', 'deleting']);
  assert.ok(db.photos.every(x => x.deleteReason === 'photo consent withdrawn'));
  // a photo registered while consent still held, then consent withdrawn by deleting the row: the cron sweep catches it
  const db2 = withObservation().db;
  const o2 = db2.observations[0];
  const id2 = run(db2, teacherPA(db2), 'photos.register', { observationId: o2.id, soloConfirmed: true }).photo.id;
  db2.consents = db2.consents.filter(c => c.purpose !== 'photos');
  const r = execute('photos.consentSweep', db2, [], { actor: { role: 'system', id: 'cron' }, now: at(), today: TODAY }, systemPersona('cron'));
  assert.deepEqual([r.children, r.photos], [1, 1]);
  assert.equal(db2.photos.find(x => x.id === id2).status, 'deleting');
});

// ---------------------------------------------------------------- observations
test('observations: staff-only until shared; shared text frozen; unshare within 24 hours (principal any time)', () => {
  const { db, t, o } = withObservation();
  const pa = parent(db, 'grd-02');
  assert.deepEqual(listObservations(db, pa, { studentId: 'stu-04' }), [], 'unshared: the parent sees nothing');
  assert.equal(run(db, t, 'observations.edit', o.id, { text: 'Built the pink tower, then the brown stair.' }).text, 'Built the pink tower, then the brown stair.');
  run(db, t, 'observations.share', o.id);
  assert.deepEqual(listObservations(db, pa, { studentId: 'stu-04' }).map(x => x.id), [o.id]);
  assert.throws(() => listObservations(db, parent(db, 'grd-01'), { studentId: 'stu-04' }), { code: 'NOT_ALLOWED' }, 'another family');
  assert.equal(listObservations(db, parent(db, 'grd-01'), {}).length, 0);
  assert.throws(() => run(db, t, 'observations.edit', o.id, { text: 'changed' }), /cannot be edited/);
  assert.throws(() => run(db, pa, 'observations.share', o.id), { code: 'NOT_ALLOWED' });
  assert.throws(() => listObservations(db, personaFor(db, { role: 'accountant', staffId: 'stf-accountant' }), {}), { code: 'NOT_ALLOWED' });
  const later = '2026-10-03T06:00:00.000Z';
  assert.throws(() => runAt(db, t, later, 'observations.unshare', o.id), /Only the principal/);
  assert.equal(runAt(db, admin(db), later, 'observations.unshare', o.id).sharedAt, null);
  run(db, t, 'observations.share', o.id);
  assert.equal(run(db, t, 'observations.unshare', o.id).sharedAt, null, 'within 24 hours the teacher may');
  assert.ok(db.auditLog.filter(a => a.entity === 'observation' && a.action === 'unshare').length === 2);
  assert.throws(() => run(db, t, 'observations.add', { studentId: 'stu-04', date: TODAY, area: 'math', presentationId: presentationIn(db, 'language').id, text: 'x' }), /another area/);
});

// ---------------------------------------------------------------- curriculum
test('curriculum: starter list has 5 areas, ≥150 unique keys, loads idempotently; save renames keeping the id; retire never deletes', () => {
  const db = base(); db.presentations = [];
  const a = admin(db);
  const r1 = run(db, a, 'curriculum.loadStarter');
  assert.ok(r1.added >= 150, `${r1.added} added`);
  assert.equal(new Set(db.presentations.map(p => p.area)).size, 5);
  assert.equal(new Set(db.presentations.map(p => p.key)).size, db.presentations.length, 'unique keys');
  const r2 = run(db, a, 'curriculum.loadStarter');
  assert.deepEqual([r2.added, r2.skippedExisting], [0, r1.added], 'idempotent');
  const pr = db.presentations[0];
  const renamed = run(db, a, 'curriculum.save', { id: pr.id, area: pr.area, name: `${pr.name} (with tray)`, sequence: pr.sequence });
  assert.equal(renamed.id, pr.id);
  assert.notEqual(renamed.key, r1.key);
  assert.throws(() => run(db, a, 'curriculum.save', { area: db.presentations[1].area, name: db.presentations[1].name }), /already exists/);
  assert.throws(() => run(db, teacherPA(db), 'curriculum.save', { area: 'math', name: 'New thing' }), { code: 'NOT_ALLOWED' });
  const n = db.presentations.length;
  run(db, a, 'curriculum.retire', pr.id);
  assert.equal(db.presentations.length, n);
  assert.equal(db.presentations.find(x => x.id === pr.id).active, false);
  run(db, a, 'curriculum.restore', pr.id);
  assert.equal(db.presentations.find(x => x.id === pr.id).active, true);
});

test('curriculum.importCsv: counts add up on the dirty fixture; rejected rows carry line + reason; a second import adds nothing', () => {
  const db = base(); db.presentations = [];
  const a = admin(db);
  const text = readFileSync(new URL('./fixtures/curriculum-dirty.csv', import.meta.url), 'utf8');
  const prev = previewCurriculumCsv(db, text);
  const r = run(db, a, 'curriculum.importCsv', text); // audit C8: the command takes the CSV text and previews it itself
  assert.equal(r.inputRows, prev.counts.inputRows);
  assert.equal(r.imported + r.skippedDuplicate + r.rejected, r.inputRows);
  assert.equal(r.imported, prev.counts.imported);
  assert.ok(r.rejected > 0 && r.rejectedRows.every(x => Number.isInteger(x.line) && x.reason), 'rejected rows have line and reason');
  assert.equal(r.rejectedRows.length, r.rejected);
  const again = run(db, a, 'curriculum.importCsv', text);
  assert.equal(again.imported, 0, 'importing the same file twice adds nothing');
  assert.equal(again.imported + again.skippedDuplicate + again.rejected, again.inputRows);
  const n = db.presentations.length;
  assert.throws(() => run(db, a, 'curriculum.importCsv', { ...prev, counts: { inputRows: 0, imported: 0, skippedDuplicate: 0, rejected: 0 }, rows: [] }), /CSV text/, 'a client-made preview is not accepted');
  assert.throws(() => run(db, a, 'curriculum.importCsv', `area,name\n${'math,x\n'.repeat(80000)}`), /larger than 512 KB/);
  assert.equal(db.presentations.length, n);
});

// ---------------------------------------------------------------- reports
function reportDb() {
  const { db, t, o } = withObservation();
  const pr = presentationIn(db, 'sensorial');
  run(db, t, 'progress.record', { studentId: 'stu-04', presentationId: pr.id, status: 'introduced', date: '2026-09-01' });
  run(db, t, 'progress.record', { studentId: 'stu-04', presentationId: pr.id, status: 'practising', date: '2026-09-20' });
  run(db, t, 'observations.share', o.id);
  const hidden = run(db, t, 'observations.add', { studentId: 'stu-04', date: '2026-09-15', area: 'math', text: 'Staff-only note.' });
  return { db, t, o, pr, hidden };
}
const TERM2 = { studentId: 'stu-04', academicYearId: 'AY2026-27', termName: 'Term 2', fromDate: '2026-09-01', toDate: '2026-10-02' };

test('reports.generate freezes names and progress as of toDate, and leaves unshared observations out', () => {
  const { db, t, o, pr, hidden } = reportDb();
  const name = pr.name;
  const r = run(db, t, 'reports.generate', { ...TERM2, toDate: '2026-09-25' });
  assert.deepEqual(r.progress.map(x => [x.presentationId, x.status, x.name]), [[pr.id, 'practising', pr.name]]);
  assert.deepEqual(r.observations.map(x => x.id), [], 'the shared observation is dated after toDate');
  const r2 = run(db, t, 'reports.generate', TERM2);
  assert.equal(r2.id, r.id, 'one report per child, year and term');
  assert.deepEqual(r2.observations.map(x => x.id), [o.id]);
  assert.ok(!r2.observations.some(x => x.id === hidden.id), 'unshared observation excluded');
  run(db, admin(db), 'curriculum.save', { id: pr.id, area: pr.area, name: 'Renamed later', sequence: pr.sequence });
  assert.equal(db.reports[0].progress[0].name, name, 'the report kept the name it was generated with');
  assert.equal(pr.name, 'Renamed later');
  assert.throws(() => run(db, t, 'reports.generate', { ...TERM2, termName: 'Term 4' }), /Unknown term/);
  assert.throws(() => run(db, t, 'reports.generate', { ...TERM2, fromDate: '2026-03-01' }), /inside/);
});

test('reports: draft → submitted → published (principal only); regenerate refused while published; unpublish needs a reason; stale revision → CONFLICT', () => {
  const { db, t } = reportDb();
  const a = admin(db);
  const r = structuredClone(run(db, t, 'reports.generate', TERM2)); // what an editor holds (the api returns copies)
  assert.throws(() => run(db, a, 'reports.publish', r.id), /Only a submitted/);
  const saved = structuredClone(run(db, t, 'reports.saveNarratives', r.id, { narratives: { sensorial: 'Enjoys grading work.' }, revision: r.revision }));
  assert.equal(saved.revision, r.revision + 1);
  assert.throws(() => run(db, t, 'reports.saveNarratives', r.id, { narratives: { math: 'x' }, revision: r.revision }), { code: 'CONFLICT' });
  assert.throws(() => run(db, t, 'reports.saveNarratives', r.id, { narratives: { history: 'x' }, revision: saved.revision }), /Unknown narrative/);
  run(db, t, 'reports.submit', r.id);
  assert.throws(() => run(db, t, 'reports.publish', r.id), { code: 'NOT_ALLOWED' }, 'a teacher cannot publish');
  const pa = parent(db, 'grd-02');
  assert.deepEqual(listReports(db, pa, {}), [], 'parents see nothing before publication');
  const pub = structuredClone(run(db, a, 'reports.publish', r.id));
  assert.equal(pub.status, 'published');
  assert.equal(getReport(db, pa, r.id).narratives.sensorial, 'Enjoys grading work.');
  assert.throws(() => getReport(db, parent(db, 'grd-01'), r.id), { code: 'NOT_ALLOWED' });
  assert.throws(() => run(db, t, 'reports.generate', TERM2), /unpublish/);
  assert.throws(() => run(db, t, 'reports.saveNarratives', r.id, { narratives: { math: 'x' }, revision: pub.revision }), /published/);
  assert.throws(() => run(db, a, 'reports.unpublish', r.id, '  '), /reason/);
  const un = run(db, a, 'reports.unpublish', r.id, 'typo in the narrative');
  assert.equal(un.status, 'draft');
  assert.deepEqual(listReports(db, pa, {}), [], 'hidden again once unpublished');
  assert.equal(run(db, t, 'reports.generate', TERM2).narratives.sensorial, 'Enjoys grading work.', 'regenerating keeps the narratives');
});

test('reports for a child who left: allowed up to 12 months after leftOn, refused without a leaving date', () => {
  const { db, t } = reportDb();
  const a = admin(db);
  run(db, t, 'reports.generate', TERM2);
  run(db, a, 'people.updateStudent', { studentId: 'stu-04', status: 'left', leftOn: '2026-09-30' });
  assert.equal(run(db, a, 'reports.generate', TERM2).status, 'draft');
  db.students.find(s => s.id === 'stu-04').leftOn = null;
  assert.throws(() => run(db, a, 'reports.generate', TERM2), /leaving date is not recorded/);
  db.students.find(s => s.id === 'stu-04').leftOn = '2025-09-01';
  assert.throws(() => run(db, a, 'reports.generate', TERM2), /more than 12 months/);
});

// ---------------------------------------------------------------- enrolment, retention
test('people.updateStudent: leaving sets leftOn (given or today); back to active clears it; class change; principal only', () => {
  const db = base(); const a = admin(db);
  assert.throws(() => run(db, teacherPA(db), 'people.updateStudent', { studentId: 'stu-01', status: 'left' }), { code: 'NOT_ALLOWED' });
  assert.equal(run(db, a, 'people.updateStudent', { studentId: 'stu-01', status: 'left' }).leftOn, TODAY);
  assert.equal(run(db, a, 'people.updateStudent', { studentId: 'stu-01', leftOn: '2026-09-15' }).leftOn, '2026-09-15');
  assert.throws(() => run(db, a, 'people.updateStudent', { studentId: 'stu-01', leftOn: '2026-10-09' }), /future/);
  const back = run(db, a, 'people.updateStudent', { studentId: 'stu-01', status: 'active' });
  assert.deepEqual([back.status, back.leftOn], ['active', null]);
  assert.throws(() => run(db, a, 'people.updateStudent', { studentId: 'stu-01', leftOn: '2026-09-15' }), /Only a child who has left/);
  assert.equal(run(db, a, 'people.updateStudent', { studentId: 'stu-01', programId: 'prog-primary-b' }).programId, 'prog-primary-b');
  assert.equal(teacherPA(db).studentIds.includes('stu-01'), false, 'the old teacher no longer sees the child');
  assert.throws(() => run(db, a, 'people.updateStudent', { studentId: 'stu-01', status: 'gone' }), /Unknown status/);
  assert.throws(() => run(db, a, 'people.updateStudent', { studentId: 'stu-01', dob: '2020-01-01' }), /Unknown field/);
  assert.ok(db.auditLog.some(x => x.entity === 'student' && x.action === 'update' && /program/.test(x.summary)));
});

test('retention: nothing is due while undecided; a set period lists what is due; purge re-checks and reconciles', () => {
  const { db, t, o } = withObservation();
  const ph = run(db, t, 'photos.register', { observationId: o.id, soloConfirmed: true }).photo.id;
  const a = admin(db);
  run(db, a, 'people.updateStudent', { studentId: 'stu-04', status: 'left', leftOn: '2026-03-31' });
  const none = retentionPlan(db, TODAY);
  assert.ok(Object.values(none.categories).every(c => c.due === 0 && c.months === null));
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2024-01-31', 1), '2024-02-29');
  run(db, a, 'admin.setRetention', { photosMonthsAfterLeaving: 6, observationsMonthsAfterLeaving: 7, diaryMonthsAfterLeaving: null });
  assert.throws(() => run(db, a, 'admin.setRetention', { photosMonthsAfterLeaving: 0 }), /whole months/);
  assert.throws(() => run(db, teacherPA(db), 'admin.setRetention', { photosMonthsAfterLeaving: 6 }), { code: 'NOT_ALLOWED' });
  const plan = retentionPlan(db, TODAY);
  assert.deepEqual(plan.categories.photos.expire, [ph], '2026-03-31 + 6 months = 2026-09-30 ≤ today');
  assert.equal(plan.categories.observations.due, 0, '+ 7 months is not yet due');
  Object.assign(db, { diaryEntries: db.diaryEntries, threads: db.threads });
  const sys = systemPersona('cron');
  const sctx = { actor: { role: 'system', id: 'cron' }, now: at(), today: TODAY };
  assert.throws(() => run(db, a, 'retention.purge', { expire: [ph] }), { code: 'NOT_ALLOWED' });
  const r = execute('retention.purge', db, [{ expire: [ph, 'pho-not-due'], deletes: { observations: [o.id] } }], sctx, sys);
  assert.deepEqual([r.requested, r.expired, r.deleted.observations, r.skipped], [3, 1, 0, 2], 'not-due rows are skipped, never deleted');
  assert.equal(db.photos.find(x => x.id === ph).status, 'deleting');
  assert.equal(db.photos.find(x => x.id === ph).deleteReason, 'retention');
  execute('photos.finishDelete', db, [{ photoIds: [ph] }], sctx, sys);
  assert.equal(db.photos.find(x => x.id === ph).status, 'expired');
  assert.throws(() => execute('retention.purge', db, [{ deletes: { payments: ['pay-1'] } }], sctx, sys), /never deletes payments/);
  const later = { ...sctx, today: '2026-11-01' };
  const plan2 = retentionPlan(db, later.today);
  const r2 = execute('retention.purge', db, [{ deletes: plan2.categories.observations.deletes }], later, sys);
  assert.equal(r2.deleted.observations, 1);
  assert.equal(db.observations.some(x => x.id === o.id), false);
  assert.equal(db.photos.some(x => x.id === ph), false, 'the expired photo row went with its observation');
});

test('imported children carry leftOn: null (a child imported as left shows "leaving date unknown"); the diary no longer takes new observations', () => {
  const db = base();
  const csv = parseCsvObjects(readFileSync(new URL('./fixtures/children-dirty.csv', import.meta.url), 'utf8'));
  const n = db.students.length;
  I.applyRows(db, { kind: 'children', mapping: I.suggestMapping('children', csv.headers), rows: csv.rows }, 'imb-p3', { actor: { role: 'admin', id: 'stf-principal' }, now: at(), today: TODAY });
  const added = db.students.slice(n);
  assert.ok(added.length > 0);
  assert.ok(added.every(s => s.leftOn === null), 'leftOn present and null on every imported child');
  assert.deepEqual(retentionPlan(db, TODAY).leftWithoutDate, added.filter(s => s.status === 'left').map(s => s.id).concat(db.students.slice(0, n).filter(s => s.status === 'left' && !s.leftOn).map(s => s.id)).sort());
  const t = teacherPA(db);
  assert.throws(() => run(db, t, 'diary.add', { studentId: 'stu-04', date: TODAY, type: 'observation', data: { area: 'math', text: 'x' } }), /Learning/);
  assert.equal(run(db, t, 'diary.add', { studentId: 'stu-04', date: TODAY, type: 'activity', data: { text: 'Painted outdoors.' } }).type, 'activity');
});

// ---------------------------------------------------------------- registry, slices, push, export
test('registry: the new commands run in both modes (server-only ones are marked); learning slice writes only learning; deletes only via retention', () => {
  const both = ['curriculum.loadStarter', 'curriculum.save', 'curriculum.retire', 'curriculum.restore', 'curriculum.importCsv', 'observations.add', 'observations.edit',
    'observations.share', 'observations.unshare', 'photos.register', 'photos.complete', 'photos.remove', 'photos.finishDelete', 'progress.record', 'reports.generate',
    'reports.saveNarratives', 'reports.submit', 'reports.publish', 'reports.unpublish', 'people.updateStudent', 'admin.setRetention'];
  for (const n of both) assert.ok(COMMANDS[n] && !COMMANDS[n].serverOnly, `${n} runs in both modes`);
  for (const n of ['photos.viewUrl', 'photos.uploadTarget', 'photos.markRejected', 'photos.consentSweep', 'retention.preview', 'retention.purge']) assert.ok(COMMANDS[n].serverOnly, `${n} server only`);
  for (const n of ['photos.viewUrl', 'photos.uploadTarget', 'retention.preview']) assert.ok(COMMANDS[n].readOnly, `${n} is never stored`);
  for (const [n, c] of Object.entries(COMMANDS)) if (/^(curriculum|observations|photos|progress|reports)\./.test(n)) assert.equal(c.slice, 'learning', n);
  assert.deepEqual(SLICES.learning.writes, ['presentations', 'observations', 'photos', 'progressEvents', 'reports']);
  assert.deepEqual([...SLICES.retention.writes].sort(), [...PURGEABLE].sort());
  for (const c of ['invoices', 'payments', 'refunds', 'credits', 'students', 'guardians', 'consents', 'auditLog']) assert.ok(!PURGEABLE.includes(c), `${c} is never purged`);
  const { db, t, o } = withObservation();
  const before = structuredClone(db);
  run(db, t, 'observations.share', o.id);
  run(db, t, 'photos.register', { observationId: o.id, soloConfirmed: true });
  const ch = diffChanges(before, db, SLICES.learning.writes);
  assert.deepEqual(Object.keys(ch.upserts).sort(), ['observations', 'photos']);
  db.diaryEntries.push({ id: 'dia-x', studentId: 'stu-04', date: TODAY, type: 'activity', data: { text: 'x' } });
  assert.throws(() => diffChanges(before, db, SLICES.learning.writes), /"diaryEntries", which its slice may not write/);
  assert.ok(guardSlices('account', ['photos']).includes('learning'), 'consent.withdraw(photos) also guards the learning slice');
  assert.ok(guardSlices('learning', ['photos']).includes('account'));
  assert.ok(guardSlices('retention', ['messages', 'attendance']).includes('messaging') && guardSlices('retention', ['attendance']).includes('classroom'));
});

test('push: a shared observation and a published report go to that child\'s guardians only', () => {
  const db = base(); const t = teacherPA(db); const a = admin(db);
  // stu-10 (two guardians), stu-01 (grd-01 also parents stu-02)
  run(db, a, 'people.updateStudent', { studentId: 'stu-10', programId: 'prog-primary-a' });
  const t2 = teacherPA(db);
  const o = run(db, t2, 'observations.add', { studentId: 'stu-10', date: TODAY, area: 'language', text: 'Traced sandpaper letters.' });
  const before = structuredClone(db);
  const shared = run(db, t2, 'observations.share', o.id);
  const m = pushMessages('observations.share', before, db, shared);
  assert.equal(m.length, 1);
  assert.deepEqual(m[0].guardianIds.sort(), ['grd-06', 'grd-07']);
  assert.deepEqual(m[0].studentIds, ['stu-10']);
  assert.deepEqual(m[0].purposes, ['push']);
  assert.ok(!/Traced/.test(m[0].payload.body), 'the observation text never goes into a push');
  assert.equal(pushMessages('observations.share', db, db, shared).length, 0, 'sharing an already shared one sends nothing');
  const r = run(db, t, 'reports.generate', { ...TERM2, studentId: 'stu-01' });
  run(db, t, 'reports.submit', r.id);
  const b2 = structuredClone(db);
  const pub = run(db, a, 'reports.publish', r.id);
  const m2 = pushMessages('reports.publish', b2, db, pub);
  assert.deepEqual(m2.map(x => [x.guardianIds, x.studentIds]), [[['grd-01'], ['stu-01']]]);
  assert.equal(pushMessages('reports.generate', b2, db, r).length, 0);
});

test('guardianExport for the principal is the full record: observations (shared and unshared), photo metadata, progress events, every report', () => {
  const { db, t } = reportDb();
  const ph = run(db, t, 'photos.register', { observationId: db.observations[0].id, soloConfirmed: true }).photo.id;
  run(db, t, 'reports.generate', TERM2);
  const x = guardianExport(db, 'grd-02', { full: true });
  assert.equal(x.observations.length, 2, 'shared and unshared: it is the child\'s record');
  assert.deepEqual(x.photos.map(p => p.id), [ph]);
  assert.ok(!('path' in x.photos[0]), 'no storage path');
  assert.equal(x.progressEvents.length, 2);
  assert.equal(x.reports.length, 1);
  assert.equal(guardianExport(db, 'grd-01', { full: true }).observations.length, 0, 'another family');
  assert.equal(JSON.parse(run(db, admin(db), 'admin.dataExport', 'grd-02')).progressEvents.length, 2, 'admin.dataExport by the principal is full');
});

test('audit #1: a parent\'s own export holds what the parent can see — shared observations, ready photos of them while consent holds, published reports; no progress, no drafts', () => {
  const { db, t, o, hidden } = reportDb();
  Object.assign(db, { invites: [], appUsers: [], erasureRequests: [] });
  const ready = run(db, t, 'photos.register', { observationId: o.id, soloConfirmed: true }).photo.id;
  execute('photos.complete', db, [ready], { ...ctxFor(t, at(), TODAY), objectInfo: okInfo() }, t);
  const pending = run(db, t, 'photos.register', { observationId: o.id, soloConfirmed: true }).photo.id;
  const draft = run(db, t, 'reports.generate', TERM2);
  const pa = parent(db, 'grd-02');
  const mine = () => JSON.parse(run(db, pa, 'admin.dataExport', 'grd-02'));
  let x = mine();
  assert.deepEqual(x.observations.map(v => v.id), [o.id], 'shared only');
  assert.ok(!x.observations.some(v => v.id === hidden.id));
  assert.deepEqual(x.photos.map(p => p.id), [ready], 'ready photos of shared observations only');
  assert.ok(!x.photos.some(p => p.id === pending));
  assert.deepEqual(x.progressEvents, []);
  assert.deepEqual(x.reports, [], 'no draft or submitted report');
  assert.match(x.learningNote, /principal on a written request/);
  run(db, t, 'reports.submit', draft.id); run(db, admin(db), 'reports.publish', draft.id);
  x = mine();
  assert.deepEqual(x.reports.map(r => [r.id, r.status]), [[draft.id, 'published']]);
  db.consents.find(c => c.guardianId === 'grd-02' && c.studentId === 'stu-04' && c.purpose === 'photos').withdrawnAt = at();
  assert.deepEqual(mine().photos, [], 'no photo metadata once photo consent no longer holds');
  const full = JSON.parse(run(db, admin(db), 'admin.dataExport', 'grd-02'));
  assert.equal(full.observations.length, 2);
  assert.equal(full.progressEvents.length, 2);
  assert.equal(full.photos.length, 2);
  assert.equal(full.learningNote, undefined);
});

test('audit C2: photos.consentStatus answers {studentId: boolean} for staff of the children; the consent rows themselves stay hidden', () => {
  const db = base();
  consent(db, 'grd-02', 'stu-04', 'app_account'); consent(db, 'grd-02', 'stu-04', 'photos');
  consent(db, 'grd-01', 'stu-01', 'app_account');
  const t = teacherPA(db);
  const r = run(db, t, 'photos.consentStatus', { programId: 'prog-primary-a' });
  assert.equal(r['stu-04'], true);
  assert.equal(r['stu-01'], false);
  assert.ok(Object.keys(r).every(id => db.students.find(s => s.id === id).programId === 'prog-primary-a'));
  assert.deepEqual(run(db, t, 'photos.consentStatus', { studentIds: ['stu-04'] }), { 'stu-04': true });
  assert.throws(() => run(db, t, 'photos.consentStatus', { programId: 'prog-toddler' }), { code: 'NOT_ALLOWED' });
  assert.throws(() => run(db, t, 'photos.consentStatus', { studentIds: ['stu-03'] }), { code: 'NOT_ALLOWED' });
  assert.throws(() => run(db, parent(db, 'grd-02'), 'photos.consentStatus', { studentIds: ['stu-04'] }), { code: 'NOT_ALLOWED' });
  assert.equal(Object.keys(run(db, admin(db), 'photos.consentStatus', { programId: 'prog-toddler' })).length > 0, true);
  assert.ok(COMMANDS['photos.consentStatus'].readOnly && COMMANDS['photos.consentStatus'].serverOnly);
});

test('audit C3/C4: viewing needs photo consent to hold; complete re-checks it and rejects the upload when it no longer holds', () => {
  const { db, t, o } = withObservation();
  const ph = run(db, t, 'photos.register', { observationId: o.id, soloConfirmed: true }).photo.id;
  // a second guardian of the child starts using the app without photo consent: consent no longer holds
  db.students.find(s => s.id === 'stu-04').guardianIds.push('grd-03');
  consent(db, 'grd-03', 'stu-04', 'app_account');
  const target = run(db, t, 'photos.uploadTarget', ph);
  assert.equal(target.consentOk, false, 'the server step learns it must delete the object');
  const r = execute('photos.complete', db, [ph], { ...ctxFor(t, at(), TODAY), objectInfo: { objectDeleted: true } }, t);
  assert.match(r.failure.message, /photo consent no longer holds/);
  assert.equal(db.photos.find(x => x.id === ph).status, 'rejected');
  assert.ok(db.photos.find(x => x.id === ph).objectDeletedAt);
  // a ready photo of a shared observation: nobody gets a view URL while consent does not hold
  db.students.find(s => s.id === 'stu-04').guardianIds.pop();
  const ph2 = run(db, t, 'photos.register', { observationId: o.id, soloConfirmed: true }).photo.id;
  execute('photos.complete', db, [ph2], { ...ctxFor(t, at(), TODAY), objectInfo: okInfo() }, t);
  run(db, t, 'observations.share', o.id);
  const pa = parent(db, 'grd-02');
  assert.ok(run(db, pa, 'photos.viewUrl', ph2).path);
  db.students.find(s => s.id === 'stu-04').guardianIds.push('grd-03');
  assert.throws(() => run(db, pa, 'photos.viewUrl', ph2), { code: 'NOT_ALLOWED' });
  assert.throws(() => run(db, t, 'photos.viewUrl', ph2), { code: 'NOT_ALLOWED' });
});

// ---------------------------------------------------------------- jpeg check, versions
test('jpeg.js: a canvas-style JPEG passes; EXIF, PNG, truncation and comments are refused', () => {
  const ok = inspectJpeg(fixture('tiny.jpg'));
  assert.deepEqual([ok.mime, ok.width, ok.height, ok.hasExif, ok.reason], ['image/jpeg', 8, 6, false, null]);
  assert.equal(objectProblem({ ...ok, sha256: null }), null);
  const ex = inspectJpeg(fixture('tiny-exif.jpg'));
  assert.equal(ex.hasExif, true);
  assert.match(ex.reason, /EXIF/);
  assert.match(objectProblem(ex), /EXIF/);
  const png = inspectJpeg(fixture('tiny.png'));
  assert.equal(png.mime, null);
  assert.match(objectProblem(png), /not a JPEG/);
  const jpg = new Uint8Array(fixture('tiny.jpg'));
  assert.match(inspectJpeg(jpg.subarray(0, 30)).reason, /cut short|frame header/);
  assert.match(inspectJpeg(fixture('tiny-truncated.jpg')).reason || '', /cut short|end of image/, 'audit C9: a file cut inside the scan data');
  assert.equal(inspectJpeg(new Uint8Array([...jpg, 0, 0])).reason, null, 'zero padding after the end marker is allowed');
  const sos = jpg.findIndex((v, i) => v === 0xff && jpg[i + 1] === 0xda);
  const sosLen = (jpg[sos + 2] << 8) | jpg[sos + 3];
  assert.match(inspectJpeg(new Uint8Array([...jpg.subarray(0, sos + 2 + sosLen), 0xff, 0xd9])).reason || '', /no image data/, 'SOS with no scan data');
  const withCom = new Uint8Array([...jpg.subarray(0, 2), 0xff, 0xfe, 0x00, 0x05, 0x61, 0x62, 0x63, ...jpg.subarray(2)]);
  assert.match(inspectJpeg(withCom).reason, /comment/);
  assert.equal(inspectJpeg(new Uint8Array(0)).reason, 'not a JPEG image');
});

test('CONSENT_VERSION is v2 everywhere: the UI notice and the latest migration defining app.consent_version()', async () => {
  assert.equal(CONSENT_VERSION, 'v2');
  const { PRIVACY_VERSION } = await import('../src/ui/privacy.js');
  assert.equal(PRIVACY_VERSION, CONSENT_VERSION);
  const dir = new URL('../supabase/migrations/', import.meta.url);
  const defs = readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
    .map(f => /create (?:or replace )?function app\.consent_version\(\)[^$]*\$\$\s*select '([^']+)'::text/.exec(readFileSync(new URL(f, dir), 'utf8')))
    .filter(Boolean);
  assert.equal(defs.at(-1)[1], CONSENT_VERSION, 'the latest definition wins');
});
