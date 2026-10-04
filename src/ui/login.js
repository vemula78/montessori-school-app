// Sign-in (email one-time code) and the "cannot continue" screens: pending approval, access removed, data unavailable.
import { api } from '../api/index.js';
import { esc, banner, errMessage, toast } from './components.js';
import { noticeHtml, PRIVACY_VERSION } from './privacy.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const frame = (inner) => `<div class="auth-wrap"><div class="auth-card stack">
  <div class="auth-logo" aria-hidden="true"><span class="logo"></span></div>${inner}</div></div>`;

/** @param {HTMLElement} root @param {{onDone:()=>void, message?:string}} o */
export function renderLogin(root, { onDone, message }) {
  let step = 'email';
  let email = '';
  let busy = false;
  let err = '';
  let cooldownUntil = 0;
  let timer = null;

  const draw = () => {
    clearInterval(timer);
    root.innerHTML = frame(step === 'email' ? `
      <h1>Sign in</h1>
      <p class="muted">Enter the email address the school has for you. We will email you a one-time code - there is no password to remember.</p>
      ${message ? banner('warn', esc(message)) : ''}
      <form id="lg-form" novalidate class="stack">
        <label class="field"><span class="lbl">Email address</span><input id="lg-email" name="email" type="email" inputmode="email" autocomplete="email" autocapitalize="off" autocorrect="off" spellcheck="false" required value="${esc(email)}"></label>
        <div class="err" id="lg-err" role="alert">${esc(err)}</div>
        <button class="btn primary block" type="submit"${busy ? ' disabled' : ''}>${busy ? 'Sending...' : 'Email me a code'}</button>
      </form>
      <details class="muted"><summary style="cursor:pointer;font-weight:700">Privacy notice (${esc(PRIVACY_VERSION)})</summary><div class="prose" style="margin-top:8px">${noticeHtml()}</div></details>`
      : `
      <h1>Enter your code</h1>
      <p class="muted">We sent a code to <strong>${esc(email)}</strong>. It can take a minute; check the spam folder too. The code works once.</p>
      <form id="lg-form" novalidate class="stack">
        <label class="field"><span class="lbl">Code from the email</span><input id="lg-code" class="code-input" name="code" inputmode="numeric" pattern="[0-9]*" autocomplete="one-time-code" maxlength="10" required></label>
        <div class="err" id="lg-err" role="alert">${esc(err)}</div>
        <button class="btn primary block" type="submit"${busy ? ' disabled' : ''}>${busy ? 'Checking...' : 'Sign in'}</button>
      </form>
      <div class="row between">
        <button class="btn sm ghost" id="lg-resend" type="button"></button>
        <button class="btn sm ghost" id="lg-back" type="button">Use a different email</button>
      </div>`);
    const form = root.querySelector('#lg-form');
    form.addEventListener('submit', (e) => { e.preventDefault(); (step === 'email' ? sendCode : checkCode)(); });
    if (step === 'code') {
      root.querySelector('#lg-code').focus();
      root.querySelector('#lg-back').addEventListener('click', () => { step = 'email'; err = ''; draw(); });
      const resend = root.querySelector('#lg-resend');
      const tick = () => {
        const left = Math.ceil((cooldownUntil - Date.now()) / 1000);
        resend.disabled = left > 0;
        resend.textContent = left > 0 ? `Send again in ${left} s` : 'Send the code again';
        if (left <= 0) clearInterval(timer);
      };
      tick(); timer = setInterval(() => { if (!resend.isConnected) clearInterval(timer); else tick(); }, 1000);
      resend.addEventListener('click', async () => {
        const r = await run(() => api.auth.signInWithOtp(email));
        if (r) { cooldownUntil = Date.now() + 30000; toast('A new code is on its way'); tick(); timer = setInterval(tick, 1000); }
      });
    } else root.querySelector('#lg-email').focus();
  };

  async function run(fn) {
    busy = true; err = '';
    try { return { value: await fn() }; } catch (e) { err = errMessage(e); return null; } finally { busy = false; const el = root.querySelector('#lg-err'); if (el) el.textContent = err; root.querySelectorAll('button[type=submit]').forEach((b) => { b.disabled = false; }); }
  }
  async function sendCode() {
    email = root.querySelector('#lg-email').value.trim();
    if (!EMAIL_RE.test(email)) { err = 'Enter a valid email address.'; root.querySelector('#lg-err').textContent = err; return; }
    root.querySelector('button[type=submit]').disabled = true;
    const r = await run(() => api.auth.signInWithOtp(email));
    if (r) { step = 'code'; cooldownUntil = Date.now() + 30000; draw(); }
  }
  async function checkCode() {
    const code = root.querySelector('#lg-code').value.replace(/\s+/g, '');
    if (!/^\d{6,10}$/.test(code)) { err = 'Enter the numeric code from the email.'; root.querySelector('#lg-err').textContent = err; return; }
    root.querySelector('button[type=submit]').disabled = true;
    const r = await run(() => api.auth.verifyOtp(email, code));
    if (r) onDone(r.value);
  }
  draw();
}

/** kind: 'pending' | 'revoked' | 'withdrawn' | 'unavailable'. */
export function renderBlocked(root, kind, { email, error, onRetry, onSignOut }) {
  const text = {
    pending: ['Waiting for the school', 'Your sign-in worked, but the school has not approved this account yet. Please contact the school office, then try again.'],
    withdrawn: ['Consent withdrawn', 'You withdrew your consent, so this account has been closed and nothing is shown. If you want to use the app again, please contact the school office; they can issue a new invite code.'],
    revoked: ['Access has been removed', 'This account no longer has access to the school app. If you think this is a mistake, please contact the school office.'],
    unavailable: ['School data is unavailable', 'The app could not load your information. Nothing has been lost - this is usually a connection problem. Please try again in a moment.'],
  }[kind];
  root.innerHTML = frame(`<h1>${esc(text[0])}</h1>
    ${banner(kind === 'unavailable' ? 'bad' : 'warn', esc(text[1]))}
    ${error ? `<small class="muted">Details: ${esc(errMessage(error))}</small>` : ''}
    ${email ? `<small class="muted">Signed in as ${esc(email)}</small>` : ''}
    <div class="row"><button class="btn primary" id="bl-retry">Try again</button><button class="btn" id="bl-out">Sign out</button></div>`);
  root.querySelector('#bl-retry').addEventListener('click', onRetry);
  root.querySelector('#bl-out').addEventListener('click', onSignOut);
}
