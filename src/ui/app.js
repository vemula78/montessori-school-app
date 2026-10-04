// Entry point: boot the api, pick a persona, mount the shell, route to screens.
import { api } from '../api/index.js';
import { parseHash, matchRoute, go, setQuery, href, startRouter } from './router.js';
import { renderShell, markActive, setBadges, curatePersonas } from './shell.js';
import * as runner from './sim-runner.js';
import { esc, banner, empty, toast, onQuotaError, downloadText, readFileText, attempt, errMessage } from './components.js';
import { isRealMode } from './mode.js';
import { renderLogin, renderBlocked } from './login.js';
import { renderInvite } from './invite.js';
import { renderConsent } from './consent.js';
import * as push from './push.js';
import { clearSlips } from './screens/invites-print.js';

const REAL = isRealMode();

const root = document.getElementById('app');
const ALL = ['admin', 'teacher', 'accountant', 'parent', 'driver'];

const ROUTES = [
  { pattern: '/home', roles: ALL, load: () => import('./screens/home.js') },
  { pattern: '/notices', roles: ['admin', 'teacher', 'parent'], load: () => import('./screens/notices.js') },
  { pattern: '/notices/:id', roles: ['admin', 'teacher', 'parent'], load: () => import('./screens/notices.js') },
  { pattern: '/messages', roles: ['admin', 'teacher', 'parent'], load: () => import('./screens/threads.js') },
  { pattern: '/messages/:id', roles: ['admin', 'teacher', 'parent'], load: () => import('./screens/threads.js') },
  { pattern: '/calendar', roles: ALL, load: () => import('./screens/calendar.js') },
  { pattern: '/calendar/import', roles: ['admin'], load: () => import('./screens/calendar-import.js') },
  { pattern: '/attendance', roles: ['admin', 'teacher'], load: () => import('./screens/attendance.js') },
  { pattern: '/diary', roles: ['admin', 'teacher', 'parent'], load: () => import('./screens/diary.js') },
  { pattern: '/learning', roles: ['admin', 'teacher', 'parent'], load: () => import('./screens/learning.js') },
  { pattern: '/print/report/:id', roles: ['admin', 'teacher', 'parent'], bare: true, load: () => import('./screens/report-print.js') },
  {
    pattern: '/bus', roles: ['admin', 'driver', 'parent'],
    load: (p) => (p.role === 'driver' ? import('./screens/bus-driver.js') : p.role === 'parent' ? import('./screens/bus-parent.js') : import('./screens/bus-admin.js')),
  },
  { pattern: '/fees', roles: ['admin', 'accountant', 'parent'], load: () => import('./screens/fees-invoices.js') },
  { pattern: '/fees/invoice/:id', roles: ['admin', 'accountant', 'parent'], load: () => import('./screens/fees-invoices.js') },
  { pattern: '/fees/structures', roles: ['admin', 'accountant'], load: () => import('./screens/fees-structures.js') },
  { pattern: '/fees/student/:studentId', roles: ['admin', 'accountant', 'parent'], load: () => import('./screens/fees-payment.js') },
  { pattern: '/print/receipt/:id', roles: ['admin', 'accountant', 'parent'], bare: true, load: () => import('./screens/receipt-print.js') },
  { pattern: '/reports', roles: ['admin', 'accountant'], load: () => import('./screens/reports.js') },
  { pattern: '/audit', roles: ['admin', 'accountant'], load: () => import('./screens/audit.js') },
  { pattern: '/settings', roles: ALL, demoRoles: ['admin'], load: () => import('./screens/settings.js') },
  // ---- real app only (the demo has no such routes) ----
  { pattern: '/privacy', roles: ALL, realOnly: true, load: () => import('./privacy.js') },
  { pattern: '/reports/settlements', roles: ['admin', 'accountant'], realOnly: true, load: () => import('./screens/settlements.js') },
  { pattern: '/fees/late-fees', roles: ['admin', 'accountant'], realOnly: true, load: () => import('./screens/late-fees.js') },
  { pattern: '/reminders', roles: ['admin', 'accountant', 'parent'], realOnly: true, load: () => import('./screens/reminders.js') },
  { pattern: '/invites', roles: ['admin', 'accountant'], realOnly: true, load: () => import('./screens/invites.js') },
  { pattern: '/print/invites', roles: ['admin', 'accountant'], realOnly: true, bare: true, load: () => import('./screens/invites-print.js') },
  { pattern: '/import', roles: ['admin'], realOnly: true, load: () => import('./screens/import-people.js') },
  { pattern: '/import/fees', roles: ['admin', 'accountant'], realOnly: true, load: () => import('./screens/import-fees.js') },
];

const ROLE_BLURB = {
  admin: 'Notices, calendar, attendance, learning and curriculum, fees overview, reports, audit, settings.',
  teacher: 'Own programme only: attendance, daily diary, observations and photos, progress, termly reports, parent messages.',
  accountant: 'Fee structures, invoices, payments, receipts, reports.',
  parent: 'Notices, messages, diary, learning (shared observations and termly reports), bus tracking, fees - for own children.',
  driver: 'Start / end the trip and share the bus position.',
};

let shell = null;
let shellFor = null;
let token = 0;
let cleanups = [];
let changeFns = new Set();
let quotaErr = null;
let recovering = false;

onQuotaError((e) => { quotaErr = e; refreshBanners(); });

function runCleanups() {
  cleanups.forEach((f) => { try { f(); } catch { /* ignore */ } });
  cleanups = [];
  changeFns = new Set();
}

// ---- banners ---------------------------------------------------------------
function corruptKeys() {
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('montessori.db.corrupt.')) keys.push(k);
    }
    return keys;
  } catch { return []; }
}

let reconcileFailing = 0;
async function checkReconcile() {
  const p = api.session.current();
  if (!p || !(p.role === 'admin' || p.role === 'accountant')) { reconcileFailing = 0; return; }
  try {
    const r = await api.fees.reconcile();
    reconcileFailing = (r?.checks || []).filter((c) => !c.ok).length;
  } catch (e) { reconcileFailing = -1; console.error(e); } // -1 = could not be computed: never silently "healthy"
}

function refreshBanners() {
  if (!shell) return;
  const parts = [];
  if (!REAL && quotaErr) {
    parts.push(banner('bad', `<div class="row between"><span><strong>Browser storage is full - changes are not being saved.</strong> Export a JSON backup now, then free space (Settings).</span><span class="row"><button class="btn sm" data-act="export">Export JSON</button><a class="btn sm" href="#/settings">Settings</a></span></div>`));
  }
  const ck = REAL ? [] : corruptKeys(); // browser-storage recovery is a demo-only concern
  if (ck.length) {
    parts.push(banner('warn', `<div class="row between"><span><strong>A damaged copy of earlier data was preserved</strong> (${ck.length}). Nothing was deleted.</span><a class="btn sm" href="#/settings">Review in Settings</a></div>`));
  }
  if (reconcileFailing === -1) {
    parts.push(banner('bad', `<div class="row between"><span><strong>Money reconciliation could not be computed.</strong> The fee data may be malformed.</span><a class="btn sm" href="#/reports?tab=reconcile">Details</a></div>`));
  } else if (reconcileFailing) {
    parts.push(banner('bad', `<div class="row between"><span><strong>Money reconciliation: ${reconcileFailing} check${reconcileFailing === 1 ? '' : 's'} failing.</strong></span><a class="btn sm" href="#/reports?tab=reconcile">View</a></div>`));
  }
  shell.banners.innerHTML = parts.join('');
}

async function exportJsonNow() {
  const r = await attempt(() => api.admin.exportJson());
  if (r.ok) downloadText(`montessori-demo-backup_${new Date().toISOString().slice(0, 10)}.json`, r.value, 'application/json');
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act="export"]');
  if (b && b.closest('.banners')) exportJsonNow();
});

// ---- badges (unread / pending) -----------------------------------------------
function computeBadges() {
  const p = api.session.current();
  const out = {};
  const db = api.getDb();
  if (!p || !db) return out;
  if (p.role === 'parent') {
    const rec = (db.noticeReceipts || []).filter((r) => r.guardianId === p.guardianId);
    const noticeById = new Map((db.notices || []).map((n) => [n.id, n]));
    out['/notices'] = rec.filter((r) => !r.readAt || (noticeById.get(r.noticeId)?.requiresAck && !r.ackAt)).length;
    const myThreads = new Set((db.threads || []).filter((t) => t.guardianId === p.guardianId).map((t) => t.id));
    out['/messages'] = (db.messages || []).filter((m) => myThreads.has(m.threadId) && m.senderRole !== 'parent' && !m.readAt).length;
  } else if (p.role === 'teacher') {
    const mine = new Set((db.threads || []).filter((t) => (p.programIds || []).includes(t.programId)).map((t) => t.id));
    out['/messages'] = (db.messages || []).filter((m) => mine.has(m.threadId) && m.senderRole === 'parent' && !m.readAt).length;
  }
  return out;
}

// The store can become unreadable after startup (another tab cleared or corrupted it): show recovery, never crash.
async function enterRecovery(err) {
  if (recovering) return;
  recovering = true;
  token += 1;
  runCleanups();
  runner.stop('Trip recording stopped: saved data became unreadable.');
  let message = err?.message;
  if (!message) { try { message = (await api.admin.storageInfo()).lastError; } catch { /* ignore */ } }
  renderRecovery({ code: 'STORAGE_CORRUPT', message: message || 'The saved data became unreadable while the app was open.' });
}

function onDbChange() {
  if (recovering) return;
  if (!api.getDb()) {
    if (REAL) { if (gateOk) { gateOk = false; renderRoute(); } return; } // signed out elsewhere, or the data could not be loaded: re-check
    enterRecovery(); return;
  }
  // the quota warning clears itself once a write has succeeded again
  if (quotaErr) api.admin.storageInfo().then((i) => { if (i && !i.writeFailed) { quotaErr = null; refreshBanners(); } }).catch(() => {});
  if (shell) {
    setBadges(root, computeBadges());
    checkReconcile().then(refreshBanners);
    refreshBanners();
  }
  changeFns.forEach((f) => { try { f(); } catch (e) { console.error(e); } });
}

// ---- screens ---------------------------------------------------------------
function makeCtx(persona, el, params, query, route) {
  return {
    api, persona, params, query, el,
    get db() { return api.getDb(); },
    go, setQuery, href,
    toast,
    onChange: (fn) => { changeFns.add(fn); },
    cleanup: (fn) => { cleanups.push(fn); },
    rerender: () => renderRoute({ keepScroll: true }),
  };
}

function showInto(el, html) { el.innerHTML = html; }

// ---- real app: sign-in, invite, consent gate -----------------------------------------
let gateOk = false;

async function signOutNow() {
  if (runner.isRunning()) runner.stop('Trip recording stopped because you signed out.');
  await attempt(() => api.auth.signOut());
  clearSlips(); // issued invite codes are shown once and must not outlive the sign-in that issued them
  gateOk = false; shell = null; shellFor = null; token += 1; runCleanups();
  document.title = 'School app';
  location.hash = '';
  renderRoute();
}

// Returns true when the person is signed in, linked and has given the required consent; otherwise draws the right screen.
async function gate() {
  if (!REAL || gateOk) return true;
  const my = ++token;
  runCleanups();
  shell = null; shellFor = null;
  const retry = () => { gateOk = false; renderRoute(); };
  let st;
  try { st = await api.auth.status(); } catch (e) { renderBlocked(root, 'unavailable', { error: e, onRetry: retry, onSignOut: signOutNow }); return false; }
  if (my !== token) return false;
  if (st.state !== 'active') clearSlips(); // signed out (also by expiry) or not usable: nothing issued earlier stays in memory
  const again = () => { gateOk = false; renderRoute(); };
  switch (st.state) {
    case 'signedOut': renderLogin(root, { onDone: again }); return false;
    case 'unlinked': renderInvite(root, { email: st.email, onDone: again, onSignOut: signOutNow }); return false;
    case 'pending': renderBlocked(root, 'pending', { email: st.email, onRetry: retry, onSignOut: signOutNow }); return false;
    case 'withdrawn': renderBlocked(root, 'withdrawn', { email: st.email, onRetry: retry, onSignOut: signOutNow }); return false;
    case 'revoked': renderBlocked(root, 'revoked', { email: st.email, onRetry: retry, onSignOut: signOutNow }); return false;
    case 'active': break;
    default: renderBlocked(root, 'unavailable', { error: new Error(`Unexpected account state: ${st.state}`), onRetry: retry, onSignOut: signOutNow }); return false;
  }
  const persona = api.session.current();
  if (!persona || !api.getDb()) { renderBlocked(root, 'unavailable', { email: st.email, onRetry: retry, onSignOut: signOutNow }); return false; }
  if (persona.role === 'parent') {
    let cs;
    try { cs = await api.consent.status(); } catch (e) { renderBlocked(root, 'unavailable', { email: st.email, error: e, onRetry: retry, onSignOut: signOutNow }); return false; }
    if (my !== token) return false;
    if (!cs?.purposes?.app_account?.given) { renderConsent(root, { status: cs, children: (persona.studentIds || []).map((id) => api.getDb().students.find((s) => s.id === id)).filter(Boolean).map((s) => ({ id: s.id, firstName: s.firstName })), photoMonths: api.getDb().school?.retention?.photosMonthsAfterLeaving ?? null, onDone: again, onSignOut: signOutNow }); return false; }
    // a parent who already chose notifications keeps them working across browser clean-ups (no prompt, no new consent)
    if (cs.purposes.push?.given) Promise.resolve().then(() => api.push.vapidPublicKey()).then((vapidKey) => push.keepAlive({ vapidKey, send: (j) => api.push.subscribe(j) })).catch(() => {});
  }
  gateOk = true;
  return true;
}

async function renderRoute({ keepScroll = false } = {}) {
  if (recovering) return;
  if (REAL) {
    if (!(await gate())) return;
  } else if (!api.getDb()) { enterRecovery(); return; }
  const my = ++token;
  const scrollY = keepScroll ? window.scrollY : 0;
  runCleanups();
  const persona = api.session.current();
  if (!persona) { renderChooser(); return; }

  const { path, query } = parseHash();
  if (path === '/') { go('/home'); return; }
  const m = matchRoute(ROUTES, path);
  if (m && m.route.realOnly && !REAL) {
    ensureShell(persona);
    markActive(root, path);
    shell.screen.innerHTML = `<div class="stack">${empty('Not part of the demo', 'This page exists only in the real school app.')}<a class="btn" href="#/home">Go home</a></div>`;
    return;
  }

  // a bare (print) page must pass the same role check as any other screen before it draws anything
  if (m?.route.bare && !((!REAL && m.route.demoRoles) || m.route.roles).includes(persona.role)) {
    shell = null; shellFor = null;
    root.innerHTML = `<div class="main"><div class="stack">${empty('Not available for this persona', `The ${persona.label} persona cannot open this page.`)}<a class="btn" href="#/home">Go home</a></div></div>`;
    return;
  }

  // bare routes (print) render without chrome
  if (m?.route.bare) {
    shell = null; shellFor = null;
    root.innerHTML = '<div id="screen" class="bare-screen" style="padding:14px"></div>';
    const el = root.querySelector('#screen');
    await mountScreen(m, persona, el, query, my);
    return;
  }

  ensureShell(persona);
  markActive(root, path);
  const el = document.createElement('div');
  shell.screen.replaceChildren(el);

  if (!m) { showInto(el, `<div class="stack">${empty('Page not found', path)}<a class="btn" href="#/home">Go home</a></div>`); return; }
  if (!((!REAL && m.route.demoRoles) || m.route.roles).includes(persona.role)) {
    showInto(el, `<div class="stack">${empty('Not available for this persona', `The ${persona.label} persona cannot open this page.`)}<a class="btn" href="#/home">Go home</a></div>`);
    return;
  }
  await mountScreen(m, persona, el, query, my);
  if (my === token && keepScroll) window.scrollTo(0, scrollY);
  else if (my === token) window.scrollTo(0, 0);
}

async function mountScreen(m, persona, el, query, my) {
  try {
    const mod = await m.route.load(persona);
    if (my !== token) return;
    const ctx = makeCtx(persona, el, m.params, query, m.route);
    await mod.render(ctx);
  } catch (e) {
    if (my !== token) return;
    console.error(e);
    if (e?.code === 'STORAGE_CORRUPT') { enterRecovery(e); return; }
    el.innerHTML = `<div class="stack">${banner('bad', `<strong>This screen failed to load.</strong> ${esc(errMessage(e))}`)}<a class="btn" href="#/home">Go home</a></div>`;
  }
}

function ensureShell(persona) {
  if (shell && shellFor === persona.id && root.contains(shell.screen)) return;
  const db = api.getDb();
  if (REAL) {
    shell = renderShell(root, { school: db.school, current: persona, real: true });
    if (db.school?.name) document.title = db.school.name;
    shell.signOut.addEventListener('click', signOutNow);
  } else {
    shell = renderShell(root, { school: db.school, personas: curatePersonas(api.session.personas(), db), current: persona });
    shell.select.addEventListener('change', async () => {
      if (runner.isRunning()) runner.stop('Trip recording stopped because the persona was switched.');
      await attempt(() => api.session.set(shell.select.value));
      shell = null; shellFor = null;
      go('/home');
    });
  }
  shellFor = persona.id;
  setBadges(root, computeBadges());
  checkReconcile().then(refreshBanners);
  refreshBanners();
}

// ---- persona chooser -----------------------------------------------------------
function renderChooser() {
  shell = null; shellFor = null;
  const all = api.session.personas();
  const { featured, others } = curatePersonas(all, api.getDb());
  const personas = featured;
  root.innerHTML = `<div class="main" style="max-width:720px">
    <h1>${esc(api.getDb().school?.name || 'School app')}</h1>
    <p class="muted">Prototype with fake data. Choose who you want to be - you can switch any time from the top bar.</p>
    <div class="grid cols-2">${personas.map((p) => `
      <button class="card" data-persona="${esc(p.id)}" style="text-align:left;cursor:pointer;font:inherit;color:inherit">
        <h3>${esc(p.tag)}</h3><div class="muted" style="font-size:.88rem">${esc(ROLE_BLURB[p.role] || '')}</div><small>${esc(p.label.replace(/^[^-]*- /, ''))}</small>
      </button>`).join('')}
    </div>
    <label class="field" style="margin-top:16px"><span class="lbl">Or anyone else in the school</span><select id="pick-other"><option value="">Choose a person...</option>${others.map((p) => `<option value="${esc(p.id)}">${esc(p.label)}</option>`).join('')}</select></label></div>`;
  root.querySelector('#pick-other').addEventListener('change', async (e) => {
    if (!e.target.value) return;
    if (runner.isRunning()) runner.stop('Trip recording stopped because the persona was switched.');
    await attempt(() => api.session.set(e.target.value));
    if (parseHash().path === '/') go('/home'); else renderRoute();
  });
  root.querySelectorAll('[data-persona]').forEach((b) => b.addEventListener('click', async () => {
    if (runner.isRunning()) runner.stop('Trip recording stopped because the persona was switched.');
    await attempt(() => api.session.set(b.dataset.persona));
    if (!parseHash().path || parseHash().path === '/') go('/home'); else renderRoute();
  }));
}

// ---- recovery (corrupt store) ----------------------------------------------------
function renderRecovery(err) {
  shell = null; shellFor = null;
  const keys = corruptKeys();
  root.innerHTML = `<div class="main" style="max-width:640px"><div class="stack">
    <h1>Saved data could not be read</h1>
    ${banner('bad', `<strong>${esc(err?.code || 'STORAGE_CORRUPT')}</strong> - ${esc(errMessage(err))}`)}
    <p>The unreadable copy has been kept in this browser${keys.length ? ` (<code>${esc(keys[keys.length - 1])}</code>)` : ''}. Nothing was deleted. Choose how to continue:</p>
    <div class="card stack">
      <button class="btn primary" id="rec-reset">Reset to demo data</button>
      <label class="field"><span class="lbl">Or import a JSON backup</span><input type="file" id="rec-file" accept="application/json,.json"></label>
      <div class="err" id="rec-err"></div>
    </div></div></div>`;
  const errEl = root.querySelector('#rec-err');
  root.querySelector('#rec-reset').addEventListener('click', async () => {
    try { await api.admin.resetToSeed(); location.reload(); } catch (e) { errEl.textContent = errMessage(e); }
  });
  root.querySelector('#rec-file').addEventListener('change', async (ev) => {
    const f = ev.target.files[0];
    if (!f) return;
    try { await api.admin.importJson(await readFileText(f)); location.reload(); } catch (e) { errEl.textContent = errMessage(e); } // read failures land here too
  });
}

// ---- boot ---------------------------------------------------------------------------
async function boot() {
  try {
    await api.ready();
  } catch (e) {
    console.error(e);
    if (e?.code === 'STORAGE_CORRUPT') { renderRecovery(e); return; }
    root.innerHTML = `<div class="main">${banner('bad', `<strong>The app could not start.</strong> ${esc(errMessage(e))}`)}</div>`;
    return;
  }
  api.subscribe(onDbChange);
  startRouter(() => renderRoute());
}

boot();
