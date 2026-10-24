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
