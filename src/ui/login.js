// Sign-in (email one-time code by default; an optional password; password recovery by emailed code) and the "cannot continue"
// screens: pending approval, access removed, blocked, data unavailable.
import { api } from '../api/index.js';
import { esc, banner, errMessage, toast } from './components.js';
import { noticeHtml, PRIVACY_VERSION } from './privacy.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const frame = (inner) => `<div class="auth-wrap"><div class="auth-card stack">
  <div class="auth-logo" aria-hidden="true"><span class="logo"></span></div>${inner}</div></div>`;

/** @param {HTMLElement} root @param {{onDone:()=>void, message?:string}} o */
export function renderLogin(root, { onDone, message }) {
  // steps: email -> code (default, emailed one-time code); password (optional); forgot -> reset (emailed recovery code + a new password)
  let step = 'email';
  let email = '';
  let busy = false;
  let err = '';
  let cooldownUntil = 0;
  let timer = null;

  const emailField = () => `<label class="field"><span class="lbl">Email address</span><input id="lg-email" name="email" type="email" inputmode="email" autocomplete="email" autocapitalize="off" autocorrect="off" spellcheck="false" required value="${esc(email)}"></label>`;
  const errLine = () => `<div class="err" id="lg-err" role="alert">${esc(err)}</div>`;
  const submit = (label, busyLabel) => `<button class="btn primary block" type="submit"${busy ? ' disabled' : ''}>${busy ? busyLabel : label}</button>`;
  const TEMPLATES = {
    email: () => `
      <h1>Sign in</h1>
      <p class="muted">Enter the email address the school has for you. We will email you a one-time code - there is no password to remember unless you choose to set one.</p>
      ${message ? banner('warn', esc(message)) : ''}
      <form id="lg-form" novalidate class="stack">
        ${emailField()}${errLine()}${submit('Email me a code', 'Sending...')}
      </form>
      <div class="row"><button class="btn sm ghost" id="lg-use-pw" type="button">Use a password</button></div>
      <details class="muted"><summary style="cursor:pointer;font-weight:700">Privacy notice (${esc(PRIVACY_VERSION)})</summary><div class="prose" style="margin-top:8px">${noticeHtml()}</div></details>`,
    code: () => `
      <h1>Enter your code</h1>
      <p class="muted">We sent a code to <strong>${esc(email)}</strong>. It can take a minute; check the spam folder too. The code works once.</p>
      <form id="lg-form" novalidate class="stack">
        <label class="field"><span class="lbl">Code from the email</span><input id="lg-code" class="code-input" name="code" inputmode="numeric" pattern="[0-9]*" autocomplete="one-time-code" maxlength="10" required></label>
        ${errLine()}${submit('Sign in', 'Checking...')}
      </form>
      <div class="row between">
        <button class="btn sm ghost" id="lg-resend" type="button"></button>
        <button class="btn sm ghost" id="lg-back" type="button">Use a different email</button>
      </div>`,
    password: () => `
      <h1>Sign in with a password</h1>
      <p class="muted">Only if you have set a password under Account. Otherwise use the emailed code.</p>
      <form id="lg-form" novalidate class="stack">
        ${emailField()}
        <label class="field"><span class="lbl">Password</span><input id="lg-pw" name="password" type="password" autocomplete="current-password" required></label>
        ${errLine()}${submit('Sign in', 'Checking...')}
      </form>
      <div class="row between">
        <button class="btn sm ghost" id="lg-forgot" type="button">Forgot password</button>
        <button class="btn sm ghost" id="lg-back" type="button">Email me a code instead</button>
      </div>`,
    forgot: () => `
      <h1>Forgot password</h1>
      <p class="muted">Enter your email address. If the school has an account for it, we will email you a recovery code; you then choose a new password.</p>
      <form id="lg-form" novalidate class="stack">
        ${emailField()}${errLine()}${submit('Email me a recovery code', 'Sending...')}
      </form>
      <div class="row"><button class="btn sm ghost" id="lg-back" type="button">Back to sign in</button></div>`,
    reset: () => `
      <h1>Choose a new password</h1>
      <p class="muted">If <strong>${esc(email)}</strong> has an account, a recovery code is on its way. It can take a minute; check the spam folder too.</p>
      <form id="lg-form" novalidate class="stack">
        <label class="field"><span class="lbl">Recovery code from the email</span><input id="lg-code" class="code-input" name="code" inputmode="numeric" pattern="[0-9]*" autocomplete="one-time-code" maxlength="10" required></label>
        <label class="field"><span class="lbl">New password</span><input id="lg-pw" name="password" type="password" autocomplete="new-password" required><span class="help">At least 8 characters.</span></label>
        ${errLine()}${submit('Set password and sign in', 'Checking...')}
      </form>
      <div class="row"><button class="btn sm ghost" id="lg-back" type="button">Back to sign in</button></div>`,
  };
  const SUBMIT = { email: () => sendCode(), code: () => checkCode(), password: () => passwordSignIn(), forgot: () => requestReset(), reset: () => finishReset() };
  const goStep = (s) => { const f = root.querySelector('#lg-email'); if (f) email = f.value.trim(); step = s; err = ''; draw(); };

  const draw = () => {
    clearInterval(timer);
    root.innerHTML = frame(TEMPLATES[step]());
    root.querySelector('#lg-form').addEventListener('submit', (e) => { e.preventDefault(); SUBMIT[step](); });
    root.querySelector('#lg-use-pw')?.addEventListener('click', () => goStep('password'));
    root.querySelector('#lg-forgot')?.addEventListener('click', () => goStep('forgot'));
    root.querySelector('#lg-back')?.addEventListener('click', () => goStep(step === 'forgot' || step === 'reset' ? 'password' : 'email'));
    if (step === 'code') {
      root.querySelector('#lg-code').focus();
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
    } else (root.querySelector('#lg-email') || root.querySelector('#lg-code')).focus();
  };

  async function run(fn) {
    busy = true; err = '';
    try { return { value: await fn() }; } catch (e) { err = errMessage(e); return null; } finally { busy = false; const el = root.querySelector('#lg-err'); if (el) el.textContent = err; root.querySelectorAll('button[type=submit]').forEach((b) => { b.disabled = false; }); }
  }
  const bad = (msg) => { err = msg; root.querySelector('#lg-err').textContent = err; };
  const readEmail = () => { email = root.querySelector('#lg-email').value.trim(); return EMAIL_RE.test(email) || (bad('Enter a valid email address.'), false); };
  async function sendCode() {
    if (!readEmail()) return;
    root.querySelector('button[type=submit]').disabled = true;
    const r = await run(() => api.auth.signInWithOtp(email));
    if (r) { step = 'code'; cooldownUntil = Date.now() + 30000; draw(); }
  }
  async function checkCode() {
    const code = root.querySelector('#lg-code').value.replace(/\s+/g, '');
    if (!/^\d{6,10}$/.test(code)) return bad('Enter the numeric code from the email.');
    root.querySelector('button[type=submit]').disabled = true;
    const r = await run(() => api.auth.verifyOtp(email, code));
    if (r) onDone(r.value);
  }
  async function passwordSignIn() {
    if (!readEmail()) return;
    const pw = root.querySelector('#lg-pw').value;
    if (!pw) return bad('Enter your password.');
    root.querySelector('button[type=submit]').disabled = true;
    const r = await run(() => api.auth.signInWithPassword(email, pw));
    if (r) onDone(r.value);
  }
  async function requestReset() {
    if (!readEmail()) return;
    root.querySelector('button[type=submit]').disabled = true;
    const r = await run(() => api.auth.requestPasswordReset(email)); // never says whether the address has an account
    if (r) goStep('reset');
  }
  async function finishReset() {
    const code = root.querySelector('#lg-code').value.replace(/\s+/g, '');
    const pw = root.querySelector('#lg-pw').value;
    if (!/^\d{6,10}$/.test(code)) return bad('Enter the numeric code from the email.');
    if (pw.length < 8) return bad('Choose a password of at least 8 characters.');
    root.querySelector('button[type=submit]').disabled = true;
    // the recovery code signs the person in; the new password is then saved. If only that last step fails they are still signed in.
    const r = await run(async () => {
      const st = await api.auth.verifyRecoveryCode(email, code);
      try { await api.auth.setPassword(pw); } catch (e) { toast(`Signed in, but the password was not saved: ${errMessage(e)}. Set it under Account.`, 'bad'); }
      return st;
    });
    if (r) onDone(r.value);
  }
  draw();
}

/** kind: 'pending' | 'revoked' | 'withdrawn' | 'blocked' | 'unavailable'. */
export function renderBlocked(root, kind, { email, error, onRetry, onSignOut }) {
  const text = {
    blocked: ['Sign-in blocked', 'The school has blocked this account. If you think this is a mistake, please contact the school office.'],
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
