// Staff, classes & routes (principal): the school's own set-up after the first-run script. Staff (add, edit, take off
// the staff), classes (name, age range, teachers; close or reopen) and bus routes (driver, attendant, fee, stops in order
// with their times and map position). Every change is a registry command (setup.*, src/domain/setup.js): the rules live
// there. Fee heads, fee structures and the late-fee rule are under Fees. Every interpolated value goes through esc().
import { rupeesToPaise, formatPaise } from '../../domain/money.js';
import { esc, badge, banner, empty, pageHead, options, formModal, confirmDialog, attempt, toast, fullName, DASH } from '../components.js';
import { isRealMode } from '../mode.js';

const TABS = [['staff', 'Staff'], ['classes', 'Classes'], ['routes', 'Bus routes']];
const ROLE = { admin: 'Principal', teacher: 'Teacher', accountant: 'Accountant', driver: 'Driver' };
const open = (x) => x && x.active !== false;
const field = (label, inner, help = '') => `<label class="field"><span class="lbl">${esc(label)}</span>${inner}${help ? `<span class="help">${esc(help)}</span>` : ''}</label>`;
const input = (name, value = '', attrs = '') => `<input name="${esc(name)}" value="${esc(value ?? '')}" ${attrs}>`;
const ticks = (name, items, chosen) => (items.length ? `<div class="stack" style="gap:4px">${items.map((i) => `<label class="check"><input type="checkbox" name="${esc(name)}" value="${esc(i.value)}"${chosen.includes(i.value) ? ' checked' : ''}> ${esc(i.label)}</label>`).join('')}</div>` : '<small class="muted">None yet.</small>');
const list = (v) => [].concat(v ?? []).map(String).filter(Boolean);
const statusBadge = (x) => (open(x) ? badge('Open', 'ok') : badge('Closed', 'mute'));

export async function render(ctx) {
  const tab = TABS.some(([k]) => k === ctx.query.tab) ? ctx.query.tab : 'staff';
  ctx.el.innerHTML = `${pageHead('Staff, classes & routes', 'The school’s own set-up: who works here, the classes and the bus routes')}
    <div class="seg" style="margin-bottom:14px">${TABS.map(([k, l]) => `<a href="${esc(ctx.href('/setup', { tab: k }))}"${k === tab ? ' aria-current="page"' : ''}>${esc(l)}</a>`).join('')}</div>
    <div id="su-body" class="stack"></div>`;
  const host = ctx.el.querySelector('#su-body');
  await ({ staff, classes, routes }[tab])(ctx, host);
  host.addEventListener('click', (e) => onClick(ctx, e));
}

const done = async (ctx, fn, msg) => { if ((await attempt(fn, msg)).ok) ctx.rerender(); };
const handlers = {};
function onClick(ctx, e) {
  const b = e.target.closest('[data-act]');
  if (b && handlers[b.dataset.act]) handlers[b.dataset.act](ctx, b.dataset);
}

// ---------------------------------------------------------------- staff
async function staff(ctx, host) {
  const { db } = ctx;
  const progName = new Map(db.programs.map((p) => [p.id, p.name]));
  const people = [...db.staff].sort((a, b) => (open(b) - open(a)) || fullName(a).localeCompare(fullName(b)));
  const drives = (s) => db.routes.filter((r) => open(r) && (r.driverId === s.id || r.attendantId === s.id)).map((r) => r.name);
  host.innerHTML = `<div class="row between"><span class="muted">${esc(people.filter(open).length)} on the staff</span><button class="btn primary" data-act="staff-edit">Add a staff member</button></div>
    ${people.length ? `<div class="tablewrap"><table><thead><tr><th>Name</th><th>Role</th><th>Classes / route</th><th>Phone</th><th>Status</th><th></th></tr></thead><tbody>
      ${people.map((s) => `<tr><td>${esc(fullName(s))}${s.id === ctx.persona.staffId ? ' <small>(you)</small>' : ''}</td><td>${esc(ROLE[s.role] || s.role)}</td>
        <td>${esc([...(s.programIds || []).map((id) => progName.get(id) || id), ...drives(s)].join(', ') || DASH)}</td><td>${esc(s.phone || DASH)}</td>
        <td>${open(s) ? badge('On the staff', 'ok') : badge('Left', 'mute')}</td>
        <td><div class="row" style="gap:6px">${open(s) ? `<button class="btn sm" data-act="staff-edit" data-id="${esc(s.id)}">Edit</button>${s.id === ctx.persona.staffId ? '' : `<button class="btn sm danger" data-act="staff-off" data-id="${esc(s.id)}" data-name="${esc(fullName(s))}">Take off the staff</button>`}`
          : `<button class="btn sm" data-act="staff-on" data-id="${esc(s.id)}">Bring back</button>`}</div></td></tr>`).join('')}
    </tbody></table></div>` : empty('No staff yet')}
    <small>A new staff member signs in with the email given here: send their invitation from Administration &gt; Accounts. A sign-in email is changed there too.</small>`;
}

handlers['staff-edit'] = async (ctx, { id }) => {
  const s = id ? ctx.db.staff.find((x) => x.id === id) : null;
  const classes = ctx.db.programs.filter((p) => open(p) || (s?.programIds || []).includes(p.id)).map((p) => ({ value: p.id, label: p.name }));
  const ok = await formModal({
    title: s ? `Edit ${fullName(s)}` : 'Add a staff member',
    fieldsHtml: `<div class="row">${field('First name', input('firstName', s?.firstName, 'maxlength="80" required'))}${field('Last name', input('lastName', s?.lastName, 'maxlength="80"'))}</div>
      ${field('Role', `<select name="role">${options(Object.entries(ROLE).map(([value, label]) => ({ value, label })), s?.role || 'teacher')}</select>`, s ? 'A principal or accountant must use two-step sign-in once the school requires it.' : '')}
      ${field('Phone', input('phone', s?.phone, 'type="tel" maxlength="20"'))}
      ${s ? '<small>The sign-in email is changed on Administration &gt; Accounts.</small>' : field('Sign-in email', input('email', '', 'type="email" maxlength="120" autocomplete="off"'), 'The email this person will sign in with. Leave empty if they will not use the app.')}
      ${field('Classes taught (teachers only)', ticks('programIds', classes, s?.programIds || []))}`,
    submitLabel: s ? 'Save' : 'Add',
    onSubmit: async (v) => {
      const body = { firstName: v.firstName, lastName: v.lastName, role: v.role, phone: v.phone, programIds: v.role === 'teacher' ? list(v.programIds) : [] };
      if (!s) body.email = v.email;
      await ctx.api.setup.saveStaff(s ? { id: s.id, ...body } : body);
    },
  });
  if (ok) { toast(s ? 'Saved' : 'Staff member added'); ctx.rerender(); }
};
handlers['staff-off'] = async (ctx, { id, name }) => {
  const real = isRealMode();
  if (!(await confirmDialog('Take off the staff', `${name} leaves their classes and can no longer act in the app.${real ? ' Also block their sign-in on Administration > Accounts, which closes it at once.' : ''} You can bring them back later.`, { okLabel: 'Take off the staff', kind: 'danger' }))) return;
  await done(ctx, () => ctx.api.setup.setStaffActive({ staffId: id, active: false }), real ? 'Done. Now block the sign-in on Administration > Accounts.' : 'Taken off the staff');
};
handlers['staff-on'] = (ctx, { id }) => done(ctx, () => ctx.api.setup.setStaffActive({ staffId: id, active: true }), 'Back on the staff (give them their classes again)');

// ---------------------------------------------------------------- classes
async function classes(ctx, host) {
  const { db } = ctx;
  const name = new Map(db.staff.map((s) => [s.id, fullName(s)]));
  const teachers = (pid) => db.staff.filter((s) => (s.programIds || []).includes(pid)).map((s) => name.get(s.id));
  const kids = (pid) => db.students.filter((s) => s.programId === pid && s.status === 'active').length;
  const progs = [...db.programs].sort((a, b) => (open(b) - open(a)) || a.name.localeCompare(b.name));
  host.innerHTML = `<div class="row between"><span class="muted">${esc(progs.filter(open).length)} open classes</span><button class="btn primary" data-act="class-edit">Add a class</button></div>
    ${progs.length ? `<div class="tablewrap"><table><thead><tr><th>Class</th><th>Age range</th><th>Teachers</th><th class="r">Children</th><th>Status</th><th></th></tr></thead><tbody>
      ${progs.map((p) => `<tr><td>${esc(p.name)}</td><td>${esc(p.ageRange || DASH)}</td><td>${esc(teachers(p.id).join(', ') || DASH)}</td><td class="r num">${esc(kids(p.id))}</td><td>${statusBadge(p)}</td>
        <td><div class="row" style="gap:6px">${open(p) ? `<button class="btn sm" data-act="class-edit" data-id="${esc(p.id)}">Edit</button><button class="btn sm" data-act="class-off" data-id="${esc(p.id)}" data-name="${esc(p.name)}">Close</button>`
          : `<button class="btn sm" data-act="class-on" data-id="${esc(p.id)}">Reopen</button>`}</div></td></tr>`).join('')}
    </tbody></table></div>` : empty('No classes yet')}
    <small>A teacher sees the children of the classes they teach. A class with children in it cannot be closed: move the children first (Children &amp; families). Fee structures for a new class are made under Fee structures.</small>`;
}

handlers['class-edit'] = async (ctx, { id }) => {
  const p = id ? ctx.db.programs.find((x) => x.id === id) : null;
  const teachers = ctx.db.staff.filter((s) => s.role === 'teacher' && open(s)).map((s) => ({ value: s.id, label: fullName(s) }));
  const current = p ? ctx.db.staff.filter((s) => (s.programIds || []).includes(p.id)).map((s) => s.id) : [];
  const ok = await formModal({
    title: p ? `Edit ${p.name}` : 'Add a class',
    fieldsHtml: `${field('Class name', input('name', p?.name, 'maxlength="60" required'))}
      ${field('Age range', input('ageRange', p?.ageRange, 'maxlength="40" placeholder="for example 3 to 4 years"'))}
      ${field('Teachers', ticks('teacherIds', teachers, current))}`,
    submitLabel: p ? 'Save' : 'Add',
    onSubmit: (v) => ctx.api.setup.saveProgram({ ...(p ? { id: p.id } : {}), name: v.name, ageRange: v.ageRange, teacherIds: list(v.teacherIds) }),
  });
  if (ok) { toast(p ? 'Saved' : 'Class added'); ctx.rerender(); }
};
handlers['class-off'] = async (ctx, { id, name }) => {
  if (await confirmDialog('Close class', `Close ${name}? Its teachers stop seeing it; its records are kept. You can reopen it.`, { okLabel: 'Close class', kind: 'danger' })) await done(ctx, () => ctx.api.setup.setProgramActive({ programId: id, active: false }), 'Class closed');
};
handlers['class-on'] = (ctx, { id }) => done(ctx, () => ctx.api.setup.setProgramActive({ programId: id, active: true }), 'Class reopened');

// ---------------------------------------------------------------- bus routes and stops
async function routes(ctx, host) {
  const { db } = ctx;
  const name = new Map(db.staff.map((s) => [s.id, fullName(s)]));
  const rts = [...db.routes].sort((a, b) => (open(b) - open(a)) || a.name.localeCompare(b.name));
  const riders = (stopId) => db.students.filter((s) => s.stopId === stopId && s.status === 'active').length;
  host.innerHTML = `<div class="row between"><span class="muted">${esc(rts.filter(open).length)} open routes</span><button class="btn primary" data-act="route-edit">Add a route</button></div>
    ${banner('info', 'A stop must be pinned within about 60 m for “arrived” to work. The surest way: the driver stands at each stop on a first run and taps <strong>Set this stop’s position here</strong> on the trip screen (needs a GPS reading of 25 m or better). Stops cannot be changed while a trip is running.')}
    ${rts.length ? rts.map((r) => `<div class="card stack"><div class="row between"><div><h3 style="margin:0">${esc(r.name)}</h3>
        <small>Bus ${esc(r.busNo)} · driver ${esc(name.get(r.driverId) || DASH)}${r.attendantId ? ` · attendant ${esc(name.get(r.attendantId) || DASH)}` : ''} · transport fee ${esc(formatPaise(r.transportFeePaise))} per instalment</small></div>
        <div class="row" style="gap:6px">${statusBadge(r)}${open(r) ? `<button class="btn sm" data-act="route-edit" data-id="${esc(r.id)}">Edit route</button><button class="btn sm" data-act="stop-edit" data-route="${esc(r.id)}">Add a stop</button><button class="btn sm" data-act="route-off" data-id="${esc(r.id)}" data-name="${esc(r.name)}">Close</button>`
          : `<button class="btn sm" data-act="route-on" data-id="${esc(r.id)}">Reopen</button>`}</div></div>
      ${r.stops.length ? `<div class="tablewrap"><table><thead><tr><th class="r">#</th><th>Stop</th><th>Pick-up</th><th>Drop</th><th>Position</th><th class="r">Children</th><th></th></tr></thead><tbody>
        ${[...r.stops].sort((a, b) => a.seq - b.seq).map((st) => `<tr><td class="r num">${esc(st.seq)}</td><td>${esc(st.name)}</td><td>${esc(st.scheduledPickup)}</td><td>${esc(st.scheduledDrop)}</td>
          <td class="nowrap"><small>${esc(Number(st.lat).toFixed(5))}, ${esc(Number(st.lng).toFixed(5))}</small></td><td class="r num">${esc(riders(st.id))}</td>
          <td>${open(r) ? `<div class="row" style="gap:6px"><button class="btn sm" data-act="stop-edit" data-route="${esc(r.id)}" data-id="${esc(st.id)}">Edit</button><button class="btn sm" data-act="stop-remove" data-route="${esc(r.id)}" data-id="${esc(st.id)}" data-name="${esc(st.name)}">Remove</button></div>` : ''}</td></tr>`).join('')}
      </tbody></table></div>` : '<p class="muted" style="margin:0">No stops yet.</p>'}</div>`).join('') : empty('No routes yet')}`;
}

handlers['route-edit'] = async (ctx, { id }) => {
  const r = id ? ctx.db.routes.find((x) => x.id === id) : null;
  const drivers = ctx.db.staff.filter((s) => s.role === 'driver' && open(s)).map((s) => ({ value: s.id, label: fullName(s) }));
  const ok = await formModal({
    title: r ? `Edit ${r.name}` : 'Add a route',
    fieldsHtml: `${field('Route name', input('name', r?.name, 'maxlength="60" required'))}
      ${field('Bus number', input('busNo', r?.busNo, 'maxlength="20" required'))}
      ${field('Driver', `<select name="driverId" required>${options(drivers, r?.driverId, { blank: 'Choose a driver...' })}</select>`, 'Drivers are added on the Staff tab (role Driver).')}
      ${field('Attendant (optional)', `<select name="attendantId">${options(drivers, r?.attendantId, { blank: 'No attendant' })}</select>`, 'Must also be on the staff as a driver to see the route.')}
      ${field('Transport fee per instalment (₹)', input('fee', r ? (r.transportFeePaise / 100).toFixed(2) : '', 'inputmode="decimal" required'), 'Charged on each fee instalment generated from now on.')}`,
    submitLabel: r ? 'Save' : 'Add',
    onSubmit: async (v) => {
      const fee = rupeesToPaise(v.fee);
      if (fee === null || fee < 0) throw new Error('Enter the transport fee in rupees, for example 4,500.');
      await ctx.api.setup.saveRoute({ ...(r ? { id: r.id } : {}), name: v.name, busNo: v.busNo, driverId: v.driverId, attendantId: v.attendantId || null, transportFeePaise: fee });
    },
  });
  if (ok) { toast(r ? 'Saved' : 'Route added; now add its stops'); ctx.rerender(); }
};
handlers['route-off'] = async (ctx, { id, name }) => {
  if (await confirmDialog('Close route', `Close ${name}? Its driver no longer sees it; trip history is kept. A route children still ride cannot be closed.`, { okLabel: 'Close route', kind: 'danger' })) await done(ctx, () => ctx.api.setup.setRouteActive({ routeId: id, active: false }), 'Route closed');
};
handlers['route-on'] = (ctx, { id }) => done(ctx, () => ctx.api.setup.setRouteActive({ routeId: id, active: true }), 'Route reopened');

handlers['stop-edit'] = async (ctx, { route, id }) => {
  const r = ctx.db.routes.find((x) => x.id === route);
  const st = id ? r.stops.find((x) => x.id === id) : null;
  const n = r.stops.length + (st ? 0 : 1);
  const ok = await formModal({
    title: st ? `Edit ${st.name}` : `Add a stop to ${r.name}`,
    fieldsHtml: `${field('Stop name', input('name', st?.name, 'maxlength="60" required'))}
      ${field('Position on the route', `<select name="seq">${options(Array.from({ length: n }, (_, i) => ({ value: i + 1, label: String(i + 1) })), st ? st.seq : n)}</select>`, 'The others move up or down to make room.')}
      <div class="row">${field('Pick-up time', input('scheduledPickup', st?.scheduledPickup, 'type="time" required'))}${field('Drop time', input('scheduledDrop', st?.scheduledDrop, 'type="time" required'))}</div>
      <div class="row">${field('Latitude', input('lat', st?.lat, 'inputmode="decimal" required'))}${field('Longitude', input('lng', st?.lng, 'inputmode="decimal" required'))}</div>
      <small>Typed or copied coordinates are often 60 to 100 m off: confirm them from the bus with “Set this stop’s position here”.</small>`,
    submitLabel: st ? 'Save' : 'Add stop',
    onSubmit: (v) => ctx.api.setup.saveStop({ routeId: r.id, ...(st ? { id: st.id } : {}), name: v.name, seq: Number(v.seq), scheduledPickup: v.scheduledPickup, scheduledDrop: v.scheduledDrop, lat: v.lat, lng: v.lng }), // text: the command reads and range-checks it
  });
  if (ok) { toast(st ? 'Stop saved' : 'Stop added'); ctx.rerender(); }
};
handlers['stop-remove'] = async (ctx, { route, id, name }) => {
  if (await confirmDialog('Remove stop', `Remove ${name}? Only a stop no child is assigned to and no trip has used can be removed.`, { okLabel: 'Remove stop', kind: 'danger' })) await done(ctx, () => ctx.api.setup.removeStop({ routeId: route, stopId: id }), 'Stop removed');
};
