// Wave 2, bus and driver: reported absences on the driver screen (#8), the pick-up list and who received a child (#68),
// "Running late" and bus-route notices (#85), the teacher's bus notes from the real app's data (#67/#22), and the
// principal's fleet card and "Trip still running" (#64/#69 leftovers).
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { todayISO } from '../src/domain/dates.js';

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
    closest: () => null, appendChild() {}, remove() {}, focus() {}, setAttribute() {}, showModal() {}, close() {}, insertAdjacentHTML(_w, h) { html += h; },
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
const { href } = await import('../src/ui/router.js');
const runner = await import('../src/ui/sim-runner.js');
const Driver = await import('../src/ui/screens/bus-driver.js');
const Notices = await import('../src/ui/screens/notices.js');
const Attendance = await import('../src/ui/screens/attendance.js');
const Pickup = await import('../src/ui/screens/pickup.js');
const Admin = await import('../src/ui/screens/bus-admin.js');
const Home = await import('../src/ui/screens/home.js');
const DRIVER = 'persona-stf-driver-1', PRINCIPAL = 'persona-stf-principal', TEACHER = 'persona-stf-teacher-pa', PARENT = 'persona-grd-01';

function stubNavigator() {
  const nav = { onLine: true, geolocation: { watchPosition: () => 1, clearWatch() {}, getCurrentPosition() {} }, permissions: { query: async () => ({ state: 'prompt' }) }, vibrate: () => true };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: nav });
}
stubNavigator();
async function mkApi(now = new Date()) {
  const api = createApi({ backend: memoryBackend(), sessionBackend: memoryBackend(), seedFn: () => buildSeed(now), clock: () => now });
  await api.ready();
  return api;
}
async function draw(api, who, mod, { query = {}, params = {} } = {}) {
  api.session.set(who);
  const cleanups = [];
  const ctx = { api, persona: api.session.current(), query, params, el: fake(), get db() { return api.getDb(); },
    go() {}, setQuery() {}, href, toast() {}, onChange() {}, cleanup: f => cleanups.push(f), rerender() {} };
  await mod.render(ctx);
  return { ctx, html: () => allHtml(ctx.el), done: () => { cleanups.forEach(f => f()); runner.resetAfterTripEnd(); } };
}
const click = (ctx, button) => ctx.el.handlers.click[0]({ target: { closest: () => ({ dataset: {}, setAttribute() {}, ...button }) } });
// poll for a condition (async work behind a tap), at most 2 s
async function until(cond, what) {
  for (let i = 0; i < 400; i++) { if (cond()) return; await new Promise(r => setTimeout(r, 5)); }
  assert.fail(`timed out waiting for ${what}`);
}
const nextDialog = async (n) => { await until(() => dialogs.length > n, 'a dialog'); return dialogs[dialogs.length - 1]; };
// openModal: the footer buttons in order; tap one by its label
const actionsOf = d => [...d.innerHTML.matchAll(/<button class="btn ([^"]*)" data-act="(\d+)">([^<]*)<\/button>/g)].map(m => ({ cls: m[1], act: m[2], label: m[3] }));
const tapAction = (d, label) => {
  const a = actionsOf(d).find(x => x.label === label);
  assert.ok(a, `no "${label}" in ${actionsOf(d).map(x => x.label).join(', ')}`);
  d.handlers.click[0]({ target: { closest: () => ({ hasAttribute: () => false, dataset: { act: a.act } }) } });
};
// formModal: submit with these values
async function submitForm(d, entries) {
  const FD = globalThis.FormData;
  globalThis.FormData = class { entries() { return entries[Symbol.iterator](); } [Symbol.iterator]() { return entries[Symbol.iterator](); } };
  try { await d.querySelector('form').handlers.submit[0]({ preventDefault() {} }); } finally { globalThis.FormData = FD; }
}
const route1Kids = api => api.getDb().students.filter(s => s.status === 'active' && s.routeId === 'route-1');
async function reportAbsentToday(api, studentId) {
  api.session.set(PARENT);
  for (const r of await api.care.leave({ studentId })) if (r.status === 'active') await api.care.withdrawLeave(r.id);
  await api.care.requestLeave({ studentId, fromDate: todayISO(), toDate: todayISO(), reason: 'Fever' });
}

// ---------------------------------------------------------------- #8 reported absences on the driver screen
test('#8 driver: today\'s reported absences are listed, the child is greyed with "Confirm absent", and one tap confirms them all', async () => {
  const api = await mkApi();
  await reportAbsentToday(api, 'stu-01');
  api.session.set(DRIVER);
  const trip = await api.transport.startTrip({ routeId: 'route-1', direction: 'pickup', simulated: true });
  const d = await draw(api, DRIVER, Driver);
  try {
    const html = d.html();
    assert.match(html, /<h2[^>]*>Absent today \(reported by parent\)<\/h2>/);
    assert.match(html, /<span class="muted">Neel [^<]*<span class="badge mute">Absent today \(reported by parent\)<\/span>/, 'greyed row');
    assert.match(html, /data-child="stu-01"[^>]*data-type="absent">Confirm absent</);
    assert.ok(!/Fever/.test(html), 'the reason is never shown to the driver');
    assert.match(html, /data-confirm-absent>Confirm absent</);
    assert.match(html, /Next stop/, 'wave-1 layout kept');
    await click(d.ctx, { dataset: { confirmAbsent: '' } });
    const t = await api.transport.activeTrip('route-1');
    assert.deepEqual(t.childEvents.map(e => [e.studentId, e.type]), [['stu-01', 'absent']], 'only the reported child');
    assert.equal(t.id, trip.id);
    assert.match(d.html(), /badge mute">Confirmed</);
    assert.ok(!/data-confirm-absent/.test(d.html()));
  } finally { d.done(); }
});

// ---------------------------------------------------------------- #68 pick-up list and who received the child
test('#68 driver: each child row opens the pick-up list with tap-to-call; nothing is recorded by looking at it', async () => {
  const api = await mkApi();
  api.session.set(DRIVER);
  await api.transport.startTrip({ routeId: 'route-1', direction: 'drop', simulated: true });
  const d = await draw(api, DRIVER, Driver);
  try {
    for (const k of route1Kids(api)) assert.match(d.html(), new RegExp(`data-people="${k.id}">Pick-up list<`));
    const n = dialogs.length;
    const p = click(d.ctx, { dataset: { people: 'stu-01' } });
    const dlg = await nextDialog(n);
    assert.match(dlg.innerHTML, /Who may collect Neel/);
    assert.match(dlg.innerHTML, /<strong>Sarla Notrealsen<\/strong> <small>Grandmother<\/small>/);
    assert.match(dlg.innerHTML, /<a class="btn block" href="tel:\+91\d+">Call \+91-/);
    dlg.handlers.click[0]({ target: { closest: () => ({ hasAttribute: a => a === 'data-close', dataset: {} }) } });
    await p;
    assert.equal((await api.transport.activeTrip('route-1')).childEvents.length, 0);
  } finally { d.done(); }
});

test('#68 a drop asks who received the child: the usual person first, then the others; "Someone else" takes a name; "Not now" still records the drop', async () => {
  const api = await mkApi();
  api.session.set(DRIVER);
  let trip = await api.transport.startTrip({ routeId: 'route-1', direction: 'drop', simulated: true });
  let d = await draw(api, DRIVER, Driver);
  try {
    // no history: a parent first, then the family's list, then someone else / not now
    let n = dialogs.length;
    let p = click(d.ctx, { dataset: { child: 'stu-01', stop: 'route-1-stop-3', type: 'dropped' } });
    let dlg = await nextDialog(n);
    assert.match(dlg.innerHTML, /Who took Neel\?/);
    assert.deepEqual(actionsOf(dlg).map(a => a.label), ['A parent', 'Sarla Notrealsen (Grandmother)', 'Someone else', 'Not now']);
    assert.equal(actionsOf(dlg)[0].cls, 'primary block', 'the first choice is the big one');
    tapAction(dlg, 'Sarla Notrealsen (Grandmother)');
    await p;
    const contact = api.getDb().pickupContacts.find(c => c.studentId === 'stu-01');
    let ev = (await api.transport.activeTrip('route-1')).childEvents.find(e => e.studentId === 'stu-01');
    assert.deepEqual([ev.type, ev.receivedBy], ['dropped', { kind: 'contact', contactId: contact.id }]);
    assert.match(d.html(), /Received by Sarla Notrealsen \(Grandmother\)/);

    // closing the question records nothing
    n = dialogs.length;
    p = click(d.ctx, { dataset: { child: 'stu-13', stop: 'route-1-stop-1', type: 'dropped' } });
    dlg = await nextDialog(n);
    dlg.handlers.click[0]({ target: { closest: () => ({ hasAttribute: a => a === 'data-close', dataset: {} }) } });
    await p;
    assert.ok(!(await api.transport.activeTrip('route-1')).childEvents.some(e => e.studentId === 'stu-13'));
    assert.match(d.html(), /data-child="stu-13"[^>]*data-type="dropped"/, 'the buttons stay');

    // someone not on the list, by name
    n = dialogs.length;
    p = click(d.ctx, { dataset: { child: 'stu-03', stop: 'route-1-stop-2', type: 'dropped' } });
    dlg = await nextDialog(n);
    tapAction(dlg, 'Someone else');
    const form = await nextDialog(n + 1);
    assert.match(form.innerHTML, /Not on the family's list/);
    await submitForm(form, [['name', '  Ravi   Testkumar ']]);
    await p;
    ev = (await api.transport.activeTrip('route-1')).childEvents.find(e => e.studentId === 'stu-03');
    assert.deepEqual(ev.receivedBy, { kind: 'other', name: 'Ravi Testkumar' });

    for (const k of route1Kids(api)) if (!['stu-01', 'stu-03'].includes(k.id)) await api.transport.markChild(trip.id, { studentId: k.id, type: 'absent' });
    await api.transport.endTrip(trip.id, { busChecked: true });
  } finally { d.done(); }

  // the next drop: the person who took Neel last time comes first; "Not now" records the drop without a name
  trip = await api.transport.startTrip({ routeId: 'route-1', direction: 'drop', simulated: true });
  d = await draw(api, DRIVER, Driver);
  try {
    const n = dialogs.length;
    const p = click(d.ctx, { dataset: { child: 'stu-01', stop: 'route-1-stop-3', type: 'dropped' } });
    const dlg = await nextDialog(n);
    assert.deepEqual(actionsOf(dlg).slice(0, 2).map(a => [a.label, a.cls]), [['Sarla Notrealsen (Grandmother)', 'primary block'], ['A parent', 'block']]);
    tapAction(dlg, 'Not now');
    await p;
    const ev = (await api.transport.activeTrip('route-1')).childEvents.find(e => e.studentId === 'stu-01');
    assert.equal(ev.type, 'dropped');
    assert.equal(ev.receivedBy, undefined);
  } finally { d.done(); }
});

// ---------------------------------------------------------------- #85 running late, bus-route notices
test('#85 "Running late": the driver picks how late and an optional reason; the families on the route get an important notice', async () => {
  const api = await mkApi();
  api.session.set(DRIVER);
  const d = await draw(api, DRIVER, Driver);
  try {
    assert.match(d.html(), /<button class="btn block" id="d-late">Running late<\/button>/, 'before a trip too');
    const n = dialogs.length;
    const p = click(d.ctx, { id: 'd-late' });
    const dlg = await nextDialog(n);
    for (const t of ['About 10 minutes late', 'About 20 minutes late', '30 minutes late or more', 'The bus has broken down', 'Reason (optional)']) assert.ok(dlg.innerHTML.includes(t), t);
    await submitForm(dlg, [['kind', 'late20'], ['reason', ' Heavy  traffic ']]);
    await p;
    const nt = api.getDb().notices.at(-1);
    assert.deepEqual(nt.audience, { scope: 'route', routeIds: ['route-1'] });
    assert.equal(nt.important, true);
    assert.match(nt.title, /about 20 minutes late/);
    assert.match(nt.body, /Reason: Heavy traffic$/);
  } finally { d.done(); }
  await assert.rejects(api.transport.runningLate({ routeId: 'route-1', kind: 'late10', reason: 'x'.repeat(121) }), /at most 120/);
  const plain = await api.transport.runningLate({ routeId: 'route-1', kind: 'late10' });
  assert.ok(!/Reason/.test(plain.body));
  await api.transport.startTrip({ routeId: 'route-1', direction: 'pickup', simulated: true });
  const d2 = await draw(api, DRIVER, Driver);
  try { assert.match(d2.html(), /id="d-late">Running late<\/button><button class="btn danger" id="d-end">End trip/, 'during a trip, beside End trip'); } finally { d2.done(); }
});

test('#85 notices: the principal can send to a bus route (teachers cannot choose it); route notices list as "Bus route: …"', async () => {
  const api = await mkApi();
  api.session.set(DRIVER);
  await api.transport.runningLate({ routeId: 'route-1', kind: 'late10' });
  const p = await draw(api, PRINCIPAL, Notices);
  assert.match(p.html(), /Bus route: Route 1 - Maple Grove East/);
  const n = dialogs.length;
  const sent = p.ctx.el.querySelector('#n-new').handlers.click[0]();
  const dlg = await nextDialog(n);
  assert.match(dlg.innerHTML, /<input type="radio" name="scope" value="route"> Bus route/);
  assert.match(dlg.innerHTML, /name="routeIds" value="route-2"> Route 2 - Lakeview North/);
  await submitForm(dlg, [['title', 'Route 2 change'], ['body', 'New stop from Monday'], ['scope', 'route'], ['routeIds', 'route-2']]);
  await sent;
  const nt = api.getDb().notices.at(-1);
  assert.deepEqual([nt.title, nt.audience], ['Route 2 change', { scope: 'route', routeIds: ['route-2'] }]);
  const route2 = new Set(api.getDb().students.filter(s => s.routeId === 'route-2' && s.status === 'active').map(s => s.id));
  assert.ok(api.getDb().noticeReceipts.filter(r => r.noticeId === nt.id).every(r => r.studentIds.every(id => route2.has(id))));

  const t = await draw(api, TEACHER, Notices);
  const m = dialogs.length;
  t.ctx.el.querySelector('#n-new').handlers.click[0]();
  const tdlg = await nextDialog(m);
  assert.ok(!/value="route"/.test(tdlg.innerHTML), 'no bus-route choice for a teacher');
  const parent = await draw(api, PARENT, Notices);
  assert.match(parent.html(), /Bus route: Route 1 - Maple Grove East/);
});

// ---------------------------------------------------------------- #67/#22 the teacher's bus notes
test('#67 register: "Came by bus" from the morning trip; a boarding that was undone does not count', async () => {
  const api = await mkApi();
  api.session.set(DRIVER);
  const trip = await api.transport.startTrip({ routeId: 'route-1', direction: 'pickup', simulated: true });
  await api.transport.markChild(trip.id, { studentId: 'stu-15', type: 'boarded' });
  await api.transport.markChild(trip.id, { studentId: 'stu-16', type: 'boarded' });
  await api.transport.markChild(trip.id, { studentId: 'stu-16', type: 'corrected' });
  const d = await draw(api, TEACHER, Attendance);
  const rowOf = (html, name) => html.split('<div class="att-row">').find(r => r.includes(`>${name} `)) || '';
  assert.match(rowOf(d.html(), 'Navya'), /Came by bus<\/strong> \d\d:\d\d/);
  assert.ok(!/Came by bus/.test(rowOf(d.html(), 'Rohan')), 'undone boarding');
});

test('#22 Going home: a child on today\'s drop bus is pre-filled "On the bus" (not recorded until the teacher taps)', async () => {
  const api = await mkApi();
  api.session.set(DRIVER);
  const trip = await api.transport.startTrip({ routeId: 'route-1', direction: 'drop', simulated: true });
  await api.transport.markChild(trip.id, { studentId: 'stu-15', type: 'dropped', receivedBy: { kind: 'guardian' } });
  await api.transport.markChild(trip.id, { studentId: 'stu-17', type: 'boarded' });
  await api.transport.markChild(trip.id, { studentId: 'stu-16', type: 'boarded' });
  await api.transport.markChild(trip.id, { studentId: 'stu-16', type: 'corrected' });
  const d = await draw(api, TEACHER, Pickup);
  const card = name => d.html().split('<div class="card stack">').find(c => c.includes(`>${name} `)) || '';
  assert.match(card('Navya'), /On the drop bus<\/strong>: dropped at \d\d:\d\d/);
  assert.match(card('Navya'), /<button class="chip on" data-quick="stu-15" data-by="bus:">/);
  assert.match(card('Tara'), /On the drop bus<\/strong>: boarded at \d\d:\d\d/);
  assert.ok(!/On the drop bus/.test(card('Rohan')), 'undone mark');
  assert.ok(!/chip on/.test(card('Rohan')));
  api.session.set(TEACHER);
  assert.equal((await api.care.pickups({ programId: 'prog-primary-a', from: todayISO() })).length, 0, 'nothing recorded by itself');
});

test('#67 real app: the teacher\'s trips for a day carry the boarding marks as the server has them now, not the older snapshot\'s', async () => {
  const { createRemoteApi } = await import('../src/api/remote.js');
  const { createSurface, ApiError, toApiError, op } = await import('../src/api/index.js');
  const NOW = new Date();
  const seedDb = buildSeed(NOW);
  const me = { userId: 'u-t', role: 'teacher', staffId: 'stf-teacher-pa', guardianId: null };
  const today = todayISO();
  const tripDoc = { id: 'trp-am', routeId: 'route-1', direction: 'pickup', date: today, driverId: 'stf-driver-1', simulated: false, status: 'active', startedAt: new Date(Date.now() - 600000).toISOString(), endedAt: null, stopEvents: [] };
  const queried = [];
  const session = { user: { id: 'u-t', email: 'teacher-pa@example.com' }, access_token: 't' };
  const sb = {
    auth: { getSession: async () => ({ data: { session } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }), signOut: async () => ({}) },
    rpc: async () => ({ data: { status: 'active', me, revs: {}, remindersSent: [], ...structuredClone(seedDb), trips: [], auditLog: [] }, error: null }),
    from(table) {
      const filters = [];
      const b = { select() { return b; }, eq(c, v) { filters.push([c, v]); return b; }, gte(c, v) { filters.push([c, v]); return b; }, in(c, v) { filters.push([c, v]); return b; }, order() { return b; }, limit() { return b; },
        then(res, rej) {
          queried.push(table);
          const data = table === 'trips' ? [{ doc: tripDoc }]
            : table === 'trip_child_events' ? [{ trip_id: 'trp-am', seq: 1, doc: { studentId: 'stu-15', stopId: 'route-1-stop-2', type: 'boarded', ts: new Date().toISOString(), by: 'stf-driver-1' } }] : [];
          return Promise.resolve({ data, error: null }).then(res, rej);
        } };
      return b;
    },
    channel() { const ch = { on() { return ch; }, subscribe() { return ch; } }; return ch; },
    removeChannel() {},
  };
  const api = await createRemoteApi({ supabaseUrl: 'http://127.0.0.1:9', supabaseAnonKey: 'x' }, { createSurface, ApiError, toApiError, op, sb, call: async () => ({}) });
  await api.ready();
  const trips = await api.transport.trips({ date: today });
  assert.deepEqual(trips.map(t => t.childEvents.map(e => [e.studentId, e.type])), [[['stu-15', 'boarded']]]);
  assert.ok(queried.includes('trip_child_events'));
});

// ---------------------------------------------------------------- principal: fleet card and Needs attention
test('#64 fleet card lists the children not marked yet on a running trip', async () => {
  const api = await mkApi();
  api.session.set(DRIVER);
  const trip = await api.transport.startTrip({ routeId: 'route-1', direction: 'pickup', simulated: true });
  const kids = route1Kids(api);
  for (const k of kids.slice(1)) await api.transport.markChild(trip.id, { studentId: k.id, type: 'boarded' });
  const d = await draw(api, PRINCIPAL, Admin);
  try {
    assert.match(d.html(), new RegExp(`Not marked yet:</strong> ${kids[0].firstName} ${kids[0].lastName}</div>`));
    assert.equal((d.html().match(/Not marked yet/g) || []).length, 1, 'only the running trip');
  } finally { d.done(); }
});

test('#69 principal home: a trip still running well after its last stop\'s time is in Needs attention', async () => {
  const now = new Date(2026, 9, 2, 11, 0); // the morning run's last stop is at 07:42
  mock.timers.enable({ apis: ['Date'], now });
  try {
    const api = await mkApi(now);
    api.session.set(DRIVER);
    await api.transport.startTrip({ routeId: 'route-1', direction: 'pickup', simulated: true });
    const d = await draw(api, PRINCIPAL, Home);
    assert.match(d.html(), /Trip still running: Route 1 - Maple Grove East \(morning pickup since 02-Oct-2026 11:00\)/);
    assert.match(d.html(), /href="#\/bus"/);
  } finally { mock.timers.reset(); }
  const now2 = new Date(2026, 9, 2, 7, 20);
  mock.timers.enable({ apis: ['Date'], now: now2 });
  try {
    const api = await mkApi(now2);
    api.session.set(DRIVER);
    await api.transport.startTrip({ routeId: 'route-1', direction: 'pickup', simulated: true });
    const d = await draw(api, PRINCIPAL, Home);
    assert.ok(!/Trip still running/.test(d.html()), 'a trip on time is not flagged');
  } finally { mock.timers.reset(); }
});
