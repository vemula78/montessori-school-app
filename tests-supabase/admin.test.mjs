// Administration module through the real auth server, PostgREST and the admin-accounts / command functions (local
// stack, fake data). Runs first of the suites (alphabetical): every change it makes is undone in after() — the
// principal's authenticator is removed and the two-step policy is off again — and its families (grd-09, grd-10) are
// used by no other suite.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { local, signIn, fn, command, rest, rpcAs, restAs, http, psql, enrollTotp, unenrollAll, claimsOf } from './helpers.mjs';

let admin, admin2, teacher, acct;
const rand = () => randomBytes(4).toString('hex');
const desk = (who, action, extra = {}) => fn('admin-accounts', { action, requestId: `t-${randomUUID()}`, ...extra }, who.token);
const snapshot = async who => (await rpcAs(who.token, 'my_snapshot')).data;
async function linkedParent(guardianId) {
  const who = await signIn(`adm-${guardianId}-${rand()}@example.com`);
  assert.equal((await rest('POST', 'app_users', { user_id: who.userId, role: 'parent', guardian_id: guardianId, status: 'active' }, 'return=minimal')).status, 201);
  assert.equal((await command(who.token, 'consent.give', { purposes: ['app_account'], version: 'v2' })).status, 200);
  return who;
}

before(async () => {
  [admin, teacher, acct] = await Promise.all(['principal@example.com', 'teacher-pa@example.com', 'accountant@example.com'].map(signIn));
});
after(async () => {
  if (admin) await unenrollAll(admin.userId);
  await rest('PATCH', 'app_policy?key=eq.two_step', { value: { required: false } });
  assert.equal(psql(`select count(*) from two_step_enrolled where user_id = '${admin.userId}'`), '0', 'the principal is unenrolled again for the later suites');
});

test('two-step: an enrolled principal at aal1 is refused everywhere (TWO_STEP_REQUIRED, snapshot two_step_required); aal2 passes', async () => {
  const plain = await desk(admin, 'directory');
  assert.equal(plain.status, 403, 'the account desk always needs aal2');
  assert.equal(plain.data.error.code, 'TWO_STEP_REQUIRED');
  const e = await enrollTotp(admin);
  admin2 = { ...admin, token: e.token, factorId: e.factorId, secret: e.secret };
  assert.equal(claimsOf(admin2.token).aal, 'aal2');
  assert.equal(psql(`select count(*) from two_step_enrolled where user_id = '${admin.userId}'`), '1', 'the mirror follows the verified factor');
  const r = await command(admin.token, 'admin.invites');
  assert.equal(r.status, 403, JSON.stringify(r.data));
  assert.equal(r.data.error.code, 'TWO_STEP_REQUIRED');
  const s = await snapshot(admin);
  assert.equal(s.status, 'two_step_required');
  assert.deepEqual(s.twoStep, { enrolled: true, required: false });
  assert.equal(s.students, undefined, 'no school data in the gate answer');
  assert.equal((await restAs(admin.token, 'students?select=id')).data.length, 0, 'RLS: an aal1 session of an enrolled principal reads no child');
  assert.equal((await command(admin2.token, 'admin.invites')).status, 200);
  const s2 = await snapshot(admin2);
  assert.equal(s2.status, 'active'); assert.equal(s2.schemaVersion, 3); assert.ok(s2.students.length > 0);
  assert.deepEqual(s2.twoStep, { enrolled: true, required: false });
});

test('the account desk: teachers and aal1 principals are refused; the directory shows sign-in details', async () => {
  const t = await desk(teacher, 'directory');
  assert.equal(t.status, 403); assert.equal(t.data.error.code, 'NOT_ALLOWED');
  const d = await desk(admin2, 'directory');
  assert.equal(d.status, 200, JSON.stringify(d.data));
  const me = d.data.result.find(x => x.userId === admin.userId);
  assert.equal(me.role, 'admin'); assert.equal(me.status, 'active'); assert.equal(me.twoStep, 'verified'); assert.ok(me.lastSignInAt);
  const g6 = d.data.result.filter(x => x.personKind === 'guardian' && x.personId === 'grd-06');
  assert.equal(g6.length, 1); assert.equal(g6[0].userId, null, 'a family without a sign-in is listed too');
  assert.ok(d.data.result.every(x => ['active', 'blocked', 'revoked', 'withdrawn', 'pending', 'invited', 'none'].includes(x.status)));
});

test('sign-in activity: the parent\'s sign-in is recorded (trigger as the auth server\'s role); principal only', async () => {
  const p = await linkedParent('grd-09');
  assert.ok(Number(psql(`select count(*) from sign_in_events where user_id = '${p.userId}'`)) >= 1);
  assert.ok((await restAs(admin2.token, `sign_in_events?user_id=eq.${p.userId}&select=at`)).data.length >= 1);
  assert.equal((await restAs(acct.token, 'sign_in_events?select=at')).data.length, 0);
  assert.equal((await restAs(p.token, 'sign_in_events?select=at')).data.length, 0);
});

test('block → the parent is cut off (snapshot blocked, refresh and new sign-in refused); unblock restores', async () => {
  const p = await linkedParent('grd-09');
  const b = await desk(admin2, 'block', { userId: p.userId });
  assert.equal(b.status, 200, JSON.stringify(b.data));
  assert.equal(b.data.result.status, 'blocked');
  assert.ok(b.data.result.sessionsEnded >= 1);
  assert.equal((await snapshot(p)).status, 'blocked', 'PostgREST under the still-valid token: blocked');
  const c = await command(p.token, 'rights.file', { kind: 'export' });
  assert.ok([401, 403].includes(c.status), `command refused (${c.status})`);
  const refresh = await http('POST', `${local().url}/auth/v1/token?grant_type=refresh_token`, { body: { refresh_token: p.refresh }, headers: { apikey: local().anon } });
  assert.notEqual(refresh.status, 200, 'the refresh token is gone');
  await assert.rejects(signIn(p.email), /verify failed|could not get an OTP/, 'a banned sign-in cannot sign in again');
  assert.equal(psql(`select status from app_users where user_id = '${p.userId}'`), 'blocked');
  const self = await desk(admin2, 'block', { userId: admin.userId });
  assert.equal(self.status, 422, 'never yourself');
  const u = await desk(admin2, 'unblock', { userId: p.userId });
  assert.equal(u.status, 200, JSON.stringify(u.data)); assert.equal(u.data.result.status, 'active');
  const again = await signIn(p.email);
  assert.equal((await snapshot(again)).status, 'active');
  assert.equal((await command(again.token, 'rights.file', { kind: 'export' })).status, 200);
  const audit = psql(`select string_agg(doc->>'action', ',' order by ts) from audit_log where doc->>'entityId' = '${p.userId}'`);
  assert.match(audit, /block.*unblock/);
});

test('sign out everywhere: the token is dead at the auth server (403) and at the command function (401)', async () => {
  const p = await linkedParent('grd-09');
  const r = await desk(admin2, 'sign_out_everywhere', { userId: p.userId });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.result.sessionsEnded >= 1);
  const u = await http('GET', `${local().url}/auth/v1/user`, { headers: { apikey: local().anon, Authorization: `Bearer ${p.token}` } });
  assert.equal(u.status, 403, JSON.stringify(u.data));
  assert.equal((await command(p.token, 'rights.file', { kind: 'erasure' })).status, 401);
  assert.equal(psql(`select count(*) from audit_log where doc->>'entityId' = '${p.userId}' and doc->>'action' = 'signOutEverywhere' and doc->>'actorId' = 'stf-principal'`), '1');
});

test('change email: the sign-in and the guardian record change together; a clash changes neither', async () => {
  const p = await linkedParent('grd-09');
  const before = psql(`select doc->>'email' from guardians where id = 'grd-09'`);
  const clashAuth = await desk(admin2, 'change_email', { userId: p.userId, email: 'teacher-pa@example.com' });
  assert.equal(clashAuth.status, 422, JSON.stringify(clashAuth.data));
  const otherGuardian = psql(`select doc->>'email' from guardians where id = 'grd-10'`);
  const clashDoc = await desk(admin2, 'change_email', { userId: p.userId, email: otherGuardian });
  assert.equal(clashDoc.status, 422, JSON.stringify(clashDoc.data));
  assert.equal(psql(`select email from auth.users where id = '${p.userId}'`), p.email, 'the auth email was put back');
  assert.equal(psql(`select doc->>'email' from guardians where id = 'grd-09'`), before);
  const next = `adm-new-${rand()}@example.com`;
  const ok = await desk(admin2, 'change_email', { userId: p.userId, email: next.toUpperCase() });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(psql(`select email from auth.users where id = '${p.userId}'`), next);
  assert.equal(psql(`select doc->>'email' from guardians where id = 'grd-09'`), next);
  assert.equal((await command(p.token, 'rights.file', { kind: 'erasure' })).status, 401, 'old sessions ended');
  assert.equal((await snapshot(await signIn(next))).status, 'active', 'signs in with the new address');
});

test('data-rights desk: a parent files, a duplicate is refused, the principal closes it with a resolution', async () => {
  const p = await linkedParent('grd-10');
  const f = await command(p.token, 'rights.file', { kind: 'correction', details: 'Fake: my phone number changed.' });
  assert.equal(f.status, 200, JSON.stringify(f.data));
  const dup = await command(p.token, 'rights.file', { kind: 'correction', details: 'again' });
  assert.equal(dup.status, 422);
  assert.deepEqual((await snapshot(p)).dataRequests.map(r => r.id), [f.data.result.id]);
  const noRes = await command(admin2.token, 'rights.update', f.data.result.id, { status: 'done' });
  assert.equal(noRes.status, 422);
  const done = await command(admin2.token, 'rights.update', f.data.result.id, { status: 'done', resolution: 'Phone corrected (fake).' });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.equal(psql(`select status from data_requests where id = '${f.data.result.id}'`), 'done');
  assert.equal((await command(admin2.token, 'rights.update', f.data.result.id, { status: 'open' })).status, 422, 'final');
  assert.equal((await restAs(teacher.token, 'data_requests?select=id')).data.length, 0);
});

test('announcement: set by the principal, in the parent\'s snapshot; HTML refused; cleared', async () => {
  const p = await linkedParent('grd-10');
  assert.equal((await command(admin2.token, 'admin.setAnnouncement', { text: '<b>x</b>' })).status, 422);
  const s = await command(admin2.token, 'admin.setAnnouncement', { text: 'Fake: school closed on Friday.', tone: 'warn', until: null });
  assert.equal(s.status, 200, JSON.stringify(s.data));
  assert.equal((await snapshot(p)).school.announcement.text, 'Fake: school closed on Friday.');
  assert.equal((await command(admin2.token, 'admin.clearAnnouncement')).status, 200);
  assert.equal((await snapshot(p)).school.announcement, null);
});

test('two-step policy: cannot be required while the accountant has no authenticator; reset two-step removes factors', async () => {
  const pol = await desk(admin2, 'two_step_policy');
  assert.equal(pol.status, 200);
  assert.equal(pol.data.result.required, false);
  assert.equal(pol.data.result.privileged.find(x => x.userId === admin.userId).enrolled, true);
  const on = await desk(admin2, 'set_two_step_policy', { required: true });
  assert.equal(on.status, 422, JSON.stringify(on.data));
  assert.equal(psql(`select value->>'required' from app_policy where key = 'two_step'`), 'false');
  // the accountant enrols; reset (as a principal would for a lost phone) removes the authenticator again
  const a = await enrollTotp(acct);
  assert.equal(psql(`select count(*) from two_step_enrolled where user_id = '${acct.userId}'`), '1');
  const reset = await desk(admin2, 'reset_two_step', { userId: acct.userId });
  assert.equal(reset.status, 200, JSON.stringify(reset.data));
  assert.equal(reset.data.result.factorsRemoved, 1);
  assert.equal(psql(`select count(*) from two_step_enrolled where user_id = '${acct.userId}'`), '0');
  void a;
});

test('resend invite: a guardian without a sign-in gets a new code once; one who signed in is refused', async () => {
  const g = await desk(admin2, 'resend_invite', { guardianId: 'grd-06' });
  assert.equal(g.status, 200, JSON.stringify(g.data));
  assert.match(g.data.result.code, /^[A-Z0-9]{5}-[A-Z0-9]{5}$/);
  assert.equal((await desk(admin2, 'resend_invite', { guardianId: 'grd-09' })).status, 422, 'grd-09 has signed in');
  assert.equal((await desk(admin2, 'resend_invite', { staffId: 'stf-teacher-pa' })).status, 422, 'teacher-pa has signed in');
});

test('resend invite (staff): the auth server mails an invite; its code signs the teacher in and links the staff role', async () => {
  const email = psql(`select email from staff_contacts where staff_id = 'stf-teacher-float'`);
  assert.ok(email.endsWith('@example.com'));
  const r = await desk(admin2, 'resend_invite', { staffId: 'stf-teacher-float' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.result, { sent: true });
  const uid = psql(`select id from auth.users where email = '${email}'`);
  assert.equal(psql(`select count(*) from app_users where user_id = '${uid}'`), '0', 'no role before the mailbox is confirmed');
  let msg = null;
  for (let i = 0; i < 20 && !msg; i++) {
    const list = await http('GET', `http://127.0.0.1:54324/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`);
    msg = (list.data?.messages || []).find(m => /invited/i.test(m.Subject));
    if (!msg) await new Promise(res => setTimeout(res, 250));
  }
  assert.ok(msg, 'the invite email reached the local mailbox');
  const body = await http('GET', `http://127.0.0.1:54324/api/v1/message/${msg.ID}`);
  const code = /\b(\d{6})\b/.exec(body.data.Text || body.data.HTML)?.[1];
  assert.ok(code, 'the invite carries a 6-digit code');
  const v = await http('POST', `${local().url}/auth/v1/verify`, { body: { type: 'email', email, token: code }, headers: { apikey: local().anon } });
  assert.equal(v.status, 200, JSON.stringify(v.data));
  assert.equal(psql(`select role || '/' || status from app_users where user_id = '${uid}'`), 'teacher/active', 'confirming the mailbox linked the staff role');
  assert.equal((await desk(admin2, 'resend_invite', { staffId: 'stf-teacher-float' })).status, 422, 'signed in: no second invite');
  await http('DELETE', `${local().url}/auth/v1/admin/users/${uid}`, { headers: { apikey: local().service, Authorization: `Bearer ${local().service}` } });
});

