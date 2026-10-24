// Wave 1, teacher experience: the register, the diary, going home, observations, progress and reports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../src/api/index.js';
import { buildSeed } from '../src/seed/seed-data.js';
import { memoryBackend } from '../src/store/storage.js';
import { todayISO, addDays } from '../src/domain/dates.js';
import { href } from '../src/ui/router.js';

const NOW = new Date(); // the screens read the real date (todayISO); the seed is built around it
const TEACHER = 'persona-stf-teacher-pa', PARENT = 'persona-grd-01';

function fake() {
  const children = new Map();
  let html = '';
  const el = {
    value: '', checked: false, disabled: false, hidden: false, textContent: '', className: '', files: [], dataset: {}, handlers: {}, children, isConnected: true,
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
globalThis.CSS ??= { escape: (s) => String(s) };

/** The demo api on the sample data; `change(db)` edits the seed first (rows the api cannot create, e.g. a past absence). */
async function mkApi(change = null) {
  const api = createApi({ backend: memoryBackend(), sessionBackend: memoryBackend(), seedFn: () => { const db = buildSeed(NOW); if (change) change(db); return db; }, clock: () => NOW });
  await api.ready();
  return api;
}
function mkCtx(api, who, query = {}) {
  api.session.set(who);
  return { api, persona: api.session.current(), query, params: {}, el: fake(), get db() { return api.getDb(); },
    go() {}, setQuery() {}, href, toast() {}, onChange() {}, cleanup() {}, rerender() {} };
}
async function draw(api, who, mod, query = {}) {
  const ctx = mkCtx(api, who, query);
  await mod.render(ctx);
  return ctx.el.innerHTML;
}
const lastSchoolDay = async (api, pid) => { let d = todayISO(); while (!(await api.calendar.isWorkingDay(d, pid))) d = addDays(d, -1); return d; };

/** Radio buttons of the register as state: st[studentId] = the checked value (or undefined). */
function radios(ctx, st) {
  const orig = ctx.el.querySelector.bind(ctx.el);
  ctx.el.querySelector = (sel) => {
    let m = sel.match(/^input\[name="st-([^"]+)"\]:checked$/);
    if (m) return st[m[1]] ? { value: st[m[1]] } : null;
    m = sel.match(/^input\[name="st-([^"]+)"\]\[value="([^"]+)"\]$/);
    if (m) { const [, id, v] = m; return { get checked() { return st[id] === v; }, set checked(on) { if (on) st[id] = v; } }; }
    return orig(sel);
  };
}

const Attendance = await import('../src/ui/screens/attendance.js');

// ---------------------------------------------------------------- #20 register: "Mark the rest present"
test('#20 register: "Mark the rest present" ticks only rows with nothing ticked; absent, late and leave marks stay', async () => {
  const api = await mkApi();
  const ctx = mkCtx(api, TEACHER);
  const pid = ctx.persona.programIds[0];
  ctx.query = { program: pid, date: await lastSchoolDay(api, pid) };
  await Attendance.render(ctx);
  const ids = (await api.attendance.forDate(ctx.query.date, pid)).map((r) => r.studentId);
  const st = { [ids[0]]: 'absent', [ids[2]]: 'late', [ids[3]]: 'leave' };
  radios(ctx, st);
  ctx.el.querySelector('#a-allp').handlers.click[0]();
  assert.equal(st[ids[0]], 'absent', 'an absence already tapped is kept');
  assert.equal(st[ids[2]], 'late');
  assert.equal(st[ids[3]], 'leave');
  assert.equal(st[ids[1]], 'present', 'an unmarked child becomes present');
  for (const id of ids.slice(4)) assert.equal(st[id], 'present');
  assert.match(ctx.el.innerHTML, /Mark the rest present/);
});

/** A Map-backed localStorage for the drafts (node's own needs a file); returns the store and a restore function. */
function memoryLocalStorage() {
  const m = new Map();
  const prev = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const ls = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
  Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true, writable: true });
  return { m, restore: () => { if (prev) Object.defineProperty(globalThis, 'localStorage', prev); else delete globalThis.localStorage; } };
}
const submitEvent = (ctx) => ({ preventDefault() {}, target: { querySelector: (sel) => ctx.el.querySelector(sel) } });

// ---------------------------------------------------------------- #26 register draft
test('#26 register: marks tapped but not saved are kept on this device and restored; saving clears them; ids and codes only', async () => {
  const store = memoryLocalStorage();
  try {
    const api = await mkApi();
    const ctx = mkCtx(api, TEACHER);
    const pid = ctx.persona.programIds[0];
    const date = await lastSchoolDay(api, pid);
    // an unmarked register: clear that day's seed records
    api.getDb().attendance = api.getDb().attendance.filter((a) => a.date !== date);
    ctx.query = { program: pid, date };
    await Attendance.render(ctx);
    const ids = (await api.attendance.forDate(date, pid)).map((r) => r.studentId);
    radios(ctx, { [ids[0]]: 'absent' });
    ctx.el.querySelector('#a-form').handlers.change[0]();
    const saved = [...store.m.values()].join('');
    assert.match(saved, new RegExp(`"${ids[0]}":"absent"`));
    assert.doesNotMatch(saved, /Notrealsen|Demoson|Exampleton/, 'no names in the draft');
    assert.equal(ctx.el.querySelector('#a-unsaved').textContent, '1 unsaved mark');
    // the screen is left and opened again: the mark is back
    const again = mkCtx(api, TEACHER, { program: pid, date });
    await Attendance.render(again);
    assert.match(again.el.innerHTML, new RegExp(`name="st-${ids[0]}" value="absent" checked`));
    assert.match(again.el.innerHTML, /1 unsaved mark/);
    // saved: the draft is gone
    radios(again, { [ids[0]]: 'absent' });
    await again.el.querySelector('#a-form').handlers.submit[0](submitEvent(again));
    assert.equal((await api.attendance.forDate(date, pid)).find((r) => r.studentId === ids[0]).status, 'absent');
    assert.doesNotMatch([...store.m.values()].join(''), new RegExp(ids[0]));
  } finally { store.restore(); }
});

// ---------------------------------------------------------------- #35 saving the register marks reported absences seen
test('#35 register: saving marks the parent-reported absences of the saved children as seen', async () => {
  const probe = await mkApi();
  probe.session.set(TEACHER);
  const day = await lastSchoolDay(probe, probe.getDb().students.find((s) => s.id === 'stu-01').programId);
  // a request reported for a past day cannot be made through the api (from today on): put one in the sample data
  const api = await mkApi((db) => db.leaveRequests.push({ id: 'lv-test-35', studentId: 'stu-01', guardianId: 'grd-01', fromDate: day, toDate: day, reason: 'Fever',
    status: 'active', createdAt: new Date().toISOString(), seenBy: null, seenAt: null, withdrawnAt: null }));
  const ctx = mkCtx(api, TEACHER);
  const pid = ctx.persona.programIds[0];
  ctx.query = { program: pid, date: day };
  await Attendance.render(ctx);
  radios(ctx, { 'stu-01': 'leave' });
  await ctx.el.querySelector('#a-form').handlers.submit[0](submitEvent(ctx));
  assert.ok((await api.care.leave({ studentId: 'stu-01' })).find((r) => r.id === 'lv-test-35').seenAt);
});

// ---------------------------------------------------------------- #37 / #31 register date limits
test('#37 register: no next day after today (arrow disabled, max on the date input); #31 the real app also sets the oldest loaded day', async () => {
  const api = await mkApi();
  const html = await draw(api, TEACHER, Attendance);
  assert.match(html, new RegExp(`id="a-date" value="${todayISO()}" max="${todayISO()}"`));
  assert.match(html, /id="a-next" aria-label="Next day" disabled/);
  assert.doesNotMatch(html, /id="a-date"[^>]*min="/, 'the demo has every day');
  const real = Object.assign(Object.create(api), { mode: 'supabase' });
  const r = await draw(real, TEACHER, Attendance, { date: addDays(todayISO(), -61) });
  assert.match(r, new RegExp(`min="${addDays(todayISO(), -60)}"`));
  assert.match(r, /Older days are not loaded in the app/);
  assert.match(r, /<fieldset disabled/, 'nothing can be saved over a day the app has not loaded');
});

// ---------------------------------------------------------------- #67 morning bus vs the register
test('#67 register: a child who boarded the morning bus shows "Came by bus" and is pre-ticked present; marked absent, it is flagged', async () => {
  const api = await mkApi();
  const db = api.getDb();
  api.session.set(TEACHER);
  const teacher = api.session.current();
  const kid = db.students.find((s) => teacher.studentIds.includes(s.id) && s.routeId && s.status === 'active');
  api.session.set('persona-stf-principal');
  let trip = await api.transport.activeTrip(kid.routeId);
  if (trip) await api.transport.endTrip(trip.id);
  trip = await api.transport.startTrip({ routeId: kid.routeId, direction: 'pickup', simulated: true });
  await api.transport.markChild(trip.id, { studentId: kid.id, type: 'boarded' });
  const today = todayISO();
  api.getDb().attendance = api.getDb().attendance.filter((a) => !(a.date === today && a.studentId === kid.id));
  const html = await draw(api, TEACHER, Attendance, { program: kid.programId, date: today });
  assert.match(html, /<strong>Came by bus<\/strong> \d\d:\d\d/);
  assert.match(html, new RegExp(`name="st-${kid.id}" value="present" checked`));
  api.getDb().attendance.push({ date: today, studentId: kid.id, status: 'absent', markedBy: 'stf-teacher-pa', markedAt: new Date().toISOString() });
  const flagged = await draw(api, TEACHER, Attendance, { program: kid.programId, date: today });
  assert.match(flagged, /but marked away: check where the child is/);
});
