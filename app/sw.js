// Service worker for the real app: push notifications, notification taps, and a copy of the app's OWN code so it
// still opens on patchy data.
// Children's data is never stored here: only GET requests for this site's own files (the page, scripts, styles,
// fonts, icons) are handled. The school database, its functions and photo storage are other origins and pass by
// untouched, as do map tiles and the payment window; so a fee or bus update can never come from a stored copy.
// The code is network-first: whatever the network returns is used and replaces the stored copy, so an update is
// picked up on the next load. The stored copy answers only when the network fails or is very slow. Changing VERSION
// drops every stored copy on the next start.
// Push payload (JSON): { title, body, url, tag }.

const VERSION = '2026-10-24';
const CACHE = `school-app-shell-${VERSION}`;
const SLOW_MS = 4000; // after this, a stored copy (if there is one) answers; the network answer still refreshes it
const OWN_FILE = /\.(?:js|css|woff2|png|svg|webmanifest|html)$/;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil((async () => {
  for (const k of await caches.keys()) if (k.startsWith('school-app-shell-') && k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));

function isOwnCode(req) {
  if (req.method !== 'GET') return false;
  let u;
  try { u = new URL(req.url); } catch { return false; }
  if (u.origin !== self.location.origin || u.search) return false;
  return req.mode === 'navigate' || OWN_FILE.test(u.pathname);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (!isOwnCode(req)) return; // the browser fetches it as usual
  const net = fetch(req).then(async (res) => {
    if (res.ok && res.type === 'basic') await (await caches.open(CACHE)).put(req, res.clone());
    return res;
  });
  event.waitUntil(net.catch(() => {}));
  event.respondWith((async () => {
    const slow = new Promise((resolve) => setTimeout(resolve, SLOW_MS, null));
    try {
      const first = await Promise.race([net, slow]);
      if (first) return first;
    } catch { /* offline: try the stored copy */ }
    const stored = await (await caches.open(CACHE)).match(req);
    return stored || net; // nothing stored yet: the network's answer (or its error) after all
  })());
});

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data ? event.data.text() : '' }; }
  // Browsers (iOS especially) require every push to show a notification, so always show one.
  event.waitUntil(self.registration.showNotification(String(data.title || 'School app'), {
    body: String(data.body || ''),
    tag: data.tag ? String(data.tag) : undefined,
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    data: { url: typeof data.url === 'string' ? data.url : '' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  // Resolve against the app scope and refuse anything that leaves the app's own origin.
  let target = new URL(self.registration.scope);
  try {
    const u = new URL(event.notification.data?.url || '', self.registration.scope);
    if (u.origin === self.location.origin) target = u;
  } catch { /* keep the app home */ }
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = wins.find((c) => c.url.startsWith(self.registration.scope));
    if (open) {
      try { await open.focus(); if ('navigate' in open && target.href !== open.url) await open.navigate(target.href); } catch { /* focus is enough */ }
      return;
    }
    await self.clients.openWindow(target.href);
  })());
});
