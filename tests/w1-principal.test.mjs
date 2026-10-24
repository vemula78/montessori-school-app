// Wave 1, principal administration: the erasure queue in one place (#44), children and families (#40), staff, classes,
// routes and stops (#77, #71), retention warning and leaving dates (#95), two-step recovery (#56).
// Screens are drawn against a minimal fake element and the real demo api (seeded), as in care-ui.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createApi } from '../src/api/index.js';
import { buildSeed } from '../src/seed/seed-data.js';
import { memoryBackend } from '../src/store/storage.js';
import { todayISO, addDays } from '../src/domain/dates.js';
import { href } from '../src/ui/router.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const NOW = new Date(); // the screens read the real date (todayISO); the seed is built around it
const EVIL = '"><img src=x onerror=alert(1)><script>alert(2)</script>';
const ADMIN = 'persona-stf-principal', TEACHER = 'persona-stf-teacher-pa', PARENT = 'persona-grd-01';

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
globalThis.document ??= { createElement: () => fake(), body: { appendChild() {} }, head: { appendChild() {} }, getElementById: () => null, addEventListener() {}, visibilityState: 'visible' };
globalThis.location ??= { hash: '', reload() {} };

async function mkApi() {
  const api = createApi({ backend: memoryBackend(), sessionBackend: memoryBackend(), seedFn: () => buildSeed(NOW), clock: () => NOW });
  await api.ready();
  return api;
}
async function draw(api, who, mod, query = {}, params = {}) {
  api.session.set(who);
  const ctx = { api, persona: api.session.current(), query, params, el: fake(), get db() { return api.getDb(); },
    go() {}, setQuery() {}, href, toast() {}, onChange() {}, cleanup() {}, rerender() {} };
  await mod.render(ctx);
  return deep(ctx.el);
}
// the page and every part a screen drew into a child element (tab bodies, panels)
const deep = (el) => [el.innerHTML, ...[...el.children.values()].map(deep)].join('\n');
const noRaw = (html) => { assert.ok(!html.includes('<img src=x') && !html.includes('<script>alert'), 'escaped'); };

const Admin = await import('../src/ui/screens/admin.js');
const Home = await import('../src/ui/screens/home.js');

// ---------------------------------------------------------------- #44 erasure requests from consent withdrawal
// The demo has no erasure_requests table (api.admin.erasureRequests() is []), so the real app's rows are stubbed here.
const withdrawal = (over = {}) => ({ id: 'era-1', guardianId: 'grd-01', guardianName: `Parent ${EVIL}`, requestedAt: '2026-10-20T05:00:00.000Z', status: 'open', doneAt: null, doneBy: null, ...over });

test('#44 an erasure request filed by withdrawing consent shows on the Data requests tab with Erase and Download, and in the tab badge', async () => {
  const api = await mkApi();
  api.session.set(ADMIN);
  const before = await draw(api, ADMIN, Admin, { tab: 'requests' });
  assert.ok(!/Consent withdrawn/.test(before), 'nothing to show in the demo');
  api.admin.erasureRequests = async () => [withdrawal(), withdrawal({ id: 'era-2', guardianId: 'grd-02', status: 'done', doneAt: '2026-10-21T05:00:00.000Z' })];
  const html = await draw(api, ADMIN, Admin, { tab: 'requests' });
  assert.match(html, /Erase personal details \(consent withdrawn\)/);
  assert.match(html, /data-act="erase" data-guardian="grd-01"/);
  assert.match(html, /data-act="export" data-guardian="grd-01"/);
  assert.ok(!html.includes('grd-02'), 'a finished erasure is hidden until "Show closed requests"');
  assert.match(html, /<strong>1<\/strong> open/);
  assert.match(html, /Data requests <span class="badge warn">1<\/span>/);
  noRaw(html);
  const closed = await draw(api, ADMIN, Admin, { tab: 'requests', closed: '1' });
  assert.match(closed, /data-guardian="grd-02"/);
});

test('#44 a clean-up that failed is shown with its error and counts as needing attention; one still running does not', async () => {
  const api = await mkApi();
  api.admin.erasureRequests = async () => [withdrawal({ status: 'cleanup', lastError: 'auth 500' }), withdrawal({ id: 'era-3', guardianId: 'grd-03', status: 'cleanup', lastError: null })];
  const html = await draw(api, ADMIN, Admin, { tab: 'requests' });
  assert.match(html, /Clean-up failed: auth 500/);
  assert.match(html, /<strong>1<\/strong> open/);
  const home = await draw(api, ADMIN, Home);
  assert.match(home, /1 open data request /);
});

test('#44 the home page counts consent-withdrawal erasures with the rights desk; Settings no longer has a second erasure queue', async () => {
  const api = await mkApi();
  api.admin.erasureRequests = async () => [withdrawal(), withdrawal({ id: 'era-4', guardianId: 'grd-04' })];
  const home = await draw(api, ADMIN, Home);
  assert.match(home, /2 open data requests/);
  assert.match(home, /tab=requests/);
  const src = read('src/ui/screens/settings-real.js');
  assert.ok(!src.includes('erasureRequests') && !src.includes('Data requests (erasure)'), 'one queue only: Administration > Data requests');
});

// ---------------------------------------------------------------- #77 classes and staff (registry commands, both modes)
const as = (api, who) => { api.session.set(who); return api; };
const code = async (p) => { try { await p; } catch (e) { return e.code; } return 'OK'; };

test('#77 a new class with a teacher: the teacher sees it at once (staff.programIds), the mirror follows, names stay unique', async () => {
  const api = as(await mkApi(), ADMIN);
  const cls = await api.setup.saveProgram({ name: 'Class Demo One', ageRange: '2 to 3 years', teacherIds: ['stf-teacher-pa'] });
  const d = api.getDb();
  assert.deepEqual(d.programs.find((p) => p.id === cls.id).teacherIds, ['stf-teacher-pa']);
  assert.ok(d.staff.find((s) => s.id === 'stf-teacher-pa').programIds.includes(cls.id));
  assert.ok(api.session.personas().find((p) => p.id === TEACHER).programIds.includes(cls.id));
  assert.equal(await code(api.setup.saveProgram({ name: ' class demo one ' })), 'VALIDATION');
  assert.equal(await code(api.setup.saveProgram({ name: 'X', teacherIds: ['stf-driver-1'] })), 'VALIDATION', 'only teachers teach');
  // edit: rename and swap the teacher
  await api.setup.saveProgram({ id: cls.id, name: 'Class Demo Two', teacherIds: ['stf-teacher-pb'] });
  const d2 = api.getDb();
  assert.ok(!d2.staff.find((s) => s.id === 'stf-teacher-pa').programIds.includes(cls.id));
  assert.deepEqual(d2.programs.find((p) => p.id === cls.id).teacherIds, ['stf-teacher-pb']);
  const audit = d2.auditLog.filter((r) => r.entity === 'program' && r.entityId === cls.id);
  assert.equal(audit.length, 2);
  assert.match(audit[1].summary, /name; teachers \+stf-teacher-pb -stf-teacher-pa/);
  as(api, TEACHER);
  assert.equal(await code(api.setup.saveProgram({ name: 'Mine' })), 'NOT_ALLOWED');
});

test('#77 closing a class: refused while children are in it; a closed class takes no children and no teachers; reopening works', async () => {
  const api = as(await mkApi(), ADMIN);
  const pid = 'prog-toddler';
  assert.equal(await code(api.setup.setProgramActive({ programId: pid, active: false })), 'VALIDATION');
  const kids = api.getDb().students.filter((s) => s.programId === pid && s.status === 'active');
  for (const k of kids) await api.people.updateStudent({ studentId: k.id, programId: 'prog-primary-a' });
  await api.setup.setProgramActive({ programId: pid, active: false });
  const d = api.getDb();
  assert.equal(d.programs.find((p) => p.id === pid).active, false);
  assert.ok(!d.staff.some((s) => (s.programIds || []).includes(pid)), 'its teachers are released');
  assert.equal(await code(api.people.updateStudent({ studentId: kids[0].id, programId: pid })), 'VALIDATION');
  assert.equal(await code(api.setup.saveProgram({ id: pid, teacherIds: ['stf-teacher-toddler'] })), 'VALIDATION');
  await api.setup.setProgramActive({ programId: pid, active: true });
  assert.ok(!('active' in api.getDb().programs.find((p) => p.id === pid)));
});

test('#77 staff: add a teacher with classes and a sign-in email; emails are unique across staff and parents; edits keep the email', async () => {
  const api = as(await mkApi(), ADMIN);
  const t = await api.setup.saveStaff({ firstName: 'Lata', lastName: 'Stubbington', role: 'teacher', phone: '+91-90000-00311', email: 'Lata.New@example.com', programIds: ['prog-primary-b'] });
  assert.equal(t.email, 'lata.new@example.com');
  const persona = api.session.personas().find((p) => p.staffId === t.id);
  assert.ok(persona && persona.role === 'teacher' && persona.programIds.includes('prog-primary-b'));
  assert.ok(api.getDb().programs.find((p) => p.id === 'prog-primary-b').teacherIds.includes(t.id));
  assert.equal(await code(api.setup.saveStaff({ firstName: 'Dup', role: 'driver', email: 'lata.new@example.com' })), 'VALIDATION');
  const parentEmail = api.getDb().guardians.find((g) => g.email).email;
  assert.equal(await code(api.setup.saveStaff({ firstName: 'Dup', role: 'driver', email: parentEmail })), 'VALIDATION');
  assert.equal(await code(api.setup.saveStaff({ id: t.id, email: 'other@example.com' })), 'VALIDATION', 'the account desk changes a sign-in email');
  await api.setup.saveStaff({ id: t.id, phone: '+91-90000-00312', programIds: ['prog-primary-a'] });
  const d = api.getDb();
  assert.deepEqual(d.staff.find((s) => s.id === t.id).programIds, ['prog-primary-a']);
  assert.ok(!d.programs.find((p) => p.id === 'prog-primary-b').teacherIds.includes(t.id));
  const rows = d.auditLog.filter((r) => r.entity === 'staff' && r.entityId === t.id);
  assert.ok(rows.every((r) => !/Lata|90000|example\.com/.test(r.summary)), 'audit rows carry ids, never names, phones or emails');
});

test('#77 taking someone off the staff: never yourself, never the only principal, never a route driver; a teacher leaves their classes and the persona list', async () => {
  const api = as(await mkApi(), ADMIN);
  assert.equal(await code(api.setup.setStaffActive({ staffId: 'stf-principal', active: false })), 'VALIDATION');
  assert.equal(await code(api.setup.saveStaff({ id: 'stf-principal', role: 'teacher' })), 'VALIDATION');
  assert.equal(await code(api.setup.setStaffActive({ staffId: 'stf-driver-1', active: false })), 'VALIDATION');
  await api.setup.setStaffActive({ staffId: 'stf-teacher-float', active: false });
  const d = api.getDb();
  assert.equal(d.staff.find((s) => s.id === 'stf-teacher-float').active, false);
  assert.ok(!d.programs.some((p) => p.teacherIds.includes('stf-teacher-float')));
  assert.ok(!api.session.personas().some((p) => p.staffId === 'stf-teacher-float'));
  assert.equal(await code(api.setup.saveProgram({ id: 'prog-primary-a', teacherIds: ['stf-teacher-float'] })), 'VALIDATION');
  await api.setup.setStaffActive({ staffId: 'stf-teacher-float', active: true });
  assert.ok(api.session.personas().some((p) => p.staffId === 'stf-teacher-float'));
  // a second principal: made from a teacher (classes cleared), and can be taken off the staff while another remains
  const p2 = await api.setup.saveStaff({ firstName: 'Second', lastName: 'Exampleton', role: 'teacher', email: 'second@example.com', programIds: ['prog-primary-a'] });
  await api.setup.saveStaff({ id: p2.id, role: 'admin' });
  assert.deepEqual(api.getDb().staff.find((s) => s.id === p2.id).programIds, []);
  await api.setup.setStaffActive({ staffId: p2.id, active: false });
});

// ---------------------------------------------------------------- #71 routes, stops, drivers
const DRIVER1 = 'persona-stf-driver-1', DRIVER2 = 'persona-stf-driver-2';

test('#71 a new route with a driver, then stops: added at the end or at a position, renumbered 1..n; the driver gets the route', async () => {
  const api = as(await mkApi(), ADMIN);
  const d0 = await api.setup.saveStaff({ firstName: 'New', lastName: 'Trialsen', role: 'driver', email: 'driver3@example.com' });
  const r = await api.setup.saveRoute({ name: 'Route 3 - Demo Loop', busNo: 'KA-00-DEMO-03', driverId: d0.id, attendantId: null, transportFeePaise: 400000 });
  assert.deepEqual(r.stops, []);
  assert.equal(await code(api.setup.saveRoute({ name: 'Route 3 - demo loop', busNo: 'X', driverId: d0.id, transportFeePaise: 0 })), 'VALIDATION');
  assert.equal(await code(api.setup.saveRoute({ name: 'R', busNo: 'X', driverId: 'stf-teacher-pa', transportFeePaise: 0 })), 'VALIDATION', 'a driver must be a driver');
  assert.equal(await code(api.setup.saveRoute({ name: 'R', busNo: 'X', driverId: d0.id, transportFeePaise: 12.5 })), 'VALIDATION', 'integer paise');
  const a = await api.setup.saveStop({ routeId: r.id, name: 'First Gate', lat: 12.9, lng: 77.6, scheduledPickup: '07:30', scheduledDrop: '15:30' });
  const b = await api.setup.saveStop({ routeId: r.id, name: 'Second Gate', lat: 12.91, lng: 77.61, scheduledPickup: '07:40', scheduledDrop: '15:20' });
  const c = await api.setup.saveStop({ routeId: r.id, name: 'Middle Gate', lat: 12.905, lng: 77.605, scheduledPickup: '07:35', scheduledDrop: '15:25', seq: 2 });
  const order = () => api.getDb().routes.find((x) => x.id === r.id).stops.map((s) => [s.id, s.seq]);
  assert.deepEqual(order(), [[a.id, 1], [c.id, 2], [b.id, 3]]);
  await api.setup.saveStop({ routeId: r.id, id: b.id, seq: 1 });
  assert.deepEqual(order(), [[b.id, 1], [a.id, 2], [c.id, 3]]);
  assert.equal(await code(api.setup.saveStop({ routeId: r.id, name: 'Bad', lat: 12.9, lng: 77.6, scheduledPickup: '7.30', scheduledDrop: '15:30' })), 'VALIDATION');
  assert.equal(await code(api.setup.saveStop({ routeId: r.id, name: 'first gate', lat: 1, lng: 1, scheduledPickup: '07:30', scheduledDrop: '15:30' })), 'VALIDATION');
  assert.ok(api.session.personas().find((p) => p.staffId === d0.id).routeIds.includes(r.id));
  // a child can now be put on the new route's stop
  await api.people.updateStudent({ studentId: 'stu-01', routeId: r.id, stopId: a.id });
  assert.equal(await code(api.setup.removeStop({ routeId: r.id, stopId: a.id })), 'VALIDATION', 'a child uses it');
  await api.setup.removeStop({ routeId: r.id, stopId: c.id });
  assert.deepEqual(order(), [[b.id, 1], [a.id, 2]]);
  assert.equal(await code(api.setup.setRouteActive({ routeId: r.id, active: false })), 'VALIDATION', 'a child rides it');
});

test('#71 nothing changes under a running bus; a stop in the trip history cannot be removed; a closed route leaves the driver', async () => {
  const api = as(await mkApi(), ADMIN);
  const r1 = api.getDb().routes.find((x) => x.id === 'route-1');
  assert.equal(await code(api.setup.removeStop({ routeId: 'route-1', stopId: r1.stops[0].id })), 'VALIDATION');
  await api.transport.startTrip({ routeId: 'route-2', direction: 'pickup', simulated: true });
  const r2 = api.getDb().routes.find((x) => x.id === 'route-2');
  assert.equal(await code(api.setup.saveStop({ routeId: 'route-2', id: r2.stops[0].id, name: 'Renamed' })), 'VALIDATION');
  assert.equal(await code(api.setup.saveRoute({ id: 'route-2', driverId: 'stf-driver-1' })), 'VALIDATION');
  await api.setup.saveRoute({ id: 'route-2', busNo: 'KA-00-DEMO-22' }); // the bus number can change
  const trip = await api.transport.activeTrip('route-2');
  await api.transport.endTrip(trip.id);
  await api.setup.saveRoute({ id: 'route-2', attendantId: 'stf-driver-1' });
  assert.ok(api.session.personas().find((p) => p.id === DRIVER1).routeIds.includes('route-2'), 'the attendant gets the route');
  // close route-2: move its children off first
  for (const s of api.getDb().students.filter((x) => x.routeId === 'route-2' && x.status === 'active')) await api.people.updateStudent({ studentId: s.id, routeId: null, stopId: null });
  await api.setup.setRouteActive({ routeId: 'route-2', active: false });
  assert.ok(!api.session.personas().find((p) => p.id === DRIVER2).routeIds.includes('route-2'));
  assert.equal(await code(api.people.updateStudent({ studentId: 'stu-01', routeId: 'route-2', stopId: r2.stops[0].id })), 'VALIDATION', 'a closed route takes no children');
  await api.setup.setStaffActive({ staffId: 'stf-driver-2', active: false }); // drives only a closed route now
});

test('#71 "Set this stop\'s position here": the route\'s driver, with a fix of 25 m or better; the audit row has no coordinates', async () => {
  const api = as(await mkApi(), DRIVER1);
  const st = api.getDb().routes.find((x) => x.id === 'route-1').stops[1];
  assert.equal(await code(api.setup.setStopPosition({ routeId: 'route-1', stopId: st.id, lat: 12.9, lng: 77.6, accuracy: 40 })), 'VALIDATION');
  const out = await api.setup.setStopPosition({ routeId: 'route-1', stopId: st.id, lat: 12.8976, lng: 77.5986, accuracy: 8 });
  assert.equal(out.lat, 12.8976);
  const r1 = api.getDb().routes.find((x) => x.id === 'route-1');
  assert.equal(r1.path, null, 'the drawn path is dropped once a stop moves');
  const row = api.getDb().auditLog.filter((x) => x.entity === 'route').at(-1);
  assert.equal(row.action, 'setStopPosition');
  assert.equal(row.actorId, 'stf-driver-1');
  assert.ok(!/12\.89|77\.59/.test(row.summary), 'no coordinates in the audit log');
  const other = api.getDb().routes.find((x) => x.id === 'route-2').stops[0];
  assert.equal(await code(api.setup.setStopPosition({ routeId: 'route-2', stopId: other.id, lat: 12.9, lng: 77.6, accuracy: 5 })), 'NOT_ALLOWED');
  assert.equal(await code(api.setup.saveStop({ routeId: 'route-1', id: st.id, name: 'Mine' })), 'NOT_ALLOWED', 'a driver only sets positions');
});

// ---------------------------------------------------------------- #77 one new admission, by the import's own rules
test('#77 add one child: new or existing parents (matched by phone and name), the import\'s checks and duplicate rule; a closed class is refused', async () => {
  const api = as(await mkApi(), ADMIN);
  const nG = api.getDb().guardians.length;
  const res = await api.people.addStudent({ admissionNo: 'ADM-W1-001', firstName: 'Tara', lastName: 'Notrealsen', dob: addDays(todayISO(), -3 * 365), program: 'prog-primary-a',
    guardian1Name: 'Meera Notrealsen', guardian1Relation: 'Mother', guardian1Phone: '9000000321', guardian1Email: 'meera@example.com' });
  assert.equal(res.guardiansCreated, 1);
  const d = api.getDb();
  const s = d.students.find((x) => x.id === res.student.id);
  assert.equal(s.status, 'active');
  assert.equal(s.source, 'app');
  assert.equal(d.guardians.length, nG + 1);
  const row = d.auditLog.at(-1);
  assert.equal(row.entity, 'student');
  assert.equal(row.action, 'admit');
  // a sibling: the same parent is linked, not added twice
  const sib = await api.people.addStudent({ admissionNo: 'ADM-W1-002', firstName: 'Ravi', lastName: 'Notrealsen', dob: addDays(todayISO(), -2 * 365), program: 'prog-toddler',
    guardian1Name: 'Meera Notrealsen', guardian1Phone: '+91 90000 00321' });
  assert.equal(sib.guardiansLinked, 1);
  assert.equal(api.getDb().guardians.length, nG + 1);
  assert.equal(await code(api.people.addStudent({ admissionNo: 'ADM-W1-001', firstName: 'Tara', lastName: 'Notrealsen', dob: s.dob, program: 'prog-primary-a', guardian1Name: 'Meera Notrealsen', guardian1Phone: '9000000321', guardian1Email: 'meera@example.com' })), 'VALIDATION');
  let err = null;
  try { await api.people.addStudent({ admissionNo: 'ADM-W1-003', firstName: 'Bad', dob: '2099-01-01', program: 'prog-primary-a', guardian1Name: 'X Y', guardian1Phone: '9000000322' }); } catch (e) { err = e; }
  assert.match(err.message, /date of birth is in the future/);
  for (const k of api.getDb().students.filter((x) => x.programId === 'prog-primary-b' && x.status === 'active')) await api.people.updateStudent({ studentId: k.id, programId: 'prog-primary-a' });
  await api.setup.setProgramActive({ programId: 'prog-primary-b', active: false });
  assert.equal(await code(api.people.addStudent({ admissionNo: 'ADM-W1-004', firstName: 'Late', dob: addDays(todayISO(), -1000), program: 'prog-primary-b', guardian1Name: 'X Y', guardian1Phone: '9000000323' })), 'VALIDATION');
  as(api, TEACHER);
  assert.equal(await code(api.people.addStudent({ admissionNo: 'ADM-W1-005' })), 'NOT_ALLOWED');
});

// ---------------------------------------------------------------- server shape: the set-up slice writes only its collections
test('#77 #71 on the server the set-up commands change only programs, staff and routes (the persist diff), and staff changes guard the ledger and account slices', async () => {
  const { COMMANDS, SLICES, execute, personaFor, ctxFor, guardSlices } = await import('../src/domain/commands.js');
  const { diffChanges } = await import('../supabase/functions/_shared/slices.js');
  const db = buildSeed(NOW);
  const p = personaFor(db, { role: 'admin', staffId: 'stf-principal' });
  const ctx = ctxFor(p, NOW.toISOString(), todayISO(NOW));
  for (const n of Object.keys(COMMANDS).filter((k) => k.startsWith('setup.'))) assert.equal(COMMANDS[n].slice, 'setup', n);
  const before = structuredClone(db);
  execute('setup.saveProgram', db, [{ name: 'Class Demo Three', teacherIds: ['stf-teacher-pa'] }], ctx, p);
  execute('setup.saveStaff', db, [{ firstName: 'Test', lastName: 'Dummyan', role: 'driver', email: 'd9@example.com' }], ctx, p);
  execute('setup.saveStop', db, [{ routeId: 'route-2', name: 'Extra Gate', lat: 12.9, lng: 77.6, scheduledPickup: '07:10', scheduledDrop: '16:00' }], ctx, p);
  const ch = diffChanges(before, db, SLICES.setup.writes);
  assert.deepEqual(Object.keys(ch.upserts).sort(), ['programs', 'routes', 'staff']);
  assert.deepEqual(guardSlices('setup', ['staff']), ['account', 'ledger']);
  assert.ok(guardSlices('ledger', ['staff']).includes('setup'), 'a role change elsewhere moves the set-up revision too');
  assert.equal(COMMANDS['setup.removeStop'].load([{}]).tripsAll, true);
  assert.equal(COMMANDS['setup.saveStop'].load([{ routeId: 'route-2' }]).routeId, 'route-2');
});
