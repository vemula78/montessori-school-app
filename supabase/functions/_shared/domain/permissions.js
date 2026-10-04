// The permission matrix: who can read and do what, checked three ways so the screen cannot drift from the truth.
//   (a) tests/admin-domain.test.mjs evaluates every `js` probe on the seed (evaluateJs below: the command registry's
//       authorize with the server's persona rules, or a read rule) and asserts it equals `allow`;
//   (b) scripts/permissions-sql.mjs turns every `sql` probe into pgTAP (supabase/tests/permissions.test.sql), run as the
//       seeded users with the JWT `aal` claim set, so RLS itself is probed cell by cell;
//   (c) npm run check-domain fails when that generated file is out of date.
// The Oversight screen shows PERMISSIONS as it is (plain data: no functions inside).
// A read probe answers "does this actor see at least one such row" on the seed plus FIXTURE (a cell of a capability the
// seed has no row for would always read "no").

import { CONSENT_VERSION, COMMANDS, personaFor, consentScopedPersona, ctxFor, STAFF_SEES_ALL } from './commands.js';
import { twoStepRequired } from './admin.js';
import { byId } from './people.js';

/** The seeded sign-ins the matrix runs as (scripts/seed-sql.mjs SEED_USERS; the no-consent parent is made by the test). */
export const MATRIX_ACTORS = {
  principal_aal2: { userId: '00000000-0000-4000-8000-000000000001', link: { role: 'admin', staffId: 'stf-principal', guardianId: null }, aal: 'aal2', enrolled: true },
  principal_aal1_enrolled: { userId: '00000000-0000-4000-8000-000000000001', link: { role: 'admin', staffId: 'stf-principal', guardianId: null }, aal: 'aal1', enrolled: true },
  teacher: { userId: '00000000-0000-4000-8000-000000000002', link: { role: 'teacher', staffId: 'stf-teacher-pa', guardianId: null }, aal: 'aal1', enrolled: false },
  accountant: { userId: '00000000-0000-4000-8000-000000000003', link: { role: 'accountant', staffId: 'stf-accountant', guardianId: null }, aal: 'aal1', enrolled: false },
  driver: { userId: '00000000-0000-4000-8000-000000000004', link: { role: 'driver', staffId: 'stf-driver-1', guardianId: null }, aal: 'aal1', enrolled: false },
  parent_consented: { userId: '00000000-0000-4000-8000-000000000006', link: { role: 'parent', staffId: null, guardianId: 'grd-02' }, aal: 'aal1', enrolled: false },
  parent_no_consent: { userId: '00000000-0000-4000-8000-0000000000c4', email: 'grd03-matrix@example.com', link: { role: 'parent', staffId: null, guardianId: 'grd-03' }, aal: 'aal1', enrolled: false },
};

/** Rows the seed lacks for some cells (fake): added by the pgTAP file inside its transaction and by the JS test to its copy. */
export const FIXTURE = {
  healthNotes: { 'stu-04': 'Fake matrix note: no nuts.' },
  signInEvents: [{ userId: '00000000-0000-4000-8000-000000000006', aal: 'aal1' }],
  dataRequests: [
    { id: 'drq-matrix-1', guardianId: 'grd-01', kind: 'export', details: '', status: 'open' },
    { id: 'drq-matrix-2', guardianId: 'grd-02', kind: 'correction', details: 'Fake: phone number changed.', status: 'open' },
  ],
};

const Y = true, N = false;
const row = (p2, p1, t, a, d, pc, pn) => ({ principal_aal2: p2, principal_aal1_enrolled: p1, teacher: t, accountant: a, driver: d, parent_consented: pc, parent_no_consent: pn });
const TODAY = '$today'; // replaced by the evaluation date

export const PERMISSIONS = {
  actors: [
    { key: 'principal_aal2', label: 'Principal (two-step done)' },
    { key: 'principal_aal1_enrolled', label: 'Principal (two-step set up, not done this session)' },
    { key: 'teacher', label: 'Teacher (own programme)' },
    { key: 'accountant', label: 'Accountant' },
    { key: 'driver', label: 'Driver (own route)' },
    { key: 'parent_consented', label: 'Parent (privacy notice accepted)' },
    { key: 'parent_no_consent', label: 'Parent (notice not yet accepted)' },
  ],
  capabilities: [
    // ---- reads (RLS)
    { key: 'children_records', label: "Children's records (name, class, date of birth)", allow: row(Y, N, Y, Y, Y, Y, N),
      js: { kind: 'read', name: 'children' }, sql: 'select count(*) from public.students' },
    { key: 'health_notes', label: 'Health notes', allow: row(Y, N, Y, N, N, Y, N),
      js: { kind: 'read', name: 'healthNotes' }, sql: 'select count(*) from public.student_health' },
    { key: 'guardian_contacts', label: "Other families' guardian details (name, phone, email)", allow: row(Y, N, Y, Y, N, N, N),
      js: { kind: 'read', name: 'otherGuardians' }, sql: "select count(*) from public.guardians where id <> coalesce(app.my_guardian_id(), '')" },
    { key: 'staff_phones', label: "Other staff members' phone numbers", allow: row(Y, N, N, N, N, N, N),
      js: { kind: 'read', name: 'staffPhones' }, sql: "select count(*) from public.staff_contacts where staff_id <> coalesce(app.my_staff_id(), '') and phone is not null" },
    { key: 'fees', label: 'Fees (invoices and receipts)', allow: row(Y, N, N, Y, N, Y, N),
      js: { kind: 'read', name: 'fees' }, sql: 'select count(*) from public.invoices' },
    { key: 'attendance', label: 'Attendance', allow: row(Y, N, Y, N, N, Y, N),
      js: { kind: 'read', name: 'attendance' }, sql: 'select count(*) from public.attendance' },
    { key: 'observations_unshared', label: "Teachers' notes not yet shared", allow: row(Y, N, Y, N, N, N, N),
      js: { kind: 'read', name: 'unsharedObservations' }, sql: 'select count(*) from public.observations where shared_at is null' },
    { key: 'observations_shared', label: 'Shared observations', allow: row(Y, N, Y, N, N, Y, N),
      js: { kind: 'read', name: 'sharedObservations' }, sql: 'select count(*) from public.observations where shared_at is not null' },
    { key: 'progress', label: 'Progress records', allow: row(Y, N, Y, N, N, N, N),
      js: { kind: 'read', name: 'progress' }, sql: 'select count(*) from public.progress_events' },
    { key: 'consents_all', label: "Every family's consent records", allow: row(Y, N, N, N, N, N, N),
      js: { kind: 'read', name: 'otherConsents' }, sql: "select count(*) from public.consents where guardian_id <> coalesce(app.my_guardian_id(), '')" },
    { key: 'audit_log', label: 'Audit log', allow: row(Y, N, N, Y, N, N, N),
      js: { kind: 'read', name: 'auditLog' }, sql: 'select count(*) from public.audit_log' },
    { key: 'sign_in_activity', label: 'Sign-in activity', allow: row(Y, N, N, N, N, N, N),
      js: { kind: 'read', name: 'signInActivity' }, sql: 'select count(*) from public.sign_in_events' },
    { key: 'data_requests_all', label: "Every family's data requests", allow: row(Y, N, N, N, N, N, N),
      js: { kind: 'read', name: 'otherDataRequests' }, sql: "select count(*) from public.data_requests where guardian_id <> coalesce(app.my_guardian_id(), '')" },
    { key: 'curriculum', label: 'Curriculum', allow: row(Y, N, Y, N, N, N, N),
      js: { kind: 'read', name: 'curriculum' }, sql: 'select count(*) from public.presentations' },
    { key: 'bus_positions', label: 'Bus trips and positions', allow: row(Y, N, N, Y, Y, Y, N),
      js: { kind: 'read', name: 'busPositions' }, sql: 'select count(*) from public.trip_positions' },
    // ---- actions (the command registry, as the server runs it)
    { key: 'record_payment', label: 'Record a payment', allow: row(Y, N, N, Y, N, N, N),
      js: { kind: 'command', name: 'fees.recordPayment', args: [{ studentId: 'stu-03', amountPaise: 100, mode: 'cash', paidOn: TODAY }] }, sql: null },
    { key: 'school_notice', label: 'Send a school-wide notice', allow: row(Y, N, N, N, N, N, N),
      js: { kind: 'command', name: 'notices.send', args: [{ title: 'x', body: 'x', audience: { scope: 'school' } }] }, sql: null },
    { key: 'mark_attendance', label: 'Mark attendance', allow: row(Y, N, Y, N, N, N, N),
      js: { kind: 'command', name: 'attendance.mark', args: [TODAY, [{ studentId: 'stu-04', status: 'present' }]] }, sql: null },
    { key: 'change_staff_role', label: "Change a staff member's role", allow: row(Y, N, N, N, N, N, N),
      js: { kind: 'command', name: 'people.setStaffRole', args: [{ staffId: 'stf-driver-2', role: 'driver' }] }, sql: null },
    { key: 'block_account', label: 'Block a sign-in', allow: row(Y, N, N, N, N, N, N),
      js: { kind: 'command', name: 'admin.blockUser', args: ['00000000-0000-4000-8000-000000000006'] }, sql: null },
    { key: 'file_data_request', label: 'File a data request (own data)', allow: row(N, N, N, N, N, Y, Y),
      js: { kind: 'command', name: 'rights.file', args: [{ kind: 'export' }] }, sql: null },
    { key: 'set_announcement', label: 'Set the school announcement', allow: row(Y, N, N, N, N, N, N),
      js: { kind: 'command', name: 'admin.setAnnouncement', args: [{ text: 'x' }] }, sql: null },
    { key: 'export_family', label: "Download a family's data (grd-02)", allow: row(Y, N, N, N, N, Y, N),
      js: { kind: 'command', name: 'admin.dataExport', args: ['grd-02'] }, sql: null },
  ],
};

// ---------------------------------------------------------------- JS evaluation (the registry and the read rules)

const anyOf = (list, pred) => (list || []).some(pred);
const learner = (p, sid) => p.role === 'admin' || ((p.role === 'teacher' || p.role === 'parent') && p.studentIds.includes(sid));
/** Read rules as RLS states them (migrations 0001–0008), over the persona's scope. */
const READS = {
  children: (db, p) => STAFF_SEES_ALL.includes(p.role) || p.studentIds.length > 0,
  healthNotes: (db, p) => ['admin', 'teacher', 'parent'].includes(p.role) && anyOf(db.students, s => s.healthNotes && (p.role === 'admin' || p.studentIds.includes(s.id))),
  otherGuardians: (db, p) => STAFF_SEES_ALL.includes(p.role) ? db.guardians.length > 0
    : p.role === 'teacher' && anyOf(db.students, s => p.studentIds.includes(s.id) && (s.guardianIds || []).length > 0),
  staffPhones: (db, p) => p.role === 'admin' && anyOf(db.staff, s => s.id !== p.staffId && s.phone),
  fees: (db, p) => anyOf(db.invoices, i => STAFF_SEES_ALL.includes(p.role) || (p.role === 'parent' && p.studentIds.includes(i.studentId))),
  attendance: (db, p) => anyOf(db.attendance, a => ['admin', 'teacher', 'parent'].includes(p.role) && (p.role === 'admin' || p.studentIds.includes(a.studentId))),
  unsharedObservations: (db, p) => p.role !== 'parent' && anyOf(db.observations, o => !o.sharedAt && learner(p, o.studentId)),
  sharedObservations: (db, p) => anyOf(db.observations, o => o.sharedAt && learner(p, o.studentId)),
  progress: (db, p) => p.role !== 'parent' && anyOf(db.progressEvents, e => learner(p, e.studentId)),
  otherConsents: (db, p) => p.role === 'admin' && db.consents.length > 0,
  auditLog: (db, p) => STAFF_SEES_ALL.includes(p.role),
  signInActivity: (db, p, extra) => p.role === 'admin' && extra.signInEvents.length > 0,
  otherDataRequests: (db, p) => p.role === 'admin' && db.dataRequests.length > 0,
  curriculum: (db, p) => ['admin', 'teacher'].includes(p.role) && db.presentations.length > 0,
  busPositions: (db, p) => anyOf(db.trips, t => (t.positions || []).length > 0 && (STAFF_SEES_ALL.includes(p.role)
    || (p.role === 'driver' && anyOf(db.routes, r => r.id === t.routeId && (r.driverId === p.staffId || r.attendantId === p.staffId)))
    || (p.role === 'parent' && anyOf(db.students, s => s.routeId === t.routeId && p.studentIds.includes(s.id)
      && anyOf(db.consents, c => c.guardianId === p.guardianId && c.studentId === s.id && c.purpose === 'bus_live' && c.version === CONSENT_VERSION && !c.withdrawnAt))))),
};

const fill = (v, today) => (v === TODAY ? today : Array.isArray(v) ? v.map(x => fill(x, today)) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, today)])) : v);

/**
 * Would this actor be allowed this capability, in JS? The server's order: the two-step rule, the persona from the link,
 * a parent narrowed to children with live app_account consent (unless the command runs before consent), then the read
 * rule or the command's authorize.
 * @param {{now:string, today:string, policyRequired?:boolean, signInEvents?:object[]}} at
 */
export function evaluateJs(db, actorKey, capKey, { now, today, policyRequired = false, signInEvents = [] }) {
  const a = MATRIX_ACTORS[actorKey];
  const cap = PERMISSIONS.capabilities.find(c => c.key === capKey);
  if (!a || !cap) throw new Error(`unknown actor or capability: ${actorKey} / ${capKey}`);
  if (twoStepRequired({ role: a.link.role, aal: a.aal, enrolled: a.enrolled, policyRequired })) return false;
  let p = personaFor(db, a.link);
  if (!p) return false;
  const full = cap.js.kind === 'command' && COMMANDS[cap.js.name].beforeConsent;
  if (p.role === 'parent' && !full) {
    p = consentScopedPersona(db, p, db.consents);
    if (!p.studentIds.length) return false; // the server refuses every such call; RLS shows no child data
  }
  if (cap.js.kind === 'read') return READS[cap.js.name](db, p, { signInEvents });
  try {
    COMMANDS[cap.js.name].authorize(p, db, fill(cap.js.args, today), { ...ctxFor(p, now, today), userId: a.userId });
    return true;
  } catch (e) {
    if (e && (e.code === 'NOT_ALLOWED' || e.code === 'NOT_FOUND')) return false;
    throw e;
  }
}

/** The seed as the local database holds it, plus FIXTURE (for the JS side of the matrix). */
export function withFixture(db) {
  for (const [sid, notes] of Object.entries(FIXTURE.healthNotes)) { const s = byId(db.students, sid); if (s) s.healthNotes = notes; }
  for (const r of FIXTURE.dataRequests) db.dataRequests.push({ ...r, filedAt: '2026-10-01T05:00:00.000Z', filedBy: r.guardianId, updatedAt: '2026-10-01T05:00:00.000Z', resolution: null, decidedBy: null, decidedAt: null });
  return db;
}
