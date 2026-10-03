// Invite codes (real app): the principal or accountant issues a single-use code per family; the parent redeems it
// together with a child's date of birth after the first email sign-in. Codes are shown once and printed as slips.
import { esc, fdate, badge, banner, empty, pageHead, confirmDialog, openModal, attempt, toast, errMessage, indexBy, fullName, DASH } from '../components.js';
import { addSlip, slipCount, claimSlips } from './invites-print.js';

const live = (inv) => inv && !inv.redeemedAt && !inv.revokedAt && inv.status !== 'locked' && Date.parse(inv.expiresAt) > Date.now();

export async function render(ctx) {
  const { api, persona } = ctx;
  claimSlips(persona.id);
  let guardians, students, invites;
  try {
    [guardians, students, invites] = await Promise.all([api.people.guardians(), api.people.students(), api.admin.invites()]);
  } catch (e) {
    ctx.el.innerHTML = `${pageHead('Invite codes')}${banner('bad', `<strong>Invite codes are unavailable.</strong> ${esc(errMessage(e))}`)}`;
    return;
  }
  // who is already signed in and linked (the principal can list sign-ins; fee staff cannot, and see invites only)
  // only the principal can list sign-ins (for the "Remove access" button); whether a redeemed code is still linked comes with the invite
  let users = [];
  if (persona.role === 'admin') { try { users = await api.admin.users(); } catch { users = []; } }
  const linkedUser = new Map(users.filter((u) => u.guardianId && u.status === 'active').map((u) => [u.guardianId, u]));
  const kids = indexBy(students);
  const q = (ctx.query.q || '').toLowerCase();
  // newest invite per guardian decides the status shown
  const latest = new Map();
  for (const inv of [...invites].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))) latest.set(inv.guardianId, inv);
  const childNames = (g) => (g.studentIds || []).map((id) => kids.get(id)).filter((s) => s && s.status === 'active').map((s) => s.firstName);
  const rows = guardians
    .filter((g) => (g.studentIds || []).some((id) => kids.get(id)?.status === 'active'))
    .map((g) => ({ g, names: childNames(g), inv: latest.get(g.id) || null }))
    .filter((r) => !q || fullName(r.g).toLowerCase().includes(q) || r.names.some((n) => n.toLowerCase().includes(q)))
    .sort((a, b) => fullName(a.g).localeCompare(fullName(b.g)));
  // 'removed' = the code was used but that sign-in is no longer active (revoked, withdrawn...): the family can be invited again.
  // A locked code (too many wrong dates of birth) is not live, so it reads as lapsed.
  const status = (r) => (r.inv?.redeemedAt ? (r.inv.redeemedUserStatus === 'active' ? 'linked' : 'removed') : live(r.inv) ? 'issued' : r.inv ? 'lapsed' : 'none');
  const counts = { linked: 0, issued: 0, lapsed: 0, none: 0 };
  rows.forEach((r) => { const st = status(r); counts[st === 'removed' ? 'lapsed' : st]++; });
  const needing = rows.filter((r) => ['none', 'lapsed'].includes(status(r)));

  ctx.el.innerHTML = `${pageHead('Invite codes', 'One single-use code per family. Parents link their email with the code and a child’s date of birth.', `${slipCount() ? `<a class="btn" href="#/print/invites">Print slips (${esc(slipCount())})</a>` : ''}`)}
    <div class="grid cols-4" style="margin-bottom:12px">
      <div class="kpi good"><div class="v">${esc(counts.linked)}</div><div class="l">families linked</div></div>
      <div class="kpi"><div class="v">${esc(counts.issued)}</div><div class="l">code issued, waiting</div></div>
      <div class="kpi ${counts.lapsed ? 'bad' : ''}"><div class="v">${esc(counts.lapsed)}</div><div class="l">code expired, revoked or access removed</div></div>
      <div class="kpi"><div class="v">${esc(counts.none)}</div><div class="l">no code yet</div></div>
    </div>
    <div class="row" style="margin-bottom:10px">
      <input id="iv-q" type="search" placeholder="Search parent or child" value="${esc(ctx.query.q || '')}" style="width:auto;min-width:220px" aria-label="Search">
      <button class="btn primary" id="iv-all"${needing.length ? '' : ' disabled'}>Issue codes for ${esc(needing.length)} ${needing.length === 1 ? 'family' : 'families'} without one</button>
    </div>
    <small class="muted">Issuing a new code cancels that family&rsquo;s earlier unused code. The code is shown only once; print it straight away.</small>
    ${rows.length ? `<ul class="list card-list" style="margin-top:10px">
      ${rows.map((r) => {
        const st = status(r);
        const badgeHtml = st === 'linked' ? badge('Linked', 'ok') + (r.inv?.redeemedAt ? ` <small>${fdate(String(r.inv.redeemedAt).slice(0, 10))}</small>` : '') : st === 'issued' ? badge('Code issued', 'info') + ` <small>expires ${fdate(String(r.inv.expiresAt).slice(0, 10))}</small>` : st === 'removed' ? badge(r.inv.redeemedUserStatus === 'revoked' ? 'Access removed' : 'Not linked', 'bad') : st === 'lapsed' ? badge(r.inv.revokedAt ? 'Revoked' : 'Expired', 'bad') : badge('No code', 'mute');
        return `<li><div class="row between"><div class="grow-text"><div class="item-title">${esc(fullName(r.g))} <small>${esc(r.g.relation || '')}</small></div><small>${esc(r.names.join(', ') || DASH)}</small><div style="margin-top:4px">${badgeHtml}</div></div>
          <div class="row"><button class="btn sm${st === 'none' || st === 'lapsed' || st === 'removed' ? ' primary' : ''}" data-issue="${esc(r.g.id)}"${st === 'linked' ? ' disabled title="Already linked"' : ''}>${st === 'issued' ? 'Issue a new code' : 'Issue code'}</button>
            ${st === 'linked' && linkedUser.has(r.g.id) && persona.role === 'admin' ? `<button class="btn sm ghost" data-revoke="${esc(linkedUser.get(r.g.id).id)}" data-name="${esc(fullName(r.g))}">Remove access</button>` : ''}</div></div></li>`;
      }).join('')}</ul>` : empty(guardians.length ? 'No families match' : 'No families yet', guardians.length ? '' : 'Import the children list first (Import data).')}`;

  const names = new Map(rows.map((r) => [r.g.id, r]));
  async function issue(gid) {
    const r = names.get(gid);
    const res = await attempt(() => api.admin.inviteCode(gid));
    if (!res.ok) return null;
    addSlip({ guardianId: gid, guardianName: fullName(r.g), children: r.names, code: res.value.code, expiresAt: res.value.expiresAt });
    return res.value;
  }
  ctx.el.querySelector('#iv-q').addEventListener('change', (e) => ctx.setQuery({ q: e.target.value }));
  ctx.el.addEventListener('click', async (e) => {
    const i = e.target.closest('[data-issue]');
    const rv = e.target.closest('[data-revoke]');
    if (i) {
      const v = await issue(i.dataset.issue);
      if (!v) return;
      await openModal({
        title: 'Invite code',
        body: `<p>For <strong>${esc(fullName(names.get(i.dataset.issue).g))}</strong>. Write it down or print it now - it cannot be shown again.</p>
          <div class="slip-code" style="font-size:2rem;text-align:center;margin:12px 0">${esc(v.code)}</div>
          <p class="muted">Valid until ${fdate(String(v.expiresAt).slice(0, 10))}. Works once.</p>`,
        actions: [{ label: 'Close', value: false }, { label: 'Print slip', kind: 'primary', value: true }],
      }).then((print) => { if (print) ctx.go('/print/invites'); else ctx.rerender(); });
    } else if (rv) {
      if (!(await confirmDialog('Remove access', `Remove ${rv.dataset.name}’s access to the app? They will be signed out and see nothing. You can issue a new code later.`, { okLabel: 'Remove access', kind: 'danger' }))) return;
      if ((await attempt(() => api.admin.revokeUser(rv.dataset.revoke), 'Access removed')).ok) ctx.rerender();
    }
  });
  ctx.el.querySelector('#iv-all').addEventListener('click', async () => {
    if (!(await confirmDialog('Issue codes', `Issue a new code for each of the ${needing.length} families without a working one? You can then print all the slips together.`, { okLabel: 'Issue codes' }))) return;
    let done = 0;
    const failed = [];
    for (const r of needing) {
      try {
        const v = await api.admin.inviteCode(r.g.id);
        addSlip({ guardianId: r.g.id, guardianName: fullName(r.g), children: r.names, code: v.code, expiresAt: v.expiresAt });
        done++;
      } catch (ex) { failed.push(`${fullName(r.g)}: ${errMessage(ex)}`); }
    }
    if (failed.length) toast(`${done} issued, ${failed.length} failed: ${failed[0]}`, 'bad'); else toast(`${done} codes issued`);
    if (done) ctx.go('/print/invites'); else ctx.rerender();
  });
}
