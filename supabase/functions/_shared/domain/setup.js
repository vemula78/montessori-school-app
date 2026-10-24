// School set-up after go-live (the principal): classes (programmes), staff, bus routes and their stops, and admitting one
// child. Pure rules shared by the demo and the command function (registry: commands.js, slice 'setup'; admitting a child:
// slice 'ledger'). No DOM, no I/O.
//   A class, staff member or route is never deleted (records point at it): it is closed (active:false) and can be
//   reopened. Only a stop that nothing has used can be removed.
//   A teacher sees a class through staff.programIds (staff_programs in SQL, which RLS reads); program.teacherIds is kept
//   as its mirror, from the staff side.
//   Audit rows carry ids and field names, never names, phone numbers, emails or coordinates.

import { fail, newId } from './ids.js';
import { byId, fullName, activeStudents } from './people.js';
import { isHHMM } from './dates.js';
import { appendAudit } from './audit.js';
import { haversineMeters, stopsInOrder } from './transport.js';
import { TARGET_FIELDS, applyRows } from './import-people.js';

export const STAFF_ROLES = ['admin', 'teacher', 'accountant', 'driver'];
/** "Set this stop's position here" needs a GPS fix this good (metres); stops are arrived at within 60 m. */
export const STOP_FIX_MAX_ACCURACY_M = 25;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PHONE_RE = /^\+?[0-9][0-9 -]{5,19}$/;
export const isOpen = x => Boolean(x) && x.active !== false;

function str(v, label, max, required = false) {
  const s = String(v ?? '').trim();
  if (required && !s) fail('VALIDATION', `${label} is required`);
  if (s.length > max) fail('VALIDATION', `${label} is longer than ${max} characters`);
  return s;
}
function only(input, keys) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('VALIDATION', 'Send the details as an object');
  for (const k of Object.keys(input)) if (!keys.includes(k)) fail('VALIDATION', `Unknown field: ${k}`);
}
const sameText = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
const runningTrip = (db, routeId) => (db.trips || []).some(t => t.routeId === routeId && t.status === 'active');
const otherOpenPrincipal = (db, staffId) => db.staff.some(s => s.id !== staffId && s.role === 'admin' && isOpen(s));
/** Open routes this staff member drives or attends. */
export const routesStaffedBy = (db, staffId) => db.routes.filter(r => isOpen(r) && (r.driverId === staffId || r.attendantId === staffId));
/** The staff teaching a class (staff.programIds is what RLS reads). */
export const teachersOf = (db, programId) => db.staff.filter(s => (s.programIds || []).includes(programId)).map(s => s.id);

function idList(v, label) {
  if (!Array.isArray(v)) fail('VALIDATION', `${label} must be a list`);
  return [...new Set(v.map(String))];
}

// ---------------------------------------------------------------- classes

/** Give a class exactly these teachers: each teacher's programIds and the class's mirror. Returns '+id -id' or ''. */
function setTeachers(db, prog, ids) {
  const plus = [], minus = [];
  for (const s of db.staff) {
    const has = (s.programIds || []).includes(prog.id), want = ids.includes(s.id);
    if (want && !has) { s.programIds = [...(s.programIds || []), prog.id]; plus.push(s.id); }
    if (!want && has) { s.programIds = s.programIds.filter(x => x !== prog.id); minus.push(s.id); }
  }
  prog.teacherIds = [...ids];
  return [...plus.map(x => `+${x}`), ...minus.map(x => `-${x}`)].join(' ');
}
/** After a teacher's own programIds changed: the mirror of every class they joined or left. */
function syncMirrors(db, programIds) {
  for (const pid of new Set(programIds)) { const p = byId(db.programs, pid); if (p) p.teacherIds = teachersOf(db, pid); }
}

/** saveProgram({id?, name, ageRange?, teacherIds?}) — add a class, or edit one (name, age range, teachers). */
export function saveProgram(db, input, ctx) {
  only(input, ['id', 'name', 'ageRange', 'teacherIds']);
  const p = input.id ? byId(db.programs, input.id) : null;
  if (input.id && !p) fail('NOT_FOUND', 'Class not found');
  const name = 'name' in input || !p ? str(input.name, 'The class name', 60, true) : p.name;
  if (db.programs.some(x => x.id !== p?.id && sameText(x.name, name))) fail('VALIDATION', `There is already a class called ${name}`);
  const ageRange = 'ageRange' in input ? str(input.ageRange, 'The age range', 40) : p?.ageRange ?? '';
  const teacherIds = 'teacherIds' in input ? idList(input.teacherIds, 'Teachers') : p ? teachersOf(db, p.id) : [];
  for (const id of teacherIds) {
    const s = byId(db.staff, id);
    if (!s) fail('NOT_FOUND', 'Teacher not found');
    if (s.role !== 'teacher') fail('VALIDATION', `${fullName(s)} is not a teacher`);
    if (!isOpen(s)) fail('VALIDATION', `${fullName(s)} is no longer on the staff`);
  }
  if (p && !isOpen(p) && teacherIds.length) fail('VALIDATION', 'Reopen the class before giving it teachers');
  const changes = [];
  let prog = p;
  if (!prog) {
    prog = { id: newId('prg'), name, ageRange, teacherIds: [] };
    db.programs.push(prog);
  } else {
    if (prog.name !== name) changes.push('name');
    if ((prog.ageRange ?? '') !== ageRange) changes.push('age range');
    Object.assign(prog, { name, ageRange });
  }
  const moved = setTeachers(db, prog, teacherIds);
  if (moved) changes.push(`teachers ${moved}`);
  appendAudit(db, ctx, { entity: 'program', entityId: prog.id, action: p ? 'update' : 'add', summary: p ? changes.join('; ') || 'no change' : `class added${moved ? `; teachers ${moved}` : ''}` });
  return { ...prog };
}

/** setProgramActive({programId, active}) — close a class with no active children (its teachers are released), or reopen it. */
export function setProgramActive(db, { programId, active } = {}, ctx) {
  const p = byId(db.programs, programId);
  if (!p) fail('NOT_FOUND', 'Class not found');
  if (typeof active !== 'boolean') fail('VALIDATION', 'active must be true or false');
  let summary = 'reopened';
  if (!active) {
    const n = activeStudents(db, p.id).length;
    if (n) fail('VALIDATION', `${n} ${n === 1 ? 'child is' : 'children are'} still in this class; move them to another class first`);
    const moved = setTeachers(db, p, []);
    p.active = false;
    summary = `closed${moved ? `; teachers ${moved}` : ''}`;
  } else delete p.active;
  appendAudit(db, ctx, { entity: 'program', entityId: p.id, action: active ? 'reopen' : 'close', summary });
  return { ...p };
}

// ---------------------------------------------------------------- staff

/**
 * saveStaff({id?, firstName, lastName?, role, phone?, email?, programIds?}) — add a staff member, or edit one.
 * The email is how the person signs in (the real app links a new sign-in to the staff record with that email, after the
 * principal sends the invite on Administration > Accounts). Once set it changes only through the account desk, which
 * changes the sign-in too. programIds: the classes a teacher teaches (empty for every other role).
 */
export function saveStaff(db, input, ctx) {
  only(input, ['id', 'firstName', 'lastName', 'role', 'phone', 'email', 'programIds']);
  const s = input.id ? byId(db.staff, input.id) : null;
  if (input.id && !s) fail('NOT_FOUND', 'Staff member not found');
  if (s && !isOpen(s)) fail('VALIDATION', 'Bring this staff member back first');
  const has = k => k in input || !s;
  const firstName = has('firstName') ? str(input.firstName, 'The first name', 80, true) : s.firstName;
  const lastName = has('lastName') ? str(input.lastName, 'The last name', 80) : s.lastName;
  const role = has('role') ? String(input.role ?? '') : s.role;
  if (!STAFF_ROLES.includes(role)) fail('VALIDATION', `Unknown role: ${role}`);
  const phone = has('phone') ? str(input.phone, 'The phone number', 20) : s.phone ?? '';
  if (phone && !PHONE_RE.test(phone)) fail('VALIDATION', 'Enter the phone number with digits, spaces or dashes only');
  let email = s ? s.email ?? '' : '';
  if ('email' in input) {
    const e = str(input.email, 'The email', 120).toLowerCase();
    if (e && !EMAIL_RE.test(e)) fail('VALIDATION', 'Enter a valid email address');
    if (s && s.email && e !== String(s.email).toLowerCase()) fail('VALIDATION', 'A sign-in email is changed on Administration > Accounts (Change email), so the sign-in changes with it');
    if (e && db.staff.some(x => x.id !== s?.id && sameText(x.email, e))) fail('VALIDATION', 'Another staff member already uses this email');
    if (e && db.guardians.some(g => sameText(g.email, e))) fail('VALIDATION', 'A parent already uses this email; staff need their own');
    email = e;
  }
  if (s && role !== s.role) {
    if (s.id === ctx.actor.id && role !== 'admin') fail('VALIDATION', 'You cannot remove your own principal role');
    if (s.role === 'admin' && !otherOpenPrincipal(db, s.id)) fail('VALIDATION', 'This is the only principal; make someone else principal first');
    const r = routesStaffedBy(db, s.id);
    if (s.role === 'driver' && r.length) fail('VALIDATION', `This driver is on ${r.map(x => x.name).join(', ')}; give the route another driver first`);
  }
  let programIds = [];
  if (role === 'teacher') {
    programIds = has('programIds') ? idList(input.programIds, 'Classes') : [...(s.programIds || [])];
    for (const pid of programIds) {
      const p = byId(db.programs, pid);
      if (!p) fail('NOT_FOUND', 'Class not found');
      if (!isOpen(p) && !(s?.programIds || []).includes(pid)) fail('VALIDATION', `${p.name} is closed`);
    }
  }
  const changes = [];
  let doc = s;
  const touched = [...programIds, ...(s?.programIds || [])];
  if (!doc) {
    doc = { id: newId('stf'), firstName, lastName, role, programIds, phone, email };
    db.staff.push(doc);
  } else {
    for (const [k, v] of Object.entries({ firstName, lastName, role, phone, email })) if ((doc[k] ?? '') !== v) changes.push(k === 'role' ? `role ${doc.role} → ${role}` : k);
    if (JSON.stringify(doc.programIds || []) !== JSON.stringify(programIds)) changes.push(`classes ${programIds.join(',') || '-'}`);
    Object.assign(doc, { firstName, lastName, role, phone, email, programIds });
  }
  syncMirrors(db, touched);
  appendAudit(db, ctx, { entity: 'staff', entityId: doc.id, action: s ? 'update' : 'add', summary: s ? changes.join('; ') || 'no change' : `added as ${role}${programIds.length ? ` (classes ${programIds.join(',')})` : ''}` });
  return { ...doc, name: fullName(doc) };
}

/**
 * setStaffActive({staffId, active}) — take someone off the staff (they leave their classes and the persona list; never
 * yourself, never the only principal, never while they drive a route), or bring them back. In the real app their sign-in
 * is blocked on the account desk: this record alone does not close a sign-in that is already linked.
 */
export function setStaffActive(db, { staffId, active } = {}, ctx) {
  const s = byId(db.staff, staffId);
  if (!s) fail('NOT_FOUND', 'Staff member not found');
  if (typeof active !== 'boolean') fail('VALIDATION', 'active must be true or false');
  let summary = 'back on the staff';
  if (!active) {
    if (s.id === ctx.actor.id) fail('VALIDATION', 'You cannot take yourself off the staff');
    if (s.role === 'admin' && !otherOpenPrincipal(db, s.id)) fail('VALIDATION', 'This is the only principal; make someone else principal first');
    const r = routesStaffedBy(db, s.id);
    if (r.length) fail('VALIDATION', `This person is on ${r.map(x => x.name).join(', ')}; give the route someone else first`);
    const left = [...(s.programIds || [])];
    s.programIds = [];
    syncMirrors(db, left);
    s.active = false;
    summary = `off the staff${left.length ? `; left classes ${left.join(',')}` : ''}`;
  } else delete s.active;
  appendAudit(db, ctx, { entity: 'staff', entityId: s.id, action: active ? 'reactivate' : 'deactivate', summary });
  return { ...s, name: fullName(s) };
}

// ---------------------------------------------------------------- bus routes and stops

function openDriver(db, id, label) {
  const s = byId(db.staff, id);
  if (!s) fail('NOT_FOUND', `${label} not found`);
  if (s.role !== 'driver') fail('VALIDATION', `${fullName(s)} is not a driver`);
  if (!isOpen(s)) fail('VALIDATION', `${fullName(s)} is no longer on the staff`);
  return s;
}
function openRoute(db, routeId) {
  const r = byId(db.routes, routeId);
  if (!r) fail('NOT_FOUND', 'Route not found');
  if (!isOpen(r)) fail('VALIDATION', 'This route is closed; reopen it first');
  return r;
}

/** saveRoute({id?, name, busNo, driverId, attendantId?, transportFeePaise}) — add a route (no stops yet), or edit one. */
export function saveRoute(db, input, ctx) {
  only(input, ['id', 'name', 'busNo', 'driverId', 'attendantId', 'transportFeePaise']);
  const r = input.id ? openRoute(db, input.id) : null;
  const has = k => k in input || !r;
  const name = has('name') ? str(input.name, 'The route name', 60, true) : r.name;
  if (db.routes.some(x => x.id !== r?.id && sameText(x.name, name))) fail('VALIDATION', `There is already a route called ${name}`);
  const busNo = has('busNo') ? str(input.busNo, 'The bus number', 20, true) : r.busNo;
  const driverId = has('driverId') ? openDriver(db, input.driverId, 'Driver').id : r.driverId;
  const attendantId = has('attendantId') ? (input.attendantId ? openDriver(db, input.attendantId, 'Attendant').id : null) : r.attendantId;
  if (attendantId && attendantId === driverId) fail('VALIDATION', 'The attendant must be someone other than the driver');
  const fee = has('transportFeePaise') ? input.transportFeePaise : r.transportFeePaise;
  if (!Number.isSafeInteger(fee) || fee < 0) fail('VALIDATION', 'The transport fee must be a whole number of paise, zero or more');
  if (r && runningTrip(db, r.id) && (driverId !== r.driverId || attendantId !== (r.attendantId ?? null))) fail('VALIDATION', 'A trip is running on this route; change the driver or attendant after it ends');
  const changes = [];
  let doc = r;
  if (!doc) {
    doc = { id: newId('route'), name, busNo, driverId, attendantId, transportFeePaise: fee, stops: [], path: null };
    db.routes.push(doc);
  } else {
    const next = { name, busNo, driverId, attendantId, transportFeePaise: fee };
    for (const [k, v] of Object.entries(next)) if ((doc[k] ?? null) !== v) changes.push(k === 'driverId' || k === 'attendantId' ? `${k} ${doc[k] || '-'} → ${v || '-'}` : k);
    Object.assign(doc, next);
  }
  appendAudit(db, ctx, { entity: 'route', entityId: doc.id, action: r ? 'update' : 'add', summary: r ? changes.join('; ') || 'no change' : `route added (driver ${driverId})` });
  return { ...doc };
}

/** setRouteActive({routeId, active}) — close a route no active child rides and no trip is running on, or reopen it. */
export function setRouteActive(db, { routeId, active } = {}, ctx) {
  const r = byId(db.routes, routeId);
  if (!r) fail('NOT_FOUND', 'Route not found');
  if (typeof active !== 'boolean') fail('VALIDATION', 'active must be true or false');
  if (!active) {
    const n = activeStudents(db).filter(s => s.routeId === r.id).length;
    if (n) fail('VALIDATION', `${n} ${n === 1 ? 'child rides' : 'children ride'} this route; move them first`);
    if (runningTrip(db, r.id)) fail('VALIDATION', 'A trip is running on this route; close it after the trip ends');
    r.active = false;
  } else {
    openDriver(db, r.driverId, 'Driver');
    delete r.active;
  }
  appendAudit(db, ctx, { entity: 'route', entityId: r.id, action: active ? 'reopen' : 'close', summary: active ? 'reopened' : 'closed' });
  return { ...r };
}

function coord(v, label, lo, hi) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < lo || n > hi) fail('VALIDATION', `${label} must be a number from ${lo} to ${hi}`);
  return n;
}
/** Put the stops in seq order with seq 1..n, `moved` at position `at` (1-based). */
function reorder(route, moved, at) {
  const rest = stopsInOrder(route).filter(x => x !== moved);
  rest.splice(at - 1, 0, moved);
  rest.forEach((x, i) => { x.seq = i + 1; });
  route.stops = rest;
}

/**
 * saveStop({routeId, id?, name, lat, lng, scheduledPickup, scheduledDrop, seq?}) — add a stop (at the end unless seq is
 * given) or edit one; seq moves it and renumbers the rest. Not while a trip is running on the route. A change to the
 * stops drops the drawn road path (the map then joins the stops).
 */
export function saveStop(db, input, ctx) {
  only(input, ['routeId', 'id', 'name', 'lat', 'lng', 'seq', 'scheduledPickup', 'scheduledDrop']);
  const r = openRoute(db, input.routeId);
  if (runningTrip(db, r.id)) fail('VALIDATION', 'A trip is running on this route; change its stops after the trip ends');
  const st = input.id ? r.stops.find(x => x.id === input.id) : null;
  if (input.id && !st) fail('NOT_FOUND', 'Stop not found');
  const has = k => k in input || !st;
  const name = has('name') ? str(input.name, 'The stop name', 60, true) : st.name;
  if (r.stops.some(x => x !== st && sameText(x.name, name))) fail('VALIDATION', `This route already has a stop called ${name}`);
  const lat = has('lat') ? coord(input.lat, 'Latitude', -90, 90) : st.lat;
  const lng = has('lng') ? coord(input.lng, 'Longitude', -180, 180) : st.lng;
  const time = (k, label) => {
    if (!has(k)) return st[k];
    const t = String(input[k] ?? '').trim();
    if (!isHHMM(t)) fail('VALIDATION', `${label} must be a time like 07:45`);
    return t;
  };
  const scheduledPickup = time('scheduledPickup', 'The pick-up time'), scheduledDrop = time('scheduledDrop', 'The drop time');
  const n = r.stops.length + (st ? 0 : 1);
  const seq = 'seq' in input ? Number(input.seq) : st ? st.seq : n;
  if (!Number.isInteger(seq) || seq < 1 || seq > n) fail('VALIDATION', `The position must be from 1 to ${n}`);
  const changes = [];
  let doc = st;
  if (!doc) {
    doc = { id: newId(`${r.id}-stop`), name, lat, lng, seq, scheduledPickup, scheduledDrop };
    r.stops.push(doc);
  } else {
    for (const [k, v] of Object.entries({ name, lat, lng, scheduledPickup, scheduledDrop })) if (doc[k] !== v) changes.push(k === 'lat' || k === 'lng' ? 'position' : k);
    if (doc.seq !== seq) changes.push(`order ${doc.seq} → ${seq}`);
    Object.assign(doc, { name, lat, lng, scheduledPickup, scheduledDrop });
  }
  const moved = !st || changes.includes('position') || changes.some(c => c.startsWith('order'));
  reorder(r, doc, seq);
  if (moved) r.path = null;
  appendAudit(db, ctx, { entity: 'route', entityId: r.id, action: st ? 'updateStop' : 'addStop', summary: `stop ${doc.id}${st ? `: ${[...new Set(changes)].join('; ') || 'no change'}` : ` added at ${seq}`}` });
  return { ...doc };
}

/** removeStop({routeId, stopId}) — only a stop no child is assigned to and no trip has recorded. */
export function removeStop(db, { routeId, stopId } = {}, ctx) {
  const r = openRoute(db, routeId);
  const st = r.stops.find(x => x.id === stopId);
  if (!st) fail('NOT_FOUND', 'Stop not found');
  if (runningTrip(db, r.id)) fail('VALIDATION', 'A trip is running on this route; change its stops after the trip ends');
  const kids = db.students.filter(s => s.stopId === st.id).length;
  if (kids) fail('VALIDATION', `${kids} ${kids === 1 ? 'child is' : 'children are'} assigned to this stop (including children who left); move them first`);
  const used = (db.trips || []).some(t => t.routeId === r.id && [...(t.stopEvents || []), ...(t.childEvents || [])].some(e => e.stopId === st.id));
  if (used) fail('VALIDATION', 'Trips have been recorded at this stop, so it stays in the history; rename or move it instead');
  r.stops = r.stops.filter(x => x !== st);
  stopsInOrder(r).forEach((x, i) => { x.seq = i + 1; });
  r.stops = stopsInOrder(r);
  r.path = null;
  appendAudit(db, ctx, { entity: 'route', entityId: r.id, action: 'removeStop', summary: `stop ${st.id} removed` });
  return { ...r };
}

/**
 * setStopPosition({routeId, stopId, lat, lng, accuracy}) — the bus's own GPS fix becomes the stop's position (the driver
 * or the principal, standing at the stop). Refused when the fix is less accurate than 25 m. Allowed during a trip: it is
 * meant for the first run of a route.
 */
export function setStopPosition(db, { routeId, stopId, lat, lng, accuracy } = {}, ctx) {
  const r = openRoute(db, routeId);
  const st = r.stops.find(x => x.id === stopId);
  if (!st) fail('NOT_FOUND', 'Stop not found');
  if (typeof accuracy !== 'number' || !Number.isFinite(accuracy) || accuracy < 0) fail('VALIDATION', 'The position has no accuracy reading');
  if (accuracy > STOP_FIX_MAX_ACCURACY_M) fail('VALIDATION', `The GPS reading is only accurate to ${Math.round(accuracy)} m; wait until it is ${STOP_FIX_MAX_ACCURACY_M} m or better`);
  const fix = { lat: coord(lat, 'Latitude', -90, 90), lng: coord(lng, 'Longitude', -180, 180) };
  const d = Number.isFinite(st.lat) && Number.isFinite(st.lng) ? Math.round(haversineMeters(st, fix)) : null;
  Object.assign(st, fix);
  r.path = null;
  appendAudit(db, ctx, { entity: 'route', entityId: r.id, action: 'setStopPosition', summary: `stop ${st.id} position taken from GPS (accuracy ${Math.round(accuracy)} m${d === null ? '' : `, moved ${d} m`})` });
  return { ...st };
}

// ---------------------------------------------------------------- one new child

/** The form fields of a new admission: the import's children fields, less status and leaving date (a new child is active). */
export const CHILD_FIELDS = TARGET_FIELDS.children.filter(f => f !== 'status' && f !== 'leftOn');

/**
 * admitChild({admissionNo, firstName, lastName, dob, program, route?, stop?, guardian1Name, …}) — one new child, checked
 * by the import's own rules (validateRows/applyRows: the same date, phone, email and duplicate checks, and a parent
 * already in the app — same phone or email and name — is linked instead of added twice). program/route/stop take ids.
 * @returns {{student, guardiansCreated:number, guardiansLinked:number}}
 */
export function admitChild(db, input, ctx) {
  only(input, CHILD_FIELDS);
  const prog = byId(db.programs, String(input.program ?? ''));
  if (prog && !isOpen(prog)) fail('VALIDATION', `${prog.name} is closed`);
  const mapping = Object.fromEntries(CHILD_FIELDS.map(f => [f, f]));
  const values = Object.fromEntries(CHILD_FIELDS.map(f => [f, String(input[f] ?? '')]));
  const nStudents = db.students.length, nGuardians = db.guardians.length, nAudit = db.auditLog.length;
  const res = applyRows(db, { kind: 'children', mapping, rows: [{ line: 1, values }] }, null, ctx);
  const row = res.rows[0];
  if (row.status === 'duplicate') fail('VALIDATION', `This child is already in the app (admission number ${values.admissionNo.trim()})`);
  if (row.status !== 'ok') fail('VALIDATION', `Not added: ${row.reason}`);
  const s = db.students[nStudents];
  Object.assign(s, { source: 'app', importBatchId: null });
  for (const g of db.guardians.slice(nGuardians)) Object.assign(g, { source: 'app', importBatchId: null });
  // applyRows wrote an import audit row; this was an admission, so the row says so
  Object.assign(db.auditLog[nAudit], { entity: 'student', entityId: s.id, action: 'admit',
    summary: `admitted to ${s.programId}: ${res.created.guardians} new guardian(s), ${res.merged.guardians} already in the app` });
  return { student: { ...s, name: fullName(s) }, guardiansCreated: res.created.guardians, guardiansLinked: res.merged.guardians };
}
