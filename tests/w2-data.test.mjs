// Wave 2 data layer: domain, registry and demo api (both modes share the surface). Part A: the annual Progress Report
// (rubrics, evaluations, levels and their promotion, signatures, school settings, print data); later parts: the other
// wave-2 features. Fake data only (the demo seed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createApi } from '../src/api/index.js';
import { buildSeed } from '../src/seed/seed-data.js';
import { memoryBackend, migrate } from '../src/store/storage.js';
import { SCHEMA_VERSION, COLLECTIONS, V5_COLLECTIONS, V5_SCHOOL_KEYS } from '../src/store/schema.js';
import { execute, personaFor, ctxFor, consentScopedPersona, systemPersona, SLICES, COMMANDS } from '../src/domain/commands.js';
import { RUBRICS, SCALES, EVALUATION_LEVELS, CULTURAL_STUDIES_FOOTNOTE } from '../src/domain/evaluation-rubrics.js';
import * as EV from '../src/domain/evaluations.js';
import { attendanceSummary } from '../src/domain/attendance.js';
import { validateDb } from '../src/domain/validate.js';
import { retentionPlan, PURGEABLE, RETENTION_COVERAGE } from '../src/domain/retention.js';
import { guardianExport } from '../src/domain/export.js';
import { officeHoursStatus } from '../src/domain/school.js';
import { sniffMime, pngSize, fileProblem, cleanFileName } from '../src/domain/files.js';
import { todayISO, addDays } from '../src/domain/dates.js';
import * as I from '../src/domain/import-people.js';

const NOW = new Date();
const TODAY = todayISO(NOW);
const AY = 'AY2026-27', AY_PREV = 'AY2025-26';
const seed = () => buildSeed(NOW);
const P = (db, link) => personaFor(db, link);
const ADMIN = { role: 'admin', staffId: 'stf-principal' };
const TPA = { role: 'teacher', staffId: 'stf-teacher-pa' };
const TPB = { role: 'teacher', staffId: 'stf-teacher-pb' };
const ACCT = { role: 'accountant', staffId: 'stf-accountant' };
const parent = g => ({ role: 'parent', guardianId: g });
const run = (db, link, name, ...args) => { const p = P(db, link); return execute(name, db, args, { ...ctxFor(p, NOW.toISOString(), TODAY) }, p); };
const code = c => ({ code: c });
async function mkApi() {
  const api = createApi({ backend: memoryBackend(), sessionBackend: memoryBackend(), seedFn: seed, clock: () => NOW });
  await api.ready();
  return api;
}
// a 3 x 2 PNG (signature stand-in, generated: no image file committed)
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 3, 0, 0, 0, 2, 8, 6, 0, 0, 0, 0, 0, 0, 0]);

// ================================================================ A. the annual Progress Report

test('rubrics: the school\'s four forms, word for word (40 / 52 / 58 / 58 items), keys unique per level, two scales', () => {
  assert.deepEqual(EVALUATION_LEVELS, ['toddlers', 'mont1', 'mont2', 'mont3']);
  const n = l => RUBRICS[l].sections.reduce((a, s) => a + s.items.length, 0);
  assert.deepEqual(EVALUATION_LEVELS.map(n), [40, 52, 58, 58]);
  for (const l of EVALUATION_LEVELS) {
    const keys = RUBRICS[l].sections.flatMap(s => s.items.map(i => i.key));
    assert.equal(new Set(keys).size, keys.length, `${l}: keys unique`);
    for (const s of RUBRICS[l].sections) assert.ok(SCALES[s.scale], `${l} ${s.title}: known scale`);
  }
  assert.deepEqual(RUBRICS.toddlers.sections.map(s => s.title), ['Physical Development and Muscular Coordination', 'Independence', 'Logical Thinking', 'Sensorial',
    'Scholastic', 'Cultural Studies', 'Work Habits', 'Social and Emotional Development', 'Non-Scholastic Areas']);
  assert.equal(RUBRICS.mont1.title, 'MONT. - 1');
  assert.equal(RUBRICS.toddlers.sections[0].items[3].label, 'Ability to lift small objects');
  assert.equal(RUBRICS.toddlers.sections.at(-1).items.at(-1).label, 'Interest in listening to stories');
  assert.equal(CULTURAL_STUDIES_FOOTNOTE, '*Cultural Studies: This area of the curriculum includes subjects like science and geography.');
  // the module is the scratch JSON the school's templates were copied into, unchanged (when that copy is at hand)
  const json = process.env.W2_RUBRICS_JSON;
  if (json) assert.deepEqual(JSON.parse(JSON.stringify(RUBRICS)), JSON.parse(readFileSync(json, 'utf8')));
});

test('schema v5: migrate v4 → v5 adds evaluations and signatures empty and the school settings null; nothing else changes', () => {
  assert.equal(SCHEMA_VERSION, 5);
  for (const c of V5_COLLECTIONS) assert.ok(COLLECTIONS.includes(c));
  const v4 = seed();
  for (const c of V5_COLLECTIONS) delete v4[c];
  for (const k of V5_SCHOOL_KEYS) delete v4.school[k];
  v4.schemaVersion = 4;
  const before = JSON.stringify({ ...v4, schemaVersion: 5 });
  const m = migrate(structuredClone(v4));
  const { evaluations, signatures, ...rest } = m;
  assert.deepEqual([evaluations, signatures], [[], []]);
  for (const k of V5_SCHOOL_KEYS) { assert.equal(rest.school[k], null, k); delete rest.school[k]; }
  assert.equal(JSON.stringify(rest), before);
  assert.deepEqual(validateDb(seed()).filter(v => v.severity !== 'warning'), [], 'the v5 seed is valid');
});

test('evaluations: start needs a level and a visible child; one per child and year (deterministic id)', () => {
  const db = seed();
  assert.throws(() => run(db, TPA, 'evaluations.start', { studentId: 'stu-08', academicYearId: AY }), /level/, 'Zoya has no level');
  assert.throws(() => run(db, TPB, 'evaluations.start', { studentId: 'stu-06', academicYearId: AY }), code('NOT_ALLOWED'));
  assert.throws(() => run(db, ACCT, 'evaluations.start', { studentId: 'stu-06', academicYearId: AY }), code('NOT_ALLOWED'));
  const e = run(db, TPA, 'evaluations.start', { studentId: 'stu-06', academicYearId: AY });
  assert.equal(e.id, `evl-${AY}-stu-06`);
  assert.equal(e.level, 'mont1');
  assert.equal(e.status, 'draft');
  assert.equal(e.total, 52);
  assert.equal(e.missing, 52);
  assert.throws(() => run(db, TPA, 'evaluations.start', { studentId: 'stu-06', academicYearId: AY }), /already started/);
  // the level is frozen: changing the child's level later leaves the started form as it was
  run(db, ADMIN, 'people.updateStudent', { studentId: 'stu-06', level: 'mont2' });
  assert.equal(db.evaluations.find(x => x.id === e.id).level, 'mont1');
});

test('evaluations: startClass counts add up (children = started + already started + no level)', () => {
  const db = seed();
  const r = run(db, TPA, 'evaluations.startClass', { programId: 'prog-primary-a', academicYearId: AY });
  assert.equal(r.started + r.skippedExisting + r.skippedNoLevel, r.children);
  assert.deepEqual([r.children, r.started, r.skippedExisting, r.skippedNoLevel], [8, 5, 2, 1]);
  assert.deepEqual(r.skippedNoLevelIds, ['stu-08']);
  const again = run(db, TPA, 'evaluations.startClass', { programId: 'prog-primary-a', academicYearId: AY });
  assert.deepEqual([again.started, again.skippedExisting], [0, 7], 'repeating starts nothing new');
  assert.throws(() => run(db, TPA, 'evaluations.startClass', { programId: 'prog-primary-b', academicYearId: AY }), code('NOT_ALLOWED'));
});

test('evaluations: ratings on the section\'s scale only; unknown items refused; stale revision → CONFLICT', () => {
  const db = seed();
  const e = run(db, TPA, 'evaluations.start', { studentId: 'stu-06', academicYearId: AY });
  const items = EV.rubricItems('mont1');
  const pm = items.find(i => i.scale === 'Progressing/Mastered'), dd = items.find(i => i.scale === 'Developing/Developed');
  assert.throws(() => run(db, TPA, 'evaluations.save', e.id, { ratings: { [pm.key]: 'developed' }, revision: e.revision }), /rated Progressing or Mastered/);
  assert.throws(() => run(db, TPA, 'evaluations.save', e.id, { ratings: { Nope: 'mastered' }, revision: e.revision }), /Unknown item/);
  assert.throws(() => run(db, TPA, 'evaluations.save', e.id, { ratings: {} }), /revision/);
  const s1 = run(db, TPA, 'evaluations.save', e.id, { ratings: { [pm.key]: 'mastered', [dd.key]: 'developing' }, remarks: '  Fake remark.  ', revision: e.revision });
  assert.equal(s1.revision, e.revision + 1);
  assert.equal(s1.rated, 2);
  assert.equal(s1.remarks, 'Fake remark.');
  assert.throws(() => run(db, TPA, 'evaluations.save', e.id, { remarks: 'x', revision: e.revision }), code('CONFLICT'));
  const s2 = run(db, TPA, 'evaluations.save', e.id, { ratings: { [pm.key]: null }, revision: s1.revision });
  assert.equal(s2.rated, 1, 'null clears a rating');
});

test('evaluations: attendance comes from the register (attendanceSummary), refreshed on save; a teacher override needs a reason', () => {
  const db = seed();
  const e = run(db, TPA, 'evaluations.start', { studentId: 'stu-06', academicYearId: AY });
  const rows = db.attendance.filter(a => a.studentId === 'stu-06');
  const first = rows.map(a => a.date).sort()[0];
  const sum = attendanceSummary(db, 'stu-06', first, TODAY);
  assert.deepEqual([e.attendance.workingDays, e.attendance.present, e.attendance.source], [sum.workingDays, sum.present + sum.late, 'register']);
  assert.throws(() => run(db, TPA, 'evaluations.save', e.id, { attendance: { workingDays: 10, present: 9 }, revision: e.revision }), /reason/);
  assert.throws(() => run(db, TPA, 'evaluations.save', e.id, { attendance: { workingDays: 5, present: 9, reason: 'x' }, revision: e.revision }), /more than the working days/);
  const t = run(db, TPA, 'evaluations.save', e.id, { attendance: { workingDays: 180, present: 170, reason: 'Fake: joined from another branch' }, revision: e.revision });
  assert.deepEqual([t.attendance.workingDays, t.attendance.present, t.attendance.source, t.attendance.register.workingDays], [180, 170, 'teacher', sum.workingDays]);
  const back = run(db, TPA, 'evaluations.save', e.id, { attendance: 'register', revision: t.revision });
  assert.equal(back.attendance.source, 'register');
  // a register change shows on the next save while the figures are the register's
  const day = rows.find(a => a.status === 'present').date;
  run(db, TPA, 'attendance.mark', day, [{ studentId: 'stu-06', status: 'absent' }]);
  const after = run(db, TPA, 'evaluations.save', e.id, { remarks: 'x', revision: back.revision });
  assert.equal(after.attendance.present, back.attendance.present - 1);
});

test('evaluations: submit needs every item rated (missing listed); publish and unpublish are the principal\'s; a published one is frozen', () => {
  const db = seed();
  let e = run(db, TPA, 'evaluations.start', { studentId: 'stu-06', academicYearId: AY });
  const err = (() => { try { run(db, TPA, 'evaluations.submit', e.id); } catch (x) { return x; } })();
  assert.equal(err.code, 'VALIDATION');
  assert.equal(err.details.missing.length, 52);
  assert.deepEqual(Object.keys(err.details.missing[0]), ['key', 'label', 'section']);
  const all = Object.fromEntries(EV.rubricItems('mont1').map(i => [i.key, i.values[1]]));
  e = run(db, TPA, 'evaluations.save', e.id, { ratings: all, revision: e.revision });
  e = run(db, TPA, 'evaluations.submit', e.id, { revision: e.revision });
  assert.equal(e.status, 'submitted');
  assert.throws(() => run(db, TPA, 'evaluations.publish', e.id), code('NOT_ALLOWED'));
  e = run(db, ADMIN, 'evaluations.publish', e.id, { revision: e.revision });
  assert.equal(e.status, 'published');
  assert.deepEqual(e.signers, { teacherIds: ['stf-teacher-float', 'stf-teacher-pa'], centerHeadId: 'stf-principal' });
  assert.throws(() => run(db, TPA, 'evaluations.save', e.id, { remarks: 'x', revision: e.revision }), /published/);
  assert.throws(() => run(db, ADMIN, 'evaluations.unpublish', e.id, '  '), /reason/);
  const u = run(db, ADMIN, 'evaluations.unpublish', e.id, 'Fake: wrong attendance');
  assert.deepEqual([u.status, u.unpublishedReason, u.signers, u.revision], ['draft', 'Fake: wrong attendance', null, e.revision + 1]);
  assert.ok(db.auditLog.some(r => r.entity === 'evaluation' && r.action === 'unpublish' && !/wrong attendance/.test(r.summary)), 'audit names no reason text');
});

test('evaluations: parents see only published reports of their own children (either guardian); the accountant sees none', async () => {
  const api = await mkApi();
  api.session.set('persona-stf-teacher-pa');
  let e = await api.evaluations.start({ studentId: 'stu-16', academicYearId: AY }); // Rohan: two guardians
  const all = Object.fromEntries(EV.rubricItems(e.level).map(i => [i.key, i.values[0]]));
  e = await api.evaluations.save(e.id, { ratings: all, revision: e.revision });
  await api.evaluations.submit(e.id);
  const db = api.getDb();
  const [g1, g2] = db.students.find(s => s.id === 'stu-16').guardianIds;
  assert.ok(g1 && g2, 'two guardians');
  api.session.set(`persona-${g1}`);
  assert.deepEqual(await api.evaluations.list({}), [], 'a submitted report is not the family\'s yet');
  await assert.rejects(api.evaluations.get(e.id), code('NOT_ALLOWED'));
  await assert.rejects(api.evaluations.printData(e.id), code('NOT_ALLOWED'));
  api.session.set('persona-stf-principal');
  await api.evaluations.publish(e.id);
  for (const g of [g1, g2]) {
    api.session.set(`persona-${g}`);
    assert.deepEqual((await api.evaluations.list({})).map(x => x.id), [e.id], `guardian ${g}`);
  }
  api.session.set('persona-grd-01');
  assert.ok(!(await api.evaluations.list({})).some(x => x.id === e.id), 'another family');
  await assert.rejects(api.evaluations.get(e.id), code('NOT_ALLOWED'));
  api.session.set('persona-stf-accountant');
  await assert.rejects(api.evaluations.list({}), code('NOT_ALLOWED'));
});

test('evaluations: the class list shows each child\'s status; print data has the footer from settings and the signature images', async () => {
  const api = await mkApi();
  api.session.set('persona-stf-teacher-pa');
  const cs = await api.evaluations.classStatus({ programId: 'prog-primary-a', academicYearId: AY });
  assert.equal(cs.length, 8);
  assert.deepEqual(cs.find(r => r.studentId === 'stu-04'), { studentId: 'stu-04', name: 'Ira Demoson', level: 'mont2', levelLabel: 'Mont 2', evaluationId: `evl-${AY}-stu-04`, status: 'draft', missing: 38, revision: 2 });
  assert.equal(cs.find(r => r.studentId === 'stu-08').status, 'not_started');
  api.session.set('persona-grd-01');
  const pd = await api.evaluations.printData(`evl-${AY_PREV}-stu-01`);
  assert.deepEqual(pd.header, { levelTitle: 'TODDLERS', title: 'PROGRESS REPORT', year: '2025-26', name: 'Neel Notrealsen', dob: '2023-04-30', admissionNo: 'ADM-26-001' });
  assert.equal(pd.school.footer.email, 'office@example.com');
  assert.deepEqual(pd.school.footer.phones, ['+91-90000-00001', '+91-90000-00002']);
  assert.equal(pd.school.directorName, 'Asha Exampleton');
  assert.deepEqual(pd.signers.map(s => s.role), ['teacher', 'teacher', 'centerHead', 'director']);
  assert.ok(pd.signers.every(s => s.blob instanceof Blob && s.blob.type === 'image/svg+xml'), 'drawn demo signatures');
  assert.equal(pd.sections.reduce((n, s) => n + s.items.length, 0), 40);
  assert.ok(pd.sections.every(s => s.items.every(i => i.rating)));
  assert.equal(pd.footnote, CULTURAL_STUDIES_FOOTNOTE);
  assert.equal(pd.draft, false);
});

test('signatures: a teacher manages only their own; the principal anyone and the director; replacing keeps one current', async () => {
  const api = await mkApi();
  const png = new Blob([PNG], { type: 'image/png' });
  api.session.set('persona-stf-teacher-pb');
  assert.deepEqual((await api.signatures.list()).map(r => [r.owner.staffId, r.signature]), [['stf-teacher-pb', null]]);
  await assert.rejects(api.signatures.upload({ kind: 'staff', staffId: 'stf-teacher-pa' }, png), code('NOT_ALLOWED'));
  await assert.rejects(api.signatures.upload({ kind: 'director' }, png), code('NOT_ALLOWED'));
  await assert.rejects(api.signatures.upload({ kind: 'staff', staffId: 'stf-teacher-pb' }, new Blob(['%PDF-1.4 fake'], { type: 'application/pdf' })), /PNG, JPG/);
  const r = await api.signatures.upload({ kind: 'staff', staffId: 'stf-teacher-pb' }, png);
  assert.deepEqual([r.signature.staffId, r.signature.mime, r.signature.width, r.signature.height, r.replaced], ['stf-teacher-pb', 'image/png', 3, 2, null]);
  assert.equal((await api.signatures.blob(r.signature.id)).size, PNG.length);
  api.session.set('persona-stf-principal');
  const list = await api.signatures.list();
  assert.ok(list.some(x => x.owner.kind === 'director' && x.signature), 'the director is listed for the principal');
  const r2 = await api.signatures.upload({ kind: 'staff', staffId: 'stf-teacher-pb' }, png);
  assert.equal(r2.replaced, r.signature.id);
  assert.equal(api.getDb().signatures.filter(x => x.staffId === 'stf-teacher-pb' && x.status === 'ready').length, 1);
  assert.ok(api.getDb().signatures.find(x => x.id === r.signature.id).objectDeletedAt, 'the replaced image is gone');
  await api.signatures.remove({ kind: 'staff', staffId: 'stf-teacher-pb' });
  const db = api.getDb();
  assert.equal(db.signatures.filter(x => x.staffId === 'stf-teacher-pb' && x.status === 'ready').length, 0);
  api.session.set('persona-grd-01');
  await assert.rejects(api.signatures.list(), code('NOT_ALLOWED'));
  await assert.rejects(api.signatures.blob('sig-demo-stf-teacher-pa'), code('NOT_ALLOWED'));
  assert.ok(db.auditLog.filter(x => x.entity === 'signature').length >= 3);
});

test('files: magic bytes decide the type; PNG size; limits per kind; display names are cleaned', () => {
  assert.equal(sniffMime(PNG), 'image/png');
  assert.equal(sniffMime(new TextEncoder().encode('%PDF-1.7 fake body')), 'application/pdf');
  assert.equal(sniffMime(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])), 'image/jpeg');
  assert.equal(sniffMime(new TextEncoder().encode('<svg xmlns=…>')), null);
  assert.deepEqual(pngSize(PNG), { width: 3, height: 2 });
  const rules = { mimes: ['image/png'], maxBytes: 100, maxEdge: 2 };
  assert.equal(fileProblem({ mime: 'image/png', bytes: 50, width: 2, height: 2 }, rules), null);
  assert.match(fileProblem({ mime: 'image/png', bytes: 500 }, rules), /larger than 100 KB|larger than 0 KB|larger than/);
  assert.match(fileProblem({ mime: 'image/png', bytes: 50, width: 3, height: 2 }, rules), /2 px/);
  assert.match(fileProblem({ mime: 'image/jpeg', bytes: 50, hasExif: true }, { mimes: ['image/jpeg'], maxBytes: 100 }), /EXIF/);
  assert.equal(cleanFileName('C:\\fake\\path\\Circular\u0007.pdf', 'application/pdf'), 'Circular.pdf');
  assert.equal(cleanFileName('', 'image/png'), 'file.png');
});

test('levels: the principal sets them (validated); the import takes an optional level column; promotion once per year with skips', () => {
  const db = seed();
  assert.throws(() => run(db, ADMIN, 'people.updateStudent', { studentId: 'stu-08', level: 'mont9' }), /Unknown level/);
  assert.throws(() => run(db, TPA, 'people.updateStudent', { studentId: 'stu-08', level: 'mont1' }), code('NOT_ALLOWED'));
  const s = run(db, ADMIN, 'people.updateStudent', { studentId: 'stu-08', level: 'mont1' });
  assert.deepEqual([s.level, s.levelAy], ['mont1', AY]);
  // import: level column
  const mapping = { admissionNo: 'Adm', firstName: 'First', lastName: 'Last', dob: 'DOB', program: 'Class', guardian1Name: 'Parent', guardian1Phone: 'Phone', level: 'Level' };
  assert.equal(I.suggestMapping('children', ['Level']).level, 'Level');
  const rows = [
    { line: 2, values: { Adm: 'ADM-W2-1', First: 'Kiran', Last: 'Demoson', DOB: '01/03/2022', Class: 'Primary A', Parent: 'Uma Demoson', Phone: '9000000351', Level: 'Mont. 2' } },
    { line: 3, values: { Adm: 'ADM-W2-2', First: 'Lata', Last: 'Demoson', DOB: '01/03/2022', Class: 'Primary A', Parent: 'Uma Demoson', Phone: '9000000351', Level: 'Grade 7' } },
  ];
  const v = I.validateRows(db, { kind: 'children', mapping, rows }, { today: TODAY, batchId: 'b' });
  assert.equal(v.rows[0].status, 'ok');
  assert.equal(v.rows[1].status, 'quarantined');
  assert.match(v.rows[1].reason, /unknown level/);
  // promotion
  const plan = EV.promotionPlan(db, 'AY2026-27');
  assert.equal(plan.already, plan.children - plan.noLevel, 'every level was set for the current year');
  db.academicYears.push({ id: 'AY2027-28', label: 'AY 2027-28', startDate: '2027-06-01', endDate: '2028-05-31' });
  const pre = EV.promotionPlan(db, 'AY2027-28');
  assert.equal(pre.promote + pre.final + pre.noLevel + pre.already, pre.children);
  const kept = pre.rows.find(r => r.outcome === 'promote');
  const res = run(db, ADMIN, 'people.promoteLevels', { toAcademicYearId: 'AY2027-28', skip: [kept.studentId] });
  assert.equal(res.promoted + res.skipped + res.final + res.noLevel + res.already, res.children);
  assert.deepEqual([res.promoted, res.skipped, res.final], [pre.promote - 1, 1, pre.final]);
  assert.equal(db.students.find(x => x.id === kept.studentId).level, kept.from, 'a skipped child keeps their level');
  const toddler = pre.rows.find(r => r.from === 'toddlers' && r.outcome === 'promote' && r.studentId !== kept.studentId);
  assert.equal(db.students.find(x => x.id === toddler.studentId).level, 'mont1');
  const again = run(db, ADMIN, 'people.promoteLevels', { toAcademicYearId: 'AY2027-28' });
  assert.deepEqual([again.promoted, again.already], [0, pre.children - pre.noLevel], 'running it again changes nothing');
  assert.throws(() => run(db, TPA, 'people.promoteLevels', { toAcademicYearId: 'AY2027-28' }), code('NOT_ALLOWED'));
});

test('school settings: the principal sets the report footer, director, privacy contact, office hours and UPI; each validated; audit names fields only', async () => {
  const db = seed();
  assert.throws(() => run(db, TPA, 'admin.setSchoolDetails', { directorName: 'x' }), code('NOT_ALLOWED'));
  assert.throws(() => run(db, ADMIN, 'admin.setSchoolDetails', { privacyContact: { name: 'Fake Exampleton', role: 'Office', email: 'not-an-email' } }), /valid email/);
  assert.throws(() => run(db, ADMIN, 'admin.setSchoolDetails', { officeHours: { start: '17:00', end: '08:00', days: [1] } }), /end after the start/);
  assert.throws(() => run(db, ADMIN, 'admin.setSchoolDetails', { upi: { vpa: 'nope', payeeName: 'x' } }), /UPI ID/);
  assert.throws(() => run(db, ADMIN, 'admin.setSchoolDetails', { colour: 'red' }), /Unknown setting/);
  assert.throws(() => run(db, ADMIN, 'admin.setSchoolDetails', { reportFooter: { address: 'x', phones: ['1', '2', '3', '4'] } }), /three/);
  const r = run(db, ADMIN, 'admin.setSchoolDetails', { privacyContact: { name: 'Fake Exampleton', role: 'Office manager', email: 'Privacy@Example.com' },
    officeHours: { start: '08:30', end: '16:00', days: [5, 1, 2, 3, 4] }, upi: { vpa: 'demo.school@examplebank', payeeName: 'Kinfolk Montessori School (Demo)' } });
  assert.equal(r.privacyContact.email, 'privacy@example.com');
  assert.deepEqual(r.officeHours.days, [1, 2, 3, 4, 5]);
  const a = db.auditLog.at(-1);
  assert.equal(a.summary, 'changed: privacyContact, officeHours, upi');
  run(db, ADMIN, 'admin.setSchoolDetails', { privacyContact: null });
  assert.equal(db.school.privacyContact, null);
  // office hours at a fixed moment (IST): Monday 10:00 open; Monday 18:00 closed until Tuesday 08:30; Saturday → Monday
  const school = db.school;
  assert.equal(officeHoursStatus(school, '2026-10-26T04:30:00.000Z').open, true);
  assert.deepEqual(officeHoursStatus(school, '2026-10-26T12:30:00.000Z').nextOpen, { day: 2, time: '08:30', inDays: 1 });
  assert.deepEqual(officeHoursStatus(school, '2026-10-24T06:00:00.000Z').nextOpen, { day: 1, time: '08:30', inDays: 2 });
  assert.equal(officeHoursStatus({}, '2026-10-24T06:00:00.000Z').set, false);
});

test('evaluations under retention (diary period) and in the family export (parents: published only)', () => {
  const db = seed();
  assert.ok(PURGEABLE.includes('evaluations'));
  assert.equal(RETENTION_COVERAGE.evaluations, 'diary');
  assert.match(RETENTION_COVERAGE.signatures, /^kept/);
  const neel = db.students.find(s => s.id === 'stu-01');
  Object.assign(neel, { status: 'left', leftOn: addDays(TODAY, -400) });
  db.school.retention.diaryMonthsAfterLeaving = 12;
  const plan = retentionPlan(db, TODAY);
  assert.deepEqual(plan.categories.diary.deletes.evaluations, [`evl-${AY_PREV}-stu-01`]);
  const db2 = seed();
  const parentView = guardianExport(db2, 'grd-02', { full: false });
  assert.deepEqual(parentView.progressReports, [], 'Ira\'s draft is not in the parent\'s own export');
  assert.deepEqual(guardianExport(db2, 'grd-02', { full: true }).progressReports.map(e => e.id), [`evl-${AY}-stu-04`]);
  assert.deepEqual(guardianExport(db2, 'grd-01', { full: false }).progressReports.map(e => e.id), [`evl-${AY_PREV}-stu-01`]);
  assert.ok(SLICES.export.reads.includes('evaluations') && SLICES.retention.reads.includes('evaluations') && SLICES.retention.writes.includes('evaluations'));
});

test('the server-only commands of part A are never run by the demo; the file is the server\'s word, not the client\'s', async () => {
  const api = await mkApi();
  for (const n of ['evaluations.signatures', 'signatures.uploadCheck', 'signatures.viewUrl']) assert.equal(COMMANDS[n].serverOnly, true, n);
  const db = seed();
  const p = P(db, ADMIN);
  assert.throws(() => execute('signatures.upload', db, [{ owner: { kind: 'director' } }], ctxFor(p, NOW.toISOString(), TODAY), p), /did not arrive/, 'no fileInfo from the client');
  assert.throws(() => execute('signatures.finishDelete', db, [{ signatureIds: [] }], ctxFor(p, NOW.toISOString(), TODAY), p), code('NOT_ALLOWED'));
  const sys = systemPersona('t');
  assert.deepEqual(execute('signatures.finishDelete', db, [{ signatureIds: ['sig-demo-director'] }], { actor: { role: 'system', id: 't' }, now: NOW.toISOString(), today: TODAY }, sys), { finished: 0 }, 'only removed rows finish');
  api.session.set('persona-grd-01');
  assert.equal(typeof (await api.school.details()).directorName, 'string');
});

test('the evaluations parent scope follows consent like every parent read (server persona)', () => {
  const db = seed();
  const p = consentScopedPersona(db, P(db, parent('grd-01')), []);
  assert.deepEqual(p.studentIds, []);
  assert.throws(() => EV.getEvaluation(db, p, `evl-${AY_PREV}-stu-01`), code('NOT_ALLOWED'));
});

// ================================================================ B. other wave-2 features

test('#78 health: a parent or the principal sets allergies and medical alerts (audited, field names only); teachers read the badge list; driver and accountant never', async () => {
  const api = await mkApi();
  api.session.set('persona-grd-02');
  const h = await api.health.set({ studentId: 'stu-04', allergies: 'Fake: egg', medical: '' });
  assert.deepEqual([h.allergies, h.medical, h.updatedByRole], ['Fake: egg', '', 'parent']);
  await assert.rejects(api.health.set({ studentId: 'stu-01', allergies: 'x' }), code('NOT_ALLOWED'), 'another family\'s child');
  assert.equal((await api.health.get('stu-04')).allergies, 'Fake: egg');
  const a = api.getDb().auditLog.at(-1);
  assert.equal(a.summary, 'allergies changed by a parent');
  assert.ok(!JSON.stringify(api.getDb().auditLog).includes('Fake: egg'), 'the text is never in the audit log');
  api.session.set('persona-stf-teacher-pa');
  await assert.rejects(api.health.set({ studentId: 'stu-04', allergies: 'x' }), code('NOT_ALLOWED'));
  const list = await api.health.alerts('prog-primary-a');
  assert.deepEqual(list.map(x => x.studentId).sort(), ['stu-04', 'stu-17'], 'Ira (new) and Tara (seed)');
  await assert.rejects(api.health.alerts('prog-toddler'), code('NOT_ALLOWED'));
  api.session.set('persona-stf-principal');
  assert.ok((await api.health.alerts()).some(x => x.studentId === 'stu-10'), 'Diya (seed) for the principal');
  const cleared = await api.health.set({ studentId: 'stu-04', allergies: '', notes: 'Fake note' });
  assert.deepEqual([cleared.allergies, cleared.notes], ['', 'Fake note']);
  assert.equal(api.getDb().students.find(s => s.id === 'stu-04').healthAlerts, null, 'no alerts left: null');
  for (const who of ['persona-stf-driver-1', 'persona-stf-accountant']) {
    api.session.set(who);
    const kids = await api.people.students({});
    assert.ok(kids.every(s => s.healthAlerts === null), `${who}: no alerts`);
  }
});

test('#8 #68 the driver: dates of reported absences on their route (never the reason), the pick-up people, and who received a child at a drop', async () => {
  const api = await mkApi();
  const db0 = api.getDb();
  const neelLeave = db0.leaveRequests.find(r => r.studentId === 'stu-01');
  api.session.set('persona-stf-driver-1');
  const abs = await api.transport.absences('route-1', neelLeave.fromDate);
  assert.deepEqual(abs, [{ studentId: 'stu-01', fromDate: neelLeave.fromDate, toDate: neelLeave.toDate }]);
  assert.ok(!JSON.stringify(abs).includes('Family function'), 'no reason');
  await assert.rejects(api.transport.absences('route-2'), code('NOT_ALLOWED'));
  const rec = await api.transport.receivers('route-1');
  assert.deepEqual(rec['stu-01'].map(c => c.name), ['Sarla Notrealsen']);
  assert.ok(!('stu-09' in rec), 'only this route\'s children');
  const trip = await api.transport.startTrip({ routeId: 'route-1', direction: 'drop', simulated: true });
  const grandma = rec['stu-01'][0];
  const e1 = await api.transport.markChild(trip.id, { studentId: 'stu-01', type: 'dropped', receivedBy: { kind: 'contact', id: grandma.id } });
  assert.deepEqual(e1.receivedBy, { kind: 'contact', contactId: grandma.id });
  const e2 = await api.transport.markChild(trip.id, { studentId: 'stu-03', type: 'dropped', receivedBy: { kind: 'other', name: 'Fake Neighbour Demoson' } });
  assert.deepEqual(e2.receivedBy, { kind: 'other', name: 'Fake Neighbour Demoson' });
  await assert.rejects(api.transport.markChild(trip.id, { studentId: 'stu-03', type: 'dropped', receivedBy: { kind: 'contact', id: grandma.id } }), /not on this child's pick-up list/);
  await assert.rejects(api.transport.markChild(trip.id, { studentId: 'stu-13', type: 'boarded', receivedBy: { kind: 'guardian' } }), /Only a drop/);
  const e3 = await api.transport.markChild(trip.id, { studentId: 'stu-13', type: 'dropped' });
  assert.equal(e3.receivedBy, undefined, 'optional (an older driver screen sends none)');
});

test('#21 diary.removeMany and #29 progress.recordMany: all or none', async () => {
  const api = await mkApi();
  api.session.set('persona-stf-teacher-pa');
  const kids = ['stu-01', 'stu-04', 'stu-06'];
  const r = await api.diary.addMany({ programId: 'prog-primary-a', date: TODAY, studentIds: kids, type: 'activity', data: { text: 'Fake: songs' } });
  const ids = r.entries.map(e => e.id);
  api.session.set('persona-stf-principal');
  const other = await api.diary.add({ studentId: 'stu-01', date: TODAY, type: 'activity', data: { text: 'Fake: principal wrote this' } });
  api.session.set('persona-stf-teacher-pa');
  await assert.rejects(api.diary.removeMany([...ids, other.id]), code('NOT_ALLOWED'), "another person's entry");
  assert.equal(api.getDb().diaryEntries.filter(e => ids.includes(e.id)).length, 3, 'nothing removed');
  assert.deepEqual((await api.diary.removeMany(ids)).removed, 3);
  assert.equal(api.getDb().diaryEntries.filter(e => ids.includes(e.id)).length, 0);
  api.session.set('persona-stf-teacher-pb');
  await assert.rejects(api.diary.removeMany([other.id]), code('NOT_ALLOWED'));
  api.session.set('persona-stf-teacher-pa');
  const pres = api.getDb().presentations.find(p => p.active && p.area === 'math' && !api.getDb().progressEvents.some(e => e.presentationId === p.id));
  const entries = ['stu-06', 'stu-09'].map(studentId => ({ studentId, presentationId: pres.id, status: 'introduced', date: TODAY }));
  const before = api.getDb().progressEvents.length;
  await assert.rejects(api.progress.recordMany({ entries: [...entries, { studentId: 'stu-06', presentationId: pres.id, status: 'introduced', date: TODAY }] }), /already introduced/);
  assert.equal(api.getDb().progressEvents.length, before, 'nothing recorded');
  assert.equal((await api.progress.recordMany({ entries })).recorded, 2);
  assert.equal(api.getDb().progressEvents.length, before + 2);
  await assert.rejects(api.progress.recordMany({ entries: [{ studentId: 'stu-02', presentationId: pres.id, status: 'introduced', date: TODAY }] }), code('NOT_ALLOWED'));
  assert.equal(COMMANDS['diary.removeMany'].load([ids]).diaryEntryIds.length, 3);
  assert.deepEqual(COMMANDS['progress.recordMany'].load([{ entries }]).learningStudentIds, ['stu-06', 'stu-09']);
});
