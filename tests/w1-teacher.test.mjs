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

// ---------------------------------------------------------------- domain: the registry, as both modes run it
import { execute, personaFor, SLICES } from '../src/domain/commands.js';
import { diffChanges } from '../supabase/functions/_shared/slices.js';

const D_NOW = new Date(Date.UTC(2026, 9, 2, 5, 0, 0)); // Friday 02-Oct-2026
const D_TODAY = '2026-10-02';
const dSeed = () => Object.assign(buildSeed(D_NOW), { leaveRequests: [], pickupContacts: [], pickups: [] });
const dCtx = (p, now = `${D_TODAY}T05:00:00.000Z`) => ({ actor: { role: p.role, id: p.staffId || p.guardianId }, now, today: now.slice(0, 10) });
const dRun = (db, link, name, args, now) => { const p = personaFor(db, link); return execute(name, db, args, dCtx(p, now), p); };
const T_PA = { role: 'teacher', staffId: 'stf-teacher-pa' };
const T_PB = { role: 'teacher', staffId: 'stf-teacher-pb' };
const PRINCIPAL = { role: 'admin', staffId: 'stf-principal' };
const kidsOf = (db, pid) => db.students.filter((s) => s.programId === pid && s.status === 'active').map((s) => s.id);
const primaryA = (db) => db.programs.find((p) => p.name === 'Primary A').id;

test('#21 diary.correct: the author within 24 hours (history kept, audited); not another teacher, not after 24 hours; the principal always', () => {
  const db = dSeed();
  const kid = kidsOf(db, primaryA(db))[0];
  const e = dRun(db, T_PA, 'diary.add', [{ studentId: kid, date: D_TODAY, type: 'meal', data: { meal: 'lunch', ate: 'none' } }]);
  const fixed = dRun(db, T_PA, 'diary.correct', [e.id, { data: { meal: 'lunch', ate: 'all', note: '' } }]);
  assert.equal(fixed.data.ate, 'all');
  assert.equal(fixed.history.length, 1);
  assert.equal(fixed.history[0].data.ate, 'none', 'what the family saw before is kept');
  assert.ok(db.auditLog.some((a) => a.entity === 'diaryEntry' && a.entityId === e.id && a.action === 'correct'));
  assert.throws(() => dRun(db, T_PA, 'diary.correct', [e.id, { data: { meal: 'lunch', ate: 'maybe' } }]), { code: 'VALIDATION' });
  assert.throws(() => dRun(db, T_PB, 'diary.correct', [e.id, { data: { meal: 'lunch', ate: 'some' } }]), { code: 'NOT_ALLOWED' }, 'another programme');
  const later = '2026-10-03T06:00:00.000Z';
  assert.throws(() => dRun(db, T_PA, 'diary.correct', [e.id, { data: { meal: 'lunch', ate: 'some' } }], later), { code: 'NOT_ALLOWED' }, 'after 24 hours');
  assert.equal(dRun(db, PRINCIPAL, 'diary.correct', [e.id, { data: { meal: 'lunch', ate: 'some' } }], later).data.ate, 'some');
  const byPrincipal = dRun(db, PRINCIPAL, 'diary.add', [{ studentId: kid, date: D_TODAY, type: 'activity', data: { text: 'Garden walk' } }]);
  assert.throws(() => dRun(db, T_PA, 'diary.correct', [byPrincipal.id, { data: { text: 'x' } }]), { code: 'NOT_ALLOWED' }, 'only the author or the principal');
  assert.throws(() => dRun(db, T_PA, 'diary.correct', ['dia-none', { data: {} }]), { code: 'NOT_FOUND' });
});

test('#21 diary.remove: the entry leaves the diary (the server deletes the row), audited; a parent cannot remove', () => {
  const db = dSeed();
  const kid = kidsOf(db, primaryA(db))[0];
  const e = dRun(db, T_PA, 'diary.add', [{ studentId: kid, date: D_TODAY, type: 'activity', data: { text: 'Wrong child' } }]);
  const parentLink = { role: 'parent', guardianId: db.students.find((s) => s.id === kid).guardianIds[0] };
  assert.throws(() => dRun(db, parentLink, 'diary.remove', [e.id]), { code: 'NOT_ALLOWED' });
  const before = structuredClone(db);
  assert.deepEqual(dRun(db, T_PA, 'diary.remove', [e.id]), { removed: e.id });
  assert.ok(!db.diaryEntries.some((x) => x.id === e.id));
  assert.ok(db.auditLog.some((a) => a.entity === 'diaryEntry' && a.entityId === e.id && a.action === 'remove' && !/Wrong child/.test(a.summary)));
  const ch = diffChanges(before, db, SLICES.classroom.writes);
  assert.deepEqual(ch.deletes.diaryEntries, [e.id], 'persist deletes the row (diaryEntries is on its delete list)');
});

test('#24 diary.addMany: a ticked child who ate a different amount gets their own amount in the same write; overrides are checked', () => {
  const db = dSeed();
  const pid = primaryA(db);
  const ids = kidsOf(db, pid);
  const r = dRun(db, T_PA, 'diary.addMany', [{ programId: pid, date: D_TODAY, studentIds: ids, type: 'meal', data: { meal: 'lunch', ate: 'all' }, overrides: { [ids[1]]: { ate: 'some' } } }]);
  assert.equal(r.added, ids.length);
  assert.equal(r.entries.find((e) => e.studentId === ids[1]).data.ate, 'some');
  assert.ok(r.entries.filter((e) => e.studentId !== ids[1]).every((e) => e.data.ate === 'all'));
  const n = db.diaryEntries.length;
  const bad = (over, type = 'meal', data = { meal: 'lunch', ate: 'all' }) => assert.throws(() => dRun(db, T_PA, 'diary.addMany', [{ programId: pid, date: D_TODAY, studentIds: ids.slice(0, 2), type, data, overrides: over }]), { code: 'VALIDATION' });
  bad({ [ids[1]]: { ate: 'lots' } });
  bad({ [ids[3]]: { ate: 'some' } }); // not ticked
  bad({ [ids[1]]: { ate: 'some', meal: 'snack' } });
  bad({ [ids[1]]: { ate: 'some' } }, 'activity', { text: 'Songs' });
  assert.equal(db.diaryEntries.length, n, 'all or none');
});

// ---------------------------------------------------------------- diary screen
const Diary = await import('../src/ui/screens/diary.js');

/** Open a modal from a click handler and return the fake dialog it built. */
async function modalFrom(fn) {
  const made = [];
  const orig = document.createElement;
  document.createElement = () => { const d = fake(); d.showModal = () => {}; d.close = () => {}; made.push(d); return d; };
  try {
    fn();
    for (let i = 0; i < 40 && !made.length; i++) await new Promise((r) => setTimeout(r, 5));
  } finally { document.createElement = orig; }
  return made[0];
}

test('#25 diary: "Lunch 1/N" counts the children in class with that entry; tapping it lists the ones still without', async () => {
  const api = await mkApi();
  const ctx = mkCtx(api, TEACHER);
  const pid = ctx.persona.programIds[0];
  const day = await lastSchoolDay(api, pid);
  const here = (await api.attendance.forDate(day, pid)).filter((r) => r.status === 'present' || r.status === 'late').map((r) => r.studentId);
  assert.ok(here.length > 2, 'the sample register has children in class');
  await api.diary.add({ studentId: here[0], date: day, type: 'meal', data: { meal: 'lunch', ate: 'all', note: '' } });
  const html = await draw(api, TEACHER, Diary, { program: pid, date: day });
  const lunches = new Set((await api.diary.forProgramDate(pid, day)).filter((e) => e.type === 'meal' && e.data.meal === 'lunch' && here.includes(e.studentId)).map((e) => e.studentId));
  assert.match(html, new RegExp(`data-missing="lunch"[^>]*>Lunch ${lunches.size}/${here.length}<`));
  const only = await draw(api, TEACHER, Diary, { program: pid, date: day, missing: 'lunch' });
  assert.ok(!only.includes(`data-add="${here[0]}"`), 'a child with lunch is not listed');
  assert.equal((only.match(/data-add=/g) || []).length, here.length - lunches.size);
  assert.match(only, /Show everyone/);
});

test('#21 diary screen: Correct and Remove on the entries this teacher wrote today, not on others\'; #37 no next day after today', async () => {
  const api = await mkApi();
  const ctx = mkCtx(api, TEACHER);
  const pid = ctx.persona.programIds[0];
  const kid = (await api.people.students({ programId: pid }))[0];
  const today = todayISO();
  const mine = await api.diary.add({ studentId: kid.id, date: today, type: 'activity', data: { text: 'Painting' } });
  api.session.set('persona-stf-principal');
  const theirs = await api.diary.add({ studentId: kid.id, date: today, type: 'activity', data: { text: 'Garden' } });
  const html = await draw(api, TEACHER, Diary, { program: pid, date: today });
  assert.match(html, new RegExp(`data-fix="${mine.id}"`));
  assert.match(html, new RegExp(`data-rm="${mine.id}"`));
  assert.ok(!html.includes(`data-fix="${theirs.id}"`), "not another person's entry");
  assert.match(html, new RegExp(`id="d-date" value="${today}" max="${today}"`));
  assert.match(html, /id="d-next" aria-label="Next day" disabled/);
  await api.diary.correct(mine.id, { data: { text: 'Painting with sponges' } });
  const fixed = await draw(api, TEACHER, Diary, { program: pid, date: today });
  assert.match(fixed, /Painting with sponges/);
  assert.match(fixed, /&middot; corrected/);
  await api.diary.remove(mine.id);
  assert.ok(!(await draw(api, TEACHER, Diary, { program: pid, date: today })).includes('Painting'));
  // #31 the real app loads 30 days of diary: the oldest is the date input's min, and an older day says so
  const real = Object.assign(Object.create(api), { mode: 'supabase' });
  const old = await draw(real, TEACHER, Diary, { program: pid, date: addDays(today, -40) });
  assert.match(old, new RegExp(`min="${addDays(today, -30)}"`));
  assert.match(old, /Older days are not loaded in the app/);
});

test('#24 whole-class diary: a meal has a per-child amount ("As above"); a nap starts from the last whole-class nap times', async () => {
  const api = await mkApi();
  const ctx = mkCtx(api, TEACHER);
  const pid = ctx.persona.programIds[0];
  const day = await lastSchoolDay(api, pid);
  const ids = (await api.people.students({ programId: pid })).filter((s) => s.status === 'active').map((s) => s.id);
  await api.diary.addMany({ programId: pid, date: addDays(day, -1), studentIds: ids, type: 'sleep', data: { from: '13:05', to: '14:20' } });
  ctx.query = { program: pid, date: day };
  await Diary.render(ctx);
  const d = await modalFrom(() => ctx.el.querySelector('#d-class').handlers.click[0]());
  assert.match(d.innerHTML, new RegExp(`name="ate-${ids[0]}"`));
  assert.match(d.innerHTML, /<option value="">As above<\/option>/);
  const sel = d.querySelector('#d-type');
  sel.value = 'sleep';
  sel.handlers.change[0]();
  assert.match(d.querySelector('#d-fields').innerHTML, /name="from" value="13:05"/);
  assert.match(d.querySelector('#d-fields').innerHTML, /name="to" value="14:20"/);
});

// ---------------------------------------------------------------- going home
const Pickup = await import('../src/ui/screens/pickup.js');

test('#22 pickup.record: "went home on the school bus" for a child with a route, with no note and no not-on-the-list audit; refused without a route', () => {
  const db = dSeed();
  const bus = db.students.find((s) => s.programId === primaryA(db) && s.status === 'active' && s.routeId);
  const walk = db.students.find((s) => s.programId === primaryA(db) && s.status === 'active' && !s.routeId);
  const p = dRun(db, T_PA, 'pickup.record', [{ studentId: bus.id, date: D_TODAY, collectedBy: { kind: 'bus' }, time: '15:10' }]);
  assert.equal(p.kind, 'bus');
  assert.equal(p.personId, null);
  assert.ok(!db.auditLog.some((a) => a.entityId === p.id && a.action === 'otherPerson'));
  assert.throws(() => dRun(db, T_PA, 'pickup.record', [{ studentId: walk.id, date: D_TODAY, collectedBy: { kind: 'bus' }, time: '15:10' }]), { code: 'VALIDATION' });
});

test('#23 Going home: one tap per child today (the bus first for a bus child, then the last collector first); #22 the bus is an option; #34 guardians as tap-to-call links', async () => {
  const api = await mkApi();
  const ctx = mkCtx(api, TEACHER);
  const pid = ctx.persona.programIds[0];
  const db = api.getDb();
  const bus = db.students.find((s) => s.programId === pid && s.status === 'active' && s.routeId);
  const today = todayISO();
  // the sample data may already record today's pick-ups: start this child from none
  const who = await api.care.whoMayCollect(bus.id);
  ctx.query = { program: pid };
  await Pickup.render(ctx);
  const html = ctx.el.innerHTML;
  if (!(await api.care.pickups({ studentId: bus.id, date: today })).length) {
    assert.match(html, new RegExp(`data-quick="${bus.id}" data-by="bus:">On the bus \\(`));
    assert.match(html, new RegExp(`data-quick="${bus.id}" data-by="guardian:${who.guardians[0].id}"`));
    assert.match(html, /Someone else/);
  }
  // one tap records it
  const q = fake();
  q.dataset = { quick: bus.id, by: 'bus:' };
  const click = ctx.el.handlers.click.at(-1);
  await click({ target: { closest: (sel) => (sel === '[data-quick]' ? q : null) } });
  const rec = (await api.care.pickups({ studentId: bus.id, date: today }))[0];
  assert.equal(rec.kind, 'bus');
  assert.match(rec.time, /^\d\d:\d\d$/);
  assert.match(await draw(api, TEACHER, Pickup, { program: pid }), /Collected by <strong>the school bus<\/strong>/);
  // the modal: the bus option and a call link for each guardian with a phone
  const d = await modalFrom(() => click({ target: { closest: (sel) => (sel === '[data-rec]' ? { dataset: { rec: bus.id } } : null) } }));
  assert.match(d.innerHTML, /value="bus:"/);
  assert.match(d.innerHTML, /href="tel:\+91\d+">Call /);
});

// ---------------------------------------------------------------- #27 forms ask before discarding what was typed
test('#27 formModal: Cancel/back with nothing typed closes at once; with something typed it asks "Discard what you typed?" first', async () => {
  const { formModal } = await import('../src/ui/components.js');
  const vals = { text: '' };
  const PrevFD = globalThis.FormData;
  globalThis.FormData = class { constructor() { this.e = Object.entries(vals); } entries() { return this.e[Symbol.iterator](); } [Symbol.iterator]() { return this.e[Symbol.iterator](); } };
  const made = [];
  const orig = document.createElement;
  document.createElement = () => { const d = fake(); d.showModal = () => {}; d.close = () => {}; made.push(d); return d; };
  const tick = () => new Promise((r) => setTimeout(r, 5));
  const button = (act) => ({ target: { closest: () => ({ hasAttribute: () => false, dataset: { act } }) } });
  try {
    // nothing typed: closes at once
    let p = formModal({ title: 'T', fieldsHtml: '', onSubmit: async () => {} });
    made[0].handlers.cancel[0]({ preventDefault() {} });
    assert.equal(await p, false);
    assert.equal(made.length, 1, 'no question asked');
    // typed: asks; "Cancel" keeps the form open, "Discard" closes it
    made.length = 0;
    let settled = false;
    p = formModal({ title: 'T', fieldsHtml: '', onSubmit: async () => {} }).then((v) => { settled = true; return v; });
    vals.text = 'A long observation';
    made[0].handlers.cancel[0]({ preventDefault() {} });
    await tick();
    assert.equal(made.length, 2, 'a confirmation opened');
    assert.match(made[1].innerHTML, /Discard what you typed\?/);
    made[1].handlers.click[0](button('0')); // Cancel: keep typing
    await tick();
    assert.equal(settled, false, 'the form is still open');
    made[0].handlers.click[0]({ target: { closest: (sel) => (sel === '[data-close]' ? {} : null) } }); // the close button
    await tick();
    assert.equal(made.length, 3);
    made[2].handlers.click[0](button('1')); // Discard
    assert.equal(await p, false);
  } finally { document.createElement = orig; globalThis.FormData = PrevFD; }
});

// ---------------------------------------------------------------- #28 observations: the right child
test('#28 observations: an unshared one can move to the right child or be removed (audited); not with a photo on it, not once shared', () => {
  const db = dSeed();
  const [a, b] = kidsOf(db, primaryA(db));
  const o = dRun(db, T_PA, 'observations.add', [{ studentId: a, date: D_TODAY, area: 'math', text: 'Counted to twenty' }]);
  const moved = dRun(db, T_PA, 'observations.edit', [o.id, { studentId: b }]);
  assert.equal(moved.studentId, b);
  assert.ok(db.auditLog.some((x) => x.entityId === o.id && x.action === 'edit' && x.summary.includes(`from student ${a} to ${b}`)));
  const other = kidsOf(db, db.programs.find((p) => p.name === 'Primary B').id)[0];
  assert.throws(() => dRun(db, T_PA, 'observations.edit', [o.id, { studentId: other }]), { code: 'NOT_ALLOWED' }, "another teacher's child");
  db.photos.push({ id: 'pho-test-28', observationId: o.id, studentId: b, status: 'ready', createdAt: `${D_TODAY}T05:00:00.000Z` });
  assert.throws(() => dRun(db, T_PA, 'observations.edit', [o.id, { studentId: a }]), { code: 'VALIDATION' }, 'a photo stays with its child');
  assert.throws(() => dRun(db, T_PA, 'observations.remove', [o.id]), { code: 'VALIDATION' });
  db.photos.find((x) => x.id === 'pho-test-28').status = 'deleted';
  const before = structuredClone(db);
  assert.deepEqual(dRun(db, T_PA, 'observations.remove', [o.id]), { removed: o.id });
  assert.ok(db.auditLog.some((x) => x.entityId === o.id && x.action === 'remove'));
  assert.deepEqual(diffChanges(before, db, SLICES.learning.writes).deletes.observations, [o.id]);
  const s = dRun(db, T_PA, 'observations.add', [{ studentId: a, date: D_TODAY, area: 'math', text: 'Shared one' }]);
  dRun(db, T_PA, 'observations.share', [s.id]);
  assert.throws(() => dRun(db, T_PA, 'observations.remove', [s.id]), { code: 'VALIDATION' });
});

test('#28 Add observation starts with no child chosen ("Choose the child") unless the list is filtered to one child', async () => {
  const Learning = await import('../src/ui/screens/learning.js');
  const api = await mkApi();
  const ctx = mkCtx(api, TEACHER, { tab: 'observations' });
  await Learning.render(ctx);
  const host = ctx.el.querySelector('#l-body');
  const d = await modalFrom(() => host.querySelector('#l-add').handlers.click[0]());
  assert.match(d.innerHTML, /<option value="">Choose the child<\/option>/);
  assert.doesNotMatch(d.innerHTML, /<option value="stu-[^"]+" selected>/);
  const kid = (await api.people.students({ programId: ctx.persona.programIds[0] }))[0];
  const one = mkCtx(api, TEACHER, { tab: 'observations', student: kid.id });
  await Learning.render(one);
  const d1 = await modalFrom(() => one.el.querySelector('#l-body').querySelector('#l-add').handlers.click[0]());
  assert.match(d1.innerHTML, new RegExp(`<option value="${kid.id}" selected>`));
  assert.doesNotMatch(d1.innerHTML, /Choose the child/);
});

/** Submit a formModal built on a fake dialog with these [name, value] pairs (FormData is stubbed for the call). */
async function submitModal(d, pairs) {
  const PrevFD = globalThis.FormData;
  globalThis.FormData = class { constructor() { this.e = pairs; } entries() { return this.e[Symbol.iterator](); } [Symbol.iterator]() { return this.e[Symbol.iterator](); } };
  try {
    const form = d.querySelector('form');
    await form.handlers.submit[0]({ preventDefault() {} });
    return d.querySelector('[data-err]').textContent;
  } finally { globalThis.FormData = PrevFD; }
}

// ---------------------------------------------------------------- #29 / #30 learning for a group or a class
test('#29 progress: a group lesson records the next step for each ticked child; a child who mastered it is skipped', async () => {
  const Learning = await import('../src/ui/screens/learning.js');
  const api = await mkApi();
  const ctx = mkCtx(api, TEACHER, { tab: 'progress' });
  const pid = ctx.persona.programIds[0];
  const kids = (await api.people.students({ programId: pid })).filter((s) => s.status === 'active').slice(0, 3).map((s) => s.id);
  const pres = (await api.curriculum.list({ area: 'sensorial' })).find((p) => p.active);
  const today = todayISO();
  const before = new Map((await api.progress.state({ programId: pid })).filter((x) => x.presentationId === pres.id).map((x) => [x.studentId, x.status]));
  await Learning.render(ctx);
  const d = await modalFrom(() => ctx.el.querySelector('#l-body').querySelector('#pg-group').handlers.click[0]());
  await new Promise((r) => setTimeout(r, 20));
  const toasts = [];
  ctx.toast = (m) => toasts.push(m);
  const err = await submitModal(d, [['area', 'sensorial'], ['date', today], ['presentationId', pres.id], ['status', 'next'], ...kids.map((k) => ['studentIds', k])]);
  assert.equal(err, '');
  const after = new Map((await api.progress.state({ programId: pid })).filter((x) => x.presentationId === pres.id).map((x) => [x.studentId, x.status]));
  const NEXT = { undefined: 'introduced', introduced: 'practising', practising: 'mastered', mastered: 'mastered' };
  for (const k of kids) assert.equal(after.get(k), NEXT[before.get(k)], `${k} moved one step`);
});

test('#30 reports: "Start reports for this class" makes one draft per child for the term and skips children who already have one', async () => {
  const Learning = await import('../src/ui/screens/learning.js');
  const api = await mkApi();
  const ctx = mkCtx(api, TEACHER, { tab: 'reports' });
  const pid = ctx.persona.programIds[0];
  const db = api.getDb();
  const ay = db.academicYears.find((a) => a.id === db.school.currentAcademicYearId);
  const kids = (await api.people.students({ programId: pid })).filter((s) => s.status === 'active');
  const to = todayISO() > ay.endDate ? ay.endDate : todayISO();
  await api.reports.generate({ studentId: kids[0].id, academicYearId: ay.id, termName: 'Term 2', fromDate: ay.startDate, toDate: to });
  await Learning.render(ctx);
  const d = await modalFrom(() => ctx.el.querySelector('#l-body').querySelector('#rp-class').handlers.click[0]());
  const toasts = [];
  ctx.toast = (m) => toasts.push(m);
  assert.equal(await submitModal(d, [['termName', 'Term 2'], ['fromDate', ay.startDate], ['toDate', to]]), '');
  const term2 = (await api.reports.list({})).filter((r) => r.termName === 'Term 2' && r.academicYearId === ay.id && kids.some((k) => k.id === r.studentId));
  assert.equal(term2.length, kids.length, 'one report per child');
  await new Promise((r) => setTimeout(r, 5));
  assert.match(toasts.join(' '), new RegExp(`Created ${kids.length - 1} reports, 1 skipped`));
});

// ---------------------------------------------------------------- #36 notices, #38 teacher home
test("#36 a teacher's new notice has their one programme ticked already", async () => {
  const Notices = await import('../src/ui/screens/notices.js');
  const api = await mkApi();
  const ctx = mkCtx(api, TEACHER);
  await Notices.render(ctx);
  const d = await modalFrom(() => ctx.el.querySelector('#n-new').handlers.click[0]());
  assert.equal(ctx.persona.programIds.length, 1);
  assert.match(d.innerHTML, new RegExp(`name="programIds" value="${ctx.persona.programIds[0]}" checked`));
});

test('#38 teacher home: "to go home" and "no lunch entry" per programme, each linking to the screen that clears it', async () => {
  const Home = await import('../src/ui/screens/home.js');
  const api = await mkApi();
  api.session.set(TEACHER);
  const pid = api.session.current().programIds[0];
  const html = await draw(api, TEACHER, Home);
  assert.match(html, new RegExp(`href="#/pickup\\?program=${pid}"[^>]*><div class="v">[^<]+</div><div class="l">to go home</div>`));
  assert.match(html, new RegExp(`href="#/diary\\?program=${pid}&amp;missing=lunch"[^>]*><div class="v">[^<]+</div><div class="l">no lunch entry</div>`));
  if (!(await api.calendar.isWorkingDay(todayISO(), pid))) return; // a weekend run: both show a dash
  const list = await api.attendance.forDate(todayISO(), pid);
  const lunch = new Set((await api.diary.forProgramDate(pid, todayISO())).filter((e) => e.type === 'meal' && e.data.meal === 'lunch').map((e) => e.studentId));
  const n = list.filter((r) => (r.status === 'present' || r.status === 'late') && !lunch.has(r.studentId)).length;
  assert.match(html, new RegExp(`<div class="v">${n}</div><div class="l">no lunch entry`));
});
