// Wave 1, parent experience (review 2026-10-19): push, read receipts, photos, start-up, fees, absences, labels.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createApi } from '../src/api/index.js';
import { buildSeed } from '../src/seed/seed-data.js';
import { memoryBackend } from '../src/store/storage.js';
import { todayISO, addDays } from '../src/domain/dates.js';
import { href } from '../src/ui/router.js';
import { pushMessages } from '../supabase/functions/_shared/notify.js';

const NOW = new Date(); // the screens read the real date (todayISO); the seed is built around it
const TEACHER = 'persona-stf-teacher-pa', PARENT = 'persona-grd-01';

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
function mkCtx(api, who, query = {}, params = {}) {
  api.session.set(who);
  return { api, persona: api.session.current(), query, params, el: fake(), get db() { return api.getDb(); },
    go() {}, setQuery() {}, href, toast() {}, onChange() {}, cleanup() {}, rerender() {} };
}
async function draw(api, who, mod, query = {}, params = {}) {
  const ctx = mkCtx(api, who, query, params);
  await mod.render(ctx);
  return ctx.el.innerHTML;
}
const clone = (x) => JSON.parse(JSON.stringify(x));

// ---- #3 teacher replies are notified ---------------------------------------------------------------
test('#3 a staff reply or a staff-opened thread notifies the guardian, never with the message text; a parent message notifies nobody', async () => {
  const api = await mkApi();
  api.session.set(PARENT);
  const p = api.session.current();
  const sid = p.studentIds[0];
  const t = await api.threads.open({ studentId: sid, subject: 'Lunch', body: 'SECRET-PARENT-TEXT' });
  const before = clone(api.getDb());
  assert.deepEqual(pushMessages('threads.open', before, api.getDb(), t), [], 'a parent writing never pushes');

  api.session.set(TEACHER);
  const b2 = clone(api.getDb());
  const m = await api.threads.reply(t.id, 'SECRET-TEACHER-TEXT');
  const out = pushMessages('threads.reply', b2, api.getDb(), m);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].guardianIds, [p.guardianId]);
  assert.deepEqual(out[0].studentIds, [sid]);
  assert.deepEqual(out[0].purposes, ['push']);
  assert.equal(out[0].payload.title, 'Message from school');
  assert.equal(out[0].payload.url, `#/messages/${t.id}`);
  const first = api.getDb().students.find((s) => s.id === sid).firstName;
  assert.equal(out[0].payload.body, `New message about ${first}`);
  assert.ok(!JSON.stringify(out).includes('SECRET'), 'message text never in a push');

  const t2 = await api.threads.open({ guardianId: p.guardianId, studentId: sid, subject: 'Shoes', body: 'SECRET-2' });
  const out2 = pushMessages('threads.open', b2, api.getDb(), t2);
  assert.equal(out2.length, 1);
  assert.equal(out2[0].payload.url, `#/messages/${t2.id}`);
  assert.deepEqual(out2[0].guardianIds, [p.guardianId]);
});

// ---- #2 notifications ticked at sign-up are actually switched on ------------------------------------
// A browser that can do web push: permission 'default', no subscription yet, a fresh localStorage.
function pushBrowser({ ios = false, standalone = false, permission = 'default' } = {}) {
  const calls = [];
  const store = new Map();
  let sub = null;
  const reg = { pushManager: {
    getSubscription: async () => sub,
    subscribe: async () => { calls.push('subscribe'); sub = { endpoint: 'https://fcm.googleapis.com/x', toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/x' }) }; return sub; },
  } };
  const nav = { userAgent: ios ? 'iPhone' : 'Android', platform: '', maxTouchPoints: 5, standalone,
    serviceWorker: { register: async () => reg, ready: Promise.resolve(reg), getRegistration: async () => reg } };
  Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true });
  globalThis.window = { isSecureContext: true, PushManager: function () {}, Notification: {}, matchMedia: () => ({ matches: standalone }) };
  globalThis.Notification = { permission, requestPermission: async () => { calls.push('permission'); globalThis.Notification.permission = 'granted'; return 'granted'; } };
  globalThis.window.Notification = globalThis.Notification;
  Object.defineProperty(globalThis, 'localStorage', { value: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) }, configurable: true });
  globalThis.document.baseURI = 'https://school.example.com/app/';
  return { calls, done: () => { delete globalThis.window; delete globalThis.Notification; } };
}

test('#2 after consent with notifications ticked, a tap on "Allow notifications on this phone" asks permission first and subscribes', async () => {
  const b = pushBrowser();
  const { api } = await import('../src/api/index.js');
  const { renderConsent } = await import('../src/ui/consent.js');
  const saved = { give: api.consent.give, key: api.push.vapidPublicKey, sub: api.push.subscribe };
  const sent = [];
  api.consent.give = async (x) => { sent.push(['consent', x.purposes]); };
  api.push.vapidPublicKey = async () => 'BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  api.push.subscribe = async (j) => { sent.push(['subscribe', j.endpoint]); };
  try {
    const root = fake();
    let done = 0;
    renderConsent(root, { children: [{ id: 'stu-01', firstName: 'Neel' }], onDone: () => { done++; }, onSignOut() {} });
    const form = root.querySelector('#cs-form');
    form.querySelector('[data-required]').checked = true;
    form.querySelectorAll = (sel) => (sel.includes('purpose') ? [{ value: 'app_account' }, { value: 'push' }] : []);
    await form.handlers.submit[0]({ preventDefault() {} });
    for (let i = 0; i < 20 && !root.innerHTML.includes('pn-on'); i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(done, 0, 'not finished yet: the phone step comes first');
    assert.match(root.innerHTML, /Allow notifications on this phone/);
    assert.match(root.innerHTML, /id="pn-skip"/);
    await root.querySelector('#pn-on').handlers.click[0]({ target: {} });
    assert.deepEqual(b.calls, ['permission', 'subscribe'], 'the permission prompt is the first thing the tap does');
    assert.deepEqual(sent.map((s) => s[0]), ['consent', 'subscribe']);
    assert.equal(done, 1);
  } finally { Object.assign(api.consent, { give: saved.give }); Object.assign(api.push, { vapidPublicKey: saved.key, subscribe: saved.sub }); b.done(); }
});

test('#2 iPhone in Safari: the step explains Add to Home Screen instead of asking; no public key: no extra step', async () => {
  const { api } = await import('../src/api/index.js');
  const { renderPushStep } = await import('../src/ui/consent.js');
  const b = pushBrowser({ ios: true });
  try {
    const root = fake();
    let done = 0;
    await renderPushStep(root, { onDone: () => { done++; } });
    assert.match(root.innerHTML, /Add to Home Screen/);
    assert.doesNotMatch(root.innerHTML, /id="pn-on"/);
    root.querySelector('#pn-skip').handlers.click[0]();
    assert.equal(done, 1);
  } finally { b.done(); }
  // the school has not set notifications up yet (no public key): nothing to switch on, go straight on
  const b2 = pushBrowser();
  const saved = api.push.vapidPublicKey;
  try {
    api.push.vapidPublicKey = async () => null;
    let done = 0;
    await renderPushStep(fake(), { onDone: () => { done++; } });
    assert.equal(done, 1);
  } finally { api.push.vapidPublicKey = saved; b2.done(); }
});

test('#2 start-up nudge: shown while this phone has no subscription, gone once dismissed, never after turning off here or when blocked', async () => {
  const push = await import('../src/ui/push.js');
  let b = pushBrowser();
  try {
    assert.equal(await push.nudge(), 'enable');
    push.dismissNudge();
    assert.equal(await push.nudge(), null, 'dismissed on this device');
  } finally { b.done(); }
  b = pushBrowser({ ios: true });
  try { assert.equal(await push.nudge(), 'ios-install'); } finally { b.done(); }
  b = pushBrowser({ permission: 'denied' });
  try { assert.equal(await push.nudge(), null, 'blocked: Settings explains, no nagging'); } finally { b.done(); }
  b = pushBrowser({ permission: 'granted' });
  try {
    await push.enable({ vapidKey: 'BAAA', giveConsent: async () => {}, send: async () => {} });
    assert.equal(await push.nudge(), null, 'subscribed');
  } finally { b.done(); }
  b = pushBrowser();
  try { localStorage.setItem('school.push.optout', '1'); assert.equal(await push.nudge(), null, 'turned off on this device'); } finally { b.done(); }
});

// ---- #4 / #33 read receipts never hold up the screen; #19 message dates ------------------------------
const PRINCIPAL = 'persona-stf-principal';
// wraps api.<area>.<fn> so each call records whether the screen had already been painted
function spyAfterPaint(ctx, area, fn, impl) {
  const calls = [];
  const orig = ctx.api[area][fn];
  ctx.api[area][fn] = (...args) => { calls.push({ args, painted: ctx.el.innerHTML.length > 0 }); return impl ? impl(...args) : orig(...args); };
  return calls;
}

test('#4 parent diary: the day is painted first, then ONE background call marks every unread entry read', async () => {
  const api = await mkApi();
  api.session.set(PARENT);
  const kid = api.getDb().students.find((s) => s.id === api.session.current().studentIds[0]);
  api.session.set(TEACHER);
  for (const text of ['Pouring water', 'Pink tower']) await api.diary.add({ studentId: kid.id, date: todayISO(), type: 'activity', data: { text } });
  const Diary = await import('../src/ui/screens/diary.js');
  const ctx = mkCtx(api, PARENT, { student: kid.id, date: todayISO() });
  const calls = spyAfterPaint(ctx, 'diary', 'markReadMany');
  await Diary.render(ctx);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].painted, 'painted before the read receipt');
  assert.ok(calls[0].args[0].length >= 2);
  await new Promise((r) => setTimeout(r, 10));
  assert.ok((await api.diary.forStudentDate(kid.id, todayISO())).every((e) => e.parentReadAt), 'all marked read');
  const again = mkCtx(api, PARENT, { student: kid.id, date: todayISO() });
  const none = spyAfterPaint(again, 'diary', 'markReadMany');
  await Diary.render(again);
  assert.equal(none.length, 0, 'nothing unread: no call');
});

test('#4 notice: the body shows without waiting for the read receipt, and the list is not re-read', async () => {
  const api = await mkApi();
  api.session.set(PRINCIPAL);
  const n = await api.notices.send({ title: 'Sports day', body: 'Wear white', audience: { scope: 'school' } });
  const Notices = await import('../src/ui/screens/notices.js');
  const ctx = mkCtx(api, PARENT, {}, { id: n.id });
  let lists = 0;
  const origList = api.notices.list;
  api.notices.list = (...a) => { lists++; return origList(...a); };
  const calls = spyAfterPaint(ctx, 'notices', 'markRead', () => new Promise(() => {})); // never answers (2G)
  await Notices.render(ctx);
  assert.match(ctx.el.innerHTML, /Wear white/);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].painted);
  assert.equal(lists, 1, 'one read of the list, no second read after marking');
});

test('#4/#33 conversation: no read receipt when nothing is unread; an offline read receipt never blocks or breaks the thread', async () => {
  const api = await mkApi();
  api.session.set(PARENT);
  const sid = api.session.current().studentIds[0];
  const t = await api.threads.open({ studentId: sid, subject: 'Lunch', body: 'Is there rice today?' });
  const Threads = await import('../src/ui/screens/threads.js');
  let ctx = mkCtx(api, PARENT, {}, { id: t.id });
  let calls = spyAfterPaint(ctx, 'threads', 'markRead');
  await Threads.render(ctx);
  assert.equal(calls.length, 0, 'only my own message: nothing to mark');
  api.session.set(TEACHER);
  await api.threads.reply(t.id, 'Yes, rice and dal');
  ctx = mkCtx(api, PARENT, {}, { id: t.id });
  calls = spyAfterPaint(ctx, 'threads', 'markRead', () => Promise.reject(Object.assign(new Error('offline'), { code: 'OFFLINE' })));
  const errs = console.error; console.error = () => {};
  try { await Threads.render(ctx); await new Promise((r) => setTimeout(r, 5)); } finally { console.error = errs; }
  assert.equal(calls.length, 1);
  assert.ok(calls[0].painted);
  assert.match(ctx.el.innerHTML, /rice and dal/);
});

test('#19 a conversation over several days shows the date (DD-MMM-YYYY) whenever the day changes', async () => {
  let now = new Date(NOW.getTime() - 3 * 86400000);
  const api = createApi({ backend: memoryBackend(), sessionBackend: memoryBackend(), seedFn: () => buildSeed(NOW), clock: () => now });
  await api.ready();
  api.session.set(PARENT);
  const sid = api.session.current().studentIds[0];
  const t = await api.threads.open({ studentId: sid, subject: 'Shoes', body: 'First day message' });
  await api.threads.reply(t.id, 'Same day follow-up');
  now = NOW;
  await api.threads.reply(t.id, 'Later message');
  const { fdatetime } = await import('../src/ui/components.js');
  const html = await draw(api, PARENT, await import('../src/ui/screens/threads.js'), {}, { id: t.id });
  const day = (d) => fdatetime(d.toISOString()).split(' ')[0];
  const seps = [...html.matchAll(/class="bubble-day[^"]*"[^>]*>([^<]+)</g)].map((m) => m[1]);
  assert.deepEqual(seps, [day(new Date(NOW.getTime() - 3 * 86400000)), day(NOW)]);
});

// ---- #5 Learning photos: only when in view, once per session; the latest ten observations first -------------------
function photoRoot(ids) {
  const imgs = ids.map((id) => ({ dataset: { photo: id }, src: '', alt: '', classList: { add() {} }, parentElement: null }));
  return { imgs, querySelectorAll: () => imgs, addEventListener() {} };
}
function photoCtx() {
  const fetched = [];
  return { fetched, cleanups: [], api: { photos: { blob: async (id) => { fetched.push(id); return new Blob(['x']); } } }, cleanup(f) { this.cleanups.push(f); } };
}
const tick = () => new Promise((r) => setTimeout(r, 5));

test('#5 a photo is downloaded only when it scrolls into view, and only once per session', async () => {
  const { loadPhotos, clearPhotoCache } = await import('../src/ui/photo-view.js');
  const seen = [];
  globalThis.IntersectionObserver = class { constructor(cb) { this.cb = cb; seen.push(this); this.els = []; } observe(el) { this.els.push(el); } unobserve() {} disconnect() {} };
  try {
    const ctx = photoCtx();
    const root = photoRoot(['w1-a', 'w1-b']);
    loadPhotos(ctx, root);
    await tick();
    assert.deepEqual(ctx.fetched, [], 'nothing before it is visible');
    const io = seen.at(-1);
    io.cb([{ isIntersecting: true, target: root.imgs[0] }, { isIntersecting: false, target: root.imgs[1] }]);
    await tick();
    assert.deepEqual(ctx.fetched, ['w1-a']);
    assert.match(root.imgs[0].src, /^blob:/);
    ctx.cleanups.forEach((f) => f()); // leaving the screen
    const back = photoCtx();
    const root2 = photoRoot(['w1-a']);
    loadPhotos(back, root2);
    seen.at(-1).cb([{ isIntersecting: true, target: root2.imgs[0] }]);
    await tick();
    assert.deepEqual(back.fetched, [], 'coming back does not download it again');
    assert.match(root2.imgs[0].src, /^blob:/);
    clearPhotoCache();
    const after = photoCtx();
    const root3 = photoRoot(['w1-a']);
    loadPhotos(after, root3);
    seen.at(-1).cb([{ isIntersecting: true, target: root3.imgs[0] }]);
    await tick();
    assert.deepEqual(after.fetched, ['w1-a'], 'sign-out empties the in-memory cache');
  } finally { delete globalThis.IntersectionObserver; }
  // a browser without IntersectionObserver still shows every photo
  const ctx = photoCtx();
  loadPhotos(ctx, photoRoot(['w1-c', 'w1-d']));
  await tick();
  assert.deepEqual(ctx.fetched.sort(), ['w1-c', 'w1-d']);
});

test('#5 parent Learning shows the latest 10 shared observations, with "Show older" for the rest', async () => {
  const api = await mkApi();
  api.session.set(PARENT);
  const kid = api.session.current().studentIds[0];
  api.session.set(TEACHER);
  for (let i = 0; i < 12; i++) {
    const o = await api.observations.add({ studentId: kid, date: addDays(todayISO(), -i), area: 'language', text: `W1OBS-${i}` });
    await api.observations.share(o.id);
  }
  api.session.set(PARENT);
  const total = (await api.observations.list({ studentId: kid })).length;
  const Learning = await import('../src/ui/screens/learning.js');
  const html = await draw(api, PARENT, Learning, { student: kid });
  assert.equal((html.match(/class="card stack obs-card"/g) || []).length, 10);
  assert.match(html, /W1OBS-0\b/, 'newest first');
  assert.match(html, new RegExp(`Show older \\(${total - 10}\\)`));
  const all = await draw(api, PARENT, Learning, { student: kid, all: '1' });
  assert.equal((all.match(/class="card stack obs-card"/g) || []).length, total);
});

// ---- #9 a parent is told why photos are hidden ---------------------------------------------------------------
test('#9 a parent may ask whether photos of their OWN child are shown (yes/no), never another child or a programme', async () => {
  const api = await mkApi();
  api.session.set(PARENT);
  const p = api.session.current();
  const own = p.studentIds[0];
  const r = await api.photos.consentStatus({ studentIds: [own] });
  assert.equal(typeof r[own], 'boolean');
  const other = api.getDb().students.find((s) => !p.studentIds.includes(s.id)).id;
  await assert.rejects(() => api.photos.consentStatus({ studentIds: [other] }), (e) => e.code === 'NOT_ALLOWED');
  await assert.rejects(() => api.photos.consentStatus({ programId: api.getDb().programs[0].id }), (e) => e.code === 'NOT_ALLOWED');
  const { COMMANDS } = await import('../src/domain/commands.js');
  const c = COMMANDS['photos.consentStatus'];
  const db = api.getDb();
  assert.doesNotThrow(() => c.authorize(p, db, [{ studentIds: [own] }]));
  assert.throws(() => c.authorize(p, db, [{ studentIds: [own, other] }]), (e) => e.code === 'NOT_ALLOWED');
  assert.throws(() => c.authorize(p, db, [{ programId: db.programs[0].id }]), (e) => e.code === 'NOT_ALLOWED');
});

test('#9 parent Learning explains hidden photos when not every guardian has agreed, and says nothing when they have', async () => {
  const api = await mkApi();
  api.session.set(PARENT);
  const kid = api.session.current().studentIds[0];
  const first = api.getDb().students.find((s) => s.id === kid).firstName;
  const Learning = await import('../src/ui/screens/learning.js');
  const ctx = mkCtx(api, PARENT, { student: kid });
  ctx.api = { ...api, photos: { ...api.photos, consentStatus: async () => ({ [kid]: false }) } };
  await Learning.render(ctx);
  assert.match(ctx.el.innerHTML, new RegExp(`Photos of ${first} are hidden until every parent or guardian who uses the app has agreed to photos`));
  const ok = mkCtx(api, PARENT, { student: kid });
  ok.api = { ...api, photos: { ...api.photos, consentStatus: async () => ({ [kid]: true }) } };
  await Learning.render(ok);
  assert.doesNotMatch(ok.el.innerHTML, /are hidden until/);
});

test('#33 teacher Learning asks the server about photo consent once per programme, not on every re-render', async () => {
  const api = await mkApi();
  const Learning = await import('../src/ui/screens/learning.js');
  let n = 0;
  const wrap = (ctx) => { ctx.api = { ...api, photos: { ...api.photos, consentStatus: (q) => { n++; return api.photos.consentStatus(q); } } }; return ctx; };
  await Learning.render(wrap(mkCtx(api, TEACHER, { tab: 'observations' })));
  await Learning.render(wrap(mkCtx(api, TEACHER, { tab: 'observations' })));
  assert.equal(n, 1, 'the re-render after Share / Edit / Add photo reuses the answer');
});

// ---- #7 fees: due now (overdue or within 14 days) vs upcoming ------------------------------------------------
const inv = (id, dueDate, balancePaise, overdueDays = 0) => ({ id, number: `INV/W1/${id}`, installmentName: `Term ${id}`, dueDate, status: 'issued', balancePaise, totalPaise: balancePaise, paidPaise: 0, overdueDays });
function feesCtx(api, kidInvoices, query = {}) {
  const ctx = mkCtx(api, PARENT, query);
  ctx.api = { ...api, fees: { ...api.fees, invoices: async () => kidInvoices.map((i) => ({ ...i })) } };
  return ctx;
}
const W1_INVOICES = () => [inv('a', addDays(todayISO(), -5), 100000, 5), inv('b', addDays(todayISO(), 10), 20000), inv('c', addDays(todayISO(), 60), 300000)];

test('#7 parent home: the fees tile counts what is due now; next term issued early shows as upcoming, not due', async () => {
  const api = await mkApi();
  const ctx = feesCtx(api, W1_INVOICES());
  await (await import('../src/ui/screens/home.js')).render(ctx);
  const html = ctx.el.innerHTML;
  assert.match(html, /₹1,200(\.00)?<\/div><div class="l">sample fees due now/);
  assert.match(html, /₹3,000(\.00)? upcoming/);
});

test('#7 parent fees: the red "Due" badge and the Pay button cover due-now invoices only; only upcoming: no red badge', async () => {
  const api = await mkApi();
  const Fees = await import('../src/ui/screens/fees-invoices.js');
  let ctx = feesCtx(api, W1_INVOICES());
  await Fees.render(ctx);
  assert.match(ctx.el.innerHTML, /<span class="badge bad">Due ₹1,200(\.00)?<\/span>/);
  assert.match(ctx.el.innerHTML, /Upcoming ₹3,000/);
  assert.match(ctx.el.innerHTML, /data-pay="[^"]+" data-scope="now">Pay ₹1,200(\.00)? online/);
  ctx = feesCtx(api, [inv('c', addDays(todayISO(), 60), 300000)]);
  await Fees.render(ctx);
  assert.doesNotMatch(ctx.el.innerHTML, /badge bad">Due/);
  assert.doesNotMatch(ctx.el.innerHTML, /All paid/);
  assert.match(ctx.el.innerHTML, /class="btn" data-pay="[^"]+" data-scope="all">Pay ₹3,000(\.00)? early/);
});

test('#7 payment window: each invoice shows its due date; only the ones due now start ticked', async () => {
  const { payOnline } = await import('../src/ui/screens/pay-online.js');
  const made = [];
  const orig = document.createElement;
  document.createElement = () => { const d = fake(); d.showModal = () => {}; d.close = () => {}; made.push(d); return d; };
  try {
    const api = await mkApi();
    payOnline(mkCtx(api, PARENT), { id: 'stu-01', firstName: 'Neel' }, W1_INVOICES());
    for (let i = 0; i < 20 && !made.length; i++) await new Promise((r) => setTimeout(r, 5));
  } finally { document.createElement = orig; }
  const html = made.map((d) => d.innerHTML).join('');
  const { fdate } = await import('../src/ui/components.js');
  assert.match(html, new RegExp(`due ${fdate(addDays(todayISO(), 60))}`));
  assert.match(html, /value="a"[^>]* checked/);
  assert.match(html, /value="b"[^>]* checked/);
  assert.doesNotMatch(html, /value="c"[^>]* checked/);
  assert.match(html, /id="po-total">₹1,200/);
});

// ---- #10 a reported absence shows on the home card -------------------------------------------------------------
test('#10 parent home: today\'s reported absence reads "Absence reported", then "Absence seen by teacher"', async () => {
  const api = await mkApi();
  const today = todayISO();
  api.session.set(PARENT);
  const kid = api.session.current().studentIds[0];
  api.getDb().attendance.filter((a) => a.date === today && a.studentId === kid).forEach((a) => { a.date = '1999-01-01'; }); // register not taken yet
  for (const r of await api.care.leave({ studentId: kid })) if (r.status === 'active') await api.care.withdrawLeave(r.id);
  const req = await api.care.requestLeave({ studentId: kid, fromDate: today, toDate: today, reason: 'Fever' });
  const Home = await import('../src/ui/screens/home.js');
  assert.match(await draw(api, PARENT, Home), /badge warn">Absence reported</);
  api.session.set(TEACHER);
  await api.care.markLeaveSeen(req.id);
  assert.match(await draw(api, PARENT, Home), /badge warn">Absence seen by teacher</);
});

// ---- #15 a started payment survives the browser being closed during the UPI switch -----------------------------
test('#15 the "payment not confirmed yet" marker is kept in localStorage (not sessionStorage) and is cleared on sign-out', () => {
  const src = readFileSync('src/ui/screens/pay-online.js', 'utf8');
  assert.doesNotMatch(src, /sessionStorage\./);
  assert.match(src, /localStorage\.getItem\(PENDING_KEY\)/);
  assert.match(src, /export function clearPendingPayment/);
  const app = readFileSync('src/ui/app.js', 'utf8');
  assert.match(app.split('async function signOutNow')[1].split('\n}\n')[0], /clearPendingPayment\(\)/);
});

// ---- #17 no bus: the Bus tab becomes Calendar ------------------------------------------------------------------
test('#17 a parent with no child on a bus gets Calendar in the tab bar instead of Bus; the home "no bus" tile is not a link', async () => {
  const Shell = await import('../src/ui/shell.js');
  const root = fake();
  Shell.renderShell(root, { school: { name: 'S' }, personas: { featured: [], others: [] }, current: { id: 'x', role: 'parent' }, noBus: true });
  const bar = root.innerHTML.split('<nav class="tabbar')[1];
  assert.match(bar, /<span>Calendar<\/span>/);
  assert.doesNotMatch(bar, /<span>Bus<\/span>/);
  const withBus = fake();
  Shell.renderShell(withBus, { school: { name: 'S' }, personas: { featured: [], others: [] }, current: { id: 'x', role: 'parent' } });
  assert.match(withBus.innerHTML.split('<nav class="tabbar')[1], /<span>Bus<\/span>/);
  const api = await mkApi();
  api.session.set(PARENT);
  const kid = api.session.current().studentIds[0];
  api.getDb().students.forEach((s) => { if (api.session.current().studentIds.includes(s.id)) s.routeId = null; });
  const html = await draw(api, PARENT, await import('../src/ui/screens/home.js'));
  assert.doesNotMatch(html, /href="#\/bus"/);
  assert.match(html, /no bus/);
  assert.ok(kid);
});

// ---- #82 the month's attendance on the parent home -------------------------------------------------------------
test('#82 parent home: "This month: present X of Y school days" with the absent, late and leave dates', async () => {
  const api = await mkApi();
  api.session.set(PARENT);
  const kid = api.session.current().studentIds[0];
  const from = `${todayISO().slice(0, 8)}01`;
  const s = await api.attendance.summary(kid, from, todayISO());
  const html = await draw(api, PARENT, await import('../src/ui/screens/home.js'));
  assert.match(html, new RegExp(`This month: present ${s.present + s.late} of ${s.workingDays} school day`));
  const { fdate } = await import('../src/ui/components.js');
  const abs = api.getDb().attendance.filter((a) => a.studentId === kid && a.date >= from && a.status === 'absent');
  for (const a of abs) assert.ok(html.includes(fdate(a.date)), `absent ${a.date} listed`);
});
