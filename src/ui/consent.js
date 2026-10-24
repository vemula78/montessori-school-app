// Consent screen (shown to a parent until the required account consent is on record).
import { api } from '../api/index.js';
import { esc, banner, errMessage } from './components.js';
import { PURPOSES, PRIVACY_VERSION, noticeHtml, noticeHash } from './privacy.js';
import * as push from './push.js';

const frame = (inner) => `<div class="auth-wrap"><div class="auth-card stack">
  <div class="auth-logo" aria-hidden="true"><span class="logo"></span></div>${inner}</div></div>`;

/** How long photos are kept, in words: the school's period once it is set, else on request. */
export const photoRetentionText = (months) => (Number.isInteger(months) && months > 0
  ? `The school deletes your child’s photos ${months} month${months === 1 ? '' : 's'} after your child leaves.`
  : 'The school has not yet set how long photos are kept after a child leaves; until it does, photos are deleted when you ask.');

/**
 * Photos are an optional choice, never ticked for the parent and never needed to continue. With more than one child
 * there is one box per child (siblings may differ); the choice is sent as perChild.
 * @param {HTMLElement} root
 * @param {{status?:object, children?:{id:string, firstName:string}[], photoMonths?:number|null, onDone:()=>void, onSignOut:()=>void}} o
 */
export function renderConsent(root, { status, children = [], photoMonths = null, onDone, onSignOut }) {
  const already = (k) => !!status?.purposes?.[k]?.given;
  const hasPhotos = (id) => (status?.byChild?.[id] || []).includes('photos');
  const photos = PURPOSES.find((p) => p.key === 'photos');
  const photoRows = children.length > 1
    ? children.map((c) => `<label class="check"><input type="checkbox" name="photos-child" value="${esc(c.id)}"${hasPhotos(c.id) ? ' checked' : ''}> Photos of ${esc(c.firstName)}</label>`).join('')
    : `<label class="check"><input type="checkbox" name="photos-child" value="${esc(children[0]?.id ?? '')}"${children[0] && hasPhotos(children[0].id) ? ' checked' : ''}> Yes, photos of my child</label>`;
  root.innerHTML = frame(`<h1>Your privacy</h1>
    <p class="muted">Before you continue, please read how the school uses your family&rsquo;s information and choose what you agree to. Nothing is ticked for you.</p>
    <details class="card tight"><summary style="cursor:pointer;font-weight:800">Read the privacy notice (${esc(PRIVACY_VERSION)})</summary><div class="prose" style="margin-top:8px">${noticeHtml()}</div></details>
    <form id="cs-form" class="stack" novalidate>
      ${PURPOSES.filter((p) => p.key !== 'photos').map((p) => `<label class="card tight consent-row"><input type="checkbox" name="purpose" value="${esc(p.key)}"${already(p.key) ? ' checked' : ''}${p.key === 'app_account' ? ' data-required="1"' : ''}>
        <span><span class="item-title">${esc(p.title)}</span> <small>${p.required ? '(required to use the app)' : '(optional)'}</small><br><small>${esc(p.detail)}</small></span></label>`).join('')}
      ${photos ? `<fieldset class="card tight" id="cs-photos" style="border:1px solid var(--line)"><legend class="item-title">${esc(photos.title)} <small>(optional)</small></legend>
        <small>${esc(photos.detail)}</small><br><small>${esc(photoRetentionText(photoMonths))}</small>
        <div class="stack">${photoRows}</div>${children.length > 1 ? '<small>You can choose differently for each child.</small>' : ''}</fieldset>` : ''}
      <div class="err" id="cs-err" role="alert"></div>
      <button class="btn primary block" type="submit" id="cs-go" disabled>I agree - continue</button>
      <button class="btn block ghost" type="button" id="cs-out">I do not agree - sign out</button>
    </form>
    <small class="muted">You can change optional choices, download your data or withdraw consent later in Settings.</small>`);
  const form = root.querySelector('#cs-form');
  const go = root.querySelector('#cs-go');
  const sync = () => { go.disabled = !form.querySelector('[data-required]').checked; };
  form.addEventListener('change', sync); sync();
  root.querySelector('#cs-out').addEventListener('click', onSignOut);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const purposes = [...form.querySelectorAll('input[name=purpose]:checked')].map((i) => i.value);
    if (!purposes.includes('app_account')) return;
    const perChild = {};
    for (const i of form.querySelectorAll('input[name=photos-child]:checked')) if (i.value) perChild[i.value] = ['photos'];
    const errEl = root.querySelector('#cs-err');
    go.disabled = true; errEl.textContent = '';
    try {
      const textHash = await noticeHash();
      await api.consent.give({ purposes, ...(Object.keys(perChild).length ? { perChild } : {}), version: PRIVACY_VERSION, ...(textHash ? { textHash } : {}) });
    } catch (ex) { errEl.textContent = errMessage(ex); go.disabled = false; return; }
    if (purposes.includes('push')) await renderPushStep(root, { onDone }); else onDone();
  });
}

/**
 * Consent to notifications only records the choice; this step switches them on for this phone. The permission prompt
 * must come straight from a tap (iOS), so the school's public key is fetched before the button is shown.
 * @param {HTMLElement} root
 * @param {{onDone:()=>void}} o
 */
export async function renderPushStep(root, { onDone }) {
  const s = push.support();
  if (!s.ok && s.code !== 'ios-install') { onDone(); return; } // this browser cannot: Settings explains why
  const vapidKey = s.ok ? await Promise.resolve().then(() => api.push.vapidPublicKey()).catch(() => null) : null;
  if (s.ok && !vapidKey) { onDone(); return; } // not set up for this school yet: nothing to switch on
  root.innerHTML = frame(`<h1>Notifications on this phone</h1>
    ${s.ok ? `<p class="muted">You chose notifications. Allow them on this phone so bus alerts, receipts and important notices reach you.</p>
      <div class="err" id="pn-err" role="alert"></div>
      <button class="btn primary block" type="button" id="pn-on">Allow notifications on this phone</button>`
    : `${banner('warn', esc(s.message))}<ol style="margin:0;padding-left:20px">${push.IOS_STEPS.map((t) => `<li>${esc(t)}</li>`).join('')}</ol>`}
    <button class="btn block ghost" type="button" id="pn-skip">${s.ok ? 'Not now' : 'Continue'}</button>
    <small class="muted">You can turn notifications on or off later in Settings.</small>`);
  root.querySelector('#pn-skip').addEventListener('click', () => { push.dismissNudge(); onDone(); }); // just answered: no banner straight after
  if (!s.ok) return;
  root.querySelector('#pn-on').addEventListener('click', async (e) => {
    const b = e.target;
    b.disabled = true;
    try {
      await push.enable({ vapidKey, giveConsent: async () => {}, send: (j) => api.push.subscribe(j) }); // consent is already on record
    } catch (ex) { root.querySelector('#pn-err').textContent = errMessage(ex); b.disabled = false; return; }
    onDone();
  });
}
