// Wave 1, go-live operations: the nightly job's result reaches the principal (#90), fee reminders are not settled
// while push keys are missing (#99), Android install path and invite-slip step (#80), honest rate-limit text (#92),
// and the backup script's safety checks (#91).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi, createSurface, ApiError, toApiError, op } from '../src/api/index.js';
import { createRemoteApi } from '../src/api/remote.js';
import { buildSeed } from '../src/seed/seed-data.js';
import { memoryBackend } from '../src/store/storage.js';
import { execute, systemPersona, buildPersonas, COMMANDS } from '../src/domain/commands.js';
import { nightlyJobStatus, NIGHTLY_STALE_MS } from '../src/domain/admin.js';
import { failedStepsOf, reminderStatus, healthcheckUrl } from '../supabase/functions/_shared/cron.js';
import { href } from '../src/ui/router.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NOW = new Date();
const ADMIN = 'persona-stf-principal', PARENT = 'persona-grd-01';

// ---- a minimal browser: window events for the install prompt, a fake DOM for the screens
const winHandlers = {};
globalThis.window = { addEventListener(t, f) { (winHandlers[t] ||= []).push(f); }, matchMedia: () => ({ matches: false }), isSecureContext: true };
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/130.0 Mobile', platform: 'Linux', maxTouchPoints: 5 }, configurable: true });
const fire = (t, e = {}) => { for (const f of winHandlers[t] || []) f(e); };

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
globalThis.document ??= { createElement: () => fake(), body: { appendChild() {} }, head: { appendChild() {} }, getElementById: () => null, addEventListener() {}, visibilityState: 'visible', baseURI: 'https://school.example.com/app/' };
globalThis.location ??= { hash: '', href: 'https://school.example.com/app/#/print/invites', reload() {} };

async function mkApi() {
  const api = createApi({ backend: memoryBackend(), sessionBackend: memoryBackend(), seedFn: () => buildSeed(NOW), clock: () => NOW });
  await api.ready();
  return api;
}
async function draw(api, who, mod, query = {}) {
  api.session.set(who);
  const ctx = { api, persona: api.session.current(), query, params: {}, el: fake(), get db() { return api.getDb(); },
    go() {}, setQuery() {}, href, toast() {}, onChange() {}, cleanup() {}, rerender() {} };
  await mod.render(ctx);
  return ctx;
}

const Home = await import('../src/ui/screens/home.js');
const Install = await import('../src/ui/install.js');
const Slips = await import('../src/ui/screens/invites-print.js');

// ---------------------------------------------------------------- #99 fee reminders and missing push keys

test('#99 a reminder is not settled as "sent" while push keys are missing: it stays failed and is retried once push works', () => {
  assert.deepEqual(reminderStatus({ sent: 0, failed: 0 }, 'VAPID keys not configured'), { status: 'failed', error: 'not pushed: VAPID keys not configured' });
  assert.deepEqual(reminderStatus({ sent: 0, failed: 0 }, null), { status: 'sent', error: null }, 'nobody subscribed: the in-app list is the reminder');
  assert.deepEqual(reminderStatus({ sent: 2, failed: 0 }, null), { status: 'sent', error: null });
  assert.deepEqual(reminderStatus({ sent: 1, failed: 1 }, null), { status: 'failed', error: '1 device(s) failed' });
});

// ---------------------------------------------------------------- #90 the nightly job's result

test('#90 failed steps: a step that threw, a privacy step with errors, and gateway events that reached the retry cap', () => {
  const steps = ['reminders', 'gatewayRetries', 'retention', 'photosCleanup', 'trips'];
  assert.deepEqual(failedStepsOf({ reminders: { failed: 3 }, gatewayRetries: { candidates: 1, ok: 1, gaveUp: 0 }, retention: {}, photosCleanup: {}, trips: {} }, steps), [],
    'a failed push is routine; nothing reached the cap');
  assert.deepEqual(failedStepsOf({ reminders: {}, gatewayRetries: { gaveUp: 2 }, retention: { errors: ['x'] }, photosCleanup: { failed: 1 }, trips: { error: 'boom' } }, steps),
    ['gatewayRetries', 'retention', 'photosCleanup', 'trips']);
  assert.deepEqual(failedStepsOf({ trips: { error: 'boom' } }, ['trips', 'retention']), ['trips'], 'a step that did not run is not a failure');
});

test('#90 healthcheck ping: only an https address; a failed run pings its /fail address', () => {
  assert.equal(healthcheckUrl('', true), null);
  assert.equal(healthcheckUrl('http://hc-ping.example.com/abc', true), null, 'plain http refused');
  assert.equal(healthcheckUrl('https://user:pw@hc-ping.example.com/abc', true), null, 'no credentials in the address');
  assert.equal(healthcheckUrl('https://hc-ping.example.com/abc', true), 'https://hc-ping.example.com/abc');
  assert.equal(healthcheckUrl('https://hc-ping.example.com/abc/', false), 'https://hc-ping.example.com/abc/fail');
});

test('#90 admin.noteNightlyRun: system only, server only, writes one audit row the principal reads', () => {
  const db = buildSeed(NOW);
  const ctx = { actor: { role: 'system', id: 'cron-daily' }, now: NOW.toISOString(), today: '2026-10-24' };
  assert.ok(COMMANDS['admin.noteNightlyRun'].serverOnly);
  const principal = buildPersonas(db).find(p => p.role === 'admin');
  assert.throws(() => execute('admin.noteNightlyRun', db, [{ ok: true, failedSteps: [] }], ctx, principal), (e) => e.code === 'NOT_ALLOWED');
  const before = db.auditLog.length;
  const r = execute('admin.noteNightlyRun', db, [{ ok: false, failedSteps: ['retention', 'photos<script>Cleanup'] }], ctx, systemPersona('cron-daily'));
  assert.equal(db.auditLog.length, before + 1);
  const row = db.auditLog.at(-1);
  assert.equal(row.entity, 'nightlyJob');
  assert.equal(row.action, 'failed');
  assert.equal(row.entityId, '2026-10-24');
  assert.equal(row.summary, 'Nightly job failed: retention, photosscriptCleanup');
  assert.deepEqual(r.failedSteps, ['retention', 'photosscriptCleanup']);
  assert.throws(() => execute('admin.noteNightlyRun', db, [{ ok: false, failedSteps: [] }], ctx, systemPersona('cron-daily')), /failed steps/);
  assert.throws(() => execute('admin.noteNightlyRun', db, [{}], ctx, systemPersona('cron-daily')), /ok must be/);
});

test('#90 nightlyJobStatus: none, ok, failed, and stale after 26 hours (a wrong secret or a paused project looks like silence)', () => {
  const t = Date.UTC(2026, 9, 24, 3, 0, 0);
  const row = (action, ms, summary = 'x') => ({ entity: 'nightlyJob', action, ts: new Date(ms).toISOString(), summary });
  assert.equal(nightlyJobStatus([], t).state, 'none');
  assert.equal(nightlyJobStatus([row('ok', t - 3600_000)], t).state, 'ok');
  const f = nightlyJobStatus([row('failed', t - 3600_000, 'Nightly job failed: retention'), row('ok', t - 2 * 86400_000)], t);
  assert.equal(f.state, 'failed');
  assert.equal(f.summary, 'Nightly job failed: retention');
  assert.equal(nightlyJobStatus([row('ok', t - NIGHTLY_STALE_MS - 1000)], t).state, 'stale');
  assert.equal(nightlyJobStatus([row('ok', t - 3600_000), row('failed', t - 7200_000)], t).state, 'ok', 'the newest row decides');
});

test('#90 real api: oversight.nightlyJob reads the newest nightlyJob audit row', async () => {
  const at = new Date(Date.now() - 3600_000).toISOString();
  const queries = [];
  const sb = fakeSb({ audit_log: (q) => { queries.push(q); return { data: [{ doc: { id: 'aud-1', entity: 'nightlyJob', action: 'failed', ts: at, summary: 'Nightly job failed: retention' } }], error: null }; } });
  const api = await createRemoteApi({ supabaseUrl: 'http://127.0.0.1:9', supabaseAnonKey: 'x' }, { createSurface, ApiError, toApiError, op, sb, call: async () => ({ result: null }) });
  await api.ready();
  const s = await api.oversight.nightlyJob();
  assert.equal(s.state, 'failed');
  assert.equal(s.at, at);
  assert.deepEqual(queries[0].filters, [['eq', 'entity', 'nightlyJob']]);
  assert.equal(queries[0].limit, 1);
});

test('#90 principal home: a failed, silent or never-run nightly job is listed under Needs attention (real app only)', async () => {
  const api = await mkApi();
  const demo = (await draw(api, ADMIN, Home)).el.innerHTML;
  assert.doesNotMatch(demo, /Nightly job/i, 'the demo has no nightly job');
  const real = (status) => Object.assign(Object.create(api), { mode: 'supabase', oversight: { ...api.oversight, nightlyJob: async () => { if (status instanceof Error) throw status; return status; } } });
  const at = new Date(Date.now() - 3600_000).toISOString();
  const failed = (await draw(real({ state: 'failed', at, summary: 'Nightly job failed: <b>retention</b>' }), ADMIN, Home)).el.innerHTML;
  assert.match(failed, /Nightly job failed: &lt;b&gt;retention&lt;\/b&gt;/);
  assert.match(failed, /Tell the developer/);
  assert.match((await draw(real({ state: 'stale', at, summary: 'x' }), ADMIN, Home)).el.innerHTML, /nightly job has not reported since/i);
  assert.match((await draw(real({ state: 'none', at: null, summary: null }), ADMIN, Home)).el.innerHTML, /No nightly job result recorded yet/);
  assert.match((await draw(real(new Error('offline')), ADMIN, Home)).el.innerHTML, /nightly job status could not be loaded/i);
  assert.doesNotMatch((await draw(real({ state: 'ok', at, summary: 'ok' }), ADMIN, Home)).el.innerHTML, /nightly job/i, 'a healthy run needs no attention');
});

// ---------------------------------------------------------------- #80 Android install and the invite slip

test('#80 Android: the install prompt is kept, offered from a tap on the parent home and in Settings, and gone once used', async () => {
  assert.equal(Install.installState(), 'android-menu', 'before the browser offers installation: the Chrome menu steps');
  let prevented = false, prompted = false;
  fire('beforeinstallprompt', { preventDefault() { prevented = true; }, prompt() { prompted = true; }, userChoice: Promise.resolve({ outcome: 'accepted' }) });
  assert.ok(prevented, 'the browser\'s own mini bar is held back so the app offers it at a sensible moment');
  assert.equal(Install.installState(), 'prompt');
  const api = await mkApi();
  const ctx = await draw(api, PARENT, Home);
  const host = ctx.el.querySelector('#home-install');
  assert.match(host.innerHTML, /Install the school app/);
  assert.match(host.innerHTML, /data-install/);
  assert.match(host.innerHTML, /data-install-later/, 'the home card can be put off');
  assert.equal(await Install.install(), 'accepted');
  assert.ok(prompted);
  assert.equal(Install.installState(), 'android-menu', 'a prompt is used once');
  fire('appinstalled');
  assert.match(Install.installCardHtml('android-menu'), /Install app/);
  assert.match(Install.installCardHtml('ios'), /Add to Home Screen/);
  assert.equal(Install.installCardHtml('installed'), '');
  assert.equal(Install.installCardHtml('none'), '');
});

test('#80 invite slip: a fourth step tells parents to install the app (Android and iPhone)', async () => {
  const api = await mkApi();
  api.session.set(ADMIN);
  Slips.claimSlips(api.session.current().id);
  Slips.addSlip({ guardianId: 'grd-01', guardianName: 'A Parent', children: ['Neel'], code: 'ABCD-EFGH', expiresAt: '2026-11-07T00:00:00Z' });
  const html = (await draw(api, ADMIN, Slips)).el.innerHTML;
  assert.match(html, /<li>Install the app:/);
  assert.match(html, /Android/);
  assert.match(html, /Add to Home Screen/);
  assert.equal((html.match(/<li>/g) || []).length, 4);
});

// ---------------------------------------------------------------- #92 email-code limits

test('#92 too many codes: the message says an hour and the school office, not "a minute"', async () => {
  const sb = fakeSb({}, { signInWithOtp: { status: 429, message: 'email rate limit exceeded' }, resetPasswordForEmail: { status: 429, message: 'email rate limit exceeded' } });
  const api = await createRemoteApi({ supabaseUrl: 'http://127.0.0.1:9', supabaseAnonKey: 'x' }, { createSurface, ApiError, toApiError, op, sb, call: async () => ({ result: null }) });
  await assert.rejects(api.auth.signInWithOtp('parent@example.com'), (e) => e.code === 'RATE_LIMITED' && /an hour/.test(e.message) && /school office/.test(e.message) && !/minute/.test(e.message));
  await assert.rejects(api.auth.requestPasswordReset('parent@example.com'), (e) => e.code === 'RATE_LIMITED' && /an hour/.test(e.message));
});

// ---------------------------------------------------------------- #91 backup script

test('#91 backup script: refuses a synced folder, and counts the rows per table in a data dump', () => {
  const sh = join(ROOT, 'scripts', 'backup.sh');
  execFileSync('sh', ['-n', sh]);
  const usage = spawnSync('sh', [sh], { encoding: 'utf8' });
  assert.equal(usage.status, 2);
  const icloud = spawnSync('sh', [sh, `${tmpdir()}/Library/Mobile Documents/com~apple~CloudDocs`], { encoding: 'utf8' });
  assert.equal(icloud.status, 2);
  assert.match(icloud.stderr, /synced/);
  const dir = mkdtempSync(join(tmpdir(), 'w1-ops-'));
  const f = join(dir, 'data.sql');
  writeFileSync(f, ['SET x = 1;', 'COPY "auth"."users" ("id", "email") FROM stdin;', 'u1\ta@example.com', 'u2\tb@example.com', '\\.', '',
    'COPY public.students (id, doc) FROM stdin;', 's1\t{}', '\\.', 'COPY public.audit_log (id, doc) FROM stdin;', '\\.', ''].join('\n'));
  const out = execFileSync('sh', [sh, '--count', f], { encoding: 'utf8' });
  assert.match(out, /^auth\.users 2$/m);
  assert.match(out, /^public\.students 1$/m);
  assert.match(out, /^public\.audit_log 0$/m);
});

// ---------------------------------------------------------------- a fake Supabase client (no network)

function fakeSb(tables = {}, authErrors = {}) {
  const session = { user: { id: 'u-admin', email: 'principal@example.com' }, access_token: 't' };
  const me = { userId: 'u-admin', role: 'admin', staffId: 'stf-principal', guardianId: null };
  const snap = { status: 'active', me, revs: {}, remindersSent: [], twoStep: { enrolled: false, required: false }, ...buildSeed(NOW), auditLog: [] };
  const err = (n) => (authErrors[n] ? { data: null, error: authErrors[n] } : { data: {}, error: null });
  return {
    auth: {
      getSession: async () => ({ data: { session } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signOut: async () => ({}),
      signInWithOtp: async () => err('signInWithOtp'),
      resetPasswordForEmail: async () => err('resetPasswordForEmail'),
      refreshSession: async () => ({ data: { session } }),
      mfa: { listFactors: async () => ({ data: { all: [], totp: [] }, error: null }), getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: 'aal1', nextLevel: 'aal1' }, error: null }) },
    },
    rpc: async () => ({ data: structuredClone(snap), error: null }),
    from(table) {
      const q = { table, filters: [] };
      const b = {
        select() { return b; }, eq(c, v) { q.filters.push(['eq', c, v]); return b; }, order() { return b; }, limit(n) { q.limit = n; return b; },
        in() { return b; }, gte() { return b; }, range() { return b; },
        then(res, rej) { return Promise.resolve(tables[table] ? tables[table](q) : { data: [], error: null }).then(res, rej); },
      };
      return b;
    },
    channel() { const ch = { on() { return ch; }, subscribe() { return ch; } }; return ch; },
    removeChannel() {},
  };
}
