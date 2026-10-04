import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyDb, SCHEMA_VERSION } from '../src/store/schema.js';
import { Storage, memoryBackend, DB_KEY, CORRUPT_PREFIX } from '../src/store/storage.js';
import { createApi } from '../src/api/index.js';
import { buildSeed } from '../src/seed/seed-data.js';
import { validateDb } from '../src/domain/validate.js';
import { migrate } from '../src/store/storage.js';

const clock = () => new Date(Date.UTC(2026, 9, 2, 5, 0, 0));
const ctx = { actor: { role: 'admin', id: 'ADM' }, now: '2026-10-02T05:00:00.000Z', today: '2026-10-02' };
function seed() {
  const db = createEmptyDb();
  db.school.name = 'Fixture School (Demo)';
  db.school.currentAcademicYearId = 'AY2026-27';
  db.academicYears.push({ id: 'AY2026-27', label: '2026-27', startDate: '2026-06-01', endDate: '2027-05-31' });
  db.staff.push({ id: 'ADM', firstName: 'Ada', lastName: 'Placeholdar', role: 'admin', programIds: [], phone: '+91-90000-00001' });
  return db;
}

test('empty storage is seeded and written', () => {
  const be = memoryBackend();
  const s = new Storage({ backend: be, seedFn: seed, clock });
  assert.equal(s.load().status, 'seeded');
  const stored = JSON.parse(be.getItem(DB_KEY));
  assert.equal(stored.schemaVersion, SCHEMA_VERSION);
  assert.equal(stored.rev, 0);
  assert.equal(stored.school.name, 'Fixture School (Demo)');
});

test('corrupt JSON is preserved under a corrupt key and the error surfaced; nothing is wiped', () => {
  const be = memoryBackend();
  be.setItem(DB_KEY, '{"schemaVersion":1, broken');
  const s = new Storage({ backend: be, seedFn: seed, clock });
  const r = s.load();
  assert.equal(r.status, 'corrupt');
  assert.match(r.error, /not valid JSON/);
  assert.equal(r.corruptKey, `${CORRUPT_PREFIX}2026-10-02T05:00:00.000Z`);
  assert.equal(be.getItem(r.corruptKey), '{"schemaVersion":1, broken');
  assert.equal(be.getItem(DB_KEY), '{"schemaVersion":1, broken'); // original untouched
  assert.throws(() => s.commit(d => d), { code: 'STORAGE_CORRUPT' });
  s.resetToSeed(ctx);
  assert.equal(s.status, 'ok');
  assert.equal(JSON.parse(be.getItem(DB_KEY)).auditLog.at(-1).action, 'resetToSeed');
  assert.equal(be.getItem(r.corruptKey), '{"schemaVersion":1, broken'); // copy kept after reset
});

test('unknown schemaVersion is refused (and preserved)', () => {
  const be = memoryBackend();
  be.setItem(DB_KEY, JSON.stringify({ ...seed(), schemaVersion: 99 }));
  const s = new Storage({ backend: be, seedFn: seed, clock });
  const r = s.load();
  assert.equal(r.status, 'unsupportedVersion');
  assert.match(r.error, /schemaVersion 99/);
  assert.ok(be.getItem(r.corruptKey));
  assert.equal(s.db, null);
});

test('rev increments per commit, subscribers fire, failed commands change nothing', () => {
  const be = memoryBackend();
  const s = new Storage({ backend: be, seedFn: seed, clock });
  s.load();
  let calls = 0;
  const off = s.subscribe(() => calls++);
  s.commit(d => { d.school.phone = '+91-90000-00999'; });
  s.commit(d => { d.school.address = 'Demo Lane'; });
  assert.equal(s.db.rev, 2);
  assert.equal(JSON.parse(be.getItem(DB_KEY)).rev, 2);
  assert.equal(calls, 2);
  assert.throws(() => s.commit(d => { d.school.phone = 'x'; throw new Error('boom'); }), /boom/);
  assert.equal(s.db.school.phone, '+91-90000-00999');
  assert.equal(JSON.parse(be.getItem(DB_KEY)).rev, 2);
  off();
  s.commit(d => d);
  assert.equal(calls, 2);
});

test('a simulated storage event from another tab reloads state', () => {
  const be = memoryBackend();
  const tab1 = new Storage({ backend: be, seedFn: seed, clock });
  const tab2 = new Storage({ backend: be, seedFn: seed, clock });
  tab1.load(); tab2.load();
  let seen = null;
  tab2.subscribe(db => { seen = db; });
  tab1.commit(d => { d.school.address = 'Changed in tab 1'; });
  tab2.handleExternalChange(be.getItem(DB_KEY));
  assert.equal(tab2.db.school.address, 'Changed in tab 1');
  assert.equal(seen.rev, 1);
  // same rev again → no extra notification
  seen = null;
  tab2.handleExternalChange(be.getItem(DB_KEY));
  assert.equal(seen, null);
});

test('quota exceeded: the change is not applied, STORAGE_QUOTA surfaces, export still has the saved state', () => {
  const be = memoryBackend();
  const s = new Storage({ backend: be, seedFn: seed, clock });
  s.load();
  s.commit(d => { d.school.address = 'Saved'; });
  const realSet = be.setItem;
  be.setItem = () => { const e = new Error('full'); e.name = 'QuotaExceededError'; throw e; };
  assert.throws(() => s.commit(d => { d.school.address = 'Refused'; }), { code: 'STORAGE_QUOTA' });
  assert.equal(s.db.school.address, 'Saved');
  assert.equal(s.info().writeFailed, true);
  assert.equal(s.info().unsaved, false);
  assert.match(s.exportJson(), /Saved/);
  be.setItem = realSet;
  s.commit(d => { d.school.phone = '+91-90000-00998'; });
  const stored = JSON.parse(be.getItem(DB_KEY));
  assert.equal(stored.school.address, 'Saved');
  assert.equal(stored.school.phone, '+91-90000-00998');
  assert.equal(s.info().writeFailed, false);
});

test('export → reset → import restores state; import refuses garbage', () => {
  const be = memoryBackend();
  const s = new Storage({ backend: be, seedFn: seed, clock });
  s.load();
  s.commit(d => { d.school.address = 'Before export'; });
  const dump = s.exportJson();
  s.resetToSeed(ctx);
  assert.equal(s.db.school.address, '');
  const r = s.importJson(dump, ctx);
  assert.deepEqual(r.violations.filter(v => v.code === 'SHAPE'), []);
  assert.equal(s.db.school.address, 'Before export');
  assert.ok(s.db.rev > 2);
  assert.throws(() => s.importJson('not json', ctx), { code: 'VALIDATION' });
  assert.throws(() => s.importJson('{"schemaVersion":1,"rev":0}', ctx), { code: 'VALIDATION' });
});

test('api: corrupt storage rejects ready() with STORAGE_CORRUPT; reset works without a persona', async () => {
  const be = memoryBackend();
  be.setItem(DB_KEY, 'garbage');
  const api = createApi({ backend: be, sessionBackend: memoryBackend(), seedFn: seed, clock });
  await assert.rejects(api.ready(), { code: 'STORAGE_CORRUPT' });
  assert.equal((await api.admin.storageInfo()).status, 'corrupt');
  await api.admin.resetToSeed();
  await api.ready();
  assert.equal(api.getDb().school.name, 'Fixture School (Demo)');
  await assert.rejects(api.people.programs(), { code: 'NOT_ALLOWED' }); // no persona chosen yet
  api.session.set('persona-ADM');
  assert.deepEqual(await api.people.programs(), []);
});

// ---------------------------------------------------------------- schema v1 -> v2 (Phase 3)
const v1Blob = () => {
  const d = buildSeed(new Date(2026, 9, 2, 10, 0, 0));
  for (const c of ['presentations', 'observations', 'photos', 'progressEvents', 'reports', 'consents']) delete d[c];
  for (const st of d.students) delete st.leftOn;
  delete d.school.retention;
  d.diaryEntries.push({ id: 'dia-old', studentId: d.students[0].id, date: '2026-10-01', type: 'observation', data: { area: 'sensorial', text: 'Old' }, createdBy: 'x', createdAt: '2026-10-01T04:00:00.000Z', parentReadAt: null });
  d.schemaVersion = 1;
  return d;
};

test('DB_KEY is unchanged by the schema bump', () => assert.equal(DB_KEY, 'montessori.db.v2'));

test('a stored v1 document is migrated on load: new collections empty, leftOn null, retention not decided, nothing else changed', () => {
  const be = memoryBackend();
  const v1 = v1Blob();
  be.setItem(DB_KEY, JSON.stringify(v1));
  const s = new Storage({ backend: be, seedFn: seed, clock });
  assert.equal(s.load().status, 'ok');
  assert.equal(s.db.schemaVersion, SCHEMA_VERSION);
  assert.equal(SCHEMA_VERSION, 2);
  for (const c of ['presentations', 'observations', 'photos', 'progressEvents', 'reports', 'consents']) assert.deepEqual(s.db[c], [], c);
  assert.ok(s.db.students.every(x => x.leftOn === null));
  assert.deepEqual(Object.values(s.db.school.retention), [null, null, null, null, null]);
  assert.equal(s.db.diaryEntries.find(e => e.id === 'dia-old').data.text, 'Old', 'old diary observations are kept as they were');
  assert.deepEqual(validateDb(s.db), [], 'loads clean');
  assert.equal(s.db.invoices.length, v1.invoices.length, 'no row lost');
  assert.equal(JSON.parse(be.getItem(DB_KEY)).schemaVersion, 1, 'load itself does not rewrite the stored blob');
  s.commit(d => { d.school.phone = '+91-90000-00997'; });
  const after = JSON.parse(be.getItem(DB_KEY));
  assert.equal(after.schemaVersion, 2, 'the first commit stores v2');
  assert.deepEqual(after.observations, []);
});

test('a v1 backup imports (migrated); garbage v1 is still refused; migrate is idempotent and refuses unknown versions', () => {
  const be = memoryBackend();
  const s = new Storage({ backend: be, seedFn: seed, clock });
  s.load();
  const r = s.importJson(JSON.stringify(v1Blob()), ctx);
  assert.deepEqual(r.violations.filter(v => v.severity !== 'warning'), []);
  assert.equal(s.db.schemaVersion, 2);
  assert.throws(() => s.importJson('{"schemaVersion":1,"rev":0}', ctx), { code: 'VALIDATION' });
  assert.throws(() => s.importJson(JSON.stringify({ ...v1Blob(), school: 'x' }), ctx), { code: 'VALIDATION' });
  const twice = migrate(migrate(v1Blob()));
  assert.equal(twice.schemaVersion, 2);
  assert.throws(() => migrate({ schemaVersion: 7 }), { code: 'STORAGE_CORRUPT' });
  assert.throws(() => migrate({ schemaVersion: 0 }), { code: 'STORAGE_CORRUPT' });
});

test('validateDb: new references and states are checked', () => {
  const d = buildSeed(new Date(2026, 9, 2, 10, 0, 0));
  const bad = structuredClone(d);
  bad.observations[0].studentId = 'no-such';
  bad.observations[1].presentationId = 'no-such';
  bad.photos[0].observationId = 'no-such';
  bad.progressEvents[0].presentationId = 'no-such';
  bad.reports[0].academicYearId = 'AY1999-00';
  bad.reports[1].studentId = 'no-such';
  const refs = validateDb(bad).filter(v => v.code === 'BAD_REF').map(v => v.entity);
  for (const e of ['observation', 'photo', 'progressEvent', 'report']) assert.ok(refs.includes(e), e);
  const gap = structuredClone(d);
  gap.progressEvents.find(e => e.seq === 2).seq = 5;
  assert.ok(validateDb(gap).some(v => v.code === 'NUMBER_GAP'), 'seq must be contiguous per key');
  const dup = structuredClone(d);
  dup.reports.push({ ...dup.reports[0], id: 'rep-dup' });
  assert.ok(validateDb(dup).some(v => v.code === 'DUPLICATE_REPORT'));
  const pub = structuredClone(d);
  pub.reports.find(r => r.status === 'published').publishedBy = null;
  assert.ok(validateDb(pub).some(v => v.code === 'PUBLISHED_WITHOUT_STAMP'));
  const cross = structuredClone(d);
  cross.photos[0].studentId = cross.students.find(s => s.id !== cross.photos[0].studentId).id;
  assert.ok(validateDb(cross).some(v => v.code === 'CROSS_STUDENT'), 'one photo, one child');
  const ret = structuredClone(d);
  ret.school.retention.photosMonthsAfterLeaving = 0;
  assert.ok(validateDb(ret).some(v => v.code === 'BAD_SCHOOL'));
  const act = structuredClone(d);
  act.students[0].leftOn = '2026-07-01';
  assert.ok(validateDb(act).some(v => v.code === 'LEFT_ON_ACTIVE'));
  const solo = structuredClone(d);
  solo.photos[0].soloConfirmedBy = null;
  assert.ok(validateDb(solo).some(v => v.code === 'NOT_CONFIRMED_SOLO'));
  const shared = structuredClone(d);
  shared.observations.find(o => o.sharedAt).sharedBy = null;
  assert.ok(validateDb(shared).some(v => v.code === 'SHARED_WITHOUT_ACTOR'));
});
