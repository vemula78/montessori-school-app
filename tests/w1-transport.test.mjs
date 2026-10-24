// Wave 1, bus / transport: child-safety end of trip (#64), GPS resume (#59), stop events in route order (#61), and the
// rest of the transport proposals (#57 #58 #60 #62 #65 #69 #70 #72 #73 #74 #75).
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyDb } from '../src/store/schema.js';
import * as T from '../src/domain/transport.js';
import { simulationPlan } from '../src/domain/sim.js';
import { COMMANDS } from '../src/domain/commands.js';

const BASE_MS = Date.UTC(2026, 9, 2, 2, 0, 0); // 07:30 IST
const iso = ms => new Date(ms).toISOString();
const ctx = (ms = BASE_MS, actor = { role: 'driver', id: 'DRV' }) => ({ actor, now: iso(ms), today: '2026-10-02' });

// a loop: the bus leaves the depot past stop 5, then runs 1 → 2 → 3 → 4 and comes back to stop 5 (~1.1 km sides)
function loopFixture() {
  const db = createEmptyDb();
  db.programs.push({ id: 'PA', name: 'Primary A', ageRange: '3-6', teacherIds: [] });
  db.staff.push({ id: 'DRV', firstName: 'Dev', lastName: 'Testwala', role: 'driver', programIds: [], phone: '+91-90000-00009' });
  db.routes.push({ id: 'R1', name: 'Loop', busNo: 'DEMO-1', driverId: 'DRV', attendantId: null, transportFeePaise: 100000, path: null, stops: [
    { id: 'S1', name: 'First', lat: 12.970, lng: 77.750, seq: 1, scheduledPickup: '07:30', scheduledDrop: '15:10' },
    { id: 'S2', name: 'Second', lat: 12.980, lng: 77.750, seq: 2, scheduledPickup: '07:35', scheduledDrop: '15:15' },
    { id: 'S3', name: 'Third', lat: 12.980, lng: 77.740, seq: 3, scheduledPickup: '07:40', scheduledDrop: '15:20' },
    { id: 'S4', name: 'Fourth', lat: 12.970, lng: 77.740, seq: 4, scheduledPickup: '07:45', scheduledDrop: '15:25' },
    { id: 'S5', name: 'Fifth', lat: 12.965, lng: 77.745, seq: 5, scheduledPickup: '07:50', scheduledDrop: '15:30' },
  ] });
  const kid = (id, first, stopId) => {
    db.guardians.push({ id: `G${id}`, firstName: 'G', lastName: 'Demoson', relation: 'mother', phone: '+91-90000-00100', email: `g${id}@example.com`, studentIds: [id] });
    db.students.push({ id, firstName: first, lastName: 'Demoson', dob: '2022-01-01', programId: 'PA', admissionNo: id, status: 'active', guardianIds: [`G${id}`], routeId: 'R1', stopId, feeCategory: 'regular', healthNotes: null });
  };
  kid('K1', 'Kiran', 'S1'); kid('K2', 'Asha', 'S2'); kid('K5', 'Neel', 'S5');
  return db;
}

/** Fixes every 5 s along straight legs (~50 m a step), dwelling 4 fixes at each listed point. */
function drive(points, startMs = BASE_MS + 1000) {
  const out = [];
  let ms = startMs;
  const push = (lat, lng) => { out.push({ lat, lng, accuracy: 8, ts: iso(ms) }); ms += 5000; };
  for (let i = 0; i < 4; i++) push(points[0].lat, points[0].lng);
  for (let p = 1; p < points.length; p++) {
    const a = points[p - 1], b = points[p];
    const n = Math.max(1, Math.ceil(T.haversineMeters(a, b) / 50));
    for (let k = 1; k <= n; k++) push(a.lat + ((b.lat - a.lat) * k) / n, a.lng + ((b.lng - a.lng) * k) / n);
    for (let i = 0; i < 3; i++) push(b.lat, b.lng);
  }
  return out;
}
const evs = trip => trip.stopEvents.map(e => `${e.stopId}:${e.type}`);

// ---------------------------------------------------------------- #61 stop events in route order
test('#61 a loop that passes stop 5 first: no early "Bus left" for stop 5; its events come when the bus really gets there', () => {
  const db = loopFixture();
  const r = db.routes[0];
  const trip = T.startTrip(db, { routeId: 'R1', direction: 'pickup' }, ctx());
  const at = id => r.stops.find(s => s.id === id);
  for (const f of drive([at('S5'), at('S1'), at('S2'), at('S3'), at('S4'), at('S5')])) T.recordPosition(db, trip.id, f);
  assert.deepEqual(evs(trip), [
    'S1:nearing', 'S1:arrived', 'S1:departed', 'S2:nearing', 'S2:arrived', 'S2:departed', 'S3:nearing', 'S3:arrived', 'S3:departed',
    'S4:nearing', 'S4:arrived', 'S4:departed', 'S5:nearing', 'S5:arrived']);
});

test('#61 two stops 80 m apart: the bus leaves the first before it arrives at the second; parked between them it is at the first only', () => {
  const db = loopFixture();
  const r = db.routes[0];
  r.stops = [
    { id: 'A', name: 'Gate A', lat: 12.9800, lng: 77.750, seq: 1, scheduledPickup: '07:30', scheduledDrop: '15:10' },
    { id: 'B', name: 'Gate B', lat: 12.98072, lng: 77.750, seq: 2, scheduledPickup: '07:31', scheduledDrop: '15:11' },
  ];
  const trip = T.startTrip(db, { routeId: 'R1', direction: 'pickup' }, ctx());
  for (const f of drive([{ lat: 12.976, lng: 77.750 }, r.stops[0], r.stops[1], { lat: 12.984, lng: 77.750 }])) T.recordPosition(db, trip.id, f);
  const e = evs(trip);
  assert.ok(e.indexOf('A:departed') >= 0 && e.indexOf('A:departed') < e.indexOf('B:arrived'), e.join(' '));
  assert.deepEqual(e.filter(x => x.endsWith('arrived')), ['A:arrived', 'B:arrived']);

  const t2 = { stopEvents: [] };
  const tracker = {};
  const mid = { lat: 12.98035, lng: 77.750 }; // 39 m from A, 41 m from B
  let ms = BASE_MS;
  for (const p of [{ lat: 12.977, lng: 77.750 }, { lat: 12.978, lng: 77.750 }, mid, mid, mid]) t2.stopEvents.push(...T.deriveStopEvents(r, tracker, { ...p, accuracy: 8, ts: iso(ms += 5000) }, 'pickup'));
  assert.deepEqual(evs(t2).filter(x => x.endsWith('arrived')), ['A:arrived'], 'parked 40 m from each: arrived at the first stop only');
});

test('#61 stops with no rider on the route do not use up the window: skipping two of them does not silence the rest of the trip', () => {
  const db = loopFixture();
  db.students = db.students.filter(s => s.id !== 'K2'); // riders at S1 and S5 only
  const r = db.routes[0];
  const trip = T.startTrip(db, { routeId: 'R1', direction: 'pickup' }, ctx());
  const at = id => r.stops.find(s => s.id === id);
  for (const f of drive([{ lat: 12.966, lng: 77.750 }, at('S1'), at('S4'), at('S5')])) T.recordPosition(db, trip.id, f);
  assert.deepEqual(evs(trip), ['S1:nearing', 'S1:arrived', 'S1:departed', 'S4:nearing', 'S4:arrived', 'S4:departed', 'S5:nearing', 'S5:arrived']);
});

test('#61 a stop that was only neared re-arms when the bus turns away, so the real approach alerts again', () => {
  const db = loopFixture();
  const r = db.routes[0];
  const tracker = {};
  let ms = BASE_MS;
  const feed = (lat, lng) => T.deriveStopEvents(r, tracker, { lat, lng, accuracy: 8, ts: iso(ms += 5000) }, 'pickup');
  const out = [];
  for (const p of [[12.9665, 77.750], [12.9667, 77.750]]) out.push(...feed(...p)); // ~350 m south of S1: nearing
  for (const p of [[12.958, 77.750], [12.957, 77.750]]) out.push(...feed(...p)); // detour: 1.3 km away
  for (const p of [[12.9666, 77.750], [12.9668, 77.750], [12.970, 77.750], [12.970, 77.750]]) out.push(...feed(...p));
  assert.deepEqual(out.map(e => `${e.stopId}:${e.type}`), ['S1:nearing', 'S1:nearing', 'S1:arrived']);
});

test('#61 a drop run follows the scheduled drop times (here the reverse of the pickup order); the simulation drives it that way', () => {
  const db = loopFixture();
  const r = db.routes[0];
  r.stops.forEach(s => { s.scheduledDrop = `15:${String(50 - s.seq * 5).padStart(2, '0')}`; }); // S5 first … S1 last
  assert.deepEqual(T.stopsForDirection(r, 'drop').map(s => s.id), ['S5', 'S4', 'S3', 'S2', 'S1']);
  assert.deepEqual(T.stopsForDirection(r, 'pickup').map(s => s.id), ['S1', 'S2', 'S3', 'S4', 'S5']);
  r.stops[0].scheduledDrop = ''; // one stop without a drop time: seq order
  assert.deepEqual(T.stopsForDirection(r, 'drop').map(s => s.id), ['S1', 'S2', 'S3', 'S4', 'S5']);
  r.stops[0].scheduledDrop = '15:45';
  const plan = simulationPlan(r, { speedKmph: 30, tickMs: 1000, direction: 'drop' });
  assert.deepEqual([plan[0].lat, plan[0].lng], [12.965, 77.745], 'starts at the first drop stop');
  assert.deepEqual([plan.at(-1).lat, plan.at(-1).lng], [12.970, 77.750], 'ends at the last drop stop');
  const trip = T.startTrip(db, { routeId: 'R1', direction: 'drop', simulated: true }, ctx());
  let ms = BASE_MS;
  for (const p of plan) T.recordPosition(db, trip.id, { lat: p.lat, lng: p.lng, accuracy: p.accuracy, ts: iso(ms += 1000) });
  assert.deepEqual(trip.stopEvents.filter(e => e.type === 'arrived').map(e => e.stopId), ['S5', 'S4', 'S3', 'S2', 'S1']);
});

// ---------------------------------------------------------------- #64 end of trip: every child marked, bus checked
test('#64 a drop trip cannot be ended while a child is unmarked, nor without the "bus checked" confirmation', () => {
  const db = loopFixture();
  const trip = T.startTrip(db, { routeId: 'R1', direction: 'drop' }, ctx());
  T.markChild(db, trip.id, { studentId: 'K1', type: 'dropped' }, ctx(BASE_MS + 60000));
  assert.deepEqual(T.unmarkedChildren(db, trip).map(c => c.studentId), ['K2', 'K5']);
  assert.throws(() => T.endTrip(db, trip.id, ctx(BASE_MS + 90000), { busChecked: true }), e => e.code === 'VALIDATION' && /Asha Demoson/.test(e.message) && /Neel Demoson/.test(e.message));
  T.markChild(db, trip.id, { studentId: 'K2', type: 'dropped' }, ctx(BASE_MS + 70000));
  T.markChild(db, trip.id, { studentId: 'K5', type: 'absent' }, ctx(BASE_MS + 80000));
  assert.deepEqual(T.unmarkedChildren(db, trip), []);
  assert.throws(() => T.endTrip(db, trip.id, ctx(BASE_MS + 90000)), e => e.code === 'VALIDATION' && /no child is left on board/i.test(e.message));
  assert.equal(trip.status, 'active');
  T.endTrip(db, trip.id, ctx(BASE_MS + 90000), { busChecked: true });
  assert.equal(trip.status, 'ended');
  assert.equal(trip.busCheckedAt, iso(BASE_MS + 90000));
  assert.equal(trip.busCheckedBy, 'DRV');
  assert.match(db.auditLog.at(-1).summary, /bus checked/);
});

test('#64 a pickup trip records the bus check; an unmarked child is reported, not blocking; the system end (3 hours) is never blocked', () => {
  const db = loopFixture();
  const trip = T.startTrip(db, { routeId: 'R1', direction: 'pickup' }, ctx());
  T.markChild(db, trip.id, { studentId: 'K1', type: 'boarded' }, ctx(BASE_MS + 60000));
  T.endTrip(db, trip.id, ctx(BASE_MS + 90000), { busChecked: true });
  assert.equal(trip.status, 'ended');
  assert.match(db.auditLog.at(-1).summary, /2 children not marked/);
  const drop = T.startTrip(db, { routeId: 'R1', direction: 'drop' }, ctx(BASE_MS + 100000));
  const sys = { actor: { role: 'system', id: 'cron-daily' }, now: iso(BASE_MS + 4 * 3600000), today: '2026-10-02' };
  const out = COMMANDS['transport.autoEndTrip'].run(db, [drop.id, 'still running 3 hours after it started'], sys);
  assert.equal(out.status, 'ended');
  assert.match(db.auditLog.at(-1).summary, /3 children not marked/);
});

test('#64 the endTrip command passes the bus check through', () => {
  const db = loopFixture();
  const trip = T.startTrip(db, { routeId: 'R1', direction: 'drop' }, ctx());
  for (const k of ['K1', 'K2', 'K5']) T.markChild(db, trip.id, { studentId: k, type: 'dropped' }, ctx(BASE_MS + 60000));
  const out = COMMANDS['transport.endTrip'].run(db, [trip.id, { busChecked: true }], ctx(BASE_MS + 90000));
  assert.equal(out.busCheckedAt, iso(BASE_MS + 90000));
});

// ---------------------------------------------------------------- #65 undo a wrong mark
test('#65 a wrong mark is undone by a "corrected" event: the child is unmarked again and the parent timeline says so', () => {
  const db = loopFixture();
  const trip = T.startTrip(db, { routeId: 'R1', direction: 'pickup' }, ctx());
  T.markChild(db, trip.id, { studentId: 'K2', type: 'absent' }, ctx(BASE_MS + 60000));
  const c = T.markChild(db, trip.id, { studentId: 'K2', type: 'corrected' }, ctx(BASE_MS + 70000));
  assert.equal(c.corrects, 'absent');
  assert.equal(c.correctsTs, iso(BASE_MS + 60000));
  assert.equal(T.lastChildEvent(trip, 'K2'), null);
  assert.ok(T.unmarkedChildren(db, trip).some(x => x.studentId === 'K2'));
  T.markChild(db, trip.id, { studentId: 'K2', type: 'boarded' }, ctx(BASE_MS + 80000));
  assert.equal(T.lastChildEvent(trip, 'K2').type, 'boarded');
  const v = T.parentView(db, 'K2', iso(BASE_MS + 90000), '2026-10-02');
  assert.ok(v.events.some(e => e.kind === 'correction' && /Correction/.test(e.text) && /absent/.test(e.text)));
  assert.ok(!v.events.some(e => e.kind === 'child' && /absent/.test(e.text)), 'the undone mark is not shown as a fact');
  assert.ok(v.events.some(e => e.kind === 'child' && /Asha boarded at/.test(e.text)));
  assert.throws(() => T.markChild(db, trip.id, { studentId: 'K1', type: 'corrected' }, ctx(BASE_MS + 95000)), { code: 'VALIDATION' }, 'nothing to undo');
});

// ---------------------------------------------------------------- driver screen (fake DOM, demo api)

const dialogs = [];
function fake() {
  const children = new Map();
  let html = '';
  const el = {
    value: '', checked: false, disabled: false, hidden: false, textContent: '', className: '', dataset: {}, handlers: {}, children, isConnected: true,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener(t, f) { (el.handlers[t] ||= []).push(f); },
    querySelector(sel) { if (!children.has(sel)) children.set(sel, fake()); return children.get(sel); },
    querySelectorAll() { return []; },
    closest: () => null, appendChild() {}, remove() {}, focus() {}, setAttribute() {}, showModal() {}, close() {},
  };
  Object.defineProperty(el, 'innerHTML', { get: () => html, set: (v) => { html = v; children.clear(); } });
  return el;
}
globalThis.document = { createElement: () => { const d = fake(); dialogs.push(d); return d; }, body: { appendChild() {} }, head: { appendChild() {} }, getElementById: () => null, addEventListener() {}, visibilityState: 'visible' };
globalThis.location ??= { hash: '', reload() {} };
const allHtml = el => el.innerHTML + [...el.children.values()].map(allHtml).join('');
// The real app's entry defines the config before src/api/index.js loads: sim-runner then queues and sends fixes as it
// does in the real app (its api methods are replaced in the runner tests; nothing touches the network). Screens get
// a demo api through ctx.
globalThis.__APP_CONFIG__ = { supabaseUrl: 'http://127.0.0.1:9', supabaseAnonKey: 'test-anon-key', vapidPublicKey: '', gatewayMode: 'test', persistSession: false };
const { createApi } = await import('../src/api/index.js');
const { buildSeed } = await import('../src/seed/seed-data.js');
const { memoryBackend } = await import('../src/store/storage.js');
const runner = await import('../src/ui/sim-runner.js');
const Driver = await import('../src/ui/screens/bus-driver.js');
const DRIVER = 'persona-stf-driver-1';

function stubNavigator({ permission = 'prompt' } = {}) {
  const nav = { onLine: true, watched: [], vibrated: [], current: 0,
    geolocation: { watchPosition: (ok, err, o) => { nav.watched.push({ ok, err, o }); return nav.watched.length; }, clearWatch() {}, getCurrentPosition: (ok, err, o) => { nav.current += 1; nav.currentOpts = o; nav.onCurrent = ok; } },
    permissions: { query: async () => ({ state: permission }) },
    vibrate: p => { nav.vibrated.push(p); return true; } };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: nav });
  return nav;
}
async function mkApi(now = new Date()) {
  const api = createApi({ backend: memoryBackend(), sessionBackend: memoryBackend(), seedFn: () => buildSeed(now), clock: () => now });
  await api.ready();
  api.session.set(DRIVER);
  return api;
}
async function drawDriver(api) {
  const cleanups = [];
  const ctx = { api, persona: api.session.current(), query: {}, params: {}, el: fake(), get db() { return api.getDb(); },
    go() {}, setQuery() {}, toast() {}, onChange() {}, cleanup: f => cleanups.push(f), rerender() {} };
  await Driver.render(ctx);
  return { ctx, html: () => allHtml(ctx.el), done: () => { cleanups.forEach(f => f()); runner.resetAfterTripEnd(); } };
}
const click = async (ctx, button) => { const t = { dataset: {}, setAttribute() {}, ...button }; await ctx.el.handlers.click[0]({ target: { closest: () => t } }); };

test('#59 an active real trip with GPS not running in this tab: resumes by itself when location is already allowed', async () => {
  const nav = stubNavigator({ permission: 'granted' });
  const api = await mkApi();
  const trip = await api.transport.startTrip({ routeId: 'route-1', direction: 'pickup', simulated: false });
  const d = await drawDriver(api);
  try {
    assert.equal(runner.snapshot().mode, 'gps');
    assert.equal(runner.snapshot().tripId, trip.id);
    assert.equal(nav.watched.length, 1, 'watchPosition started');
    assert.ok(!/Tracking is OFF/.test(d.html()));
  } finally { d.done(); }
});

test('#59 without granted permission the screen shows a red "Tracking is OFF" alarm with a resume button, and vibrates', async () => {
  const nav = stubNavigator({ permission: 'prompt' });
  const api = await mkApi();
  await api.transport.startTrip({ routeId: 'route-1', direction: 'pickup', simulated: false });
  const d = await drawDriver(api);
  try {
    assert.equal(runner.snapshot().mode, 'idle', 'no automatic start: the browser would have to ask');
    assert.match(d.html(), /class="banner alarm" role="alert"[^>]*><strong>Tracking is OFF\.<\/strong> Parents cannot see the bus\./);
    assert.match(d.html(), /data-resume/);
    assert.ok(!/GPS is not running in this tab/.test(d.html()), 'not a grey line any more');
    assert.equal(nav.vibrated.length, 1);
    await click(d.ctx, { dataset: { resume: '' } });
    assert.equal(runner.snapshot().mode, 'gps', 'one tap resumes');
    assert.ok(!/Tracking is OFF/.test(d.html()));
  } finally { d.done(); }
});

test('#64 End trip on a drop run with unmarked children lists them instead of ending; the api refuses it too', async () => {
  stubNavigator();
  const api = await mkApi();
  const trip = await api.transport.startTrip({ routeId: 'route-1', direction: 'drop', simulated: true });
  const d = await drawDriver(api);
  try {
    const riders = api.getDb().students.filter(s => s.status === 'active' && s.routeId === 'route-1');
    dialogs.length = 0;
    click(d.ctx, { id: 'd-end' }); // the dialog stays open: not awaited
    for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
    const dlg = dialogs.map(x => x.innerHTML).join('');
    assert.match(dlg, /Mark every child first/);
    for (const k of riders) assert.ok(dlg.includes(`${k.firstName} ${k.lastName}`), k.firstName);
    await assert.rejects(api.transport.endTrip(trip.id), e => e.code === 'VALIDATION' && /Mark every child/.test(e.message));
    for (const k of riders) await api.transport.markChild(trip.id, { studentId: k.id, type: 'dropped' });
    await assert.rejects(api.transport.endTrip(trip.id), e => e.code === 'VALIDATION' && /no child is left on board/.test(e.message));
    const ended = await api.transport.endTrip(trip.id, { busChecked: true });
    assert.equal(ended.status, 'ended');
    assert.ok(ended.busCheckedAt);
  } finally { d.done(); }
});

test('#73 #65 driving layout: next stop first with full-size buttons, map behind a button; a wrong mark can be undone', async () => {
  stubNavigator();
  const api = await mkApi();
  await api.transport.startTrip({ routeId: 'route-1', direction: 'pickup', simulated: true });
  const d = await drawDriver(api);
  try {
    const html = d.html();
    assert.match(html, /Next stop/);
    assert.match(html, /id="d-map-toggle"[^>]*>Show map/);
    assert.match(html, /id="d-map"[^>]*hidden/, 'map hidden until asked for');
    assert.ok(!/btn sm/.test(html), 'no small buttons on the driving screen');
    const first = api.getDb().students.filter(s => s.status === 'active' && s.routeId === 'route-1').sort((a, b) => a.stopId.localeCompare(b.stopId))[0];
    await click(d.ctx, { dataset: { child: first.id, stop: first.stopId, type: 'absent' } });
    assert.match(d.html(), new RegExp(`data-undo="${first.id}"`));
    await click(d.ctx, { dataset: { undo: first.id } });
    const t = await api.transport.activeTrip('route-1');
    assert.deepEqual(t.childEvents.filter(e => e.studentId === first.id).map(e => e.type), ['absent', 'corrected']);
    assert.ok(!new RegExp(`data-undo="${first.id}"`).test(d.html()), 'undone: the mark buttons are back');
    assert.match(d.html(), new RegExp(`data-child="${first.id}"`));
  } finally { d.done(); }
});

test('#70 with no trip running the direction defaults from the time of day, and the start button names it', async () => {
  stubNavigator();
  for (const [hour, label] of [[8, 'Start morning pickup'], [15, 'Start afternoon drop']]) {
    const now = new Date(2026, 9, 2, hour, 5);
    mock.timers.enable({ apis: ['Date'], now });
    try {
      const api = await mkApi(now);
      const d = await drawDriver(api);
      try { assert.match(d.html(), new RegExp(label)); } finally { d.done(); }
    } finally { mock.timers.reset(); }
  }
});

// ---------------------------------------------------------------- #62 #65 pushes
const { pushMessages } = await import('../supabase/functions/_shared/notify.js');

test('#62 when the bus leaves a stop, the next stop\'s families hear "your stop is next"; a child marked absent gets no bus alerts', () => {
  const db = loopFixture();
  db.guardians.push({ id: 'GK3', firstName: 'G', lastName: 'Demoson', relation: 'father', phone: '+91-90000-00101', email: 'gk3@example.com', studentIds: ['K3'] });
  db.students.push({ id: 'K3', firstName: 'Ravi', lastName: 'Demoson', dob: '2022-01-01', programId: 'PA', admissionNo: 'K3', status: 'active', guardianIds: ['GK3'], routeId: 'R1', stopId: 'S2', feeCategory: 'regular', healthNotes: null });
  const r = db.routes[0];
  const trip = T.startTrip(db, { routeId: 'R1', direction: 'pickup' }, ctx());
  T.markChild(db, trip.id, { studentId: 'K2', type: 'absent' }, ctx(BASE_MS + 500));
  const msgs = [];
  for (const f of drive([{ lat: 12.966, lng: 77.750 }, r.stops[0], r.stops[1]])) {
    const res = T.recordPosition(db, trip.id, f);
    msgs.push(...pushMessages('transport.recordPosition', db, db, res));
  }
  const next = msgs.filter(m => m.payload.tag === `trip-${trip.id}-S2-next`);
  assert.equal(next.length, 1);
  assert.equal(next[0].payload.body, 'Bus left First. Second is next (scheduled 07:35)');
  assert.deepEqual(next[0].guardianIds, ['GK3'], 'Asha is absent today: her family is not alerted');
  assert.equal(msgs.filter(m => m.studentIds.includes('K2')).length, 0, 'no nearing/arrived for the absent child either');
  assert.ok(msgs.some(m => /nearing Second/.test(m.payload.body) && m.guardianIds.includes('GK3')));
});

test('#58 #62 a batch of backlog fixes pushes only the latest event per stop (no stale "nearing" after the bus has left)', () => {
  const db = loopFixture();
  const trip = T.startTrip(db, { routeId: 'R1', direction: 'pickup' }, ctx());
  const t = iso(BASE_MS + 5000);
  const newEvents = [{ stopId: 'S1', type: 'nearing', ts: t }, { stopId: 'S1', type: 'arrived', ts: t }, { stopId: 'S1', type: 'departed', ts: t }];
  trip.stopEvents.push(...newEvents);
  const msgs = pushMessages('transport.recordPositions', db, db, { trip, newEvents });
  assert.deepEqual(msgs.map(m => m.payload.body), ['Bus left First. Second is next (scheduled 07:35)']);
});

test('#65 undoing a mark sends a correction that replaces the wrong notification on the phone', () => {
  const db = loopFixture();
  const trip = T.startTrip(db, { routeId: 'R1', direction: 'pickup' }, ctx());
  const wrong = T.markChild(db, trip.id, { studentId: 'K2', type: 'absent' }, ctx(BASE_MS + 60000));
  const [first] = pushMessages('transport.markChild', db, db, wrong);
  const fix = T.markChild(db, trip.id, { studentId: 'K2', type: 'corrected' }, ctx(BASE_MS + 70000));
  const [corr] = pushMessages('transport.markChild', db, db, fix);
  assert.equal(corr.payload.tag, first.payload.tag, 'same tag: the phone replaces the wrong message');
  assert.match(corr.payload.body, /^Correction: Asha was marked absent at Second was a mistake/);
  assert.deepEqual(corr.guardianIds, ['GK2']);
});

// ---------------------------------------------------------------- #58 backlog in one write
test('#58 recordPositions takes a backlog in one write: each fix as recordPosition would, refusals listed, not fatal', () => {
  const db = loopFixture();
  const trip = T.startTrip(db, { routeId: 'R1', direction: 'pickup' }, ctx());
  const fixes = drive([{ lat: 12.966, lng: 77.750 }, db.routes[0].stops[0]]).slice(0, 13);
  const dup = fixes[3];
  const out = COMMANDS['transport.recordPositions'].run(db, [trip.id, [...fixes.slice(0, 4), dup, ...fixes.slice(4), { lat: 'x', lng: 1, accuracy: 5, ts: iso(BASE_MS + 999999) }]], ctx(BASE_MS + 120000));
  assert.equal(out.accepted, 13);
  assert.deepEqual(out.rejected, ['not newer than the last fix', 'Invalid coordinates']);
  assert.deepEqual(out.newEvents.map(e => `${e.stopId}:${e.type}`), ['S1:nearing', 'S1:arrived']);
  assert.equal(out.trip.positions, undefined, 'the answer does not carry the positions back');
  assert.throws(() => COMMANDS['transport.recordPositions'].run(db, [trip.id, []], ctx()), { code: 'VALIDATION' });
  assert.throws(() => COMMANDS['transport.recordPositions'].run(db, [trip.id, Array(101).fill(fixes[0])], ctx()), { code: 'VALIDATION' });
});

// ---------------------------------------------------------------- sim-runner (real-app mode, api methods replaced)
const { api: appApi } = await import('../src/api/index.js');
const netErr = () => Object.assign(new Error('Failed to fetch'), { code: 'NETWORK' });
const gpsFix = (nav, n, kind = 'watch') => {
  const pos = { coords: { latitude: 12.9 + n / 1e4, longitude: 77.6, accuracy: 5 }, timestamp: Date.parse('2026-10-05T03:00:00Z') + n * 60000 };
  (kind === 'watch' ? nav.watched.at(-1).ok : nav.onCurrent)(pos);
  return new Promise(r => setImmediate(r));
};

test('#58 after a dead zone the queued fixes go out in one batched request, not one request each', async () => {
  const nav = stubNavigator();
  appApi.session.current = () => ({ id: 'drv-1' });
  let offline = true;
  const singles = [], batches = [];
  appApi.transport.recordPosition = async (t, f) => { singles.push(f); if (offline) throw netErr(); return {}; };
  appApi.transport.recordPositions = async (t, fs) => { batches.push(fs.length); if (offline) throw netErr(); return { accepted: fs.length, rejected: [] }; };
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    runner.startGps('trip-1', 'r1');
    for (let n = 1; n <= 4; n++) await gpsFix(nav, n);
    assert.equal(runner.snapshot().queued, 4);
    offline = false;
    const before = singles.length;
    await runner.flushNow();
    assert.equal(runner.snapshot().queued, 0);
    assert.equal(batches.at(-1), 4, 'the whole backlog in one call');
    assert.equal(singles.length, before, 'no single sends for the backlog');
    assert.equal(runner.snapshot().sent, 4);
  } finally { mock.timers.reset(); runner.resetAfterTripEnd(); }
});

test('#60 with no GPS callback for 20 s the runner asks for a fresh fix and sends it; a watch timeout right after a fix is not an error', async () => {
  const nav = stubNavigator();
  appApi.session.current = () => ({ id: 'drv-1' });
  const sent = [];
  appApi.transport.recordPosition = async (t, f) => { sent.push(f); return {}; };
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-10-05T03:00:00Z') });
  try {
    runner.startGps('trip-1', 'r1');
    mock.timers.tick(20000);
    assert.equal(nav.current, 1, 'getCurrentPosition after 20 s of silence');
    assert.equal(nav.currentOpts.maximumAge, 0, 'a fresh fix, never a cached one');
    await gpsFix(nav, 1, 'current');
    assert.equal(sent.length, 1, 'the fresh fix is sent (parents see the bus is alive)');
    mock.timers.tick(10000);
    nav.watched.at(-1).err({ code: 3, message: 'Timeout expired' });
    assert.equal(runner.snapshot().gps.status, 'ok', 'standing still is not a GPS failure');
    mock.timers.tick(70000);
    nav.watched.at(-1).err({ code: 3, message: 'Timeout expired' });
    assert.equal(runner.snapshot().gps.status, 'timeout', 'a long silence still shows');
  } finally { mock.timers.reset(); runner.resetAfterTripEnd(); }
});

// ---------------------------------------------------------------- remote api (fake Supabase client)
const { createRemoteApi } = await import('../src/api/remote.js');
const { createSurface, ApiError, toApiError, op } = await import('../src/api/index.js');
const { subscribeNudges } = await import('../src/api/supabase/realtime.js');

function fakeSb({ snapshot, tables = {} }) {
  const session = { user: { id: 'u-drv', email: 'driver1@example.com' }, access_token: 't' };
  const sb = {
    rpcs: 0, channels: [],
    auth: { getSession: async () => ({ data: { session } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }), signOut: async () => ({}) },
    rpc: async () => { sb.rpcs += 1; return { data: snapshot(), error: null }; },
    from(table) {
      const q = { table, filters: [] };
      const b = {
        select() { return b; }, eq(c, v) { q.filters.push(['eq', c, v]); return b; }, gte(c, v) { q.filters.push(['gte', c, v]); return b; },
        in(c, v) { q.filters.push(['in', c, v]); return b; }, order() { return b; }, limit() { return b; },
        then(res, rej) { return Promise.resolve(tables[table] ? tables[table](q) : { data: [], error: null }).then(res, rej); },
      };
      return b;
    },
    channel(name) { const ch = { name, tables: [], on(_t, f) { ch.tables.push(f.table); return ch; }, subscribe() { return ch; } }; sb.channels.push(ch); return ch; },
    removeChannel() {},
  };
  return sb;
}

test('#57 #72 real app: a GPS fix or a backlog does not re-download the school snapshot; the driver\'s trip is read fresh from the server', async () => {
  const NOW2 = new Date();
  const seedDb = buildSeed(NOW2);
  const me = { userId: 'u-drv', role: 'driver', staffId: 'stf-driver-1', guardianId: null };
  const tripDoc = { id: 'trp-live', routeId: 'route-1', direction: 'pickup', date: seedDb.trips[0]?.date || '2026-10-02', driverId: 'stf-driver-1', simulated: false, status: 'active',
    startedAt: new Date(Date.now() - 60000).toISOString(), endedAt: null, stopEvents: [{ stopId: 'route-1-stop-1', type: 'arrived', ts: new Date().toISOString() }] };
  const snapTrip = { ...tripDoc, stopEvents: [], positions: [], childEvents: [] }; // what the (older) snapshot holds
  const sb = fakeSb({
    snapshot: () => ({ status: 'active', me, revs: {}, remindersSent: [], ...structuredClone(seedDb), trips: [snapTrip], auditLog: [] }),
    tables: {
      trips: q => ({ data: q.filters.every(f => f[1] !== 'route_id' || f[2] === 'route-1') ? [{ doc: tripDoc }] : [], error: null }),
      trip_child_events: () => ({ data: [{ trip_id: 'trp-live', seq: 1, doc: { studentId: 'stu-01', stopId: 'route-1-stop-1', type: 'boarded', ts: new Date().toISOString(), by: 'stf-driver-1' } }], error: null }),
      trip_positions: () => ({ data: [{ lat: 12.9, lng: 77.6, accuracy: 5, ts: new Date().toISOString() }], error: null }),
    },
  });
  const called = [];
  const api = await createRemoteApi({ supabaseUrl: 'http://127.0.0.1:9', supabaseAnonKey: 'x' }, { createSurface, ApiError, toApiError, op, sb,
    call: async (fn, body) => { called.push(body.name); return { result: { trip: { id: 'trp-live' }, newEvents: [], rejected: null, accepted: 1 } }; } });
  await api.ready();
  const after = sb.rpcs;
  const fix = { lat: 12.9, lng: 77.6, accuracy: 5, ts: new Date().toISOString() };
  await api.transport.recordPosition('trp-live', fix);
  await api.transport.recordPositions('trp-live', [fix, fix]);
  assert.deepEqual(called, ['transport.recordPosition', 'transport.recordPositions']);
  assert.equal(sb.rpcs, after, 'no snapshot download per fix');
  const t = await api.transport.activeTrip('route-1');
  assert.deepEqual(t.stopEvents.map(e => e.type), ['arrived'], 'stop events from the server, not the older snapshot');
  assert.deepEqual(t.childEvents.map(e => e.type), ['boarded']);
  assert.equal(t.positions.length, 1);
  const hist = await api.transport.trips({});
  assert.deepEqual(hist.map(x => [x.id, x.stopEvents.length]), [['trp-live', 1]], 'trip history from the server too');

  const nudges = fakeSb({ snapshot: () => null });
  subscribeNudges(nudges, () => {});
  const tables = nudges.channels.flatMap(c => c.tables);
  assert.ok(!tables.includes('trips') && !tables.includes('trip_child_events'), 'a stop event no longer makes every signed-in user re-download the snapshot');
  assert.ok(tables.includes('messages'));
});

// ---------------------------------------------------------------- #69 forgotten trips
test('#69 the system ends a finished route soon after its last stop, never one with a child unaccounted for', () => {
  const db = loopFixture();
  const r = db.routes[0];
  const sys = ms => ({ actor: { role: 'system', id: 'cron-daily' }, now: iso(ms), today: '2026-10-02' });
  const run = (tripId, ms) => COMMANDS['transport.autoEndIfFinished'].run(db, [tripId], sys(ms));
  assert.equal(COMMANDS['transport.autoEndIfFinished'].serverOnly, true);
  const trip = T.startTrip(db, { routeId: 'R1', direction: 'drop' }, ctx());
  const fixes = drive([r.stops[0], r.stops[1], r.stops[2], r.stops[3], r.stops[4], { lat: 12.955, lng: 77.745 }]);
  for (const f of fixes) T.recordPosition(db, trip.id, f);
  const leftLast = T.tripChecklist(db, trip).lastStopLeftAt;
  assert.ok(leftLast, 'the last stop was left');
  const lastFixMs = Date.parse(fixes.at(-1).ts);
  assert.equal(run(trip.id, Date.parse(leftLast) + 45 * 60000).ended, false, 'children not marked: it keeps running (a child may be on board)');
  for (const k of ['K1', 'K2', 'K5']) T.markChild(db, trip.id, { studentId: k, type: 'dropped' }, ctx(lastFixMs));
  assert.equal(run(trip.id, Date.parse(leftLast) + 10 * 60000).ended, false, 'too soon after the last stop');
  const out = run(trip.id, Date.parse(leftLast) + 31 * 60000);
  assert.equal(out.ended, true);
  assert.equal(trip.status, 'ended');
  assert.match(trip.autoEnded, /route finished/);

  const pick = T.startTrip(db, { routeId: 'R1', direction: 'pickup' }, ctx(lastFixMs + 60000));
  for (const k of ['K1', 'K2', 'K5']) T.markChild(db, pick.id, { studentId: k, type: 'boarded' }, ctx(lastFixMs + 70000));
  assert.equal(run(pick.id, lastFixMs + 3 * 3600000 - 60000).ended, false, 'a pickup whose last stop was never left waits for the driver (or the 3-hour limit)');
});

// ---------------------------------------------------------------- #74 parent map
function fakeLeaflet() {
  const handlers = {};
  const log = { fits: 0, controls: [] };
  const chain = (o = {}) => Object.assign(o, { addTo() { return o; }, bindTooltip() { return o; }, setLatLng() { return o; }, remove() {} });
  const map = {
    on(n, f) { (handlers[n] ||= []).push(f); return map; },
    fire(n) { (handlers[n] || []).forEach(f => f({})); },
    fitBounds() { log.fits += 1; map.fire('zoomstart'); return map; }, // with animate:false Leaflet fires zoomstart at once
    setView() { return map; }, invalidateSize() {}, remove() {},
    getBounds: () => ({ contains: () => false }), // the bus is always outside the current view
  };
  const L = {
    map: () => map, tileLayer: () => chain(), marker: () => chain(), divIcon: () => ({}),
    polyline: () => chain({ getBounds: () => ({ isValid: () => true }) }), latLngBounds: () => ({}),
    control: () => { const c = { addTo() { c.el = c.onAdd(map); log.controls.push(c); return c; } }; return c; },
    DomUtil: { create: (tag, cls) => ({ tag, className: cls, textContent: '', type: '', setAttribute() {}, listeners: {} }) },
    DomEvent: { on(el, n, f) { el.listeners[n] = f; }, disableClickPropagation() {} },
  };
  return { L, map, log };
}

test('#74 the parent map follows the bus only until the parent zooms or drags; "Show bus" brings it back', async () => {
  const { createRouteMap } = await import('../src/ui/map.js');
  const { L, map, log } = fakeLeaflet();
  globalThis.window = { L };
  try {
    const route = loopFixture().routes[0];
    const m = createRouteMap(fake(), route, {});
    const base = log.fits;
    m.setBus(12.99, 77.75, 'BUS');
    assert.equal(log.fits, base + 1, 'bus off-screen: the map refits while following');
    map.fire('zoomstart'); // the parent zooms in on their stop
    m.setBus(12.991, 77.75, 'BUS');
    assert.equal(log.fits, base + 1, 'no snapping back after the parent zoomed');
    const show = log.controls.at(-1)?.el;
    assert.ok(show && /Show bus/.test(show.textContent), 'a Show bus button');
    show.listeners.click({ preventDefault() {}, stopPropagation() {} });
    assert.equal(log.fits, base + 2, 'Show bus brings the bus into view');
    m.setBus(12.992, 77.75, 'BUS');
    assert.equal(log.fits, base + 3, 'and following resumes');
  } finally { delete globalThis.window; }
});

// ---------------------------------------------------------------- #75 fleet screen
test('#75 fleet history shows duration and stop events (not a positions count the real app cannot know); buses move on the live feed; polling every 20 s', async () => {
  stubNavigator();
  const api = await mkApi();
  api.session.set('persona-stf-principal');
  const trip = await api.transport.startTrip({ routeId: 'route-2', direction: 'pickup', simulated: true });
  await api.transport.endTrip(trip.id, { busChecked: true });
  let reads = 0;
  const subscribed = [];
  const transport = { ...api.transport,
    activeTrip: async (id) => { reads += 1; return api.transport.activeTrip(id); },
    subscribeTrip: (routeId, fn) => { subscribed.push(routeId); return () => {}; } };
  const Admin = await import('../src/ui/screens/bus-admin.js');
  const cleanups = [];
  const ctx = { api: { ...api, transport }, persona: api.session.current(), query: {}, params: {}, el: fake(), get db() { return api.getDb(); },
    go() {}, setQuery() {}, toast() {}, onChange() {}, cleanup: f => cleanups.push(f), rerender() {} };
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    await Admin.render(ctx);
    const html = allHtml(ctx.el);
    assert.match(html, /<th class="r">Duration<\/th>/);
    assert.ok(!/>Positions</.test(html), 'no positions column');
    assert.match(html, /<td class="r num">\d+ min<\/td>/);
    assert.deepEqual(subscribed.sort(), ['route-1', 'route-2'], 'a live feed per route for the bus markers');
    const after = reads;
    mock.timers.tick(3000);
    assert.equal(reads, after, 'no 3-second polling in the real app');
    mock.timers.tick(17000);
    await new Promise(r => setImmediate(r));
    assert.ok(reads > after, 'a 20-second fallback poll');
  } finally { cleanups.forEach(f => f()); mock.timers.reset(); }
});
