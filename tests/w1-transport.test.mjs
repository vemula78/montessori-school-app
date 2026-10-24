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
