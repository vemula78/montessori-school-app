// Administration module, domain side: the two-step rule, accounts (block/unblock/email), the data-rights desk, the
// announcement, guardian corrections, who-can-see and the permission matrix (JS half; the SQL half is the generated
// supabase/tests/permissions.test.sql). Fake seed data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSeed } from '../src/seed/seed-data.js';
import { COMMANDS, SLICES, execute, personaFor, buildPersonas, consentScopedPersona, sees, systemPersona, guardSlices, CONSENT_VERSION } from '../src/domain/commands.js';
import { twoStepRequired, whoCanSee, listDataRequests, activeAnnouncement, ANNOUNCEMENT_MAX } from '../src/domain/admin.js';
import { PERMISSIONS, MATRIX_ACTORS, evaluateJs, withFixture, FIXTURE } from '../src/domain/permissions.js';
import { migrate } from '../src/store/storage.js';
import { SCHEMA_VERSION, COLLECTIONS } from '../src/store/schema.js';
import { validateDb } from '../src/domain/validate.js';
import { linkChanges } from '../scripts/seed-sql.mjs';

const NOW = new Date(Date.UTC(2026, 9, 2, 5, 0, 0));
const TODAY = '2026-10-02';
const ctx = (actor, today = TODAY) => ({ actor, now: `${today}T05:00:00.000Z`, today });
const seed = () => buildSeed(NOW);
const ADMIN = { role: 'admin', id: 'stf-principal' };
const admin = db => personaFor(db, { role: 'admin', staffId: 'stf-principal' });
const parent = (db, gid = 'grd-02') => personaFor(db, { role: 'parent', guardianId: gid });
const U = n => `00000000-0000-4000-8000-00000000000${n}`;
const withAccounts = db => Object.assign(db, { appUsers: [
  { id: U(1), role: 'admin', staffId: 'stf-principal', guardianId: null, status: 'active' },
  { id: U(3), role: 'accountant', staffId: 'stf-accountant', guardianId: null, status: 'active' },
  { id: U(6), role: 'parent', staffId: null, guardianId: 'grd-02', status: 'active' },
], invites: [], erasureRequests: [], importBatches: [], importRows: [] });
const run = (db, name, args, actor = ADMIN, p = admin(db)) => execute(name, db, args, ctx(actor), p);

// ---------------------------------------------------------------- the two-step rule
test('twoStepRequired: privileged roles only; enrolled or policy; aal2 always passes (truth table)', () => {
  for (const role of ['admin', 'accountant', 'teacher', 'driver', 'parent']) {
    for (const aal of [null, 'aal1', 'aal2']) {
      for (const enrolled of [false, true]) {
        for (const policyRequired of [false, true]) {
          const want = aal !== 'aal2' && ['admin', 'accountant'].includes(role) && (enrolled || policyRequired);
          assert.equal(twoStepRequired({ role, aal, enrolled, policyRequired }), want, JSON.stringify({ role, aal, enrolled, policyRequired }));
        }
      }
    }
  }
  assert.equal(twoStepRequired({ role: 'admin', aal: 'aal1', enrolled: 'yes' }), false, 'only a real boolean counts (no truthy strings)');
});

// ---------------------------------------------------------------- accounts
test('admin.blockUser: never yourself, never the last active principal; block → unblock round trip, audited', () => {
  const db = withAccounts(seed());
  assert.throws(() => run(db, 'admin.blockUser', [U(1)]), { code: 'VALIDATION', message: /own account/ });
  // a second principal: with two active principals one may block the other
  db.staff.push({ id: 'stf-principal-2', firstName: 'Second', lastName: 'Demoson', role: 'admin', programIds: [], phone: '+91-90000-00199', email: 'principal2@example.com' });
  db.appUsers.push({ id: U(9), role: 'admin', staffId: 'stf-principal-2', guardianId: null, status: 'active' });
  const p2 = personaFor(db, { role: 'admin', staffId: 'stf-principal-2' });
  assert.deepEqual(execute('admin.blockUser', db, [U(1)], ctx({ role: 'admin', id: 'stf-principal-2' }), p2), { userId: U(1), status: 'blocked' });
  // the remaining one is the last active principal account: refused, whoever asks
  db.appUsers.find(u => u.id === U(1)).status = 'revoked';
  assert.throws(() => run(db, 'admin.blockUser', [U(9)]), { code: 'VALIDATION', message: /last active principal/ });
  db.appUsers.find(u => u.id === U(1)).status = 'active';
  const b = run(db, 'admin.blockUser', [U(6)]);
  assert.deepEqual(b, { userId: U(6), status: 'blocked' });
  assert.deepEqual(run(db, 'admin.blockUser', [U(6)]), b, 'blocking twice is a no-op');
  assert.deepEqual(run(db, 'admin.unblockUser', [U(6)]), { userId: U(6), status: 'active' });
  db.appUsers.find(u => u.id === U(6)).status = 'revoked';
  assert.throws(() => run(db, 'admin.blockUser', [U(6)]), { code: 'VALIDATION', message: /revoked/ });
  assert.throws(() => run(db, 'admin.unblockUser', [U(6)]), { code: 'VALIDATION', message: /not blocked/ });
  assert.throws(() => run(db, 'admin.blockUser', [U(6)], { role: 'accountant', id: 'stf-accountant' }, personaFor(db, { role: 'accountant', staffId: 'stf-accountant' })), { code: 'NOT_ALLOWED' });
  assert.equal(db.auditLog.filter(r => r.entity === 'appUser' && ['block', 'unblock'].includes(r.action)).length, 3);
  for (const n of ['admin.blockUser', 'admin.unblockUser', 'admin.changeSignInEmail', 'admin.noteAccountAction']) {
    assert.equal(COMMANDS[n].serverOnly, true, `${n} is server only`);
    assert.equal(COMMANDS[n].slice, 'account');
  }
});

test('admin.changeSignInEmail: changes the person record; refuses an address another person uses (case-insensitive)', () => {
  const db = withAccounts(seed());
  const other = db.guardians.find(g => g.id === 'grd-05').email;
  assert.throws(() => run(db, 'admin.changeSignInEmail', [{ userId: U(6), email: other.toUpperCase() }]), { code: 'VALIDATION', message: /already uses/ });
  assert.throws(() => run(db, 'admin.changeSignInEmail', [{ userId: U(6), email: 'teacher-pa@example.com' }]), { code: 'VALIDATION' });
  assert.throws(() => run(db, 'admin.changeSignInEmail', [{ userId: U(6), email: 'not-an-email' }]), { code: 'VALIDATION' });
  assert.deepEqual(run(db, 'admin.changeSignInEmail', [{ userId: U(6), email: 'New.Address@Example.com' }]), { userId: U(6), email: 'new.address@example.com' });
  assert.equal(db.guardians.find(g => g.id === 'grd-02').email, 'new.address@example.com');
  run(db, 'admin.changeSignInEmail', [{ userId: U(3), email: 'office-accounts@example.com' }]);
  assert.equal(db.staff.find(s => s.id === 'stf-accountant').email, 'office-accounts@example.com');
  assert.ok(!db.auditLog.some(r => /new\.address|office-accounts/.test(r.summary)), 'no email address in the audit log');
  assert.ok(SLICES.account.writes.includes('staff'), 'the account slice may write the staff sign-in email');
});

test('admin.noteAccountAction: system only (never callable by a signed-in principal), attributed to the principal, no personal data', () => {
  const db = withAccounts(seed());
  assert.throws(() => run(db, 'admin.noteAccountAction', [{ userId: U(6), action: 'signOutEverywhere', outcome: 'ok', by: 'stf-principal' }]), { code: 'NOT_ALLOWED' });
  const r = execute('admin.noteAccountAction', db, [{ userId: U(6), action: 'signOutEverywhere', outcome: 'ok', detail: 'sessions=2 <b>x@y.z</b>', by: 'stf-principal' }], ctx({ role: 'system', id: 'admin-accounts' }), systemPersona('admin-accounts'));
  const row = db.auditLog.find(x => x.id === r.id);
  assert.equal(row.actorRole, 'admin'); assert.equal(row.actorId, 'stf-principal'); assert.equal(row.entityId, U(6));
  assert.doesNotMatch(row.summary, /[<>@]/);
  assert.throws(() => execute('admin.noteAccountAction', db, [{ action: 'deleteEverything', outcome: 'ok', by: 'x' }], ctx({ role: 'system', id: 'a' }), systemPersona('a')), { code: 'VALIDATION' });
});

// ---------------------------------------------------------------- data-rights desk
test('rights.file: a parent files about own data (before consent too); a second open request of the same kind is refused', () => {
  const db = seed();
  const p = parent(db);
  const pc = ctx({ role: 'parent', id: 'grd-02' });
  assert.equal(COMMANDS['rights.file'].beforeConsent, true);
  const r = execute('rights.file', db, [{ kind: 'correction', details: 'Fake: my phone changed.' }], pc, p);
  assert.equal(r.status, 'open'); assert.equal(r.guardianId, 'grd-02'); assert.equal(typeof r.guardianName, 'string');
  assert.throws(() => execute('rights.file', db, [{ kind: 'correction', details: 'again' }], pc, p), { code: 'VALIDATION', message: /already have an open/ });
  assert.equal(execute('rights.file', db, [{ kind: 'export' }], pc, p).kind, 'export', 'another kind is fine');
  assert.throws(() => execute('rights.file', db, [{ kind: 'correction' }], ctx({ role: 'parent', id: 'grd-01' }), parent(db, 'grd-01')), { code: 'VALIDATION', message: /required/ }, 'a correction says what to correct');
  assert.throws(() => execute('rights.file', db, [{ kind: 'other' }], pc, p), { code: 'VALIDATION' });
  assert.throws(() => run(db, 'rights.file', [{ kind: 'export' }]), { code: 'NOT_ALLOWED' }, 'staff do not file for families');
  assert.equal(listDataRequests(db, p).length, 2);
  assert.equal(listDataRequests(db, parent(db, 'grd-01')).length, 0, "another family's requests are not listed");
  assert.equal(listDataRequests(db, admin(db)).length, 2);
  assert.throws(() => listDataRequests(db, personaFor(db, { role: 'teacher', staffId: 'stf-teacher-pa' })), { code: 'NOT_ALLOWED' });
});

test('rights.update: the principal only; closing needs a resolution and is final', () => {
  const db = seed();
  const r = execute('rights.file', db, [{ kind: 'export' }], ctx({ role: 'parent', id: 'grd-02' }), parent(db));
  assert.throws(() => execute('rights.update', db, [r.id, { status: 'done', resolution: 'x' }], ctx({ role: 'parent', id: 'grd-02' }), parent(db)), { code: 'NOT_ALLOWED' });
  assert.equal(run(db, 'rights.update', [r.id, { status: 'in_progress' }]).status, 'in_progress');
  assert.throws(() => run(db, 'rights.update', [r.id, { status: 'done' }]), { code: 'VALIDATION', message: /resolution/ });
  const done = run(db, 'rights.update', [r.id, { status: 'declined', resolution: 'Fee records must be kept for 8 years (fake).' }]);
  assert.equal(done.decidedBy, 'stf-principal');
  assert.throws(() => run(db, 'rights.update', [r.id, { status: 'open' }]), { code: 'VALIDATION', message: /final/ });
  assert.throws(() => run(db, 'rights.update', ['drq-none', { status: 'done', resolution: 'x' }]), { code: 'NOT_FOUND' });
  assert.deepEqual(validateDb(db).filter(v => v.severity !== 'warning'), []);
});

test('erasure on the desk: in progress after anonymise, done only when finishErasure succeeds; done by hand before that is refused', () => {
  const db = withAccounts(seed());
  const r = execute('rights.file', db, [{ kind: 'erasure' }], ctx({ role: 'parent', id: 'grd-02' }), parent(db));
  assert.throws(() => run(db, 'rights.update', [r.id, { status: 'done', resolution: 'x' }]), { code: 'VALIDATION', message: /erasure first/ }, 'not done before the erasure');
  const res = run(db, 'people.anonymiseGuardian', ['grd-02']);
  assert.equal(res.dataRequestsInProgress, 1);
  const desk = () => db.dataRequests.find(x => x.id === r.id);
  assert.equal(desk().status, 'in_progress'); assert.ok(desk().resolution);
  assert.throws(() => run(db, 'rights.update', [r.id, { status: 'done', resolution: 'x' }]), { code: 'VALIDATION' }, 'still cleanup: not done yet');
  const sys = systemPersona('erasure');
  const failed = execute('people.finishErasure', db, ['grd-02', { errors: ['auth 500'] }], ctx({ role: 'system', id: 'erasure' }), sys);
  assert.equal(failed.dataRequestsDone, 0); assert.equal(desk().status, 'in_progress', 'a failed clean-up leaves it in progress');
  const ok = execute('people.finishErasure', db, ['grd-02', { errors: [] }], ctx({ role: 'system', id: 'erasure' }), sys);
  assert.equal(ok.dataRequestsDone, 1);
  assert.equal(desk().status, 'done'); assert.ok(desk().decidedAt);
  // declining stays allowed at any time
  const db2 = seed();
  const r2 = execute('rights.file', db2, [{ kind: 'erasure' }], ctx({ role: 'parent', id: 'grd-02' }), parent(db2));
  assert.equal(run(db2, 'rights.update', [r2.id, { status: 'declined', resolution: 'Fake: fees outstanding, kept by law.' }]).status, 'declined');
  assert.ok(SLICES.erasure.writes.includes('dataRequests') && SLICES.erasure.reads.includes('dataRequests'));
  assert.ok(SLICES.rights.reads.includes('erasureRequests'));
  assert.ok(guardSlices('rights', ['dataRequests']).includes('erasure') && guardSlices('erasure', ['dataRequests']).includes('rights'));
  assert.ok(SLICES.export.reads.includes('dataRequests'));
});

test('account commands are admin-accounts only (POST /command refuses functionOnly); noteAccountAction knows auth_db_mismatch', () => {
  for (const n of ['admin.blockUser', 'admin.unblockUser', 'admin.changeSignInEmail', 'admin.noteAccountAction']) assert.equal(COMMANDS[n].functionOnly, 'admin-accounts', n);
  for (const [n, c] of Object.entries(COMMANDS)) if (c.functionOnly) assert.ok(c.serverOnly, `${n}: functionOnly implies serverOnly`);
  const db = withAccounts(seed());
  const r = execute('admin.noteAccountAction', db, [{ userId: U(6), action: 'changeEmail', outcome: 'auth_db_mismatch', by: 'stf-principal' }], ctx({ role: 'system', id: 'admin-accounts' }), systemPersona('admin-accounts'));
  assert.equal(r.outcome, 'auth_db_mismatch');
});

// ---------------------------------------------------------------- announcement
test('admin.setAnnouncement: plain text up to 280 characters, tone and last day checked; clear; active until the last day', () => {
  const db = seed();
  assert.throws(() => run(db, 'admin.setAnnouncement', [{ text: 'x'.repeat(ANNOUNCEMENT_MAX + 1) }]), { code: 'VALIDATION', message: /280/ });
  assert.throws(() => run(db, 'admin.setAnnouncement', [{ text: 'Hello <script>alert(1)</script>' }]), { code: 'VALIDATION', message: /plain text/ });
  assert.throws(() => run(db, 'admin.setAnnouncement', [{ text: 'see <a href=x>' }]), { code: 'VALIDATION' });
  assert.throws(() => run(db, 'admin.setAnnouncement', [{ text: '  ' }]), { code: 'VALIDATION' });
  assert.throws(() => run(db, 'admin.setAnnouncement', [{ text: 'ok', tone: 'loud' }]), { code: 'VALIDATION' });
  assert.throws(() => run(db, 'admin.setAnnouncement', [{ text: 'ok', until: '2026-10-01' }]), { code: 'VALIDATION', message: /past/ });
  assert.throws(() => execute('admin.setAnnouncement', db, [{ text: 'ok' }], ctx({ role: 'parent', id: 'grd-02' }), parent(db)), { code: 'NOT_ALLOWED' });
  const a = run(db, 'admin.setAnnouncement', [{ text: ' School closed on Friday (fake). 2 < 3 is fine. ', tone: 'warn', until: '2026-10-09' }]);
  assert.deepEqual(a, { text: 'School closed on Friday (fake). 2 < 3 is fine.', tone: 'warn', until: '2026-10-09', setBy: 'stf-principal', setAt: `${TODAY}T05:00:00.000Z` });
  assert.deepEqual(db.school.announcement, a);
  assert.equal(activeAnnouncement(db.school, '2026-10-09'), a);
  assert.equal(activeAnnouncement(db.school, '2026-10-10'), null, 'gone after its last day');
  assert.deepEqual(validateDb(db).filter(v => v.severity !== 'warning'), []);
  assert.equal(run(db, 'admin.clearAnnouncement', []), null);
  assert.equal(db.school.announcement, null);
  assert.equal(COMMANDS['admin.setAnnouncement'].slice, 'ledger');
});

// ---------------------------------------------------------------- guardian corrections
test('people.updateGuardian: principal only; name/phone/relation; never the email; never an erased guardian; audit without values', () => {
  const db = withAccounts(seed());
  assert.throws(() => run(db, 'people.updateGuardian', [{ guardianId: 'grd-02', email: 'x@example.com' }]), { code: 'VALIDATION', message: /Unknown field/ });
  assert.throws(() => run(db, 'people.updateGuardian', [{ guardianId: 'grd-02', phone: 'call me' }]), { code: 'VALIDATION' });
  assert.throws(() => run(db, 'people.updateGuardian', [{ guardianId: 'grd-02', firstName: ' ' }]), { code: 'VALIDATION' });
  assert.throws(() => execute('people.updateGuardian', db, [{ guardianId: 'grd-02', phone: '+91-90000-00998' }], ctx({ role: 'parent', id: 'grd-02' }), parent(db)), { code: 'NOT_ALLOWED' });
  const g = run(db, 'people.updateGuardian', [{ guardianId: 'grd-02', phone: '+91-90000-00998', relation: 'Father' }]);
  assert.equal(g.phone, '+91-90000-00998'); assert.equal(g.relation, 'Father'); assert.equal(typeof g.name, 'string');
  const row = db.auditLog.at(-1);
  assert.match(row.summary, /phone/); assert.doesNotMatch(row.summary, /90000/);
  run(db, 'people.anonymiseGuardian', ['grd-02']);
  assert.throws(() => run(db, 'people.updateGuardian', [{ guardianId: 'grd-02', firstName: 'Back' }]), { code: 'VALIDATION', message: /erased/ });
});

// ---------------------------------------------------------------- who can see a child
test('whoCanSee: a viewer sees the child exactly when the persona the commands use does (demo personas, every child)', () => {
  const db = seed();
  const personas = buildPersonas(db);
  for (const s of db.students) {
    const w = whoCanSee(db, s.id);
    const seeing = new Set(w.viewers.filter(v => v.sees).map(v => v.id));
    for (const p of personas) assert.equal(seeing.has(p.staffId || p.guardianId), sees(p, s.id), `${p.id} / ${s.id}`);
    assert.equal(w.student.id, s.id);
    assert.ok(w.viewers.every(v => v.signIn === 'none'), 'no accounts known → none');
  }
});

test('whoCanSee (real app): a guardian without app_account consent is listed as not seeing; sign-in status from the links', () => {
  const db = seed();
  db.consents = linkChanges(db, NOW.toISOString()).upserts.consents; // the local database: only grd-01 and grd-02 consented
  const appUsers = [{ id: U(6), role: 'parent', guardianId: 'grd-02', staffId: null, status: 'blocked' }, { id: U(2), role: 'teacher', staffId: 'stf-teacher-pa', guardianId: null, status: 'active' }];
  for (const s of db.students) {
    const w = whoCanSee(db, s.id, { appUsers, requireConsent: true });
    for (const p of buildPersonas(db)) {
      const server = p.role === 'parent' ? consentScopedPersona(db, p, db.consents) : p;
      const v = w.viewers.find(x => x.id === (p.staffId || p.guardianId));
      assert.equal(Boolean(v && v.sees), sees(server, s.id), `${p.id} / ${s.id}`);
    }
  }
  const w6 = whoCanSee(db, 'stu-06', { appUsers, requireConsent: true }); // grd-03: no consent
  const g3 = w6.viewers.find(v => v.id === 'grd-03');
  assert.equal(g3.sees, false); assert.equal(g3.consent, false); assert.match(g3.via, /privacy notice/);
  const w4 = whoCanSee(db, 'stu-04', { appUsers, requireConsent: true });
  assert.equal(w4.viewers.find(v => v.id === 'grd-02').signIn, 'blocked');
  assert.equal(w4.viewers.find(v => v.id === 'stf-teacher-pa').signIn, 'active');
  assert.equal(w4.viewers[0].role, 'admin', 'principal first');
  assert.throws(() => whoCanSee(db, 'stu-none'), { code: 'NOT_FOUND' });
});

// ---------------------------------------------------------------- the permission matrix (JS half)
test('permission matrix: every JS probe on the local seed equals the matrix cell', () => {
  const db = withFixture(seed());
  const lc = linkChanges(db, NOW.toISOString()); // the local database: links, their consents and the seed-links audit row
  db.consents = lc.upserts.consents;
  db.auditLog.push(...lc.audit);
  db.appUsers = []; db.invites = []; db.erasureRequests = []; db.importBatches = []; db.importRows = [];
  const keys = PERMISSIONS.actors.map(a => a.key);
  assert.deepEqual(keys, Object.keys(MATRIX_ACTORS));
  assert.ok(PERMISSIONS.capabilities.length >= 20);
  const wrong = [];
  for (const cap of PERMISSIONS.capabilities) {
    assert.deepEqual(Object.keys(cap.allow), keys, `${cap.key}: one cell per actor`);
    if (cap.js.kind === 'command') assert.ok(COMMANDS[cap.js.name], `${cap.key}: ${cap.js.name} is a registry command`);
    for (const a of keys) {
      const got = evaluateJs(db, a, cap.key, { now: NOW.toISOString(), today: TODAY, signInEvents: FIXTURE.signInEvents });
      if (got !== cap.allow[a]) wrong.push(`${cap.key} / ${a}: matrix ${cap.allow[a]}, JS ${got}`);
    }
  }
  assert.deepEqual(wrong, []);
  assert.ok(PERMISSIONS.capabilities.every(c => Object.values(c.allow).every(v => typeof v === 'boolean')));
  assert.ok(PERMISSIONS.capabilities.every(c => !c.allow.principal_aal1_enrolled), 'an enrolled principal without the second step reaches nothing');
  assert.doesNotThrow(() => structuredClone(PERMISSIONS), 'plain data (the api clones it)');
});

test('permission matrix: a policy requiring two-step closes the unenrolled accountant at aal1', () => {
  const db = withFixture(seed());
  db.consents = linkChanges(db, NOW.toISOString()).upserts.consents;
  assert.equal(evaluateJs(db, 'accountant', 'fees', { now: NOW.toISOString(), today: TODAY }), true);
  assert.equal(evaluateJs(db, 'accountant', 'fees', { now: NOW.toISOString(), today: TODAY, policyRequired: true }), false);
  assert.equal(evaluateJs(db, 'teacher', 'attendance', { now: NOW.toISOString(), today: TODAY, policyRequired: true }), true, 'teachers are never asked');
});

// ---------------------------------------------------------------- schema v3
test('schema v3: dataRequests collection and school.announcement; migrate v2 → v3 adds them empty and keeps everything else', () => {
  assert.equal(SCHEMA_VERSION, 3);
  assert.ok(COLLECTIONS.includes('dataRequests'));
  const v2 = seed();
  delete v2.dataRequests; delete v2.school.announcement; v2.schemaVersion = 2;
  const before = JSON.stringify({ ...v2, schemaVersion: 3 });
  const m = migrate(structuredClone(v2));
  assert.equal(m.schemaVersion, 3);
  assert.deepEqual(m.dataRequests, []);
  assert.equal(m.school.announcement, null);
  const { dataRequests, ...rest } = m; void dataRequests;
  const { announcement, ...school } = rest.school; void announcement;
  assert.equal(JSON.stringify({ ...rest, school }), before, 'nothing else changed');
  assert.deepEqual(validateDb(m).filter(v => v.severity !== 'warning'), []);
  const kept = structuredClone(m); kept.school.announcement = { text: 'x', tone: 'info', until: null, setBy: 's', setAt: 't' };
  assert.deepEqual(migrate(kept).school.announcement.text, 'x', 'migrate is idempotent on v3');
  const bad = structuredClone(m); bad.school.announcement = { text: 'y'.repeat(300), tone: 'info', until: null };
  assert.ok(validateDb(bad).some(v => v.code === 'BAD_SCHOOL'));
  assert.equal(CONSENT_VERSION, 'v2', 'no new privacy notice in this module');
});
