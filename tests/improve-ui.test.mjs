// Usability fixes from the 11-Oct-2026 walkthrough: school-day awareness (home, diary, attendance), the teacher's
// phone tab bar, the principal's "Needs attention" list, and the parent's "due in N days" hint.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../src/api/index.js';
import { buildSeed } from '../src/seed/seed-data.js';
import { memoryBackend } from '../src/store/storage.js';
import { todayISO, addDays } from '../src/domain/dates.js';
import { href } from '../src/ui/router.js';

const NOW = new Date(Date.UTC(2026, 10, 2, 5, 0, 0));
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
function makeCtx(api, query = {}) {
  const ctx = {
    api, persona: api.session.current(), query, params: {}, el: fake(),
    get db() { return api.getDb(); },
    go() {}, setQuery() {}, href, toast() {}, onChange() {}, cleanup() {}, rerender() {},
  };
  return ctx;
}
async function draw(api, who, mod, query = {}) { api.session.set(who); const ctx = makeCtx(api, query); await mod.render(ctx); return ctx.el.innerHTML; }

// Screens read the real date (todayISO), so a whole-school holiday is put on today to make it a non-working day.
async function holidayToday(api) {
  api.session.set(ADMIN);
  const ayId = api.getDb().school.currentAcademicYearId;
  await api.calendar.create({ academicYearId: ayId, type: 'holiday', title: 'Test closure', startDate: todayISO(), endDate: todayISO() });
}

const Home = await import('../src/ui/screens/home.js');
const Diary = await import('../src/ui/screens/diary.js');
const Attendance = await import('../src/ui/screens/attendance.js');
const Shell = await import('../src/ui/shell.js');
const { dueHint } = await import('../src/ui/components.js');

test('parent home on a holiday says there is no school today instead of "Not marked yet"', async () => {
  const api = await mkApi();
  await holidayToday(api);
  const html = await draw(api, PARENT, Home);
  assert.match(html, /No school today/);
  assert.doesNotMatch(html, /Not marked yet/);
});

test('parent diary on a holiday explains why it is empty and offers the previous school day', async () => {
  const api = await mkApi();
  await holidayToday(api);
  const html = await draw(api, PARENT, Diary);
  assert.match(html, /Holiday: Test closure/);
  assert.match(html, /id="d-lastwork"/);
});

test('staff diary on a holiday shows the same notice; on a school day it does not', async () => {
  const api = await mkApi();
  await holidayToday(api);
  assert.match(await draw(api, TEACHER, Diary), /Holiday: Test closure[\s\S]*id="d-lastwork"/);
  const api2 = await mkApi();
  api2.session.set(TEACHER);
  const pid = api2.session.current().programIds[0];
  let d = todayISO();
  while (!(await api2.calendar.isWorkingDay(d, pid))) d = addDays(d, -1);
  assert.doesNotMatch(await draw(api2, TEACHER, Diary, { date: d }), /id="d-lastwork"/);
});

test('attendance on a non-working day disables the register and its buttons', async () => {
  const api = await mkApi();
  await holidayToday(api);
  const html = await draw(api, TEACHER, Attendance);
  assert.match(html, /<fieldset[^>]*disabled/);
});

test('teachers get the bottom tab bar on phones (Register for attendance); the principal keeps the strip', () => {
  const root = fake();
  Shell.renderShell(root, { school: { name: 'S' }, personas: { featured: [], others: [] }, current: { id: 'x', role: 'teacher' } });
  assert.match(root.innerHTML, /class="shell staff tabbed"/);
  assert.match(root.innerHTML, /<nav class="tabbar[^"]*"/);
  assert.match(root.innerHTML, /<span>Register<\/span>/);
  const r2 = fake();
  Shell.renderShell(r2, { school: { name: 'S' }, personas: { featured: [], others: [] }, current: { id: 'y', role: 'admin' } });
  assert.doesNotMatch(r2.innerHTML, /tabbar/);
});

test('principal home lists what needs attention: unread messages, unacknowledged notices, overdue fees, open data requests', async () => {
  const api = await mkApi();
  api.session.set(PARENT);
  await api.rights.file({ kind: 'export', details: 'Please send me our data.' });
  const html = await draw(api, ADMIN, Home);
  assert.match(html, /Needs attention/);
  assert.match(html, /parent messages? not yet read by staff/);
  assert.match(html, /awaiting acknowledgement/);
  assert.match(html, /child(ren)? with overdue fees/);
  assert.match(html, /1 open data request/);
  assert.match(html, /href="#\/admin\?tab=requests"/);
});

test('dueHint: future, today and past due dates', () => {
  assert.equal(dueHint('2026-10-15', '2026-10-11'), 'in 4 days');
  assert.equal(dueHint('2026-10-12', '2026-10-11'), 'tomorrow');
  assert.equal(dueHint('2026-10-11', '2026-10-11'), 'today');
  assert.equal(dueHint('2026-12-31', '2026-10-11'), '', 'more than two weeks away: no hint');
  assert.equal(dueHint('2026-10-01', '2026-10-11'), '', 'past due: the Overdue badge already says it');
});
