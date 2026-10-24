// Wave 2, care, health, diary and notices screens: allergy badges and health details (#78), all-or-none diary removal
// and group lessons (#21/#29), toileting and "please send" (#83), notice files, corrections and withdrawals (#12/#84),
// who has not read (#86), and the office-hours note in conversations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../src/api/index.js';
import { buildSeed } from '../src/seed/seed-data.js';
import { memoryBackend } from '../src/store/storage.js';
import { todayISO, addDays } from '../src/domain/dates.js';
import { href } from '../src/ui/router.js';

const NOW = new Date(); // the screens read the real date (todayISO); the seed is built around it
const EVIL = '"><img src=x onerror=alert(1)><script>alert(2)</script>';
const PRINCIPAL = 'persona-stf-principal', TEACHER = 'persona-stf-teacher-pa', TODDLER_TEACHER = 'persona-stf-teacher-toddler';
const PARENT = 'persona-grd-01', TODDLER_PARENT = 'persona-grd-02';

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

async function mkApi({ change = null, clock = () => NOW } = {}) {
  const api = createApi({ backend: memoryBackend(), sessionBackend: memoryBackend(), seedFn: () => { const db = buildSeed(NOW); if (change) change(db); return db; }, clock });
  await api.ready();
  return api;
}
function mkCtx(api, who, query = {}, params = {}) {
  api.session.set(who);
  const cleanups = [];
  return { api, persona: api.session.current(), query, params, el: fake(), get db() { return api.getDb(); }, cleanups,
    go() {}, setQuery() {}, href, toast() {}, onChange() {}, cleanup(f) { cleanups.push(f); }, rerender() {} };
}
async function draw(api, who, mod, query = {}, params = {}) {
  const ctx = mkCtx(api, who, query, params);
  await mod.render(ctx);
  return ctx.el.innerHTML;
}
const noRaw = (html) => assert.ok(!html.includes('<img src=x') && !html.includes('<script>alert'), 'escaped');
const lastSchoolDay = async (api, pid) => { let d = todayISO(); while (!(await api.calendar.isWorkingDay(d, pid))) d = addDays(d, -1); return d; };

/** Open a modal from a click handler and return the fake dialog it built. */
async function modalFrom(fn) {
  const made = [];
  const orig = document.createElement;
  document.createElement = () => { const d = fake(); d.showModal = () => {}; d.close = () => {}; made.push(d); return d; };
  try {
    fn();
    for (let i = 0; i < 400 && !made.length; i++) await new Promise((r) => setTimeout(r, 5));
  } finally { document.createElement = orig; }
  return made[0];
}
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
/** Poll for a condition (2 s cap), never a fixed short timer. */
async function until(fn, what = 'condition') {
  for (let i = 0; i < 400; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 5)); }
  assert.fail(`timed out waiting for ${what}`);
}

const Diary = await import('../src/ui/screens/diary.js');

// ---------------------------------------------------------------- parent diary
test("parent diary: an entry is followed by nothing but its own text (no stray list index after each entry)", async () => {
  const api = await mkApi();
  const date = api.getDb().diaryEntries.filter((x) => x.studentId === 'stu-01').map((x) => x.date).sort().at(-1);
  const html = await draw(api, PARENT, Diary, { student: 'stu-01', date });
  assert.match(html, /class="diary-entry/);
  assert.doesNotMatch(html, /<\/small><\/div>\d+<\/div>/, 'the map index must not be printed');
});

/** A click under root on an element matching `sel` with this dataset (every click listener on root runs, as in the browser). */
async function clickOn(root, sel, dataset) {
  const target = { dataset, disabled: false, closest: (s) => (s === sel ? target : null) };
  for (const f of root.handlers.click || []) await f({ target, preventDefault() {} });
  return target;
}
/** Answer an openModal with the action at index `i` (the fake dialog's click handler). */
async function chooseAction(d, i) {
  const btn = { dataset: { act: String(i) }, hasAttribute: () => false };
  for (const f of d.handlers.click || []) f({ target: { closest: () => btn } });
}

const Attendance = await import('../src/ui/screens/attendance.js');
const Pickup = await import('../src/ui/screens/pickup.js');
const People = await import('../src/ui/screens/people.js');
const Care = await import('../src/ui/screens/care.js');
const Home = await import('../src/ui/screens/home.js');
const Notices = await import('../src/ui/screens/notices.js');
const Threads = await import('../src/ui/screens/threads.js');

// ---------------------------------------------------------------- #78 allergy and medical alerts
test('#78 register, diary and going home: an "Allergy" badge next to the child; tapping it shows the details; a note-only child gets "Health note"', async () => {
  const api = await mkApi();
  api.session.set(TODDLER_TEACHER);
  const pid = api.session.current().programIds[0];
  const date = await lastSchoolDay(api, pid);
  for (const [mod, q] of [[Attendance, { date }], [Diary, { date }], [Pickup, {}]]) {
    const ctx = mkCtx(api, TODDLER_TEACHER, q);
    await mod.render(ctx);
    const html = ctx.el.innerHTML;
    assert.match(html, /<button type="button" class="chip health-flag" data-health="stu-10" aria-label="Allergy for Diya Mockherjee: show details">Allergy<\/button>/);
    assert.match(html, /class="chip health-flag note" data-health="stu-11"[^>]*>Health note</);
    assert.doesNotMatch(html, /data-health="stu-03"/, 'no badge for a child with nothing recorded');
    assert.doesNotMatch(html, /Peanuts/, 'details stay behind the tap');
    const d = await modalFrom(() => clickOn(ctx.el, '[data-health]', { health: 'stu-10' }));
    assert.match(d.innerHTML, /Peanuts and tree nuts/);
    assert.match(d.innerHTML, /antihistamine/);
    assert.match(d.innerHTML, /by a parent/);
  }
});

test('#78 what is typed in an alert is escaped everywhere; an alert list that fails to load says so instead of showing no badges', async () => {
  const api = await mkApi();
  api.session.set(PRINCIPAL);
  await api.health.set({ studentId: 'stu-03', allergies: EVIL });
  const ctx = mkCtx(api, TODDLER_TEACHER, {});
  await Pickup.render(ctx);
  noRaw(ctx.el.innerHTML);
  const d = await modalFrom(() => clickOn(ctx.el, '[data-health]', { health: 'stu-03' }));
  noRaw(d.innerHTML);
  assert.match(d.innerHTML, /&lt;script&gt;/);
  const broken = mkCtx(api, TODDLER_TEACHER, {});
  broken.api = { ...api, health: { ...api.health, alerts: async () => { throw Object.assign(new Error('offline'), { code: 'OFFLINE' }); } } };
  await Pickup.render(broken);
  assert.match(broken.el.innerHTML, /Allergy and medical alerts could not be loaded/);
});

test("#78 principal's child page: the badge, the details and Change; saving updates the child's alerts", async () => {
  const api = await mkApi();
  const ctx = mkCtx(api, PRINCIPAL, {}, { id: 'stu-17' });
  await People.render(ctx);
  const html = ctx.el.innerHTML;
  assert.match(html, /data-health="stu-17"[^>]*>Medical alert</);
  assert.match(html, /Allergies and health/);
  assert.match(html, /Mild asthma/);
  const d = await modalFrom(() => ctx.el.querySelector('#health-edit').handlers.click[0]());
  assert.match(d.innerHTML, /name="allergies" maxlength="500"/);
  assert.equal(await submitModal(d, [['allergies', 'Egg (demo data)'], ['medical', 'Mild asthma: inhaler with the class teacher (demo data)'], ['notes', '']]), '');
  const h = await api.health.get('stu-17');
  assert.equal(h.allergies, 'Egg (demo data)');
  assert.equal(h.updatedByRole, 'admin');
});

test("#78 parent's page: their child's allergies with Change; the parent's change is what the teacher's badge then shows", async () => {
  const api = await mkApi();
  const ctx = mkCtx(api, TODDLER_PARENT, { student: 'stu-03' });
  await Care.render(ctx);
  assert.match(ctx.el.innerHTML, /Allergies and health/);
  assert.match(ctx.el.innerHTML, /Nothing recorded/);
  const d = await modalFrom(() => ctx.el.querySelector('#health-edit').handlers.click[0]());
  assert.equal(await submitModal(d, [['allergies', 'Milk (demo data)'], ['medical', ''], ['notes', '']]), '');
  assert.equal((await api.health.get('stu-03')).updatedByRole, 'parent');
  assert.match(await draw(api, TODDLER_TEACHER, Pickup), /data-health="stu-03"[^>]*>Allergy</);
});

// ---------------------------------------------------------------- #21 / #29 all or none
test('#21 diary: "All N children" removes a whole-class entry in one write (diary.removeMany); a refusal removes none', async () => {
  const api = await mkApi();
  api.session.set(TEACHER);
  const pid = api.session.current().programIds[0];
  const date = await lastSchoolDay(api, pid);
  const kids = (await api.people.students({ programId: pid })).filter((s) => s.status === 'active').slice(0, 3).map((s) => s.id);
  await api.diary.addMany({ programId: pid, date, studentIds: kids, type: 'activity', data: { text: 'Whole-class painting (fake)' } });
  const mine = (await api.diary.forProgramDate(pid, date)).filter((e) => e.data?.text === 'Whole-class painting (fake)');
  assert.equal(mine.length, 3);
  const ctx = mkCtx(api, TEACHER, { date });
  const calls = { many: [], one: 0 };
  ctx.api = { ...api, diary: { ...api.diary, removeMany: async (ids) => { calls.many.push(ids); throw Object.assign(new Error('Refused (fake)'), { code: 'NOT_ALLOWED' }); }, remove: async () => { calls.one++; } } };
  await Diary.render(ctx);
  const d = await modalFrom(() => clickOn(ctx.el, '[data-rm]', { rm: mine[0].id }));
  assert.match(d.innerHTML, /All 3 children/);
  await chooseAction(d, 2);
  await until(() => calls.many.length === 1, 'removeMany');
  assert.deepEqual([...calls.many[0]].sort(), mine.map((e) => e.id).sort());
  assert.equal(calls.one, 0, 'never one by one');
  assert.equal((await api.diary.forProgramDate(pid, date)).filter((e) => e.data?.text === 'Whole-class painting (fake)').length, 3, 'nothing removed');
  // and for real
  const ctx2 = mkCtx(api, TEACHER, { date });
  await Diary.render(ctx2);
  const d2 = await modalFrom(() => clickOn(ctx2.el, '[data-rm]', { rm: mine[0].id }));
  await chooseAction(d2, 2);
  await until(async () => (await api.diary.forProgramDate(pid, date)).every((e) => e.data?.text !== 'Whole-class painting (fake)'), 'all three removed');
});

test('#29 group lesson: one child the server refuses means nothing is recorded for the others, and the form says so', async () => {
  const Learning = await import('../src/ui/screens/learning.js');
  const api = await mkApi();
  const ctx = mkCtx(api, TEACHER, { tab: 'progress' });
  const pid = ctx.persona.programIds[0];
  const kids = (await api.people.students({ programId: pid })).filter((s) => s.status === 'active').map((s) => s.id);
  const state = await api.progress.state({ programId: pid });
  const pres = (await api.curriculum.list({ area: 'language' })).find((p) => p.active && !state.some((x) => x.presentationId === p.id));
  const [a, b, c] = kids;
  await api.progress.record({ studentId: a, presentationId: pres.id, status: 'introduced', date: todayISO(), note: '', correction: false, reason: null });
  await Learning.render(ctx);
  const d = await modalFrom(() => ctx.el.querySelector('#l-body').querySelector('#pg-group').handlers.click[0]());
  await new Promise((r) => setTimeout(r, 20));
  const err = await submitModal(d, [['area', 'language'], ['date', todayISO()], ['presentationId', pres.id], ['status', 'introduced'], ['studentIds', a], ['studentIds', b], ['studentIds', c]]);
  assert.match(err, /^Nothing was recorded\./);
  const after = (await api.progress.state({ programId: pid })).filter((x) => x.presentationId === pres.id).map((x) => x.studentId);
  assert.deepEqual(after, [a], 'b and c were not recorded');
});

// ---------------------------------------------------------------- #83 toileting and "please send"
test('#83 diary: toilet / nappy is offered for toddlers only; "please send" for every child', async () => {
  const api = await mkApi();
  api.session.set(TODDLER_TEACHER);
  const tpid = api.session.current().programIds[0];
  const tctx = mkCtx(api, TODDLER_TEACHER, { date: await lastSchoolDay(api, tpid) });
  await Diary.render(tctx);
  const td = await modalFrom(() => clickOn(tctx.el, '[data-add]', { add: 'stu-03' }));
  assert.match(td.innerHTML, /<option value="toilet">Toilet \/ nappy<\/option>/);
  assert.match(td.innerHTML, /<option value="needs">/);
  const wc = await modalFrom(() => tctx.el.querySelector('#d-class').handlers.click[0]());
  assert.match(wc.innerHTML, /value="toilet"/, 'the whole-class entry too');
  api.session.set(TEACHER);
  const pid = api.session.current().programIds[0];
  const ctx = mkCtx(api, TEACHER, { date: await lastSchoolDay(api, pid) });
  await Diary.render(ctx);
  const kid = (await api.people.students({ programId: pid })).find((s) => s.status === 'active');
  const d = await modalFrom(() => clickOn(ctx.el, '[data-add]', { add: kid.id }));
  assert.doesNotMatch(d.innerHTML, /value="toilet"/);
  assert.match(d.innerHTML, /value="needs"/);
});

test('#83 a toilet entry and a "please send" request: the family sees both, answers "I will send it" once, and the teacher sees the answer', async () => {
  const api = await mkApi();
  api.session.set(TODDLER_TEACHER);
  const date = todayISO();
  await api.diary.add({ studentId: 'stu-03', date, type: 'toilet', data: { time: '10:30', kind: 'wet', note: '' } });
  const ctx = mkCtx(api, TODDLER_TEACHER, { date });
  await Diary.render(ctx);
  const d = await modalFrom(() => clickOn(ctx.el, '[data-add]', { add: 'stu-03' }));
  assert.equal(await submitModal(d, [['type', 'needs'], ['items', 'spareClothes'], ['items', 'wipes'], ['note', '']]), '');
  const need = (await api.diary.forStudentDate('stu-03', date)).find((e) => e.type === 'needs');
  assert.deepEqual(need.data.items, ['spareClothes', 'wipes']);
  assert.match(await draw(api, TODDLER_TEACHER, Diary, { date }), /Family has not answered yet/);
  // the parent's home and diary
  assert.match(await draw(api, TODDLER_PARENT, Home), /Please send to school for Aarav:<\/strong> spare clothes, wipes/);
  const pctx = mkCtx(api, TODDLER_PARENT, { student: 'stu-03', date });
  await Diary.render(pctx);
  assert.match(pctx.el.innerHTML, /<strong>Wet nappy<\/strong> at 10:30/);
  assert.match(pctx.el.innerHTML, /Please send to school:<\/strong> spare clothes, wipes/);
  assert.match(pctx.el.innerHTML, new RegExp(`data-ack="${need.id}">I will send it`));
  const b = await clickOn(pctx.el, '[data-ack]', { ack: need.id });
  assert.equal(b.disabled, true, 'a double tap answers once');
  assert.ok((await api.diary.forStudentDate('stu-03', date)).find((e) => e.id === need.id).ackAt);
  assert.match(await draw(api, TODDLER_PARENT, Diary, { student: 'stu-03', date }), /You said you will send it/);
  assert.doesNotMatch(await draw(api, TODDLER_PARENT, Home), /Please send to school for Aarav/);
  assert.match(await draw(api, TODDLER_TEACHER, Diary, { date }), /Family will send it/);
});

// ---------------------------------------------------------------- #12 / #84 notice files, correction, withdrawal
const pdfFile = (name = 'Circular.pdf') => new File(['%PDF-1.4 fake circular'], name, { type: 'application/pdf' });

test('#12 client-side file check: at most 3, PDF/JPEG/PNG only, 2 MB each', () => {
  assert.equal(Notices.filesProblem([pdfFile()]), '');
  assert.match(Notices.filesProblem([pdfFile(), pdfFile(), pdfFile(), pdfFile()]), /at most 3/);
  assert.match(Notices.filesProblem([pdfFile()], 3), /at most 3/, 'counts the files kept on a corrected notice');
  assert.match(Notices.filesProblem([new File(['<svg/>'], 'x.svg', { type: 'image/svg+xml' })]), /only PDF, JPEG or PNG/);
  assert.match(Notices.filesProblem([{ name: 'big.pdf', type: 'application/pdf', size: 2 * 1024 * 1024 + 1 }]), /at most 2 MB/);
});

/** A teacher's notice to their programme with one PDF, sent through the compose form. */
async function sendWithPdf(api) {
  const ctx = mkCtx(api, TEACHER);
  await Notices.render(ctx);
  const d = await modalFrom(() => ctx.el.querySelector('#n-new').handlers.click[0]());
  assert.match(d.innerHTML, /type="file" name="files" id="n-files" accept="application\/pdf,image\/jpeg,image\/png/);
  d.querySelector('form').querySelector('#n-files').files = [pdfFile()];
  const err = await submitModal(d, [['title', 'Fake trip (sample)'], ['body', 'Bring a cap (fake)'], ['scope', 'program'], ['programIds', ctx.persona.programIds[0]], ['requiresAck', 'on']]);
  assert.equal(err, '');
  api.session.set(TEACHER);
  return (await api.notices.list()).find((n) => n.title === 'Fake trip (sample)');
}

test('#12 compose: the chosen PDF is uploaded and sent with the notice; a parent opens it in a new tab from a blob', async () => {
  const api = await mkApi();
  const n = await sendWithPdf(api);
  assert.deepEqual(n.attachments.map((a) => [a.name, a.mime]), [['Circular.pdf', 'application/pdf']]);
  const ctx = mkCtx(api, PARENT, {}, { id: n.id });
  await Notices.render(ctx);
  assert.match(ctx.el.innerHTML, new RegExp(`data-open-file="${n.attachments[0].id}">Open Circular.pdf`));
  assert.doesNotMatch(ctx.el.innerHTML, /https?:\/\/|blob:/, 'no URL in the markup');
  const win = { location: { href: '' }, close() { this.closed = true; } };
  const prevWindow = globalThis.window;
  globalThis.window = { open: () => win };
  try {
    await clickOn(ctx.el, '[data-open-file]', { openFile: n.attachments[0].id });
    await until(() => win.location.href.startsWith('blob:'), 'the PDF in the new tab');
  } finally { globalThis.window = prevWindow; }
  const revoked = [];
  const prevRevoke = URL.revokeObjectURL;
  URL.revokeObjectURL = (u) => { revoked.push(u); prevRevoke(u); };
  try { ctx.cleanups.forEach((f) => f()); } finally { URL.revokeObjectURL = prevRevoke; }
  assert.deepEqual(revoked, [win.location.href], 'revoked on leaving the screen');
});

test('#84 parent: an image attachment is shown inline from a blob URL', async () => {
  const api = await mkApi();
  api.session.set(PARENT);
  const n = (await api.notices.list()).find((x) => x.attachments.some((a) => a.id === 'nfl-demo-1'));
  const ctx = mkCtx(api, PARENT, {}, { id: n.id });
  const img = { dataset: { nfile: 'nfl-demo-1' }, alt: 'Meeting plan', src: '' };
  ctx.el.querySelectorAll = (sel) => (sel === 'img[data-nfile]' ? [img] : []);
  await Notices.render(ctx);
  assert.match(ctx.el.innerHTML, /<img data-nfile="nfl-demo-1" alt="Meeting plan \(sample\).svg"/);
  await until(() => img.src.startsWith('blob:'), 'the image');
});

test('#84 correct and withdraw: history kept for staff, parents see "corrected", then "withdrawn" with the reason and no files', async () => {
  const api = await mkApi();
  const n = await sendWithPdf(api);
  let ctx = mkCtx(api, TEACHER, {}, { id: n.id });
  await Notices.render(ctx);
  const d = await modalFrom(() => ctx.el.querySelector('#n-correct').handlers.click[0]());
  assert.match(d.innerHTML, new RegExp(`name="keep" value="${n.attachments[0].id}" checked`));
  assert.match(await submitModal(d, [['title', n.title], ['body', n.body], ['keep', n.attachments[0].id], ['reason', 'Nothing']]), /Change the title, the message or the files first/);
  assert.equal(await submitModal(d, [['title', n.title], ['body', 'Bring a cap and water (fake)'], ['keep', n.attachments[0].id], ['reason', 'Water was missing (fake)']]), '');
  let html = await draw(api, PARENT, Notices, {}, { id: n.id });
  assert.match(html, /Bring a cap and water/);
  assert.match(html, /<strong>Corrected [^<]+\.<\/strong> Water was missing \(fake\)/);
  assert.doesNotMatch(html, /Earlier wording/, 'the earlier wording is for staff');
  assert.match(await draw(api, PARENT, Notices), /class="badge info">Corrected</);
  html = await draw(api, TEACHER, Notices, {}, { id: n.id });
  assert.match(html, /Earlier wording \(1\)/);
  ctx = mkCtx(api, TEACHER, {}, { id: n.id });
  await Notices.render(ctx);
  const w = await modalFrom(() => ctx.el.querySelector('#n-withdraw').handlers.click[0]());
  assert.equal(await submitModal(w, [['reason', 'Trip cancelled (fake)']]), '');
  html = await draw(api, PARENT, Notices, {}, { id: n.id });
  assert.match(html, /<strong>Withdrawn [^<]+\.<\/strong> Trip cancelled \(fake\)/);
  assert.match(html, /files of a withdrawn notice are no longer available/);
  assert.doesNotMatch(html, /data-open-file|data-nfile|id="n-ack"/, 'no files and no acknowledgement once withdrawn');
  assert.match(await draw(api, PARENT, Notices), /class="badge mute">Withdrawn</);
  assert.doesNotMatch(await draw(api, TEACHER, Notices, {}, { id: n.id }), /id="n-correct"|id="n-withdraw"/, 'nothing more to change');
});

test('#86 staff see "Not read yet" with tap-to-call links and no WhatsApp links; parents never see the list', async () => {
  const api = await mkApi();
  const n = await sendWithPdf(api);
  const html = await draw(api, TEACHER, Notices, {}, { id: n.id });
  const u = await api.notices.unread(n.id);
  assert.ok(u.notRead.length > 1);
  assert.match(html, new RegExp(`Not read yet \\(${u.notRead.length}\\)`));
  const g = u.notRead.find((r) => r.phone);
  assert.ok(html.includes(`href="tel:${g.phone.replace(/[^\d+]/g, '')}" aria-label="Call ${g.guardianName}"`));
  assert.doesNotMatch(html, /wa\.me|whatsapp/i);
  // once read, the family moves to "read, not acknowledged"
  api.session.set(PARENT);
  await api.notices.markRead(n.id);
  const after = await draw(api, TEACHER, Notices, {}, { id: n.id });
  assert.match(after, new RegExp(`Not read yet \\(${u.notRead.length - 1}\\)`));
  assert.match(after, /Read, not acknowledged yet \(1\)/);
  assert.doesNotMatch(await draw(api, PARENT, Notices, {}, { id: n.id }), /Not read yet|tel:/);
});

// ---------------------------------------------------------------- office hours in conversations
test('office hours: outside them a parent is told when the school will reply; inside them, and for staff, nothing', async () => {
  assert.equal(Threads.officeHoursNote({ set: false, open: true }), '');
  assert.equal(Threads.officeHoursNote({ set: true, open: true, hours: { start: '08:30', end: '16:00', days: [1] } }), '');
  assert.match(Threads.officeHoursNote({ set: true, open: false, hours: { start: '08:30', end: '16:00', days: [1] }, nextOpen: { day: 1, time: '08:30', inDays: 2 } }),
    /The school will reply during office hours \(.*next: Monday at 08:30\)\./);
  assert.match(Threads.officeHoursNote({ set: true, open: false, hours: { start: '08:30', end: '16:00', days: [1] }, nextOpen: { day: 2, time: '08:30', inDays: 1 } }), /next: tomorrow at 08:30/);
  // a Sunday morning in school time (IST): the seed's office opens Monday to Friday
  const sunday = new Date(NOW);
  sunday.setUTCDate(sunday.getUTCDate() + ((7 - sunday.getUTCDay()) % 7 || 7));
  sunday.setUTCHours(5, 0, 0, 0);
  const api = await mkApi({ clock: () => sunday });
  api.session.set(PARENT);
  const t = await api.threads.open({ studentId: api.session.current().studentIds[0], subject: 'Fake question', body: 'Fake body' });
  assert.match(await draw(api, PARENT, Threads, {}, { id: t.id }), /The school will reply during office hours \(.*next: tomorrow at 08:30\)/);
  assert.doesNotMatch(await draw(api, TEACHER, Threads, {}, { id: t.id }), /office hours/);
});
