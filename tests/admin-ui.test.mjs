// Administration UI, without a DOM: screens are drawn against a minimal fake element and the real demo api (seeded), in
// the style of phase3-ui.test.mjs. Proves who sees what, that every interpolated value is escaped (one hostile string
// pushed through names, request text and the banner), the actions call the right api methods, the sign-in/two-step
// flows, and the wiring (routes, nav, gate states) in app.js and shell.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createApi, api as singleton } from '../src/api/index.js';
import { buildSeed } from '../src/seed/seed-data.js';
import { memoryBackend } from '../src/store/storage.js';
import { totp } from '../src/api/totp.js';
import { href } from '../src/ui/router.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const NOW = new Date(Date.UTC(2026, 10, 2, 5, 0, 0));
const EVIL = '"><img src=x onerror=alert(1)><script>alert(2)</script>';
const ADMIN = 'persona-stf-principal', ACCOUNTANT = 'persona-stf-accountant', TEACHER = 'persona-stf-teacher-pa', PARENT = 'persona-grd-02';

// ---------------------------------------------------------------- harness
function fake() {
  const children = new Map();
  let html = '';
  const el = {
    value: '', checked: false, disabled: false, textContent: '', className: '', files: [], dataset: {}, handlers: {}, children, isConnected: true,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener(t, f) { (el.handlers[t] ||= []).push(f); },
    querySelector(sel) { if (!children.has(sel)) children.set(sel, fake()); return children.get(sel); },
    querySelectorAll() { return []; },
    closest: () => null, appendChild() {}, remove() {}, focus() {}, insertAdjacentHTML(_w, h) { html += h; },
  };
  Object.defineProperty(el, 'innerHTML', { get: () => html, set: (v) => { html = v; children.clear(); } });
  return el;
}
const dialogs = [];
globalThis.document = {
  createElement: (tag) => {
    const d = fake(); const h = {};
    d.addEventListener = (t, f) => { (h[t] ||= []).push(f); };
    d.showModal = () => {
      dialogs.push(d);
      const n = (d.innerHTML.match(/data-act="/g) || []).length;
      // an auto-answering stub: confirmation dialogs get their LAST button (Confirm)
      if (tag === 'dialog' && n) queueMicrotask(() => h.click?.forEach((f) => f({ target: { closest: () => ({ hasAttribute: () => false, dataset: { act: String(n - 1) } }) } })));
    };
    d.close = () => {};
    return d;
  },
  body: { appendChild() {} }, head: { appendChild() {} }, getElementById: () => null, addEventListener() {}, visibilityState: 'visible',
};
globalThis.location ??= { hash: '', reload() {} };

async function mkApi() {
  const api = createApi({ backend: memoryBackend(), sessionBackend: memoryBackend(), seedFn: () => buildSeed(NOW), clock: () => NOW });
  await api.ready();
  return api;
}
function makeCtx(api, { query = {}, params = {} } = {}) {
  const toasts = [], went = [];
  const ctx = {
    api, persona: api.session.current(), query, params, el: fake(), toasts, went,
    get db() { return api.getDb(); },
    go: (...a) => went.push(a), setQuery: (p) => went.push(['setQuery', p]), href, toast: (m, k) => toasts.push([m, k]), onChange() {}, cleanup() {},
    rerender: () => { ctx.rerendered = (ctx.rerendered || 0) + 1; },
  };
  return ctx;
}
const page = (ctx, bodyId = '#ad-body') => ctx.el.innerHTML + (ctx.el.children.get(bodyId)?.innerHTML ?? '');
const fire = async (el, type, matches = {}, target = {}) => {
  for (const f of [...(el.handlers[type] || [])]) Promise.resolve(f({ target: { closest: (sel) => matches[sel] ?? null, ...target }, preventDefault() {} })).catch((e) => { el.lastError = e; });
  await new Promise((r) => setTimeout(r, 20));
};
const noRaw = (html, what) => {
  assert.ok(!html.includes('<img src=x'), `${what}: raw <img>`);
  assert.ok(!html.includes('<script>alert'), `${what}: raw <script>`);
  assert.ok(!/"><img src=x/.test(html), `${what}: attribute breakout`);
};
const Admin = await import('../src/ui/screens/admin.js');
const Account = await import('../src/ui/screens/account.js');
const Audit = await import('../src/ui/screens/audit.js');
const { renderTwoStep } = await import('../src/ui/two-step.js');
const { renderLogin } = await import('../src/ui/login.js');
const { announcementBanner } = await import('../src/ui/components.js');
const draw = async (api, who, tab, query = {}) => { api.session.set(who); const ctx = makeCtx(api, { query: { tab, ...query } }); await Admin.render(ctx); return ctx; };

// ---------------------------------------------------------------- Accounts desk
test('accounts: every person listed; no Block on your own row; Block asks for confirmation and blocks; a blocked row offers Unblock', async () => {
  const api = await mkApi();
  let ctx = await draw(api, ADMIN, 'accounts');
  const html = page(ctx);
  assert.match(html, /Demo: blocking, two-step/);
  assert.ok(html.includes('principal@example.com') && html.includes('teacher-pa@example.com') && html.includes('meena.notrealsen1@example.com'));
  assert.match(html, /\(you\)/);
  assert.ok(!html.includes(`data-act="block" data-user="${ADMIN}"`), 'no self-block button');
  assert.ok(html.includes(`data-act="block" data-user="${TEACHER}"`));
  assert.ok(!/data-act="invite"/.test(html), 'demo: no invites');
  const nBefore = dialogs.length;
  const host = ctx.el.children.get('#ad-body');
  await fire(host, 'click', { '[data-act]': { dataset: { act: 'block', user: TEACHER, name: 'Teacher' } } });
  assert.equal(dialogs.length, nBefore + 1, 'a confirmation was asked');
  assert.match(dialogs.at(-1).innerHTML, /Block account/);
  assert.equal((await api.admin.accounts.list()).find((r) => r.userId === TEACHER).status, 'blocked');
  assert.equal(ctx.rerendered, 1);
  ctx = await draw(api, ADMIN, 'accounts');
  assert.ok(page(ctx).includes(`data-act="unblock" data-user="${TEACHER}"`));
  assert.ok(!page(ctx).includes(`data-act="block" data-user="${TEACHER}"`));
});

test('accounts: the search box filters by name, email or role', async () => {
  const api = await mkApi();
  const ctx = await draw(api, ADMIN, 'accounts', { q: 'accountant' });
  const html = page(ctx);
  assert.ok(html.includes('accountant@example.com') && !html.includes('teacher-pa@example.com'));
});

test('accounts: hostile names are escaped everywhere; non-principals get nothing from the api', async () => {
  const api = await mkApi();
  api.session.set(ADMIN);
  await api.people.updateGuardian({ guardianId: 'grd-02', firstName: EVIL });
  const ctx = await draw(api, ADMIN, 'accounts');
  noRaw(page(ctx), 'accounts');
  assert.match(page(ctx), /&lt;script&gt;/);
  api.session.set(TEACHER);
  const bad = makeCtx(api, { query: { tab: 'accounts' } });
  await Admin.render(bad);
  assert.match(page(bad), /could not be loaded/i, 'a teacher who somehow reaches the screen sees an error, not a list');
  assert.ok(!page(bad).includes('principal@example.com'));
});

// ---------------------------------------------------------------- Oversight
test('oversight: activity, history with names, who-can-see for a chosen child, and the whole permission matrix', async () => {
  const api = await mkApi();
  api.session.set(PARENT);
  await api.rights.file({ kind: 'export', details: EVIL });
  let ctx = await draw(api, ADMIN, 'oversight');
  let html = page(ctx);
  for (const h of ['Sign-in activity', 'Change history', 'Who can see this child', 'Permission matrix']) assert.ok(html.includes(h), h);
  assert.match(html, /Priyanka Demoson/, 'actor names in the history and activity');
  noRaw(html, 'oversight');
  const m = await api.oversight.permissions();
  for (const c of m.capabilities) assert.ok(html.includes(c.label.replace(/'/g, '&#39;').replace(/"/g, '&quot;')), `matrix row: ${c.label}`);
  for (const a of m.actors) assert.ok(html.includes(a.label), `matrix column: ${a.label}`);
  assert.ok(html.includes('Choose a child to see'));
  ctx = await draw(api, ADMIN, 'oversight', { student: 'stu-03' });
  html = page(ctx);
  assert.match(html, /Why they can see/);
  assert.ok(html.includes('Priyanka Demoson') && html.includes('Principal: every child'));
  assert.ok(!html.includes('Choose a child to see'));
});

test('oversight: one failing section reports itself and the others still draw', async () => {
  const api = await mkApi();
  api.session.set(ADMIN);
  const ctx = makeCtx(api, { query: { tab: 'oversight' } });
  ctx.api = { ...api, oversight: { ...api.oversight, signInActivity: async () => { throw new Error('activity offline'); } }, people: api.people, rights: api.rights };
  await Admin.render(ctx);
  const html = page(ctx);
  assert.match(html, /activity offline/);
  assert.ok(html.includes('Permission matrix') && html.includes('Change history'));
});

// ---------------------------------------------------------------- Data requests
test('data requests: open ones shown with the parent, details escaped, closed hidden until asked; Start moves it on; closing asks for an answer', async () => {
  const api = await mkApi();
  api.session.set(PARENT);
  const a = await api.rights.file({ kind: 'correction', details: EVIL });
  const b = await api.rights.file({ kind: 'export' });
  api.session.set(ADMIN);
  await api.rights.update(b.id, { status: 'done', resolution: 'Sent.' });
  let ctx = await draw(api, ADMIN, 'requests');
  let html = page(ctx);
  noRaw(html, 'requests');
  assert.ok(html.includes('Priyanka Demoson') && html.includes('Correct my details'));
  assert.ok(!html.includes('Copy of my data'), 'the closed request is hidden');
  assert.match(html, /Closing a request needs a written answer/);
  assert.ok(html.includes(`data-act="start" data-id="${a.id}"`) && html.includes(`data-act="done" data-id="${a.id}"`) && html.includes(`data-act="declined" data-id="${a.id}"`));
  ctx = await draw(api, ADMIN, 'requests', { closed: '1' });
  html = page(ctx);
  assert.ok(html.includes('Copy of my data') && html.includes('Sent.'));
  assert.ok(html.includes(`data-act="export" data-guardian="grd-02"`), 'a closed export can still be downloaded');
  const host = ctx.el.children.get('#ad-body');
  await fire(host, 'click', { '[data-act]': { dataset: { act: 'start', id: a.id } } });
  assert.equal((await api.rights.list()).find((r) => r.id === a.id).status, 'in_progress');
  assert.equal(ctx.rerendered, 1);
});

// ---------------------------------------------------------------- Announcement
test('announcement tab: publishes through the api, refuses empty and over-long text before calling it, and can remove the notice', async () => {
  const api = await mkApi();
  let ctx = await draw(api, ADMIN, 'announcement');
  const host = ctx.el.children.get('#ad-body');
  const form = host.querySelector('#an-form');
  assert.match(page(ctx), /No notice is showing/);
  host.querySelector('#an-text').value = 'x'.repeat(281);
  host.querySelector('#an-tone').value = 'warn';
  host.querySelector('#an-until').value = '';
  await fire(form, 'submit');
  assert.match(host.querySelector('#an-err').textContent, /280/);
  assert.equal(api.getDb().school.announcement, null);
  host.querySelector('#an-text').value = '';
  await fire(form, 'submit');
  assert.match(host.querySelector('#an-err').textContent, /message first/);
  host.querySelector('#an-text').value = 'School closes at noon on Friday.';
  host.querySelector('#an-until').value = '2026-11-09';
  await fire(form, 'submit');
  assert.equal(api.getDb().school.announcement.tone, 'warn');
  assert.equal(api.getDb().school.announcement.until, '2026-11-09');
  ctx = await draw(api, ADMIN, 'announcement');
  assert.match(page(ctx), /Showing now:<\/strong> School closes at noon on Friday\./);
  assert.ok(ctx.el.children.get('#ad-body').querySelector('#an-clear'), 'a remove button exists');
  await fire(ctx.el.children.get('#ad-body').querySelector('#an-clear'), 'click');
  assert.equal(api.getDb().school.announcement, null);
});

test('announcement banner: escaped even if the stored text is hostile, tone picks the colour, and it stops after its last day', () => {
  const evil = { text: EVIL, tone: 'warn', until: null };
  const html = announcementBanner(evil, '2026-11-02');
  noRaw(html, 'banner');
  assert.match(html, /class="banner warn"/);
  assert.match(html, /School notice:/);
  assert.match(announcementBanner({ text: 'Hello', tone: 'info' }, '2026-11-02'), /class="banner info"/);
  assert.match(announcementBanner({ text: 'Hello', tone: 'bogus' }, '2026-11-02'), /class="banner info"/);
  assert.notEqual(announcementBanner({ text: 'Hello', tone: 'info', until: '2026-11-02' }, '2026-11-02'), '', 'the last day still shows');
  assert.equal(announcementBanner({ text: 'Hello', tone: 'info', until: '2026-11-01' }, '2026-11-02'), '');
  assert.equal(announcementBanner(null, '2026-11-02'), '');
  assert.equal(announcementBanner({ text: '', tone: 'info' }, '2026-11-02'), '');
});

// ---------------------------------------------------------------- Two-step policy
test('two-step policy: the demo lists who has set up an authenticator and has no requirement switch', async () => {
  const api = await mkApi();
  api.session.set(ADMIN);
  const en = await api.auth.twoStep.enroll();
  await api.auth.twoStep.verify(en.factorId, await totp(en.secret, NOW.getTime()));
  const ctx = await draw(api, ADMIN, 'twostep');
  const html = page(ctx);
  assert.match(html, /Not required yet/);
  assert.ok(html.includes('Set up') && html.includes('Not set up'));
  assert.ok(!html.includes('id="tp-on"') && !html.includes('id="tp-off"'));
  assert.match(html, /Demo: the requirement itself/);
});

test('two-step policy (real app): "Require for all" is disabled until everyone has an authenticator, then asks for confirmation and calls setTwoStepPolicy', async () => {
  const calls = [];
  const mkPol = (enrolledAll) => ({ required: false, privileged: [{ userId: 'u1', name: 'P One', role: 'admin', enrolled: true }, { userId: 'u2', name: 'A Two', role: 'accountant', enrolled: enrolledAll }] });
  const prevMode = singleton.mode;
  singleton.mode = 'supabase'; // the screens ask the api which mode they run in
  try {
    const run = async (pol) => {
      const ctx = makeCtx(await mkApi());
      ctx.query = { tab: 'twostep' };
      ctx.api = { rights: { list: async () => [] }, admin: { accounts: { twoStepPolicy: async () => pol, setTwoStepPolicy: async (a) => { calls.push(a); } } } };
      await Admin.render(ctx);
      return ctx;
    };
    let ctx = await run(mkPol(false));
    assert.match(page(ctx), /id="tp-on" type="button" disabled/);
    ctx = await run(mkPol(true));
    assert.ok(!/id="tp-on" type="button" disabled/.test(page(ctx)));
    await fire(ctx.el.children.get('#ad-body').querySelector('#tp-on'), 'click');
    assert.deepEqual(calls, [{ required: true }]);
  } finally { singleton.mode = prevMode; }
});

// ---------------------------------------------------------------- Account
test('account: everyone gets password and sign-out-everywhere; two-step only for the principal and accountant; the data-request form only for parents', async () => {
  const api = await mkApi();
  const view = async (who) => { api.session.set(who); const ctx = makeCtx(api); await Account.render(ctx); return ctx; };
  for (const who of [ADMIN, ACCOUNTANT]) { const h = page(await view(who), '#ac-two-step'); assert.ok(h.includes('Two-step sign-in') && h.includes('Sign out everywhere') && h.includes('ac-pw-form'), who); }
  for (const who of [TEACHER, PARENT]) { const h = (await view(who)).el.innerHTML; assert.ok(!h.includes('ac-two-step'), who); assert.ok(h.includes('ac-pw-form') && h.includes('ac-out-all')); }
  assert.ok(!(await view(TEACHER)).el.innerHTML.includes('ac-rights'));
  const p = await view(PARENT);
  assert.ok(p.el.innerHTML.includes('ac-rights'));
  assert.match(page(p, '#ac-rights'), /Send request/);
  assert.match((await view(ADMIN)).el.innerHTML, /principal@example\.com/);
});

test('account: a short password is refused in the form without calling the api; a good one is saved; the password is never put into the page', async () => {
  const api = await mkApi();
  api.session.set(TEACHER);
  const ctx = makeCtx(api);
  const saved = [];
  const real = api.auth.setPassword;
  api.auth.setPassword = async (pw) => { saved.push(pw); return real(pw); };
  await Account.render(ctx);
  const form = ctx.el.querySelector('#ac-pw-form');
  ctx.el.querySelector('#ac-pw').value = 'short';
  await fire(form, 'submit');
  assert.match(ctx.el.querySelector('#ac-pw-err').textContent, /at least 8/);
  assert.deepEqual(saved, []);
  ctx.el.querySelector('#ac-pw').value = 'long enough pw';
  await fire(form, 'submit');
  assert.deepEqual(saved, ['long enough pw']);
  assert.equal(ctx.el.querySelector('#ac-pw').value, '', 'the field is cleared after saving');
  assert.ok(!ctx.el.innerHTML.includes('long enough pw'));
});

test('account: a parent files a request through the form and sees it with its status and the principal\'s answer, escaped', async () => {
  const api = await mkApi();
  api.session.set(PARENT);
  let ctx = makeCtx(api);
  await Account.render(ctx);
  const host = ctx.el.querySelector('#ac-rights');
  host.querySelector('#rt-kind').value = 'correction';
  host.querySelector('#rt-details').value = EVIL;
  await fire(host.querySelector('#rt-form'), 'submit');
  const list = await api.rights.list();
  assert.equal(list.length, 1);
  api.session.set(ADMIN);
  await api.rights.update(list[0].id, { status: 'declined', resolution: EVIL });
  api.session.set(PARENT);
  ctx = makeCtx(api);
  await Account.render(ctx);
  const html = page(ctx, '#ac-rights');
  noRaw(html, 'account requests');
  assert.ok(html.includes('Correct my details') && html.includes('Declined') && html.includes('Answer:'));
  // a second open request of the same kind is refused by the command and shown in the form, not swallowed
  const again = makeCtx(api); await Account.render(again);
  const h2 = again.el.querySelector('#ac-rights');
  h2.querySelector('#rt-kind').value = 'erasure';
  await fire(h2.querySelector('#rt-form'), 'submit');
  await fire(h2.querySelector('#rt-form'), 'submit');
  assert.match(h2.querySelector('#rt-err').textContent, /already have an open/);
});

// ---------------------------------------------------------------- two-step screens
test('two-step gate: set up shows the secret and the otpauth link as text plus the demo authenticator; the live code opens it; a wrong code does not', async () => {
  const api = singleton;
  // the gate screen uses the singleton demo api (memory-backed here); seed it and sign in as the accountant
  await api.ready();
  api.session.set(ACCOUNTANT);
  let done = 0, out = 0;
  const rootEl = fake();
  await renderTwoStep(rootEl, { onDone: () => { done++; }, onSignOut: () => { out++; }, email: 'accountant@example.com', signOutLabel: 'Choose another person' });
  assert.match(rootEl.innerHTML, /Two-step sign-in/);
  assert.match(rootEl.innerHTML, /Choose another person/);
  const host = rootEl.querySelector('#ts-host');
  assert.match(host.innerHTML, /Set up an authenticator app/);
  await fire(host.querySelector('#ts-start'), 'click', {});
  assert.match(host.innerHTML, /Demo authenticator/);
  const secret = host.innerHTML.match(/id="ts-secret">([A-Z2-7]{32})</)?.[1];
  assert.ok(secret, 'the secret is shown as text');
  assert.match(host.innerHTML, /otpauth:\/\/totp\//);
  host.querySelector('#ts-code').value = '000000';
  await fire(host.querySelector('#ts-form'), 'submit');
  assert.equal(done, 0);
  assert.match(host.querySelector('#ts-err').textContent, /not accepted/);
  host.querySelector('#ts-code').value = '12';
  await fire(host.querySelector('#ts-form'), 'submit');
  assert.match(host.querySelector('#ts-err').textContent, /6 digits/);
  host.querySelector('#ts-code').value = (await api.auth.twoStep.demoCode()).code;
  await fire(host.querySelector('#ts-form'), 'submit');
  assert.equal(done, 1, 'the code opened the gate');
  assert.equal((await api.auth.status()).state, 'demo');
  await fire(rootEl.querySelector('#ts-out'), 'click');
  assert.equal(out, 1);
  await api.auth.twoStep.disable((await api.auth.twoStep.status()).factorId);
});

test('two-step panel in Account: on shows a turn-off button; the principal can turn it off after confirming', async () => {
  const api = await mkApi();
  api.session.set(ADMIN);
  const en = await api.auth.twoStep.enroll();
  await api.auth.twoStep.verify(en.factorId, await totp(en.secret, NOW.getTime()));
  const ctx = makeCtx(api);
  await Account.render(ctx);
  const host = ctx.el.querySelector('#ac-two-step');
  assert.match(host.innerHTML, /Two-step sign-in is on/);
  await fire(host.querySelector('#ts-off'), 'click');
  assert.equal((await api.auth.twoStep.status()).enrolled, false);
});

// ---------------------------------------------------------------- sign-in screen
test('sign-in: the emailed code stays the default; "Use a password" signs in with email and password', async () => {
  const rootEl = fake();
  const calls = [];
  const a = singleton.auth;
  const keep = { signInWithOtp: a.signInWithOtp, signInWithPassword: a.signInWithPassword };
  a.signInWithOtp = async (e) => { calls.push(['otp', e]); };
  a.signInWithPassword = async (e, p) => { calls.push(['pw', e, p]); return { state: 'active', email: e }; };
  try {
    let signedIn = null;
    renderLogin(rootEl, { onDone: (v) => { signedIn = v; } });
    assert.match(rootEl.innerHTML, /Email me a code/);
    assert.match(rootEl.innerHTML, /id="lg-use-pw"/);
    assert.ok(!rootEl.innerHTML.includes('id="lg-pw"'));
    await fire(rootEl.querySelector('#lg-use-pw'), 'click');
    assert.match(rootEl.innerHTML, /Sign in with a password/);
    rootEl.querySelector('#lg-email').value = 'not an email';
    await fire(rootEl.querySelector('#lg-form'), 'submit');
    assert.match(rootEl.querySelector('#lg-err').textContent, /valid email/);
    rootEl.querySelector('#lg-email').value = 'teacher@example.com';
    rootEl.querySelector('#lg-pw').value = 'my password 1';
    await fire(rootEl.querySelector('#lg-form'), 'submit');
    assert.deepEqual(calls, [['pw', 'teacher@example.com', 'my password 1']]);
    assert.deepEqual(signedIn, { state: 'active', email: 'teacher@example.com' });
    // the way back to the emailed code keeps the typed address
    renderLogin(rootEl, { onDone() {} });
    await fire(rootEl.querySelector('#lg-use-pw'), 'click');
    rootEl.querySelector('#lg-email').value = 'back@example.com';
    await fire(rootEl.querySelector('#lg-back'), 'click');
    assert.match(rootEl.innerHTML, /value="back@example.com"/);
  } finally { Object.assign(a, keep); }
});

test('sign-in: forgot password asks for a recovery code (never says whether the address exists), then sets the new password after the code signs in', async () => {
  const rootEl = fake();
  const calls = [];
  const a = singleton.auth;
  const keep = { requestPasswordReset: a.requestPasswordReset, verifyRecoveryCode: a.verifyRecoveryCode, setPassword: a.setPassword };
  a.requestPasswordReset = async (e) => { calls.push(['reset', e]); };
  a.verifyRecoveryCode = async (e, c) => { calls.push(['verify', e, c]); return { state: 'active', email: e }; };
  a.setPassword = async (p) => { calls.push(['set', p]); };
  try {
    let signedIn = null;
    renderLogin(rootEl, { onDone: (v) => { signedIn = v; } });
    await fire(rootEl.querySelector('#lg-use-pw'), 'click');
    await fire(rootEl.querySelector('#lg-forgot'), 'click');
    assert.match(rootEl.innerHTML, /Forgot password/);
    rootEl.querySelector('#lg-email').value = 'someone@example.com';
    await fire(rootEl.querySelector('#lg-form'), 'submit');
    assert.deepEqual(calls, [['reset', 'someone@example.com']]);
    assert.match(rootEl.innerHTML, /If <strong>someone@example.com<\/strong> has an account/);
    rootEl.querySelector('#lg-code').value = '123456';
    rootEl.querySelector('#lg-pw').value = 'short';
    await fire(rootEl.querySelector('#lg-form'), 'submit');
    assert.match(rootEl.querySelector('#lg-err').textContent, /at least 8/);
    assert.equal(calls.length, 1, 'nothing sent for a short password');
    rootEl.querySelector('#lg-pw').value = 'a brand new password';
    await fire(rootEl.querySelector('#lg-form'), 'submit');
    assert.deepEqual(calls.slice(1), [['verify', 'someone@example.com', '123456'], ['set', 'a brand new password']], 'the code signs in first, then the password is saved');
    assert.deepEqual(signedIn, { state: 'active', email: 'someone@example.com' });
  } finally { Object.assign(a, keep); }
});

// ---------------------------------------------------------------- audit screen
test('audit screen: reads history with names, shows the Who column as a name, and filters by record id', async () => {
  const seen = [];
  const rows = [{ id: 'a1', ts: '2026-11-02T05:00:00Z', actorRole: 'admin', actorName: 'Pat Principal', entity: 'invoice', entityId: 'inv-1', action: 'create', summary: EVIL }, { id: 'a2', ts: '2026-11-02T04:00:00Z', actorRole: 'system', actorName: null, entity: 'invoice', entityId: 'inv-1', action: 'late', summary: 's' }];
  const ctx = makeCtx(await mkApi(), { query: { entityId: 'inv-1' } });
  ctx.api = { oversight: { history: async (q) => { seen.push(q); return rows; } } };
  await Audit.render(ctx);
  assert.deepEqual(seen.at(-1), { entity: undefined, entityId: 'inv-1', limit: 100 });
  const html = ctx.el.innerHTML;
  assert.ok(html.includes('Pat Principal') && html.includes('>system<'), 'a name when known, the role otherwise');
  noRaw(html, 'audit');
  assert.match(html, /id="au-eid"[^>]*value="inv-1"/);
  await fire(ctx.el.querySelector('#au-eid'), 'change', {}, { value: ' inv-2 ' });
  assert.deepEqual(ctx.went.at(-1), ['setQuery', { entityId: 'inv-2' }]);
});

// ---------------------------------------------------------------- wiring
test('app.js: /admin for the principal, /account for every role incl. the demo, both gate states, the demo gate and the banner', () => {
  const app = read('src/ui/app.js');
  assert.match(app, /pattern: '\/admin', roles: \['admin'\]/);
  assert.match(app, /pattern: '\/account', roles: ALL, demoRoles: ALL/);
  assert.match(app, /case 'blocked': renderBlocked\(root, 'blocked'/);
  assert.match(app, /case 'two_step_required': renderTwoStep\(root/);
  assert.match(app, /if \(!REAL\) return demoGate\(\)/);
  assert.match(app, /announcementBanner\(api\.getDb\(\)\?\.school\?\.announcement/);
  const render = app.slice(app.indexOf('async function renderRoute'));
  assert.ok(render.indexOf('await gate()') > 0 && render.indexOf('await gate()') < render.indexOf('ensureShell(persona)'), 'the gate comes before any screen');
});

test('shell: the principal has Administration; nobody else does; the demo bar links to Account', async () => {
  const { NAV, navFor, renderShell } = await import('../src/ui/shell.js');
  assert.ok(NAV.admin.includes('administration'));
  for (const r of ['teacher', 'accountant', 'parent', 'driver']) assert.ok(!NAV[r].includes('administration'), r);
  assert.equal(navFor('admin').find((i) => i.path === '/admin').label, 'Administration');
  const rootEl = fake();
  renderShell(rootEl, { school: { name: 'S' }, personas: { featured: [], others: [] }, current: { id: 'x', role: 'teacher', label: 'T' }, real: false });
  assert.match(rootEl.innerHTML, /href="#\/account"/);
});

test('UI source: new screens keep the project rules (no app config / remote / network, only api + helpers imported, tokens only in new css)', () => {
  const files = ['src/ui/two-step.js', 'src/ui/screens/admin.js', 'src/ui/screens/account.js', 'src/ui/login.js'];
  for (const f of files) {
    const s = read(f);
    assert.ok(!/__APP_CONFIG__|remote\.js|supabase|fetch\(/i.test(s), `${f} must not name the real-app plumbing or call the network`);
    for (const m of s.matchAll(/from '([^']+)'/g)) assert.ok(/(^|\/)(api\/index|components|mode|login|two-step|privacy|account|dates)\.js$/.test(m[1]), `${f} imports ${m[1]}`);
  }
  const css = read('app.css');
  const section = css.slice(css.indexOf('administration: two-step setup'), css.indexOf('.consent-row'));
  assert.ok(section.length > 200 && !/#[0-9a-fA-F]{3,8}\b/.test(section), 'tokens only');
});
