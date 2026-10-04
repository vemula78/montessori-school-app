// Phase 2 audit fixes that live in the UI layer (findings #4, #10, #18, #40, #41, #43, #48).
// Screens are rendered against a fake ctx (no DOM); app.js needs a real page, so its guards are checked as source text.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

// The real app's entry defines the config before src/api/index.js loads (sim-runner only queues fixes in the real app).
// Nothing here touches the network: the api methods the runner calls are replaced below.
globalThis.__APP_CONFIG__ = { supabaseUrl: 'http://127.0.0.1:9', supabaseAnonKey: 'test-anon-key', vapidPublicKey: '', gatewayMode: 'test', persistSession: false };
globalThis.document ??= { addEventListener() {}, visibilityState: 'visible' }; // sim-runner registers a visibilitychange handler at import
globalThis.location ??= { href: 'http://localhost:8090/app/#/print/invites' };

const fakeEl = () => {
  const nodes = {};
  return {
    nodes, isConnected: true, innerHTML: '',
    querySelector(sel) { return (nodes[sel] ??= { innerHTML: '', addEventListener() {} }); },
    querySelectorAll: () => [],
    addEventListener() {},
  };
};

// ---------------------------------------------------------------- #4 invite slips
const Print = await import('../src/ui/screens/invites-print.js');

test('#4 print/invites shows nothing to a non-staff role even when slips are in memory', async () => {
  Print.clearSlips();
  Print.claimSlips('adm-1');
  Print.addSlip({ guardianId: 'g1', guardianName: 'Asha Rao', children: ['Kiran'], code: 'ABCD-EFGH', expiresAt: '2026-10-20T00:00:00Z' });
  const el = fakeEl();
  await Print.render({ el, persona: { id: 'par-1', role: 'parent' }, db: { school: { name: 'Test School' } }, go() {} });
  assert.ok(!el.innerHTML.includes('ABCD-EFGH') && !el.innerHTML.includes('Asha'), 'no code or family name for a parent');
  const admin = fakeEl();
  await Print.render({ el: admin, persona: { id: 'adm-1', role: 'admin' }, db: { school: { name: 'Test School' } }, go() {} });
  assert.ok(admin.innerHTML.includes('ABCD-EFGH'), 'the principal who issued it still sees it');
  Print.clearSlips();
});

test('#4 slips issued under one sign-in are dropped when a different person is signed in', () => {
  Print.clearSlips();
  Print.claimSlips('adm-1');
  Print.addSlip({ guardianId: 'g1', guardianName: 'Asha Rao', children: [], code: 'ABCD-EFGH', expiresAt: null });
  assert.equal(Print.slipCount(), 1);
  Print.claimSlips('adm-1');
  assert.equal(Print.slipCount(), 1, 'same person: kept');
  Print.claimSlips('par-1');
  assert.equal(Print.slipCount(), 0, 'different person: cleared');
});

test('#4 app.js clears slips on sign-out / lost session, and role-checks bare routes before rendering them', () => {
  const app = read('src/ui/app.js');
  assert.match(app, /import \{[^}]*clearSlips[^}]*\} from '\.\/screens\/invites-print\.js'/);
  assert.match(app, /async function signOutNow\(\) \{[^}]*clearSlips\(\)/);
  assert.match(app, /if \(st\.state !== 'active'\) clearSlips\(\)/);
  const roleCheckBare = app.search(/m\?\.route\.bare && !\(\(!REAL && m\.route\.demoRoles\) \|\| m\.route\.roles\)\.includes\(persona\.role\)/);
  const bareRender = app.indexOf('// bare routes (print) render without chrome');
  assert.ok(roleCheckBare > 0 && bareRender > roleCheckBare, 'role check for bare routes comes before they are rendered');
});

// ---------------------------------------------------------------- administration module: gate and links keep the earlier guarantees
test('administration: blocked / two-step gate states clear issued invite codes like every non-active state; the real settings page links to Account', () => {
  const app = read('src/ui/app.js');
  const clear = app.indexOf("if (st.state !== 'active') clearSlips()");
  const sw = app.indexOf("switch (st.state)");
  assert.ok(clear > 0 && sw > clear, 'slips are cleared before any state is drawn');
  assert.ok(app.includes("case 'blocked':") && app.includes("case 'two_step_required':"));
  assert.match(read('src/ui/screens/settings-real.js'), /href="#\/account"/);
});

// ---------------------------------------------------------------- #10 retention wording
test('#10 the retention section of the privacy notice is marked as a draft pending decision and enforcement', async () => {
  const { SECTIONS } = await import('../src/ui/privacy.js');
  const s = SECTIONS.find((x) => /how long/i.test(x.h));
  assert.ok(s, 'retention section exists');
  const text = `${s.h} ${s.p.join(' ')}`;
  assert.match(text, /draft/i);
  assert.match(text, /pending|not yet (decided|final)/i);
  assert.match(text, /does not yet enforce|not (yet )?enforced/i);
});

test('#10 GO-LIVE lists retention enforcement as a gate before real data', () => {
  assert.match(read('docs/GO-LIVE.md'), /- \[ \] \*\*Retention[^\n]*enforc/i);
});

// Phase 3 built the enforcement: the gate is now "decide the periods and set them", and the notice says what is enforced.
test('#10 (Phase 3) the notice says an unset period is not enforced and photos are; GO-LIVE sends the principal to the Settings card', async () => {
  const { SECTIONS } = await import('../src/ui/privacy.js');
  const text = SECTIONS.find((x) => /how long/i.test(x.h)).p.join(' ');
  assert.match(text, /not enforced/i);
  assert.match(text, /Photos are the exception/);
  assert.match(read('docs/GO-LIVE.md'), /Settings > How long records are kept/);
});

// ---------------------------------------------------------------- #48 consent version, two sources
test('#48 the UI privacy version equals the server CONSENT_VERSION, and GO-LIVE names all three places', async () => {
  const { PRIVACY_VERSION } = await import('../src/ui/privacy.js');
  const { CONSENT_VERSION } = await import('../src/domain/commands.js');
  assert.equal(PRIVACY_VERSION, CONSENT_VERSION);
  const doc = read('docs/GO-LIVE.md');
  assert.ok(doc.includes('src/ui/privacy.js') && doc.includes('CONSENT_VERSION') && doc.includes('src/domain/commands.js'));
  assert.ok(doc.includes('npm run sync-domain') && doc.includes('app.consent_version()'), 'the third place: the database function, via a new migration');
  assert.match(doc, /three changes/i);
});

// ---------------------------------------------------------------- #1 doc side
test('#1 GO-LIVE keeps email confirmation ON and does not use password sign-up', () => {
  const doc = read('docs/GO-LIVE.md');
  assert.ok(!/Confirm email OFF/i.test(doc), 'must not tell the operator to switch confirmation off');
  assert.match(doc, /Confirm email ON/i);
  assert.match(doc, /password/i);
});

// ---------------------------------------------------------------- #18 online payments cannot be cancelled
test('#18 a gateway-captured payment has no Cancel button and says it must be refunded; a cash payment keeps Cancel', async () => {
  const { render } = await import('../src/ui/screens/fees-payment.js');
  const student = { id: 's1', firstName: 'Kiran', lastName: 'Rao', status: 'active', programId: 'P1', admissionNo: 'A1', guardianIds: ['g1'] };
  const pay = (id, extra) => ({ id, receiptNumber: `R-${id}`, paidOn: '2026-10-01', recordedAt: `2026-10-01T10:0${id.slice(1)}:00Z`, amountPaise: 100000, allocations: [], creditPaise: 0, status: 'valid', ...extra });
  const payments = [pay('p1', { mode: 'online', gatewayMode: 'test', gatewayPaymentId: 'pay_X1' }), pay('p2', { mode: 'cash' }), pay('p3', { mode: 'online' })];
  const db = { payments, credits: [], refunds: [], guardians: [{ id: 'g1', firstName: 'Asha', lastName: 'Rao', relation: 'mother' }], programs: [{ id: 'P1', name: 'Toddlers' }] };
  const el = fakeEl();
  await render({
    el, persona: { role: 'accountant' }, params: { studentId: 's1' }, query: {}, db, rerender() {},
    api: { people: { student: async () => student }, fees: { invoices: async () => [], payments: async () => payments } },
  });
  assert.ok(!el.innerHTML.includes('data-cancel="p1"'), 'no cancel for the captured online payment');
  assert.ok(el.innerHTML.includes('data-refund="p1"'), 'refund is still offered');
  assert.match(el.innerHTML, /cannot be cancelled[^<]*refund|refund[^<]*cannot be cancelled/i);
  assert.ok(!el.innerHTML.includes('data-cancel="p3"'), 'mode online alone is refused by the domain too, so no Cancel');
  assert.ok(el.innerHTML.includes('data-cancel="p2"'), 'cash payment can still be cancelled');
});

// ---------------------------------------------------------------- #41 re-invite a revoked family
test('#41 re-issue is allowed unless the redeeming sign-in is still active (any staff role); locked codes count as expired', async () => {
  const { render } = await import('../src/ui/screens/invites.js');
  const guardians = [{ id: 'g1', firstName: 'Asha', lastName: 'Rao', relation: 'mother', studentIds: ['s1'] }];
  const students = [{ id: 's1', firstName: 'Kiran', status: 'active' }];
  const redeemed = (redeemedUserStatus) => ({ id: 'i1', guardianId: 'g1', createdAt: '2026-09-01T00:00:00Z', expiresAt: '2026-09-15T00:00:00Z', redeemedAt: '2026-09-02T00:00:00Z', revokedAt: null, status: 'redeemed', redeemedUserStatus });
  const locked = { id: 'i2', guardianId: 'g1', createdAt: '2026-10-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z', redeemedAt: null, revokedAt: null, failedAttempts: 5, status: 'locked', redeemedUserStatus: null };
  const draw = async (role, invites) => {
    const el = fakeEl();
    await render({ el, persona: { id: 'u', role }, query: {}, go() {}, rerender() {}, setQuery() {}, api: { people: { guardians: async () => guardians, students: async () => students }, admin: { invites: async () => invites, users: async () => [] } } });
    return { btn: el.innerHTML.match(/<button[^>]*data-issue="g1"[^>]*>/)[0], html: el.innerHTML };
  };
  for (const role of ['admin', 'accountant']) {
    for (const st of ['revoked', 'withdrawn', 'pending', 'missing']) assert.ok(!/disabled/.test((await draw(role, [redeemed(st)])).btn), `${role}: ${st} sign-in is re-invitable`);
    assert.ok(/disabled/.test((await draw(role, [redeemed('active')])).btn), `${role}: active sign-in is already linked`);
  }
  const l = await draw('accountant', [redeemed('active'), locked]);
  assert.ok(!/disabled/.test(l.btn) && /Expired/.test(l.html) && !/Code issued/.test(l.html), 'a locked code is shown as expired and can be re-issued');
});

// ---------------------------------------------------------------- #40 bus fallback shows a stale indicator
test('#40 a failed reload of the bus view is shown to the parent, and clears when a reload works again', async () => {
  const { render } = await import('../src/ui/screens/bus-parent.js');
  let fail = false;
  const view = { route: { id: 'r1', stops: [] }, stop: null, trip: null, events: [], lastFix: null };
  const cleanups = [];
  let onChange;
  const el = fakeEl();
  await render({
    el, persona: { guardianId: 'g1' }, query: {},
    cleanup: (f) => cleanups.push(f), onChange: (f) => { onChange = f; },
    api: {
      people: { childrenOf: async () => [{ id: 'k1', firstName: 'Kiran', routeId: 'r1', status: 'active' }] },
      transport: { parentView: async () => { if (fail) throw new Error('network down'); return view; }, subscribeTrip: () => () => {} },
      consent: { status: async () => ({ purposes: { bus_live: { given: true } } }) },
    },
  });
  try {
    const status = () => el.nodes['#b-status'].innerHTML;
    assert.ok(!/could not refresh/i.test(status()));
    fail = true;
    await onChange();
    assert.match(status(), /could not refresh/i);
    fail = false;
    await onChange();
    assert.ok(!/could not refresh/i.test(status()));
  } finally { cleanups.forEach((f) => f()); }
});

// ---------------------------------------------------------------- #43 sim-runner queue
const { api } = await import('../src/api/index.js');
const runner = await import('../src/ui/sim-runner.js');

function gpsHarness() {
  let onFix;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { onLine: true, geolocation: { watchPosition: (ok) => { onFix = ok; return 1; }, clearWatch() {} } },
  });
  let persona = { id: 'drv-1' };
  api.session.current = () => persona;
  const calls = [];
  const harness = {
    calls, setPersona: (p) => { persona = p; },
    fix: async (n) => { onFix({ coords: { latitude: 12.9 + n / 1e4, longitude: 77.6, accuracy: 5 }, timestamp: Date.parse('2026-10-05T03:00:00Z') + n * 60000 }); await new Promise((r) => setImmediate(r)); },
  };
  return harness;
}
const netErr = () => Object.assign(new Error('Failed to fetch'), { code: 'NETWORK' });

test('#43 stop() clears queued fixes and the retry timer: nothing is sent afterwards', async () => {
  const h = gpsHarness();
  api.transport.recordPosition = async (tripId, fix) => { h.calls.push([tripId, fix.lat]); throw netErr(); };
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    runner.startGps('trip-1', 'r1');
    await h.fix(1);
    assert.equal(runner.snapshot().queued, 1, 'offline: the fix waits in the queue');
    const before = h.calls.length;
    runner.stop('driver paused');
    assert.equal(runner.snapshot().queued, 0, 'queue cleared by stop()');
    mock.timers.tick(6000);
    await new Promise((r) => setImmediate(r));
    assert.equal(h.calls.length, before, 'retry timer is gone: no further send');
  } finally { mock.timers.reset(); runner.resetAfterTripEnd(); }
});

test('#43 a fix queued under one trip is never sent under the next trip', async () => {
  const h = gpsHarness();
  let offline = true;
  api.transport.recordPosition = async (tripId, fix) => { h.calls.push([tripId, fix.lat]); if (offline) throw netErr(); return {}; };
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    runner.startGps('trip-1', 'r1');
    await h.fix(1);
    runner.startGps('trip-2', 'r1');
    offline = false;
    await h.fix(2);
    const sentOnTrip2 = h.calls.filter(([t]) => t === 'trip-2');
    assert.deepEqual(sentOnTrip2.map(([, lat]) => lat), [12.9 + 2 / 1e4], 'only the trip-2 fix goes out under trip-2');
  } finally { mock.timers.reset(); runner.resetAfterTripEnd(); }
});

test('#43 a queued fix captured by one sign-in is dropped, not sent, when another sign-in is current', async () => {
  const h = gpsHarness();
  let offline = true;
  api.transport.recordPosition = async (tripId, fix) => { h.calls.push([tripId, fix.lat]); if (offline) throw netErr(); return {}; };
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    runner.startGps('trip-1', 'r1');
    await h.fix(1);
    const attempts = h.calls.length;
    h.setPersona({ id: 'par-9' }); // someone else is signed in now; the runner was not stopped
    offline = false;
    await runner.flushNow();
    assert.equal(h.calls.length, attempts, 'no send under the other session');
    assert.equal(runner.snapshot().queued, 0, 'the stale fix was dropped from the queue');
  } finally { mock.timers.reset(); runner.resetAfterTripEnd(); }
});

test('GO-LIVE tells the operator never to set PUSH_TEST_ORIGINS in the cloud and lists the cron-trips job', () => {
  const doc = read('docs/GO-LIVE.md');
  assert.match(doc, /Do not set `PUSH_TEST_ORIGINS` in the cloud/);
  assert.match(doc, /`cron-trips` \(every 15 minutes\)/);
});
