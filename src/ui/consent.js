// Consent screen (shown to a parent until the required account consent is on record).
import { api } from '../api/index.js';
import { esc, banner, errMessage } from './components.js';
import { PURPOSES, PRIVACY_VERSION, noticeHtml, noticeHash } from './privacy.js';

const frame = (inner) => `<div class="auth-wrap"><div class="auth-card stack">
  <div class="auth-logo" aria-hidden="true"><span class="logo">A</span></div>${inner}</div></div>`;

/** @param {HTMLElement} root @param {{status?:object, onDone:()=>void, onSignOut:()=>void}} o */
export function renderConsent(root, { status, onDone, onSignOut }) {
  const already = (k) => !!status?.purposes?.[k]?.given;
  root.innerHTML = frame(`<h1>Your privacy</h1>
    <p class="muted">Before you continue, please read how the school uses your family&rsquo;s information and choose what you agree to. Nothing is ticked for you.</p>
    <details class="card tight"><summary style="cursor:pointer;font-weight:800">Read the privacy notice (${esc(PRIVACY_VERSION)})</summary><div class="prose" style="margin-top:8px">${noticeHtml()}</div></details>
    <form id="cs-form" class="stack" novalidate>
      ${PURPOSES.map((p) => `<label class="card tight consent-row"><input type="checkbox" name="purpose" value="${esc(p.key)}"${already(p.key) ? ' checked' : ''}${p.key === 'app_account' ? ' data-required="1"' : ''}>
        <span><span class="item-title">${esc(p.title)}</span> <small>${p.required ? '(required to use the app)' : '(optional)'}</small><br><small>${esc(p.detail)}</small></span></label>`).join('')}
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
    const errEl = root.querySelector('#cs-err');
    go.disabled = true; errEl.textContent = '';
    try {
      const textHash = await noticeHash();
      await api.consent.give({ purposes, version: PRIVACY_VERSION, ...(textHash ? { textHash } : {}) });
      onDone();
    } catch (ex) { errEl.textContent = errMessage(ex); go.disabled = false; }
  });
}
