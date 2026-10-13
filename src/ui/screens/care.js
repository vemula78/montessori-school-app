// Parent: report an absence in advance, keep the list of people who may collect the child, see who collected them.
// The teacher reads the absences on the attendance register; the pick-up log is the teacher's record (Going home).
import { todayISO, addDays } from '../../domain/dates.js';
import { esc, empty, pageHead, fdate, ftime, fullName, badge, formModal, confirmDialog, attempt } from '../components.js';

const relationOf = (g) => (g.relation ? g.relation[0].toUpperCase() + g.relation.slice(1) : 'Parent');

function leaveHtml(rows, today) {
  if (!rows.length) return '<p class="muted" style="margin:0">No absences reported.</p>';
  return `<ul class="list">${rows.map((r) => {
    const st = r.status === 'withdrawn' ? badge('Withdrawn', 'mute') : r.seenAt ? badge('Seen by the teacher', 'ok') : badge('Sent', 'info');
    const canWithdraw = r.status === 'active' && r.toDate >= today;
    return `<li><div class="row between"><div><div class="item-title">${fdate(r.fromDate)}${r.toDate !== r.fromDate ? ` to ${fdate(r.toDate)}` : ''}</div>
      ${r.reason ? `<small>${esc(r.reason)}</small>` : ''}</div><div class="row">${st}${canWithdraw ? `<button class="btn sm" data-withdraw="${esc(r.id)}">Withdraw</button>` : ''}</div></div></li>`;
  }).join('')}</ul>`;
}

function whoHtml(kid, who) {
  const guardians = who.guardians.map((g) => `<li><div class="row between"><div><div class="item-title">${esc(g.name)}</div><small>${esc(relationOf(g))}${g.phone ? ` &middot; ${esc(g.phone)}` : ''}</small></div>${badge('Guardian', 'mute')}</div></li>`);
  if (who.otherGuardians) guardians.push(`<li><small class="muted">and ${esc(who.otherGuardians)} other guardian${who.otherGuardians === 1 ? '' : 's'} on the school's records</small></li>`);
  const contacts = who.contacts.map((c) => `<li><div class="row between"><div><div class="item-title">${esc(c.name)}</div><small>${esc(c.relation)} &middot; ${esc(c.phone)}</small></div>
    <button class="btn sm" data-remove="${esc(c.id)}" aria-label="Remove ${esc(c.name)} from the list">Remove</button></div></li>`);
  return `<ul class="list">${guardians.join('')}${contacts.join('')}</ul>
    <p class="muted" style="font-size:.85rem;margin:6px 0 0">The school hands ${esc(kid.firstName)} only to these people. Ask them to carry photo identity; if someone else must come, message the teacher first.</p>`;
}

function pickupsHtml(rows, who) {
  if (!rows.length) return '<p class="muted" style="margin:0">No pick-ups recorded in the last two weeks.</p>';
  const name = (p) => (p.kind === 'other' ? `${p.name} (not on the list)` : p.kind === 'contact' ? [...who.contacts, ...who.former].find((c) => c.id === p.personId)?.name || 'a person on the list'
    : who.guardians.find((g) => g.id === p.personId)?.name || 'a guardian');
  return `<ul class="list">${rows.map((p) => `<li><div class="row between"><div><div class="item-title">${fdate(p.date)}</div><small>Collected by ${esc(name(p))}${p.note ? ` &mdash; ${esc(p.note)}` : ''}</small></div><span class="muted">${p.time ? esc(p.time) : ftime(p.at)}</span></div></li>`).join('')}</ul>`;
}

async function reportAbsence(ctx, kid) {
  const today = todayISO();
  return formModal({
    title: `Report an absence - ${kid.firstName}`, submitLabel: 'Send to the teacher',
    fieldsHtml: `<div class="grid cols-2"><label class="field"><span class="lbl">First day</span><input type="date" name="fromDate" required min="${esc(today)}" value="${esc(addDays(today, 1))}"></label>
      <label class="field"><span class="lbl">Last day</span><input type="date" name="toDate" required min="${esc(today)}" value="${esc(addDays(today, 1))}"></label></div>
      <label class="field"><span class="lbl">Reason (optional)</span><input name="reason" maxlength="200" placeholder="For example: family function"><small>No medical details are needed.</small></label>`,
    onSubmit: (v) => ctx.api.care.requestLeave({ studentId: kid.id, fromDate: v.fromDate, toDate: v.toDate, reason: v.reason }),
  });
}

async function addPerson(ctx, kid) {
  return formModal({
    title: `Who else may collect ${kid.firstName}`, submitLabel: 'Add to the list',
    fieldsHtml: `<label class="field"><span class="lbl">Full name</span><input name="name" required maxlength="80" autocomplete="off"></label>
      <label class="field"><span class="lbl">Relation to ${esc(kid.firstName)}</span><input name="relation" required maxlength="40" placeholder="For example: grandmother, driver"></label>
      <label class="field"><span class="lbl">Mobile number</span><input name="phone" required inputmode="tel" autocomplete="off" placeholder="10 digits"></label>
      <small>Add someone only with their agreement: the school keeps their name and number to check who collects ${esc(kid.firstName)}.</small>`,
    onSubmit: (v) => ctx.api.care.addContact({ studentId: kid.id, name: v.name, relation: v.relation, phone: v.phone }),
  });
}

export async function render(ctx) {
  const { api, persona, query } = ctx;
  const kids = (await api.people.childrenOf(persona.guardianId)).filter((k) => k.status === 'active');
  if (!kids.length) { ctx.el.innerHTML = `${pageHead('Absences & pick-up')}${empty('No children linked to this account')}`; return; }
  const kid = kids.find((k) => k.id === query.student) || kids[0];
  const today = todayISO();
  const [leave, who, pickups] = await Promise.all([
    api.care.leave({ studentId: kid.id, from: addDays(today, -30) }),
    api.care.whoMayCollect(kid.id),
    api.care.pickups({ studentId: kid.id, from: addDays(today, -14) }),
  ]);
  ctx.el.innerHTML = `${pageHead('Absences & pick-up', fullName(kid))}
    ${kids.length > 1 ? `<div class="seg" role="tablist" style="margin-bottom:12px">${kids.map((k) => `<button role="tab" aria-pressed="${k.id === kid.id}" data-kid="${esc(k.id)}">${esc(k.firstName)}</button>`).join('')}</div>` : ''}
    <div class="stack">
      <div class="card stack"><div class="row between"><h2 style="margin:0">Absences</h2><button class="btn sm primary" id="c-leave">Report an absence</button></div>
        <p class="muted" style="margin:0;font-size:.85rem">Tell the teacher in advance; they still mark the register on the day.</p>
        ${leaveHtml(leave, today)}</div>
      <div class="card stack"><div class="row between"><h2 style="margin:0">Who may collect ${esc(kid.firstName)}</h2>${who.contacts.length < 6 ? '<button class="btn sm" id="c-add">Add a person</button>' : ''}</div>
        ${whoHtml(kid, who)}</div>
      <div class="card stack"><h2 style="margin:0">Recent pick-ups</h2>${pickupsHtml(pickups, who)}</div>
    </div>`;
  ctx.el.querySelectorAll('[data-kid]').forEach((b) => b.addEventListener('click', () => ctx.setQuery({ student: b.dataset.kid })));
  ctx.el.querySelector('#c-leave').addEventListener('click', async () => { if (await reportAbsence(ctx, kid)) ctx.rerender(); });
  ctx.el.querySelector('#c-add')?.addEventListener('click', async () => { if (await addPerson(ctx, kid)) ctx.rerender(); });
  ctx.el.addEventListener('click', async (e) => {
    const w = e.target.closest('[data-withdraw]');
    if (w && await confirmDialog('Withdraw absence', 'Tell the teacher this absence is cancelled?', { okLabel: 'Withdraw' })
      && (await attempt(() => api.care.withdrawLeave(w.dataset.withdraw), 'Absence withdrawn')).ok) { ctx.rerender(); return; }
    const r = e.target.closest('[data-remove]');
    if (r && await confirmDialog('Remove person', 'The school will no longer hand your child to this person.', { okLabel: 'Remove', kind: 'danger' })
      && (await attempt(() => api.care.removeContact(r.dataset.remove), 'Removed from the list')).ok) ctx.rerender();
  });
}
