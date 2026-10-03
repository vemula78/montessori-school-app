// Web push on this device: support check, permission prompt, subscription, and the iPhone "Add to Home Screen" rule.
// The permission prompt MUST be raised straight from a tap (iOS refuses otherwise), so enable() takes the
// already-fetched public key and asks for permission before doing any other awaited work.

// Remembers, on this device only, that the person turned notifications off, so start-up never silently turns them back on.
const OPTOUT_KEY = 'school.push.optout';
const optedOut = () => { try { return localStorage.getItem(OPTOUT_KEY) === '1'; } catch { return false; } };
const setOptOut = (on) => { try { if (on) localStorage.setItem(OPTOUT_KEY, '1'); else localStorage.removeItem(OPTOUT_KEY); } catch { /* not persisted: worst case start-up re-checks */ } };

const isIos = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;

/** What this browser can do, and the plain-language reason when it cannot. */
export function support() {
  const ios = isIos();
  const standalone = isStandalone();
  if (!window.isSecureContext) return { ok: false, code: 'insecure', ios, standalone, message: 'Notifications need a secure (https) page.' };
  if (ios && !standalone) {
    return { ok: false, code: 'ios-install', ios, standalone, message: 'On iPhone and iPad, notifications work only after the app is added to the Home Screen.' };
  }
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return { ok: false, code: 'unsupported', ios, standalone, message: ios ? 'This iOS version does not support notifications for web apps (iOS 16.4 or newer is needed).' : 'This browser does not support notifications.' };
  }
  return { ok: true, ios, standalone };
}

export const IOS_STEPS = [
  'Open this page in Safari (not inside another app).',
  'Tap the Share button (the square with an arrow) at the bottom of the screen.',
  'Scroll down and tap “Add to Home Screen”, then tap Add.',
  'Open the app from the new Home Screen icon (not from Safari), come back to Settings, and turn notifications on.',
];

async function worker() {
  const url = new URL('sw.js', document.baseURI);
  const scope = new URL('./', document.baseURI).href;
  await navigator.serviceWorker.register(url, { scope, updateViaCache: 'none' });
  return navigator.serviceWorker.ready;
}

function keyBytes(b64url) {
  const pad = '='.repeat((4 - (b64url.length % 4)) % 4);
  const raw = atob((b64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** { support, permission: 'default'|'granted'|'denied'|'n/a', subscribed:boolean, endpoint } */
export async function state() {
  const s = support();
  if (!s.ok) return { support: s, permission: 'n/a', subscribed: false, endpoint: null };
  let sub = null;
  try { const reg = await navigator.serviceWorker.getRegistration(new URL('./', document.baseURI).href); sub = reg ? await reg.pushManager.getSubscription() : null; } catch { /* treated as not subscribed */ }
  return { support: s, permission: Notification.permission, subscribed: !!sub, endpoint: sub?.endpoint || null };
}

/**
 * Turn notifications on for this device.
 * @param {{vapidKey:string, giveConsent:()=>Promise<any>, send:(subscriptionJson:any)=>Promise<any>}} o
 */
export async function enable({ vapidKey, giveConsent, send }) {
  const s = support();
  if (!s.ok) throw Object.assign(new Error(s.message), { code: 'NOT_SUPPORTED' });
  if (!vapidKey) throw Object.assign(new Error('Notifications have not been set up for this school yet.'), { code: 'NOT_CONFIGURED' });
  const perm = await Notification.requestPermission(); // first await: still inside the tap
  if (perm !== 'granted') {
    throw Object.assign(new Error(perm === 'denied' ? 'Notifications are blocked for this site. Allow them in the browser or phone settings, then try again.' : 'Notification permission was not given.'), { code: 'PERMISSION' });
  }
  await giveConsent();
  const reg = await worker();
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(vapidKey) });
  await send(sub.toJSON());
  setOptOut(false);
  return sub.endpoint;
}

/** Turn notifications off for this device: the server first (so it stops sending), then the browser. */
export async function disable({ remove }) {
  const reg = await navigator.serviceWorker.getRegistration(new URL('./', document.baseURI).href);
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  if (!sub) return;
  await remove(sub.endpoint);
  await sub.unsubscribe();
  setOptOut(true);
}

/** Called at start-up in the real app: keeps the worker current; re-subscribes silently if the browser dropped it. */
export async function keepAlive({ vapidKey, send }) {
  const s = support();
  if (!s.ok || optedOut()) return;
  try {
    const reg = await worker();
    if (Notification.permission === 'granted' && vapidKey && !(await reg.pushManager.getSubscription())) {
      // permission was granted before but the subscription is gone (browser cleaned it up): restore it, no prompt needed
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(vapidKey) });
      await send(sub.toJSON());
    }
  } catch (e) { console.warn('push keep-alive failed', e); }
}
