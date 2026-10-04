// The administration module in the demo api (no server): optional password, real TOTP two-step with a demo
// authenticator, blocking, sign-in activity, the account desk running the SAME registry commands, the data-rights desk,
// the announcement, oversight reads, and "reset to demo data" clearing the demo-only stores.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApi, DEMO_KEYS, SESSION_KEY } from '../src/api/index.js';
import { buildSeed } from '../src/seed/seed-data.js';
import { memoryBackend } from '../src/store/storage.js';
import { totp } from '../src/api/totp.js';

const NOW = new Date(Date.UTC(2026, 9, 2, 5, 0, 0));
const ADMIN = 'persona-stf-principal', ACCOUNTANT = 'persona-stf-accountant', TEACHER = 'persona-stf-teacher-pa', PARENT = 'persona-grd-02', PARENT1 = 'persona-grd-01';

async function mk({ backend = memoryBackend(), sessionBackend = memoryBackend() } = {}) {
  const api = createApi({ backend, sessionBackend, seedFn: () => buildSeed(NOW), clock: () => NOW });
  await api.ready();
  return { api, backend, sessionBackend };
}
const as = (api, id) => api.session.set(id);
const codeNow = (secret) => totp(secret, NOW.getTime());

// ---------------------------------------------------------------- password (optional; the emailed code stays the default)
test('password: set by anyone, at least 8 characters, stored as a per-persona hash, and it signs that person in', async () => {
  const { api, sessionBackend } = await mk();
  as(api, TEACHER);
  await assert.rejects(api.auth.setPassword('short'), { code: 'VALIDATION' });
  await api.auth.setPassword('correct horse battery');
  const raw = sessionBackend.getItem(DEMO_KEYS.password);
  assert.ok(raw && !raw.includes('correct horse'), 'the password itself is never stored');
  assert.equal(JSON.parse(raw)[TEACHER].length, 64, 'SHA-256 hex');
  api.session.clear();
  const st = await api.auth.signInWithPassword('teacher-pa@example.com', 'correct horse battery');
  assert.equal(st.state, 'demo');
  assert.equal(api.session.current().id, TEACHER);
});

test('password: wrong password and an unknown address are refused with the same message; another persona\'s password does not open this one', async () => {
  const { api } = await mk();
  as(api, TEACHER);
  await api.auth.setPassword('teacher-secret-1');
  api.session.clear();
  const wrong = await api.auth.signInWithPassword('teacher-pa@example.com', 'nope-nope-nope').catch((e) => e);
  const unknown = await api.auth.signInWithPassword('nobody@example.com', 'teacher-secret-1').catch((e) => e);
  assert.equal(wrong.code, 'VALIDATION');
  assert.equal(wrong.message, unknown.message, 'never reveals whether the address has an account');
  as(api, ACCOUNTANT);
  api.session.clear();
  await assert.rejects(api.auth.signInWithPassword('accountant@example.com', 'teacher-secret-1'), { code: 'VALIDATION' });
  assert.equal(api.session.current(), null, 'a failed attempt signs nobody in');
});

test('password reset by emailed code exists only in the real app', async () => {
  const { api } = await mk();
  await assert.rejects(api.auth.requestPasswordReset('teacher-pa@example.com'), { code: 'NOT_ALLOWED' });
  await assert.rejects(api.auth.verifyRecoveryCode('teacher-pa@example.com', '123456'), { code: 'NOT_ALLOWED' });
});

// ---------------------------------------------------------------- two-step (real TOTP, demo authenticator)
test('two-step: only the principal and accountant; enrol gives a secret and otpauth link; a code from totp.js verifies, a wrong one does not', async () => {
  const { api } = await mk();
  as(api, TEACHER);
  await assert.rejects(api.auth.twoStep.enroll(), { code: 'NOT_ALLOWED' });
  as(api, ADMIN);
  assert.deepEqual(await api.auth.twoStep.status(), { enrolled: false, verified: false, required: false, factorId: null });
  const en = await api.auth.twoStep.enroll();
  assert.match(en.secret, /^[A-Z2-7]{32}$/);
  assert.match(en.uri, /^otpauth:\/\/totp\/.+secret=/);
  assert.ok(en.uri.includes(en.secret));
  assert.equal((await api.auth.status()).state, 'demo', 'not enrolled until the first correct code');
  await assert.rejects(api.auth.twoStep.verify(en.factorId, '000000'), { code: 'VALIDATION' });
  const shown = await api.auth.twoStep.demoCode();
  assert.equal(shown.code, await codeNow(en.secret), 'the demo authenticator shows the real RFC 6238 code');
  assert.ok(shown.secondsLeft >= 1 && shown.secondsLeft <= 30);
  assert.deepEqual(await api.auth.twoStep.verify(en.factorId, shown.code), { verified: true });
  assert.deepEqual(await api.auth.twoStep.status(), { enrolled: true, verified: true, required: false, factorId: en.factorId });
  await assert.rejects(api.auth.twoStep.enroll(), { code: 'VALIDATION' }, 'already set up');
});

test('two-step gate: an enrolled principal who has not verified this session is two_step_required; the code opens it; turning it off removes the gate', async () => {
  const { api } = await mk();
  as(api, ACCOUNTANT);
  const en = await api.auth.twoStep.enroll();
  await api.auth.twoStep.verify(en.factorId, (await api.auth.twoStep.demoCode()).code);
  await api.auth.signOutEverywhere(); // ends the session and its second step
  as(api, ACCOUNTANT);
  const gated = await api.auth.status();
  assert.equal(gated.state, 'two_step_required');
  assert.deepEqual(gated.twoStep, { enrolled: true, verified: false, required: false, factorId: en.factorId });
  await api.auth.twoStep.verify(en.factorId, (await api.auth.twoStep.demoCode()).code);
  assert.equal((await api.auth.status()).state, 'demo');
  await api.auth.twoStep.disable(en.factorId);
  assert.equal((await api.auth.twoStep.status()).enrolled, false);
  await assert.rejects(api.auth.twoStep.demoCode(), { code: 'NOT_FOUND' });
});

test('two-step: a secret for one persona never verifies another, and an unfinished set-up does not gate anyone', async () => {
  const { api } = await mk();
  as(api, ADMIN);
  const a = await api.auth.twoStep.enroll();
  as(api, ACCOUNTANT);
  const b = await api.auth.twoStep.enroll();
  assert.notEqual(a.secret, b.secret);
  await assert.rejects(api.auth.twoStep.verify(a.factorId, await codeNow(a.secret)), { code: 'NOT_FOUND' }, "another persona's factor id");
  await assert.rejects(api.auth.twoStep.verify(b.factorId, await codeNow(a.secret)), { code: 'VALIDATION' }, "another persona's code");
  as(api, ADMIN);
  assert.equal((await api.auth.status()).state, 'demo', 'enrolment is not finished, so no gate');
});

// ---------------------------------------------------------------- block, activity, accounts
test('block: the persona switcher refuses a blocked persona, the block survives a reload, and unblock restores it', async () => {
  const { api, backend, sessionBackend } = await mk();
  as(api, ADMIN);
  const rows = await api.admin.accounts.list();
  assert.ok(rows.length >= 8 && rows.some((r) => r.personKind === 'guardian'));
  assert.deepEqual(rows.find((r) => r.userId === TEACHER), { userId: TEACHER, personKind: 'staff', personId: 'stf-teacher-pa', name: rows.find((r) => r.userId === TEACHER).name, role: 'teacher', email: 'teacher-pa@example.com', status: 'active', lastSignInAt: null, confirmedAt: null, twoStep: 'none', bannedUntil: null });
  assert.deepEqual(await api.admin.accounts.block(TEACHER), { userId: TEACHER, status: 'blocked' });
  assert.equal((await api.admin.accounts.list()).find((r) => r.userId === TEACHER).status, 'blocked');
  assert.throws(() => api.session.set(TEACHER), { code: 'NOT_ALLOWED', message: /blocked in the demo/ });
  assert.equal(api.session.current().id, ADMIN, 'the refused switch left the session alone');
  assert.ok(JSON.parse(backend.getItem(DEMO_KEYS.accounts)).blocked[TEACHER], 'kept in the demo accounts store');
  const reloaded = await mk({ backend, sessionBackend });
  assert.throws(() => reloaded.api.session.set(TEACHER), { code: 'NOT_ALLOWED' });
  assert.deepEqual(await api.admin.accounts.unblock(TEACHER), { userId: TEACHER, status: 'active' });
  as(api, TEACHER);
  assert.equal(api.session.current().id, TEACHER);
});

test('block: the registry rules apply in the demo (not yourself) and the action is audited; only the principal runs the desk', async () => {
  const { api } = await mk();
  as(api, ADMIN);
  await assert.rejects(api.admin.accounts.block(ADMIN), { code: 'VALIDATION', message: /own account/ });
  await assert.rejects(api.admin.accounts.block('persona-nobody'), { code: 'NOT_FOUND' });
  await api.admin.accounts.block(PARENT1);
  const hist = await api.oversight.history({ entity: 'appUser' });
  assert.ok(hist.some((r) => r.action === 'block' && r.entityId === PARENT1), 'the block is in the change history');
  assert.equal(api.getDb().appUsers, undefined, 'the demo document never keeps sign-in links');
  for (const who of [TEACHER, PARENT, ACCOUNTANT]) {
    as(api, who);
    await assert.rejects(api.admin.accounts.list(), { code: 'NOT_ALLOWED' }, who);
    await assert.rejects(api.admin.accounts.block(PARENT1), { code: 'NOT_ALLOWED' }, who);
    await assert.rejects(api.oversight.signInActivity(), { code: 'NOT_ALLOWED' }, who);
    await assert.rejects(api.oversight.permissions(), { code: 'NOT_ALLOWED' }, who);
  }
});

test('change email runs the registry command: the person\'s email changes, a collision is refused, both are audited or unchanged', async () => {
  const { api } = await mk();
  as(api, ADMIN);
  assert.deepEqual(await api.admin.accounts.changeEmail(TEACHER, 'New.Teacher@example.com'), { userId: TEACHER, email: 'new.teacher@example.com' });
  assert.equal(api.getDb().staff.find((s) => s.id === 'stf-teacher-pa').email, 'new.teacher@example.com');
  await assert.rejects(api.admin.accounts.changeEmail(TEACHER, 'accountant@example.com'), { code: 'VALIDATION', message: /already uses/ });
  await assert.rejects(api.admin.accounts.changeEmail(TEACHER, 'not-an-email'), { code: 'VALIDATION' });
  assert.equal(api.getDb().staff.find((s) => s.id === 'stf-teacher-pa').email, 'new.teacher@example.com');
  assert.ok((await api.oversight.history({ entityId: TEACHER })).some((r) => r.action === 'changeEmail'));
});

test('sign-in activity: persona switches this session, newest first, with names and the second-step level; limit applies', async () => {
  const { api } = await mk();
  as(api, TEACHER);
  as(api, PARENT);
  as(api, ADMIN);
  const en = await api.auth.twoStep.enroll();
  await api.auth.twoStep.verify(en.factorId, await codeNow(en.secret));
  as(api, ACCOUNTANT);
  as(api, ADMIN); // after verifying: aal2
  const rows = await api.oversight.signInActivity();
  assert.deepEqual(rows.map((r) => r.userId), [ADMIN, ACCOUNTANT, ADMIN, PARENT, TEACHER]);
  assert.equal(rows[0].aal, 'aal2');
  assert.equal(rows[2].aal, 'aal1');
  assert.ok(rows.every((r) => r.at && r.name && r.role));
  assert.equal((await api.oversight.signInActivity({ limit: 2 })).length, 2);
  const list = await api.admin.accounts.list();
  assert.equal(list.find((r) => r.userId === TEACHER).lastSignInAt, rows.find((r) => r.userId === TEACHER).at);
  assert.equal(list.find((r) => r.userId === ADMIN).twoStep, 'verified');
});

test('sign out everywhere: own session ends in this tab; for another person it ends their second step; resetting two-step removes the authenticator; both are audited', async () => {
  const { api } = await mk();
  as(api, ACCOUNTANT);
  const en = await api.auth.twoStep.enroll();
  await api.auth.twoStep.verify(en.factorId, await codeNow(en.secret));
  as(api, ADMIN);
  assert.deepEqual(await api.admin.accounts.signOutEverywhere(ACCOUNTANT), { userId: ACCOUNTANT, sessionsEnded: 0 });
  as(api, ACCOUNTANT);
  assert.equal((await api.auth.status()).state, 'two_step_required', 'their verified session was ended');
  as(api, ADMIN);
  assert.deepEqual(await api.admin.accounts.resetTwoStep(ACCOUNTANT), { userId: ACCOUNTANT, factorsRemoved: 1 });
  as(api, ACCOUNTANT);
  assert.equal((await api.auth.status()).state, 'demo');
  as(api, ADMIN);
  assert.deepEqual(await api.admin.accounts.signOutEverywhere(ADMIN), { userId: ADMIN, sessionsEnded: 1 });
  assert.equal(api.session.current(), null);
  as(api, ADMIN);
  const acts = (await api.oversight.history({ entity: 'appUser', entityId: ACCOUNTANT })).map((r) => r.action);
  assert.ok(acts.includes('signOutEverywhere') && acts.includes('resetTwoStep'));
});

test('invites and the two-step requirement switch are real-app-only; the policy view lists who has set up an authenticator', async () => {
  const { api } = await mk();
  as(api, ADMIN);
  await assert.rejects(api.admin.accounts.resendInvite({ guardianId: 'grd-01' }), { code: 'NOT_ALLOWED' });
  await assert.rejects(api.admin.accounts.setTwoStepPolicy({ required: true }), { code: 'NOT_ALLOWED' });
  const en = await api.auth.twoStep.enroll();
  await api.auth.twoStep.verify(en.factorId, await codeNow(en.secret));
  const pol = await api.admin.accounts.twoStepPolicy();
  assert.equal(pol.required, false);
  assert.deepEqual(pol.privileged.map((p) => [p.userId, p.role, p.enrolled]), [[ADMIN, 'admin', true], [ACCOUNTANT, 'accountant', false]]);
});

// ---------------------------------------------------------------- reset to demo data
test('reset to demo data clears the demo-only stores: blocks, passwords, authenticators and activity', async () => {
  const { api, backend, sessionBackend } = await mk();
  as(api, ADMIN);
  const en = await api.auth.twoStep.enroll();
  await api.auth.twoStep.verify(en.factorId, await codeNow(en.secret));
  await api.auth.setPassword('principal-pass-1');
  await api.admin.accounts.block(TEACHER);
  for (const k of [DEMO_KEYS.accounts]) assert.ok(backend.getItem(k), k);
  for (const k of [DEMO_KEYS.password, DEMO_KEYS.twoStep, DEMO_KEYS.activity]) assert.ok(sessionBackend.getItem(k), k);
  await api.admin.resetToSeed();
  for (const k of [DEMO_KEYS.accounts]) assert.equal(backend.getItem(k), null, k);
  for (const k of [DEMO_KEYS.password, DEMO_KEYS.twoStep, DEMO_KEYS.activity]) assert.equal(sessionBackend.getItem(k), null, k);
  as(api, TEACHER); // no longer blocked
  assert.equal((await api.auth.status()).state, 'demo');
  assert.equal(sessionBackend.getItem(SESSION_KEY), TEACHER);
});

test('a session store that refuses the demo-only keys never breaks the demo: set-up and recording just do not persist', async () => {
  const mem = memoryBackend();
  const angry = (k) => { if (String(k).startsWith('montessori.demo-')) throw new Error('denied'); };
  const sessionBackend = { getItem: (k) => { angry(k); return mem.getItem(k); }, setItem: (k, v) => { angry(k); mem.setItem(k, v); }, removeItem: (k) => { angry(k); mem.removeItem(k); } };
  const api = createApi({ backend: memoryBackend(), sessionBackend, seedFn: () => buildSeed(NOW), clock: () => NOW });
  await api.ready();
  as(api, ADMIN);
  assert.equal((await api.auth.status()).state, 'demo');
  assert.equal((await api.oversight.signInActivity()).length, 0, 'nothing could be recorded');
  await api.auth.setPassword('principal-pass-1'); // swallowed: not stored, not fatal
  await api.admin.resetToSeed();
});

// ---------------------------------------------------------------- announcement
test('announcement: set, shown in the document for everyone, plain text only, cleared', async () => {
  const { api } = await mk();
  as(api, ADMIN);
  await assert.rejects(api.admin.announcement.set({ text: '<script>alert(1)</script>', tone: 'info' }), { code: 'VALIDATION' });
  await assert.rejects(api.admin.announcement.set({ text: 'x'.repeat(281), tone: 'info' }), { code: 'VALIDATION' });
  await assert.rejects(api.admin.announcement.set({ text: '', tone: 'info' }), { code: 'VALIDATION' });
  const a = await api.admin.announcement.set({ text: 'School closes at noon on Friday.', tone: 'warn', until: '2026-10-09' });
  assert.equal(a.text, 'School closes at noon on Friday.');
  as(api, PARENT);
  assert.equal(api.getDb().school.announcement.tone, 'warn');
  await assert.rejects(api.admin.announcement.set({ text: 'Parents cannot post notices', tone: 'info' }), { code: 'NOT_ALLOWED' });
  as(api, ADMIN);
  assert.equal(await api.admin.announcement.clear(), null);
  assert.equal(api.getDb().school.announcement, null);
});

// ---------------------------------------------------------------- data-rights desk
test('data requests: a parent files and sees only their own; one open request per kind; the principal moves it on and closing is final', async () => {
  const { api } = await mk();
  as(api, PARENT);
  const r1 = await api.rights.file({ kind: 'export' });
  assert.equal(r1.status, 'open');
  await assert.rejects(api.rights.file({ kind: 'export' }), { code: 'VALIDATION' }, 'duplicate open request');
  await assert.rejects(api.rights.file({ kind: 'correction', details: '' }), { code: 'VALIDATION' }, 'a correction says what is wrong');
  await assert.rejects(api.rights.file({ kind: 'bogus' }), { code: 'VALIDATION' });
  const r2 = await api.rights.file({ kind: 'correction', details: 'Phone number changed.' });
  as(api, PARENT1);
  await api.rights.file({ kind: 'erasure' });
  assert.deepEqual((await api.rights.list()).map((r) => r.kind), ['erasure'], "another family's requests are not visible");
  as(api, PARENT);
  assert.deepEqual((await api.rights.list()).map((r) => r.id).sort(), [r1.id, r2.id].sort());
  await assert.rejects(api.rights.update(r1.id, { status: 'done', resolution: 'x' }), { code: 'NOT_ALLOWED' });
  as(api, TEACHER);
  await assert.rejects(api.rights.list(), { code: 'NOT_ALLOWED' });
  as(api, ADMIN);
  const all = await api.rights.list();
  assert.equal(all.length, 3);
  assert.ok(all.every((r) => r.guardianName && r.guardianName !== '—'));
  assert.equal((await api.rights.update(r1.id, { status: 'in_progress' })).status, 'in_progress');
  await assert.rejects(api.rights.update(r1.id, { status: 'done' }), { code: 'VALIDATION' }, 'closing needs a resolution');
  const done = await api.rights.update(r1.id, { status: 'done', resolution: 'Sent by email.' });
  assert.equal(done.decidedBy, 'stf-principal');
  await assert.rejects(api.rights.update(r1.id, { status: 'declined', resolution: 'changed my mind' }), { code: 'VALIDATION' }, 'closed is final');
  as(api, PARENT);
  assert.equal((await api.rights.list()).find((r) => r.id === r1.id).resolution, 'Sent by email.');
  await api.rights.file({ kind: 'export' }); // the first one is closed, so a new one is allowed
});

test('correction desk: the principal corrects a guardian through people.updateGuardian, and it is in the change history', async () => {
  const { api } = await mk();
  as(api, ADMIN);
  const g = await api.people.updateGuardian({ guardianId: 'grd-02', phone: '+91-90000-00999' });
  assert.equal(g.phone, '+91-90000-00999');
  assert.ok((await api.oversight.history({ entityId: 'grd-02' })).length >= 1);
  as(api, TEACHER);
  await assert.rejects(api.people.updateGuardian({ guardianId: 'grd-02', phone: '+91-90000-00998' }), { code: 'NOT_ALLOWED' });
});

// ---------------------------------------------------------------- oversight
test('history carries actor names (staff and guardian) and filters by entity id; accountant may read it, a parent may not', async () => {
  const { api } = await mk();
  as(api, PARENT);
  const r = await api.rights.file({ kind: 'export' });
  as(api, ADMIN);
  await api.rights.update(r.id, { status: 'in_progress' });
  const rows = await api.oversight.history({ entityId: r.id });
  assert.equal(rows.find((x) => x.action === 'file').actorName, 'Priyanka Demoson');
  const principal = api.getDb().staff.find((x) => x.id === 'stf-principal');
  assert.equal(rows.find((x) => x.action === 'update').actorName, `${principal.firstName} ${principal.lastName}`);
  assert.ok(!rows.some((x) => x.entityId !== r.id), 'filtered by record id');
  as(api, ACCOUNTANT);
  assert.ok(Array.isArray(await api.oversight.history({ limit: 5 })));
  as(api, PARENT);
  await assert.rejects(api.oversight.history({}), { code: 'NOT_ALLOWED' });
});

test('who can see this child: exactly the people the authorization rule lets in, with the demo sign-in status (blocked shows)', async () => {
  const { api } = await mk();
  as(api, ADMIN);
  const res = await api.oversight.whoCanSee('stu-03');
  assert.equal(res.student.id, 'stu-03');
  const personas = api.session.personas();
  const expected = personas.filter((p) => p.studentIds.includes('stu-03')).map((p) => p.staffId || p.guardianId).sort();
  assert.deepEqual(res.viewers.filter((v) => v.sees).map((v) => v.id).sort(), expected, 'viewers equal the personas that can open the child');
  assert.ok(res.viewers.every((v) => v.signIn === 'active'));
  await api.admin.accounts.block(PARENT);
  const after = await api.oversight.whoCanSee('stu-03');
  assert.equal(after.viewers.find((v) => v.id === 'grd-02').signIn, 'blocked');
  await assert.rejects(api.oversight.whoCanSee('stu-nope'), { code: 'NOT_FOUND' });
  as(api, TEACHER);
  await assert.rejects(api.oversight.whoCanSee('stu-03'), { code: 'NOT_ALLOWED' });
});

test('permissions matrix: served to the principal as the shared object', async () => {
  const { api } = await mk();
  as(api, ADMIN);
  const m = await api.oversight.permissions();
  assert.ok(m.actors.length >= 7 && m.capabilities.length >= 15);
  assert.ok(m.capabilities.every((c) => c.label && Object.keys(c.allow).length === m.actors.length));
});
