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
