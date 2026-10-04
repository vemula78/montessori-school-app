// App chrome: topbar + persona switcher, left rail / strip nav (staff roles) or bottom tab bar (parent, driver).
import { esc, icon } from './components.js';

const N = {
  home: { path: '/home', label: 'Home', icon: 'home' },
  notices: { path: '/notices', label: 'Notices', icon: 'bell' },
  messages: { path: '/messages', label: 'Messages', icon: 'chat', short: 'Chat' },
  calendar: { path: '/calendar', label: 'Calendar', icon: 'calendar' },
  attendance: { path: '/attendance', label: 'Attendance', icon: 'check' },
  diary: { path: '/diary', label: 'Daily diary', icon: 'book', short: 'Diary' },
  bus: { path: '/bus', label: 'Bus', icon: 'bus' },
  trip: { path: '/bus', label: 'Trip', icon: 'bus' },
  fees: { path: '/fees', label: 'Fees', icon: 'rupee' },
  structures: { path: '/fees/structures', label: 'Fee structures', icon: 'receipt' },
  reports: { path: '/reports', label: 'Reports', icon: 'chart' },
  audit: { path: '/audit', label: 'Audit log', icon: 'shield' },
  settings: { path: '/settings', label: 'Settings', icon: 'gear' },
  // real app only (see REAL_EXTRA)
  invites: { path: '/invites', label: 'Invite codes', icon: 'users' },
  importData: { path: '/import', label: 'Import data', icon: 'upload' },
};

export const NAV = {
  admin: ['home', 'notices', 'messages', 'calendar', 'attendance', 'diary', 'bus', 'fees', 'structures', 'reports', 'audit', 'settings'],
  teacher: ['home', 'notices', 'messages', 'calendar', 'attendance', 'diary'],
  accountant: ['home', 'fees', 'structures', 'reports', 'calendar', 'audit'],
  parent: ['home', 'notices', 'messages', 'diary', 'bus', 'fees'],
  driver: ['home', 'trip', 'calendar'],
};

// Extra rail items in the real app, inserted before the named existing item. The demo's menus are left exactly as they were.
const REAL_EXTRA = {
  admin: [['invites', 'audit'], ['importData', 'audit']],
  accountant: [['invites', 'audit']],
};

export const isTouchRole = (role) => role === 'parent' || role === 'driver';
export function navFor(role, real = false) {
  const keys = [...(NAV[role] || ['home'])];
  if (real) {
    for (const [add, before] of REAL_EXTRA[role] || []) {
      const at = keys.indexOf(before);
      keys.splice(at < 0 ? keys.length : at, 0, add);
    }
  }
  return keys.map((k) => N[k]);
}

function isActive(item, path) {
  if (item.path === '/home') return path === '/home' || path === '/';
  if (item.path === '/fees') return path === '/fees' || (path.startsWith('/fees/') && !path.startsWith('/fees/structures'));
  return path === item.path || path.startsWith(item.path + '/');
}

// The 6 demo personas first (named for what they demonstrate), everyone else under "All people".
export function curatePersonas(personas, db) {
  const progName = (id) => db.programs.find((p) => p.id === id)?.name;
  const names = (p) => (p.programIds || []).map(progName);
  const hasBus = (p) => (p.studentIds || []).some((id) => db.students.find((s) => s.id === id)?.routeId);
  const parents = personas.filter((p) => p.role === 'parent');
  const busRoute = (p) => (p?.studentIds || []).map((id) => db.students.find((s) => s.id === id)?.routeId).find(Boolean);
  const siblings = parents.find((p) => p.studentIds.length >= 2 && ['Primary A', 'Primary B'].every((n) => names(p).includes(n))) || parents.find((p) => p.studentIds.length >= 2 && hasBus(p)) || parents.find((p) => p.studentIds.length >= 2);
  const singles = parents.filter((p) => p.studentIds.length === 1);
  // keep the demo coherent: the featured driver drives the route the featured parents' children ride
  const single = singles.find((p) => hasBus(p) && busRoute(p) === busRoute(siblings)) || singles.find(hasBus) || singles[0];
  const driver = personas.find((p) => p.role === 'driver' && busRoute(siblings) && (p.routeIds || []).includes(busRoute(siblings))) || personas.find((p) => p.role === 'driver');
  const picks = [
    ['Principal', personas.find((p) => p.role === 'admin')],
    ['Teacher, Primary A', personas.find((p) => p.role === 'teacher' && p.programIds.length === 1 && progName(p.programIds[0]) === 'Primary A') || personas.find((p) => p.role === 'teacher')],
    ['Accountant', personas.find((p) => p.role === 'accountant')],
    ['Parent with siblings', siblings],
    ['Parent, single child', single],
    ['Driver', driver],
  ].filter(([, p]) => p);
  const featured = picks.map(([tag, p]) => ({ ...p, tag, label: `${tag} - ${p.label.replace(/^[^\u2014]*\u2014\s*/, '')}` }));
  const ids = new Set(featured.map((p) => p.id));
  return { featured, others: personas.filter((p) => !ids.has(p.id)) };
}

const ROLE_TAG = { admin: 'Principal', teacher: 'Teacher', accountant: 'Accountant', driver: 'Driver', parent: 'Parent' };
const initialsOf = (label) => esc(String(label || '?').replace(/\(.*$/, '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?');

// Real app: no persona switcher. The person is whoever signed in; the top bar offers Settings and Sign out.
function personaBlock(personas, current, real) {
  if (real) {
    const name = String(current?.label || '').replace(/^[^\u2014]*\u2014\s*/, '').replace(/\s*\(.*$/, '');
    return `<div class="profile">
        <a class="who" href="#/settings" aria-label="Settings and privacy for ${esc(name || ROLE_TAG[current?.role] || 'you')}"><span class="avatar">${initialsOf(name)}</span><span class="who-text"><strong>${esc(name || DASHCHAR)}</strong><small>${esc(ROLE_TAG[current?.role] || '')}</small></span></a>
        <button class="btn sm" id="signout" type="button">Sign out</button></div>`;
  }
  return `<div class="persona">
        <label for="persona-select">Viewing as</label>
        <select id="persona-select" aria-label="Switch demo persona">
          <optgroup label="Demo personas">${personas.featured.map((p) => `<option value="${esc(p.id)}"${p.id === current?.id ? ' selected' : ''}>${esc(p.label)}</option>`).join('')}</optgroup>
          <optgroup label="All people">${personas.others.map((p) => `<option value="${esc(p.id)}"${p.id === current?.id ? ' selected' : ''}>${esc(p.label)}</option>`).join('')}</optgroup>
        </select>
      </div>`;
}
const DASHCHAR = '\u2014';

export function renderShell(root, { school, personas, current, real = false }) {
  const role = current?.role;
  const touch = isTouchRole(role);
  const items = navFor(role, real);
  const link = (i, cls = '') => `<a href="#${esc(i.path)}" data-path="${esc(i.path)}" data-key="${esc(i.path)}">${icon(i.icon)}<span>${esc(touch ? (i.short || i.label) : i.label)}</span><span class="nbadge badge clay hide" data-badge="${esc(i.path)}"></span></a>`;
  root.innerHTML = `
  <div class="shell ${touch ? 'touch' : 'staff'}">
    <header class="topbar no-print">
      <a class="brand" href="#/home"><span class="logo" aria-hidden="true"></span><span class="name">${esc(school?.name || 'School')}</span></a>
      <span class="spacer"></span>
      ${personaBlock(personas, current, real)}
    </header>
    ${touch ? '' : `<nav class="stripnav no-print" aria-label="Main">${items.map((i) => link(i)).join('')}</nav>`}
    <div class="body">
      ${touch ? '' : `<nav class="rail no-print" aria-label="Main">${items.map((i) => link(i)).join('')}</nav>`}
      <main class="main" id="main">
        <div class="banners" id="banners"></div>
        <div id="screen"></div>
      </main>
    </div>
    ${touch ? `<nav class="tabbar no-print" aria-label="Main">${items.map((i) => link(i)).join('')}</nav>` : ''}
  </div>`;
  return {
    screen: root.querySelector('#screen'),
    banners: root.querySelector('#banners'),
    select: root.querySelector('#persona-select'),
    signOut: root.querySelector('#signout'),
  };
}

export function markActive(root, path) {
  root.querySelectorAll('nav a[data-path]').forEach((a) => {
    const item = { path: a.dataset.path };
    if (isActive(item, path)) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
}

export function setBadges(root, counts) {
  root.querySelectorAll('[data-badge]').forEach((b) => {
    const n = counts[b.dataset.badge] || 0;
    b.textContent = n ? String(n) : '';
    b.classList.toggle('hide', !n);
  });
}
