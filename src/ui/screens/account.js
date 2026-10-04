// My account (every role): who I am, my password (optional; the emailed code stays the default), two-step sign-in for
// the principal and accountant, signing out everywhere, and for a parent the data-rights desk (file a request, see mine).
import { esc, fdate, badge, banner, empty, pageHead, confirmDialog, attempt, errMessage, DASH } from '../components.js';
import { isRealMode } from '../mode.js';
import { mountTwoStep } from '../two-step.js';

const ROLE = { admin: 'Principal', teacher: 'Teacher', accountant: 'Accountant', driver: 'Driver', parent: 'Parent' };
export const KIND_LABEL = { export: 'Copy of my data', erasure: 'Erase my personal details', correction: 'Correct my details' };
export const REQUEST_STATUS = { open: ['Open', 'warn'], in_progress: ['In progress', 'info'], done: ['Done', 'ok'], declined: ['Declined', 'bad'] };

export async function render(ctx) {
  const { api, persona } = ctx;
  const real = isRealMode();
  const personName = String(persona.label || '').replace(/^[^—]*—\s*/, '').replace(/\s*\(.*$/, '') || DASH;
  const auth = await attempt(() => api.auth.status());
  const email = auth.ok ? auth.value.email : null;
  const privileged = persona.role === 'admin' || persona.role === 'accountant';
  const isParent = persona.role === 'parent';

  ctx.el.innerHTML = `${pageHead('My account', 'Your sign-in, password and two-step sign-in')}
    <div class="stack">
      <div class="card stack"><h2>Signed in as</h2>
        <dl style="display:grid;grid-template-columns:130px 1fr;gap:4px 10px;margin:0">
          <dt class="muted">Name</dt><dd style="margin:0">${esc(personName)}</dd>
          <dt class="muted">Role</dt><dd style="margin:0">${esc(ROLE[persona.role] || persona.role)}</dd>
          <dt class="muted">Email</dt><dd style="margin:0">${esc(email || DASH)}</dd>
        </dl></div>

      <div class="card stack"><h2>Password</h2>
        <p style="margin:0">You do not need a password: the school emails you a code each time. If you would rather type a password, set one here and use <em>Use a password</em> on the sign-in page. If you forget it, the sign-in page can email you a recovery code.</p>
        ${real ? '' : '<small>In this demo a password is kept only for this browser tab (it is lost when the tab closes), and the emailed recovery code exists only in the real app.</small>'}
        <form id="ac-pw-form" class="stack" novalidate>
          <input type="email" autocomplete="username" value="${esc(email || '')}" hidden>
          <label class="field" style="margin:0"><span class="lbl">Set or change your password</span><input id="ac-pw" type="password" autocomplete="new-password" placeholder="At least 8 characters"></label>
          <div class="err" id="ac-pw-err" role="alert"></div>
          <div><button class="btn" type="submit">Save password</button></div></form></div>

      ${privileged ? '<div class="card stack"><h2>Two-step sign-in</h2><div id="ac-two-step"></div></div>' : ''}

      <div class="card stack"><h2>Sign out everywhere</h2>
        <p style="margin:0">${real ? 'Ends your sign-in on every phone and computer. Do this if a device is lost.' : 'In the real app this ends your sign-in on every device. Here it ends this person&rsquo;s session in this tab.'}</p>
        <div><button class="btn danger" id="ac-out-all" type="button">Sign out everywhere</button></div></div>

      ${isParent ? '<div class="card stack" id="ac-rights"></div>' : ''}
    </div>`;

  // ---- password
  ctx.el.querySelector('#ac-pw-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = ctx.el.querySelector('#ac-pw-err');
    const input = ctx.el.querySelector('#ac-pw');
    errEl.textContent = '';
    if (input.value.length < 8) { errEl.textContent = 'Choose a password of at least 8 characters.'; return; }
    const r = await attempt(() => api.auth.setPassword(input.value), 'Password saved');
    if (r.ok) input.value = '';
    else errEl.textContent = /reauth/i.test(errMessage(r.error)) ? 'For security this needs a fresh sign-in: sign out, then use Forgot password.' : errMessage(r.error);
  });

  // ---- two-step
  if (privileged) await mountTwoStep(ctx.el.querySelector('#ac-two-step'), { api, allowDisable: true });

  // ---- sign out everywhere
  ctx.el.querySelector('#ac-out-all').addEventListener('click', async () => {
    if (!(await confirmDialog('Sign out everywhere', 'Sign out on every device, including this one? You will have to sign in again.', { okLabel: 'Sign out everywhere', kind: 'danger' }))) return;
    if (!(await attempt(() => api.auth.signOutEverywhere())).ok) return;
    location.hash = ''; location.reload();
  });

  // ---- parent: data rights
  if (isParent) await drawRights(ctx, ctx.el.querySelector('#ac-rights'));
}

async function drawRights(ctx, host) {
  const { api } = ctx;
  let list = [], err = null;
  try { list = await api.rights.list(); } catch (e) { err = e; }
  host.innerHTML = `<h2>My data requests</h2>
    <p style="margin:0">You can ask the school for a copy of your data, to erase your personal details, or to correct them. The principal will answer; you see the answer here.</p>
    ${err ? banner('bad', `<strong>Your requests could not be loaded.</strong> ${esc(errMessage(err))}`) : ''}
    <form id="rt-form" class="stack" novalidate>
      <label class="field" style="margin:0"><span class="lbl">What do you need?</span><select id="rt-kind" name="kind">${Object.entries(KIND_LABEL).map(([k, l]) => `<option value="${esc(k)}">${esc(l)}</option>`).join('')}</select></label>
      <label class="field" style="margin:0"><span class="lbl">Details (optional)</span><textarea id="rt-details" name="details" maxlength="1000" placeholder="For a correction, say what is wrong and what it should be."></textarea></label>
      <div class="err" id="rt-err" role="alert"></div>
      <div><button class="btn primary" type="submit">Send request</button></div></form>
    ${list.length ? `<ul class="list card-list">${list.map((r) => {
      const [label, kind] = REQUEST_STATUS[r.status] || [r.status, ''];
      return `<li><div class="row between"><div class="grow-text"><div class="item-title">${esc(KIND_LABEL[r.kind] || r.kind)}</div><small>Sent ${r.filedAt ? esc(fdate(String(r.filedAt).slice(0, 10))) : DASH}${r.details ? ` - ${esc(r.details)}` : ''}</small>
        ${r.resolution ? `<div style="margin-top:4px"><small><strong>Answer:</strong> ${esc(r.resolution)}</small></div>` : ''}</div><div>${badge(label, kind)}</div></div></li>`;
    }).join('')}</ul>` : (err ? '' : empty('No requests yet'))}`;
  host.querySelector('#rt-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = host.querySelector('#rt-err');
    errEl.textContent = '';
    const kind = host.querySelector('#rt-kind').value;
    const details = host.querySelector('#rt-details').value.trim();
    const r = await attempt(() => api.rights.file({ kind, details }), 'Request sent');
    if (r.ok) ctx.rerender(); else errEl.textContent = errMessage(r.error);
  });
}
