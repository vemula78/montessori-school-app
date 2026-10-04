// First sign-in: link this email to the family with the invite code printed by the school plus a child's date of birth.
import { api } from '../api/index.js';
import { esc, banner, errMessage } from './components.js';
import { todayISO } from '../domain/dates.js';

const frame = (inner) => `<div class="auth-wrap"><div class="auth-card stack">
  <div class="auth-logo" aria-hidden="true"><span class="logo"></span></div>${inner}</div></div>`;

/** @param {HTMLElement} root @param {{email?:string, onDone:()=>void, onSignOut:()=>void}} o */
export function renderInvite(root, { email, onDone, onSignOut }) {
  let err = '';
  let linked = null;

  const draw = () => {
    if (linked) {
      root.innerHTML = frame(`<h1>You are linked</h1>
        ${banner('ok', `This sign-in is now linked to ${linked.length ? linked.map((c) => `<strong>${esc(c.firstName)}</strong>`).join(', ') : 'your family'}. Next you will be asked to read and accept the privacy notice.`)}
        <button class="btn primary block" id="iv-next">Continue</button>`);
      root.querySelector('#iv-next').addEventListener('click', onDone);
      return;
    }
    root.innerHTML = frame(`<h1>Link your family</h1>
      <p class="muted">Signed in as <strong>${esc(email || 'your email')}</strong>. Type the invite code from the slip the school gave you, and the date of birth of one of your children. This makes sure only you see your family&rsquo;s information.</p>
      <form id="iv-form" novalidate class="stack">
        <label class="field"><span class="lbl">Invite code</span><input id="iv-code" class="code-input" name="code" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" required></label>
        <label class="field"><span class="lbl">Child&rsquo;s date of birth</span><input id="iv-dob" name="dob" type="date" required max="${esc(todayISO())}"></label>
        <div class="err" id="iv-err" role="alert">${esc(err)}</div>
        <button class="btn primary block" type="submit">Link my family</button>
      </form>
      <div class="banner"><strong>School staff:</strong> you do not need a code. Ask the principal to add exactly this email (<strong>${esc(email || 'the one you signed in with')}</strong>) to the staff list, then sign out and in again.</div>
      <div class="row between"><small class="muted">Code expired or lost? Ask the school office for a new one.</small><button class="btn sm ghost" id="iv-out" type="button">Sign out</button></div>`);
    root.querySelector('#iv-out').addEventListener('click', onSignOut);
    root.querySelector('#iv-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const code = root.querySelector('#iv-code').value.replace(/\s+/g, '');
      const dob = root.querySelector('#iv-dob').value;
      const errEl = root.querySelector('#iv-err');
      if (!code || !dob) { errEl.textContent = 'Enter both the code and the date of birth.'; return; }
      const btn = root.querySelector('button[type=submit]');
      btn.disabled = true; errEl.textContent = '';
      try {
        const r = await api.auth.redeemInvite(code, dob);
        linked = r?.children || [];
        draw();
      } catch (ex) {
        errEl.textContent = errMessage(ex); // wrong code / date of birth / expired / already used
        btn.disabled = false;
      }
    });
  };
  draw();
}
