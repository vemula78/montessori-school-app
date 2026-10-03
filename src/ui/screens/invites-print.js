// Printable invite slips (bare page, no app chrome). A code is shown ONCE, when it is issued: the server keeps only
// a hash. So the slips live in memory for this page view only - reloading the page loses them (issue a new code).
import { esc, fdate, empty, DASH } from '../components.js';

const slips = [];
const STAFF = ['admin', 'accountant']; // same as the route table: this bare page must not depend on the router having checked
let owner = null; // the signed-in person who issued the slips in memory

/** Remember an issued code so it can be printed. {guardianName, children:[firstName], code, expiresAt} */
export function addSlip(s) {
  const i = slips.findIndex((x) => x.guardianId === s.guardianId);
  if (i >= 0) slips.splice(i, 1);
  slips.push(s);
}
export const slipCount = () => slips.length;
export const clearSlips = () => { slips.length = 0; owner = null; };
/** Slips belong to the person who issued them: anyone else asking for them (or counting them) starts with none. */
export function claimSlips(personaId) {
  if (owner !== personaId) { slips.length = 0; owner = personaId; }
}

export async function render(ctx) {
  if (!STAFF.includes(ctx.persona?.role)) {
    ctx.el.innerHTML = `${empty('Not available for this persona', 'Invite slips can be printed only by the principal or the accountant.')}<p><a class="btn" href="#/home">Go home</a></p>`;
    return;
  }
  claimSlips(ctx.persona.id);
  const school = ctx.db?.school?.name || 'School';
  const url = location.href.split('#')[0];
  if (!slips.length) {
    ctx.el.innerHTML = `${empty('No invite codes to print', 'Codes can be printed only right after they are issued. Go back, issue the codes, then print.')}<p><a class="btn" href="#/invites">Back to invite codes</a></p>`;
    return;
  }
  ctx.el.innerHTML = `<div class="no-print row between" style="max-width:560px;margin:0 auto 12px">
      <button class="btn" id="iv-back">&larr; Back</button>
      <button class="btn primary" id="iv-print">Print ${esc(slips.length)} slip${slips.length === 1 ? '' : 's'}</button>
    </div>
    <p class="no-print muted" style="max-width:560px;margin:0 auto 12px;font-size:.85rem">Each code works once, for one family, and expires on the date shown. Hand each slip to the right parent only.</p>
    <div class="slips">${slips.map((s) => `<article class="slip" aria-label="Invite code for ${esc(s.guardianName)}">
      <h2>${esc(school)}</h2>
      <div class="slip-for">Invite for <strong>${esc(s.guardianName)}</strong>${s.children?.length ? `<br><small>${esc(s.children.join(', '))}</small>` : ''}</div>
      <div class="slip-code" aria-label="Invite code">${esc(s.code)}</div>
      <div class="slip-valid">Valid until <strong>${s.expiresAt ? fdate(String(s.expiresAt).slice(0, 10)) : DASH}</strong> &middot; use once</div>
      <ol>
        <li>Open <strong>${esc(url)}</strong> on your phone.</li>
        <li>Sign in with your email address (we send a code).</li>
        <li>Type this invite code and your child&rsquo;s date of birth.</li>
      </ol>
      <p class="slip-warn">Do not share this code. The school will never ask you for it by phone or message.</p>
    </article>`).join('')}</div>`;
  ctx.el.querySelector('#iv-print').addEventListener('click', () => window.print());
  ctx.el.querySelector('#iv-back').addEventListener('click', () => (history.length > 1 ? history.back() : ctx.go('/invites')));
}
