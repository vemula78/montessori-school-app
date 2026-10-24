// Children & families (principal): find a child; change their class, bus stop or status (left, with the leaving date);
// correct a parent's details; admit one new child. Every change is a registry command (people.updateStudent,
// people.updateGuardian, people.addStudent): the rules live there, not here. Every interpolated value goes through esc().
import { todayISO } from '../../domain/dates.js';
import { esc, fdate, badge, banner, empty, pageHead, options, formModal, attempt, toast, DASH } from '../components.js';

const STATUS_FILTERS = [['active', 'Attending'], ['left', 'Left'], ['nodate', 'Left, no leaving date'], ['all', 'All']];
const openOnly = (list, keepId) => list.filter((x) => x.active !== false || x.id === keepId);

/** "routeId|stopId" options grouped by route, for one select (no dependent dropdowns). */
function busOptions(routes, routeId, stopId) {
  const cur = routeId ? `${routeId}|${stopId || ''}` : '';
  return `<option value="">No school bus</option>${openOnly(routes, routeId).map((r) => `<optgroup label="${esc(r.name)}">${[...r.stops].sort((a, b) => a.seq - b.seq)
    .map((s) => `<option value="${esc(`${r.id}|${s.id}`)}"${`${r.id}|${s.id}` === cur ? ' selected' : ''}>${esc(s.seq)}. ${esc(s.name)}</option>`).join('')}</optgroup>`).join('')}`;
}
const busText = (routes, s) => {
  const r = routes.find((x) => x.id === s.routeId);
  const st = r?.stops.find((x) => x.id === s.stopId);
  return r ? `${r.name}${st ? `, ${st.name}` : ''}` : DASH;
};
const statusBadge = (s) => (s.status === 'active' ? badge('Attending', 'ok') : badge(s.leftOn ? `Left ${fdate(s.leftOn)}` : 'Left, date not recorded', s.leftOn ? 'mute' : 'warn'));

export async function render(ctx) {
  if (ctx.params.id) return child(ctx);
  const { api, query } = ctx;
  const [students, guardians, programs, routes] = await Promise.all([api.people.students(), api.people.guardians(), api.people.programs(), api.transport.routes()]);
  const gById = new Map(guardians.map((g) => [g.id, g]));
  const status = STATUS_FILTERS.some(([k]) => k === query.status) ? query.status : 'active';
  const q = String(query.q || '').trim().toLowerCase();
  const byStatus = { active: (s) => s.status === 'active', left: (s) => s.status === 'left', nodate: (s) => s.status === 'left' && !s.leftOn, all: () => true }[status];
  const parentsOf = (s) => (s.guardianIds || []).map((id) => gById.get(id)).filter(Boolean);
  const shown = students.filter(byStatus)
    .filter((s) => !query.guardian || (s.guardianIds || []).includes(query.guardian))
    .filter((s) => !q || `${s.name} ${s.admissionNo} ${s.programName} ${parentsOf(s).map((g) => g.name).join(' ')}`.toLowerCase().includes(q));
  const noDate = students.filter((s) => s.status === 'left' && !s.leftOn).length;
  ctx.el.innerHTML = `${pageHead('Children & families', 'Class, bus stop, leaving and parents’ details', '<button class="btn primary" id="pp-add">Add a child</button>')}
    ${noDate ? banner('warn', `<strong>${esc(noDate)} ${noDate === 1 ? 'child has' : 'children have'} left without a leaving date.</strong> Their records can never come due for deletion until the date is set. <a href="${esc(ctx.href('/people', { status: 'nodate' }))}">Show them</a>`) : ''}
    <div class="row" style="margin-bottom:12px"><input id="pp-q" type="search" placeholder="Search child, admission number, class or parent" value="${esc(query.q || '')}" style="width:auto;min-width:260px" aria-label="Search children">
      <div class="seg">${STATUS_FILTERS.map(([k, l]) => `<a href="${esc(ctx.href('/people', { ...query, status: k }))}"${k === status ? ' aria-current="page"' : ''}>${esc(l)}</a>`).join('')}</div>
      ${query.guardian ? `<a class="btn sm" href="${esc(ctx.href('/people', { status }))}">All families</a>` : ''}
      <span class="muted">${esc(shown.length)} shown</span></div>
    ${shown.length ? `<div class="tablewrap"><table><thead><tr><th>Child</th><th>Adm. no</th><th>Class</th><th>Status</th><th>School bus</th><th>Parents</th></tr></thead><tbody>
      ${shown.map((s) => `<tr><td><a href="${esc(ctx.href(`/people/${s.id}`))}">${esc(s.name)}</a></td><td>${esc(s.admissionNo || DASH)}</td><td>${esc(s.programName)}</td><td>${statusBadge(s)}</td>
        <td>${esc(busText(routes, s))}</td><td>${esc(parentsOf(s).map((g) => g.name).join(', ') || DASH)}</td></tr>`).join('')}
    </tbody></table></div>` : empty('No children match')}`;
  ctx.el.querySelector('#pp-q').addEventListener('change', (e) => ctx.setQuery({ q: e.target.value }));
  ctx.el.querySelector('#pp-add').addEventListener('click', () => addChild(ctx, programs, routes));
}

// ---------------------------------------------------------------- one child
async function child(ctx) {
  const { api } = ctx;
  let s;
  try { s = await api.people.student(ctx.params.id); } catch (e) { ctx.el.innerHTML = `${pageHead('Child')}${empty('Child not found')}`; return; }
  const [programs, routes, guardians] = await Promise.all([api.people.programs(), api.transport.routes(), api.people.guardians()]);
  const mine = guardians.filter((g) => (s.guardianIds || []).includes(g.id));
  const today = todayISO();
  ctx.el.innerHTML = `${pageHead(s.name, `Admission ${s.admissionNo || DASH} · born ${fdate(s.dob)} · ${s.programName}`, `<a class="btn" href="${esc(ctx.href('/people'))}">All children</a>`)}
    <div class="grid cols-2">
      <form class="card stack" id="pp-form" novalidate><h2>Class, bus stop and status</h2>
        <label class="field"><span class="lbl">Class</span><select name="programId">${options(openOnly(programs, s.programId).map((p) => ({ value: p.id, label: p.name })), s.programId)}</select></label>
        <label class="field"><span class="lbl">School bus</span><select name="bus">${busOptions(routes, s.routeId, s.stopId)}</select></label>
        <label class="field"><span class="lbl">Status</span><select name="status">${options([{ value: 'active', label: 'Attending' }, { value: 'left', label: 'Has left the school' }], s.status)}</select></label>
        <label class="field"><span class="lbl">Leaving date (when the child has left)</span><input type="date" name="leftOn" max="${esc(today)}" value="${esc(s.leftOn || '')}"></label>
        <small>A child who has left stays visible to their parents, read-only. The retention schedule (Settings) counts from the leaving date.</small>
        <div class="err" id="pp-err" role="alert"></div>
        <div><button class="btn primary" type="submit">Save changes</button></div></form>
      <div class="card stack"><h2>Parents and guardians</h2>
        ${mine.length ? `<ul class="list">${mine.map((g) => {
          const erased = /^Erased-\d+$/.test(g.firstName);
          return `<li><div class="row between"><div><div class="item-title">${esc(g.name)}</div><small>${esc(g.relation || DASH)} · ${esc(g.phone || 'no phone')} · ${esc(g.email || 'no email')}</small></div>
            ${erased ? badge('Erased', 'mute') : `<button class="btn sm" data-edit-g="${esc(g.id)}">Correct details</button>`}</div></li>`;
        }).join('')}</ul>` : empty('No guardian recorded')}
        <small>A parent’s sign-in email is changed on Administration &gt; Accounts. Other children of the same parent: <a href="${esc(ctx.href('/people', { status: 'all', guardian: mine[0]?.id || '' }))}">show the family</a>.</small></div>
    </div>`;
  const form = ctx.el.querySelector('#pp-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = ctx.el.querySelector('#pp-err');
    err.textContent = '';
    const v = Object.fromEntries(new FormData(form).entries());
    const patch = {};
    if (v.programId && v.programId !== s.programId) patch.programId = v.programId;
    const [routeId, stopId] = v.bus ? String(v.bus).split('|') : [null, null];
    if ((routeId || null) !== (s.routeId || null) || (stopId || null) !== (s.stopId || null)) Object.assign(patch, { routeId: routeId || null, stopId: stopId || null });
    if (v.status === 'left') {
      if (!v.leftOn) { err.textContent = 'Enter the leaving date.'; return; }
      if (s.status !== 'left' || v.leftOn !== s.leftOn) Object.assign(patch, s.status === 'left' ? { leftOn: v.leftOn } : { status: 'left', leftOn: v.leftOn });
    } else if (s.status !== 'active') patch.status = 'active';
    if (!Object.keys(patch).length) { toast('Nothing changed'); return; }
    const r = await attempt(() => api.people.updateStudent({ studentId: s.id, ...patch }), 'Saved');
    if (r.ok) ctx.rerender(); else err.textContent = r.error?.message || '';
  });
  ctx.el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-edit-g]');
    if (!b) return;
    const g = mine.find((x) => x.id === b.dataset.editG);
    const ok = await formModal({
      title: `Correct ${g.name}’s details`,
      fieldsHtml: `<label class="field"><span class="lbl">First name</span><input name="firstName" maxlength="80" value="${esc(g.firstName)}" required></label>
        <label class="field"><span class="lbl">Last name</span><input name="lastName" maxlength="80" value="${esc(g.lastName)}"></label>
        <label class="field"><span class="lbl">Relation to the child</span><input name="relation" maxlength="80" value="${esc(g.relation || '')}"></label>
        <label class="field"><span class="lbl">Phone</span><input name="phone" type="tel" maxlength="20" value="${esc(g.phone || '')}"></label>
        <small>The audit log records which fields changed, not the old or new values.</small>`,
      submitLabel: 'Save',
      onSubmit: async (v) => {
        const patch = {};
        for (const k of ['firstName', 'lastName', 'relation', 'phone']) if (String(v[k] ?? '').trim() !== String(g[k] ?? '')) patch[k] = String(v[k] ?? '').trim();
        if (Object.keys(patch).length) await api.people.updateGuardian({ guardianId: g.id, ...patch });
      },
    });
    if (ok) { toast('Details saved'); ctx.rerender(); }
  });
}

// ---------------------------------------------------------------- one new child (the import's own checks, on the server too)
async function addChild(ctx, programs, routes) {
  const parent = (n) => `<fieldset class="stack" style="border:0;padding:0;margin:0"><legend class="lbl">Parent ${n}${n === 1 ? '' : ' (optional)'}</legend>
    <label class="field"><span class="lbl">Full name</span><input name="guardian${n}Name" maxlength="120"${n === 1 ? ' required' : ''}></label>
    <label class="field"><span class="lbl">Relation</span><input name="guardian${n}Relation" maxlength="40" placeholder="Mother, Father, Guardian"></label>
    <label class="field"><span class="lbl">Mobile</span><input name="guardian${n}Phone" type="tel" maxlength="20" placeholder="10-digit mobile"></label>
    <label class="field"><span class="lbl">Email</span><input name="guardian${n}Email" type="email" maxlength="120"></label></fieldset>`;
  let added = null;
  const ok = await formModal({
    title: 'Add a child',
    fieldsHtml: `<label class="field"><span class="lbl">Admission number</span><input name="admissionNo" maxlength="40" required></label>
      <div class="row"><label class="field grow"><span class="lbl">First name</span><input name="firstName" maxlength="80" required></label><label class="field grow"><span class="lbl">Last name</span><input name="lastName" maxlength="80"></label></div>
      <label class="field"><span class="lbl">Date of birth</span><input name="dob" type="date" max="${esc(todayISO())}" required></label>
      <label class="field"><span class="lbl">Class</span><select name="program" required>${options(openOnly(programs).map((p) => ({ value: p.id, label: p.name })), '', { blank: 'Choose a class...' })}</select></label>
      <label class="field"><span class="lbl">School bus</span><select name="bus">${busOptions(routes, null, null)}</select></label>
      ${parent(1)}${parent(2)}
      <small>A parent already in the app (same mobile or email, same name) is linked to this child, not added twice. Each parent needs a mobile or an email; invite them from Invite codes afterwards.</small>`,
    submitLabel: 'Add child',
    onSubmit: async (v) => {
      const { bus, ...rest } = v;
      const [route, stop] = bus ? String(bus).split('|') : ['', ''];
      added = await ctx.api.people.addStudent({ ...rest, route, stop });
    },
  });
  if (ok && added) { toast(`${added.student.name} added`); ctx.go(`/people/${added.student.id}`); }
}
