// "Install the school app". Android Chrome (and desktop Chrome/Edge) offer installation through the beforeinstallprompt
// event, which fires once per page load: app/boot.js imports this module before the app code loads so the event is not
// missed. It is held back (the browser's own mini bar would show at a random moment) and replayed from a tap.
// iPhone has no such event: it gets the Add to Home Screen steps. Nothing shows once the app runs installed.
import { esc } from './components.js';
import { IOS_STEPS, isIos, isStandalone } from './push.js';

const LATER_KEY = 'school.install.later';
let deferred = null;
const listeners = new Set();
const changed = () => { for (const f of [...listeners]) { try { f(); } catch { /* one card failing does not stop the others */ } } };
if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; changed(); });
  window.addEventListener('appinstalled', () => { deferred = null; changed(); });
}

const isAndroid = () => typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent || '');
/** 'installed' | 'prompt' (a tap installs) | 'ios' (Share > Add to Home Screen) | 'android-menu' (Chrome's menu) | 'none' */
export function installState() {
  if (typeof window === 'undefined') return 'none';
  if (isStandalone()) return 'installed';
  if (deferred) return 'prompt';
  if (isIos()) return 'ios';
  if (isAndroid()) return 'android-menu';
  return 'none';
}

/** Shows the browser's install dialog (from a tap) → 'accepted' | 'dismissed' | 'unavailable'. A prompt can be used once. */
export async function install() {
  const e = deferred;
  if (!e) return 'unavailable';
  deferred = null;
  e.prompt();
  let outcome = 'dismissed';
  try { outcome = (await e.userChoice).outcome; } catch { /* treated as dismissed */ }
  changed();
  return outcome;
}

export const ANDROID_MENU_STEPS = [
  'Open this page in Chrome (not inside WhatsApp or another app).',
  'Tap the ⋮ menu at the top right.',
  'Tap “Install app” (or “Add to Home screen”), then Install.',
];
const WHY = 'It then opens from your home screen like any other app, and notifications arrive more reliably.';

/** The card for a state ('' when there is nothing to offer). later: show the "Not now" button. */
export function installCardHtml(state, { later = false } = {}) {
  const steps = state === 'ios' ? IOS_STEPS.slice(0, 3) : state === 'android-menu' ? ANDROID_MENU_STEPS : null;
  if (state !== 'prompt' && !steps) return '';
  const laterBtn = later ? '<button class="btn sm" data-install-later>Not now</button>' : '';
  return `<div class="card stack"><h2>Install the school app</h2><p style="margin:0">${esc(WHY)}</p>
    ${steps ? `<ol style="margin:0;padding-left:20px">${steps.map((t) => `<li>${esc(t)}</li>`).join('')}</ol>${laterBtn ? `<div class="row">${laterBtn}</div>` : ''}`
    : `<div class="row"><button class="btn primary" data-install>Install the app</button>${laterBtn}</div>`}</div>`;
}

const putOff = () => { try { return localStorage.getItem(LATER_KEY) === '1'; } catch { return false; } };

/** Draws the card into host and redraws it when the browser offers or completes installation. dismissible: the home card. */
export function mountInstall(host, { dismissible = false, cleanup = null } = {}) {
  const draw = () => {
    if (host.isConnected === false) return;
    host.innerHTML = dismissible && putOff() ? '' : installCardHtml(installState(), { later: dismissible });
    host.querySelector('[data-install]')?.addEventListener('click', () => { install().then(draw); });
    host.querySelector('[data-install-later]')?.addEventListener('click', () => { try { localStorage.setItem(LATER_KEY, '1'); } catch { /* shown again next time */ } draw(); });
  };
  draw();
  listeners.add(draw);
  const off = () => listeners.delete(draw);
  if (cleanup) cleanup(off);
  return off;
}
