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
