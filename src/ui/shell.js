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
};

export const NAV = {
  admin: ['home', 'notices', 'messages', 'calendar', 'attendance', 'diary', 'bus', 'fees', 'structures', 'reports', 'audit', 'settings'],
  teacher: ['home', 'notices', 'messages', 'calendar', 'attendance', 'diary'],
  accountant: ['home', 'fees', 'structures', 'reports', 'calendar', 'audit'],
  parent: ['home', 'notices', 'messages', 'diary', 'bus', 'fees'],
  driver: ['home', 'trip', 'calendar'],
};

export const isTouchRole = (role) => role === 'parent' || role === 'driver';
export const navFor = (role) => (NAV[role] || ['home']).map((k) => N[k]);

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

export function renderShell(root, { school, personas, current }) {
  const role = current?.role;
  const touch = isTouchRole(role);
  const items = navFor(role);
  const link = (i, cls = '') => `<a href="#${esc(i.path)}" data-path="${esc(i.path)}" data-key="${esc(i.path)}">${icon(i.icon)}<span>${esc(touch ? (i.short || i.label) : i.label)}</span><span class="nbadge badge clay hide" data-badge="${esc(i.path)}"></span></a>`;
  root.innerHTML = `
  <div class="shell ${touch ? 'touch' : 'staff'}">
    <header class="topbar no-print">
      <a class="brand" href="#/home"><span class="logo" aria-hidden="true">A</span><span class="name">${esc(school?.name || 'School')}</span></a>
      <span class="spacer"></span>
      <div class="persona">
        <label for="persona-select">Viewing as</label>
        <select id="persona-select" aria-label="Switch demo persona">
          <optgroup label="Demo personas">${personas.featured.map((p) => `<option value="${esc(p.id)}"${p.id === current?.id ? ' selected' : ''}>${esc(p.label)}</option>`).join('')}</optgroup>
          <optgroup label="All people">${personas.others.map((p) => `<option value="${esc(p.id)}"${p.id === current?.id ? ' selected' : ''}>${esc(p.label)}</option>`).join('')}</optgroup>
        </select>
      </div>
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
