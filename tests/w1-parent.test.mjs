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
