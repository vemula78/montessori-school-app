// Service worker for the real app: push notifications and notification taps ONLY.
// Deliberately no fetch handler and no cache: children's data must never be stored by a service worker,
// and a stale cached page must never hide a fee or bus update.
// Push payload (JSON): { title, body, url, tag }.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

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
