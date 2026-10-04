// Real-app api (remote.js + remote-admin.js) for the administration module, against a fake Supabase client and a fake
// function caller (no network): each api method maps to the right supabase-js auth call or admin-accounts action.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSeed } from '../src/seed/seed-data.js';
import { createRemoteApi } from '../src/api/remote.js';
import { createSurface, ApiError, toApiError, op } from '../src/api/index.js';

const NOW = new Date(Date.UTC(2026, 9, 2, 5, 0, 0));
const ADMIN = { userId: 'u-admin', role: 'admin', staffId: 'stf-principal', guardianId: null };
const PARENT = { userId: 'u-parent', role: 'parent', staffId: null, guardianId: 'grd-02' };
const snapshotOf = (me, twoStep = { enrolled: false, required: false }) => ({ status: 'active', me, revs: {}, remindersSent: [], twoStep, ...buildSeed(NOW), auditLog: [] });

function fakeSb({ snapshots = [], tables = {}, factors = { all: [], totp: [] }, aal = 'aal1', errors = {} } = {}) {
  let session = { user: { id: 'u-admin', email: 'principal@example.com' }, access_token: 't' };
  const calls = [];
  const rec = (name, arg) => { calls.push([name, arg]); return errors[name] ? { data: null, error: errors[name] } : null; };
  const sb = {
    calls,
    auth: {
      getSession: async () => ({ data: { session } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signOut: async a => { rec('signOut', a); session = null; return {}; },
      signInWithPassword: async a => rec('signInWithPassword', a) || { data: {}, error: null },
      resetPasswordForEmail: async e => rec('resetPasswordForEmail', e) || { data: {}, error: null },
      verifyOtp: async a => rec('verifyOtp', a) || { data: {}, error: null },
      updateUser: async a => rec('updateUser', a) || { data: {}, error: null },
      refreshSession: async () => ({ data: { session } }),
      mfa: {
        listFactors: async () => ({ data: factors, error: null }),
        getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: aal, nextLevel: aal }, error: null }),
        enroll: async a => rec('mfa.enroll', a) || { data: { id: 'f-new', totp: { secret: 'JBSWY3DPEHPK3PXP', uri: 'otpauth://totp/x' } }, error: null },
        unenroll: async a => rec('mfa.unenroll', a) || { data: {}, error: null },
        challengeAndVerify: async a => { const r = rec('mfa.challengeAndVerify', a); if (r) return r; aal = 'aal2'; return { data: {}, error: null }; },
      },
    },
    rpc: async () => { const next = snapshots.shift(); if (!next) throw new Error('no snapshot queued'); return { data: next, error: null }; },
    from(table) {
      const q = { table, filters: [] };
      const b = {
        select(c) { q.select = c; return b; }, eq(c, v) { q.filters.push(['eq', c, v]); return b; }, order(c, o) { q.order = [c, o]; return b; },
        limit(n) { q.limit = n; return b; }, in() { return b; }, gte() { return b; }, range() { return b; },
        then(res, rej) { calls.push(['from', q]); return Promise.resolve(tables[table] ? tables[table](q) : { data: [], error: null }).then(res, rej); },
      };
      return b;
    },
    channel() { const ch = { on() { return ch; }, subscribe() { return ch; } }; return ch; },
    removeChannel() {},
  };
  return sb;
}
const make = (sb, call = async () => ({ result: null })) => createRemoteApi({ supabaseUrl: 'http://127.0.0.1:9', supabaseAnonKey: 'x' }, { createSurface, ApiError, toApiError, op, sb, call });
const named = (sb, n) => sb.calls.filter(c => c[0] === n).map(c => c[1]);

test('real api exposes the administration surface (contract names)', async () => {
  const api = await make(fakeSb({ snapshots: [snapshotOf(ADMIN)] }));
  for (const f of ['signInWithPassword', 'requestPasswordReset', 'verifyRecoveryCode', 'setPassword', 'signOutEverywhere']) assert.equal(typeof api.auth[f], 'function', `auth.${f}`);
  for (const f of ['status', 'enroll', 'verify', 'disable', 'demoCode']) assert.equal(typeof api.auth.twoStep[f], 'function', `auth.twoStep.${f}`);
  for (const f of ['list', 'block', 'unblock', 'signOutEverywhere', 'changeEmail', 'resendInvite', 'resetTwoStep', 'twoStepPolicy', 'setTwoStepPolicy']) assert.equal(typeof api.admin.accounts[f], 'function', `admin.accounts.${f}`);
  for (const f of ['set', 'clear']) assert.equal(typeof api.admin.announcement[f], 'function', `admin.announcement.${f}`);
  for (const f of ['signInActivity', 'whoCanSee', 'permissions', 'history']) assert.equal(typeof api.oversight[f], 'function', `oversight.${f}`);
  for (const f of ['list', 'file', 'update']) assert.equal(typeof api.rights[f], 'function', `rights.${f}`);
  assert.equal(typeof api.people.updateGuardian, 'function');
});

test('passwords: setPassword needs 8 characters and calls updateUser; reset never reveals the account; recovery code signs in', async () => {
  const sb = fakeSb({ snapshots: [snapshotOf(ADMIN), snapshotOf(ADMIN)], errors: { resetPasswordForEmail: { status: 400, message: 'User not found' } } });
  const api = await make(sb);
  await api.ready();
  await assert.rejects(api.auth.setPassword('short7!'), { code: 'VALIDATION' });
  assert.equal(named(sb, 'updateUser').length, 0, 'nothing sent for a short password');
  await api.auth.setPassword('long-enough-1');
  assert.deepEqual(named(sb, 'updateUser'), [{ password: 'long-enough-1' }]);
  await api.auth.requestPasswordReset(' Somebody@Example.com ');
  assert.deepEqual(named(sb, 'resetPasswordForEmail'), ['somebody@example.com'], 'an unknown address answers like a known one');
  await assert.rejects(api.auth.requestPasswordReset('nope'), { code: 'VALIDATION' });
  const st = await api.auth.verifyRecoveryCode('principal@example.com', ' 123456 ');
  assert.deepEqual(named(sb, 'verifyOtp'), [{ email: 'principal@example.com', token: '123456', type: 'recovery' }]);
  assert.equal(st.state, 'active');
});

test('passwords: a wrong pair is VALIDATION without saying which half; sign out everywhere uses scope global and drops the data', async () => {
  const sb = fakeSb({ snapshots: [snapshotOf(ADMIN)], errors: { signInWithPassword: { status: 400, message: 'Invalid login credentials' } } });
  const api = await make(sb);
  await api.ready();
  await assert.rejects(api.auth.signInWithPassword('principal@example.com', 'wrong-password'), e => e.code === 'VALIDATION' && !/password is wrong|no such/i.test(e.message));
  assert.deepEqual(named(sb, 'signInWithPassword'), [{ email: 'principal@example.com', password: 'wrong-password' }]);
  await api.auth.signOutEverywhere();
  assert.deepEqual(named(sb, 'signOut'), [{ scope: 'global' }]);
  assert.equal(api.getDb(), null);
});

test('two-step: status, enroll (an unfinished set-up replaced), verify → aal2 + reload, demoCode refused; a parent is refused', async () => {
  const sb = fakeSb({
    snapshots: [snapshotOf(ADMIN), snapshotOf(ADMIN, { enrolled: true, required: false })],
    factors: { all: [{ id: 'f-old', factor_type: 'totp', status: 'unverified' }], totp: [] },
    tables: { app_policy: () => ({ data: [{ value: { required: true } }], error: null }) },
  });
  const api = await make(sb);
  await api.ready();
  assert.deepEqual(await api.auth.twoStep.status(), { enrolled: false, verified: false, required: true, factorId: null });
  const e = await api.auth.twoStep.enroll();
  assert.deepEqual(e, { factorId: 'f-new', secret: 'JBSWY3DPEHPK3PXP', uri: 'otpauth://totp/x' });
  assert.deepEqual(named(sb, 'mfa.unenroll'), [{ factorId: 'f-old' }]);
  assert.equal(named(sb, 'mfa.enroll')[0].factorType, 'totp');
  assert.deepEqual(await api.auth.twoStep.verify('f-new', '123 456'), { verified: true });
  assert.deepEqual(named(sb, 'mfa.challengeAndVerify'), [{ factorId: 'f-new', code: '123456' }]);
  assert.deepEqual((await api.auth.status()).twoStep, { enrolled: true, verified: true, required: false });
  await assert.rejects(api.auth.twoStep.demoCode(), { code: 'NOT_ALLOWED' });
  const p = await make(fakeSb({ snapshots: [snapshotOf(PARENT)] }));
  await p.ready();
  await assert.rejects(p.auth.twoStep.enroll(), { code: 'NOT_ALLOWED' });
});

test('auth.status: two_step_required and blocked come through with the role\'s twoStep state; no school data', async () => {
  const gate = { status: 'two_step_required', me: { role: 'accountant' }, twoStep: { enrolled: false, required: true } };
  const api = await make(fakeSb({ snapshots: [gate] }));
  assert.deepEqual(await api.auth.status(), { state: 'two_step_required', email: 'principal@example.com', twoStep: { enrolled: false, verified: false, required: true } });
  assert.equal(api.getDb(), null);
  await assert.rejects(api.people.students(), { code: 'NOT_ALLOWED' });
  const b = await make(fakeSb({ snapshots: [{ status: 'blocked' }] }));
  assert.deepEqual(await b.auth.status(), { state: 'blocked', email: 'principal@example.com' });
});

test('account desk: each action is one admin-accounts call with a request id; who-can-see uses the desk\'s links and consent', async () => {
  const bodies = [];
  const directory = [
    { userId: 'u-parent', personKind: 'guardian', personId: 'grd-02', role: 'parent', status: 'blocked' },
    { userId: null, personKind: 'guardian', personId: 'grd-03', role: 'parent', status: 'invited' },
  ];
  const call = async (fn, body) => { bodies.push({ fn, ...structuredClone(body) }); return { result: body.action === 'directory' ? directory : { ok: body.action } }; };
  const snap = snapshotOf(ADMIN);
  snap.consents = snap.consents.filter(c => c.guardianId !== 'grd-02'); // grd-02 has not accepted the notice in this snapshot
  const api = await make(fakeSb({ snapshots: [snap] }), call);
  await api.ready();
  await api.admin.accounts.block('u-parent');
  await api.admin.accounts.resendInvite({ guardianId: 'grd-03' });
  await api.admin.accounts.setTwoStepPolicy({ required: true });
  assert.deepEqual(bodies.map(b => [b.fn, b.action]), [['admin-accounts', 'block'], ['admin-accounts', 'resend_invite'], ['admin-accounts', 'set_two_step_policy']]);
  assert.equal(bodies[0].userId, 'u-parent'); assert.equal(bodies[1].guardianId, 'grd-03'); assert.equal(bodies[2].required, true);
  assert.ok(bodies.every(b => /^[A-Za-z0-9_-]{8,100}$/.test(b.requestId)));
  const w = await api.oversight.whoCanSee('stu-04');
  const g2 = w.viewers.find(v => v.id === 'grd-02');
  assert.equal(g2.signIn, 'blocked', 'sign-in status from the desk');
  assert.equal(g2.sees, false, 'without app_account consent the real app shows the parent as not seeing');
});

test('oversight.signInActivity: sign_in_events newest first, named through admin.users; principal only', async () => {
  const rows = [{ user_id: 'u-parent', at: '2026-10-02T05:00:00Z', aal: 'aal1' }, { user_id: 'u-gone', at: '2026-10-01T05:00:00Z', aal: null }];
  const sb = fakeSb({ snapshots: [snapshotOf(ADMIN)], tables: { sign_in_events: () => ({ data: rows, error: null }) } });
  const call = async (fn, body) => ({ result: body.name === 'admin.users' ? [{ id: 'u-parent', role: 'parent', name: 'Fake Parent' }] : null });
  const api = await make(sb, call);
  await api.ready();
  const out = await api.oversight.signInActivity({ limit: 5000 });
  assert.deepEqual(out, [{ at: rows[0].at, userId: 'u-parent', name: 'Fake Parent', role: 'parent', aal: 'aal1' }, { at: rows[1].at, userId: 'u-gone', name: null, role: null, aal: null }]);
  const q = sb.calls.find(c => c[0] === 'from' && c[1].table === 'sign_in_events')[1];
  assert.deepEqual(q.order, ['at', { ascending: false }]); assert.equal(q.limit, 1000, 'capped');
  const p = await make(fakeSb({ snapshots: [snapshotOf(PARENT)] }));
  await p.ready();
  await assert.rejects(p.oversight.signInActivity(), { code: 'NOT_ALLOWED' });
});
