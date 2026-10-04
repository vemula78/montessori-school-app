// Two-step sign-in (an authenticator app's 6-digit code) for the principal and the accountant.
//   renderTwoStep   the gate screen: shown instead of the app until the code is verified (aal2).
//   mountTwoStep    the same panel inside the Account screen (set up / on / turn off).
// The secret and the otpauth link are shown as text (no QR library). In the demo a "demo authenticator" panel shows
// the live code the phone would show; the real app never has one.
import { api as defaultApi } from '../api/index.js';
import { esc, banner, errMessage, confirmDialog } from './components.js';
import { frame } from './login.js';
import { isRealMode } from './mode.js';

const codeForm = (label) => `<form id="ts-form" novalidate class="stack">
  <label class="field"><span class="lbl">6-digit code from your authenticator app</span><input id="ts-code" class="code-input" name="code" inputmode="numeric" pattern="[0-9]*" autocomplete="one-time-code" maxlength="6" required></label>
  <div class="err" id="ts-err" role="alert"></div>
  <button class="btn primary block" type="submit">${esc(label)}</button></form>`;

const demoPanel = () => `<div class="card clay stack" id="ts-demo"><strong>Demo authenticator</strong>
  <div class="live-code" id="ts-live" aria-live="off">------</div>
  <small>This is the code a phone app would show; it changes in <span id="ts-left">--</span> s. In the real app it comes from your own phone.</small></div>`;

/**
 * Draw the panel into `host`. onVerified() runs after a correct code (gate: continue; Account: redraw is automatic).
 * @param {HTMLElement} host @param {{api?:object, onVerified?:()=>void, allowDisable?:boolean}} o
 */
export async function mountTwoStep(host, { api = defaultApi, onVerified, allowDisable = true } = {}) {
  let timer = null;
  const stopTimer = () => { clearInterval(timer); timer = null; };
  const startDemo = () => {
    if (isRealMode()) return;
    const live = host.querySelector('#ts-live'), left = host.querySelector('#ts-left');
    if (!live) return;
    const tick = async () => {
      if (host.isConnected === false || !host.querySelector('#ts-live')) { stopTimer(); return; }
      try { const c = await api.auth.twoStep.demoCode(); live.textContent = c.code; left.textContent = String(c.secondsLeft); } catch { live.textContent = '------'; }
    };
    tick();
    timer = setInterval(tick, 1000);
    timer.unref?.();
  };
  const wireVerify = (factorId) => {
    const form = host.querySelector('#ts-form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const errEl = host.querySelector('#ts-err');
      const code = host.querySelector('#ts-code').value.replace(/\s+/g, '');
      if (!/^\d{6}$/.test(code)) { errEl.textContent = 'Enter the 6 digits shown in the app.'; return; }
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true; errEl.textContent = '';
      try {
        await api.auth.twoStep.verify(factorId, code);
        stopTimer();
        if (onVerified) onVerified(); else await draw();
      } catch (ex) { errEl.textContent = errMessage(ex); btn.disabled = false; }
    });
  };

  async function draw() {
    stopTimer();
    let st;
    try { st = await api.auth.twoStep.status(); } catch (e) { host.innerHTML = banner('bad', `<strong>Two-step status could not be loaded.</strong> ${esc(errMessage(e))}`); return; }
    if (st.enrolled && st.verified) {
      host.innerHTML = `${banner('ok', '<strong>Two-step sign-in is on.</strong> This sign-in is unlocked with your authenticator app.')}
        ${allowDisable ? '<div><button class="btn" id="ts-off" type="button">Turn off two-step sign-in</button></div>' : ''}`;
      host.querySelector('#ts-off')?.addEventListener('click', async () => {
        if (!(await confirmDialog('Turn off two-step sign-in', 'Turn off two-step sign-in for this account? The school may require it again.', { okLabel: 'Turn off', kind: 'danger' }))) return;
        try { await api.auth.twoStep.disable(st.factorId); await draw(); } catch (ex) { host.insertAdjacentHTML('beforeend', banner('bad', esc(errMessage(ex)))); }
      });
      return;
    }
    if (st.enrolled) {
      host.innerHTML = `<p class="muted" style="margin:0">Enter the current code from your authenticator app to continue.</p>${isRealMode() ? '' : demoPanel()}${codeForm('Verify')}`;
      wireVerify(st.factorId);
      startDemo();
      host.querySelector('#ts-code').focus();
      return;
    }
    host.innerHTML = `<p class="muted" style="margin:0">${st.required ? 'The school requires a second step for this account. ' : ''}Use an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, Authy). After this, signing in needs your email code or password <strong>and</strong> the app's 6-digit code.</p>
      <div><button class="btn primary" id="ts-start" type="button">Set up an authenticator app</button></div><div class="err" id="ts-err" role="alert"></div>`;
    host.querySelector('#ts-start').addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        const en = await api.auth.twoStep.enroll();
        host.innerHTML = `<ol style="margin:0;padding-left:20px" class="stack">
            <li>In the authenticator app choose <em>Add account</em>, then <em>Enter a setup key</em>.</li>
            <li>Type this key: <div class="secret" id="ts-secret">${esc(en.secret)}</div></li>
            <li>Type the 6-digit code the app then shows, below.</li></ol>
          <details><summary style="cursor:pointer;font-weight:700">Setup link for the app (otpauth)</summary><div class="secret" style="margin-top:6px">${esc(en.uri)}</div></details>
          ${isRealMode() ? '' : demoPanel()}${codeForm('Turn on two-step sign-in')}`;
        wireVerify(en.factorId);
        startDemo();
        host.querySelector('#ts-code').focus();
      } catch (ex) { e.target.disabled = false; host.querySelector('#ts-err').textContent = errMessage(ex); }
    });
  }
  await draw();
}

/** The gate: a signed-in principal or accountant who has not completed the second step sees only this. */
export async function renderTwoStep(root, { onDone, onSignOut, email, signOutLabel = 'Sign out' }) {
  root.innerHTML = frame(`<h1>Two-step sign-in</h1>
    ${email ? `<small class="muted">Signed in as ${esc(email)}</small>` : ''}
    <div id="ts-host" class="stack"></div>
    <div><button class="btn ghost" id="ts-out" type="button">${esc(signOutLabel)}</button></div>`);
  root.querySelector('#ts-out').addEventListener('click', onSignOut);
  await mountTwoStep(root.querySelector('#ts-host'), { onVerified: onDone, allowDisable: false });
}
