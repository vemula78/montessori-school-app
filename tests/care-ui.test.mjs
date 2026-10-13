// Screens for absences and pick-up: the parent's page, the register pre-fill, the teacher's Going home page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../src/api/index.js';
import { buildSeed } from '../src/seed/seed-data.js';
import { memoryBackend } from '../src/store/storage.js';
import { todayISO, addDays } from '../src/domain/dates.js';
import { href } from '../src/ui/router.js';

const NOW = new Date(); // the screens read the real date (todayISO); the seed is built around it
const EVIL = '"><img src=x onerror=alert(1)><script>alert(2)</script>';
const TEACHER = 'persona-stf-teacher-pa', PARENT = 'persona-grd-01', OTHER_PARENT = 'persona-grd-02';

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
async function draw(api, who, mod, query = {}) {
  api.session.set(who);
  const ctx = { api, persona: api.session.current(), query, params: {}, el: fake(), get db() { return api.getDb(); },
    go() {}, setQuery() {}, href, toast() {}, onChange() {}, cleanup() {}, rerender() {} };
  await mod.render(ctx);
  return ctx.el.innerHTML;
}
const nextSchoolDay = async (api, pid) => { let d = addDays(todayISO(), 1); while (!(await api.calendar.isWorkingDay(d, pid))) d = addDays(d, 1); return d; };
const noRaw = (html) => { assert.ok(!html.includes('<img src=x') && !html.includes('<script>alert'), 'escaped'); };

const Care = await import('../src/ui/screens/care.js');
const Attendance = await import('../src/ui/screens/attendance.js');
const Pickup = await import('../src/ui/screens/pickup.js');
const Shell = await import('../src/ui/shell.js');
const Diary = await import('../src/ui/screens/diary.js');

test("parent page: own child's absences, guardians and pick-up people; what parents type is escaped; another family sees none of it", async () => {
  const api = await mkApi();
  api.session.set(PARENT);
  const d = addDays(todayISO(), 20);
  await api.care.requestLeave({ studentId: 'stu-01', fromDate: d, toDate: d, reason: EVIL.slice(0, 60) });
  await api.care.addContact({ studentId: 'stu-01', name: `X${EVIL}`.slice(0, 80), relation: 'Uncle', phone: '9000000377' });
  const html = await draw(api, PARENT, Care, { student: 'stu-01' });
  assert.match(html, /Absences/);
  assert.match(html, /Who may collect Neel/);
  assert.match(html, /\+91-90000-00377/);
  assert.match(html, /data-withdraw=/);
  noRaw(html);
  const other = await draw(api, OTHER_PARENT, Care);
  assert.ok(!other.includes('90000-00377') && !other.includes('Neel'), "another family's page shows nothing of Neel");
});

test('register: a child with a reported absence is pre-ticked "On leave" with the reason; the panel offers Mark seen', async () => {
  const api = await mkApi();
  api.session.set(TEACHER);
  const pid = api.session.current().programIds[0];
  const day = await nextSchoolDay(api, pid);
  api.session.set(PARENT);
  for (const r of await api.care.leave({ studentId: 'stu-01' })) if (r.status === 'active') await api.care.withdrawLeave(r.id);
  await api.care.requestLeave({ studentId: 'stu-01', fromDate: day, toDate: day, reason: 'Wedding' });
  const html = await draw(api, TEACHER, Attendance, { date: day });
  assert.match(html, /Absences reported by parents/);
  assert.match(html, /data-seen=/);
  assert.match(html, /name="st-stu-01" value="leave" checked/);
  assert.match(html, /Absence reported<\/strong>: Wedding/);
  assert.doesNotMatch(html, /name="st-stu-04" value="leave" checked/, 'only that child');
});

test('Going home: lists the children, records a pick-up and shows who collected them', async () => {
  const api = await mkApi();
  const html = await draw(api, TEACHER, Pickup);
  assert.match(html, /Going home/);
  api.session.set(TEACHER);
  await api.care.recordPickup({ studentId: 'stu-01', date: todayISO(), collectedBy: { kind: 'guardian', id: 'grd-01' }, time: '15:30' });
  const after = await draw(api, TEACHER, Pickup);
  assert.match(after, /Collected by <strong>Meena Notrealsen<\/strong> at 15:30/);
});

test("teacher's phone tab bar: Pick-up is in, the calendar stays in the rail (seven tabs)", () => {
  const root = fake();
  Shell.renderShell(root, { school: { name: 'S' }, personas: { featured: [], others: [] }, current: { id: 'x', role: 'teacher' } });
  const bar = root.innerHTML.split('<nav class="tabbar')[1];
  assert.match(bar, /<span>Pick-up<\/span>/);
  assert.doesNotMatch(bar, /<span>Calendar<\/span>/);
  assert.equal((bar.match(/<a /g) || []).length, 7);
});

test('Going home: a pick-up by someone since removed from the list still shows their name (audit 2026-10-13 #6)', async () => {
  const api = await mkApi();
  api.session.set(PARENT);
  const c = await api.care.addContact({ studentId: 'stu-01', name: 'Rani Removedsen', relation: 'Grandmother', phone: '9000000381' });
  api.session.set(TEACHER);
  await api.care.recordPickup({ studentId: 'stu-01', date: todayISO(), collectedBy: { kind: 'contact', id: c.id }, time: '15:30' });
  api.session.set(PARENT);
  await api.care.removeContact(c.id);
  const who = await api.care.whoMayCollect('stu-01');
  assert.ok(!who.contacts.some((x) => x.id === c.id), 'not on the current list');
  assert.match(await draw(api, TEACHER, Pickup), /Collected by <strong>Rani Removedsen<\/strong>/);
  assert.match(await draw(api, PARENT, Care, { student: 'stu-01' }), /Rani Removedsen/);
});

test('whole-class diary: a child whose parent reported an absence starts unticked even before the register is taken (audit 2026-10-13 #5)', async () => {
  const api = await mkApi();
  api.session.set(TEACHER);
  const pid = api.session.current().programIds[0];
  const day = await nextSchoolDay(api, pid);
  api.session.set(PARENT);
  for (const r of await api.care.leave({ studentId: 'stu-01' })) if (r.status === 'active') await api.care.withdrawLeave(r.id);
  await api.care.requestLeave({ studentId: 'stu-01', fromDate: day, toDate: day, reason: 'Wedding' });
  api.session.set(TEACHER);
  const ctx = { api, persona: api.session.current(), query: { program: pid, date: day }, params: {}, el: fake(), get db() { return api.getDb(); },
    go() {}, setQuery() {}, href, toast() {}, onChange() {}, cleanup() {}, rerender() {} };
  await Diary.render(ctx);
  const made = [];
  const orig = document.createElement;
  document.createElement = () => { const d = fake(); d.showModal = () => {}; d.close = () => {}; made.push(d); return d; };
  try {
    ctx.el.querySelector('#d-class').handlers.click[0]();
    for (let i = 0; i < 20 && !made.length; i++) await new Promise((r) => setTimeout(r, 5));
  } finally { document.createElement = orig; }
  const html = made[0].innerHTML;
  assert.match(html, /value="stu-01">/, 'stu-01 is listed unticked');
  assert.match(html, /stu-01">[^<]*<small class="muted">\(reported absent\)/);
  assert.match(html, /value="stu-0[^1]" checked/, 'the others start ticked');
});
