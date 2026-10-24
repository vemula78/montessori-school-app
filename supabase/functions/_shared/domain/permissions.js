// The permission matrix: who can read and do what, checked three ways so the screen cannot drift from the truth.
//   (a) tests/admin-domain.test.mjs evaluates every `js` probe on the seed (evaluateJs below: the command registry's
//       authorize with the server's persona rules, or a read rule) and asserts it equals `allow`;
//   (b) scripts/permissions-sql.mjs turns every `sql` probe (the READ rows) into pgTAP (supabase/tests/permissions.test.sql),
//       run as the seeded users with the JWT `aal` claim set, so RLS itself is probed cell by cell. The ACTION rows have no
//       SQL probe: they are checked against the registry's authorize, and tests-supabase/admin.test.mjs sends every denied
//       action cell of the teacher and the aal1 principal to the command function;
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
  // schema v4 (care): one row of each for stu-04 (Primary A, grd-02), whatever day the seed was generated on
  care: {
    leaveRequests: [{ id: 'lv-matrix-1', studentId: 'stu-04', guardianId: 'grd-02', fromDate: '2026-10-05', toDate: '2026-10-05', reason: '', status: 'active',
      createdAt: '2026-10-01T05:00:00.000Z', seenBy: null, seenAt: null, withdrawnAt: null },
    // a route-1 child's absence still to come (wave 2: the driver reads its dates)
    { id: 'lv-matrix-2', studentId: 'stu-01', guardianId: 'grd-01', fromDate: '2099-01-05', toDate: '2099-01-05', reason: 'Fake matrix reason', status: 'active',
      createdAt: '2026-10-01T05:00:00.000Z', seenBy: null, seenAt: null, withdrawnAt: null }],
    pickupContacts: [{ id: 'pkc-matrix-1', studentId: 'stu-04', name: 'Matrix Demoson', relation: 'Uncle', phone: '+91-90000-00399', status: 'active',
      addedBy: 'grd-02', addedByRole: 'parent', addedAt: '2026-10-01T05:00:00.000Z', removedBy: null, removedAt: null }],
    pickups: [{ id: 'pck-2026-10-01-stu-04', studentId: 'stu-04', date: '2026-10-01', kind: 'guardian', personId: 'grd-02', name: null, note: '', time: '15:30',
      at: '2026-10-01T10:00:00.000Z', recordedBy: 'stf-teacher-pa', correctedAt: null }],
  },
  // schema v5: a published progress report of stu-04 (grd-02's child, Primary A) and a signature of the Primary B teacher
  // (the local database holds no demo signature rows: they have no stored image)
  v5: {
    evaluations: [{ id: 'evl-AY2025-26-stu-04', studentId: 'stu-04', academicYearId: 'AY2025-26', level: 'mont1', programId: 'prog-primary-a', ratings: {},
      attendance: { workingDays: 10, present: 9, unmarked: 0, source: 'register', from: '2025-06-01', to: '2025-06-14', reason: null }, remarks: '', status: 'published', revision: 4,
      createdBy: 'stf-teacher-pa', createdAt: '2026-05-01T05:00:00.000Z', updatedBy: 'stf-principal', updatedAt: '2026-05-20T05:00:00.000Z', submittedBy: 'stf-teacher-pa',
      submittedAt: '2026-05-10T05:00:00.000Z', publishedBy: 'stf-principal', publishedAt: '2026-05-20T05:00:00.000Z', lastPublishedAt: null, unpublishedReason: null,
      signers: { teacherIds: ['stf-teacher-pa'], centerHeadId: 'stf-principal' } }],
    signatures: [{ id: 'sig-matrix-1', ownerKind: 'staff', staffId: 'stf-teacher-pb', path: 'sig/matrix-1.png', mime: 'image/png', bytes: 100, sha256: null, width: 30, height: 10,
      status: 'ready', uploadedBy: 'stf-principal', uploadedAt: '2026-06-01T05:00:00.000Z', removedBy: null, removedAt: null, objectDeletedAt: null }],
  },
};
/** Table of each care collection (scripts/permissions-sql.mjs inserts FIXTURE.care there). */
export const CARE_TABLES = { leaveRequests: 'leave_requests', pickupContacts: 'pickup_contacts', pickups: 'pickups' };
/** Table of each v5 fixture collection. */
export const V5_TABLES = { evaluations: 'evaluations', signatures: 'signatures' };

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
    { key: 'account_audit', label: 'Account desk history (blocks, sign-outs, email changes)', allow: row(Y, N, N, N, N, N, N),
      js: { kind: 'read', name: 'accountAudit' }, sql: "select count(*) from public.audit_log where entity = 'appUser'" },
    { key: 'sign_in_activity', label: 'Sign-in activity', allow: row(Y, N, N, N, N, N, N),
      js: { kind: 'read', name: 'signInActivity' }, sql: 'select count(*) from public.sign_in_events' },
    { key: 'data_requests_all', label: "Every family's data requests", allow: row(Y, N, N, N, N, N, N),
      js: { kind: 'read', name: 'otherDataRequests' }, sql: "select count(*) from public.data_requests where guardian_id <> coalesce(app.my_guardian_id(), '')" },
    { key: 'absences_reported', label: 'Absences parents reported', allow: row(Y, N, Y, N, N, Y, N),
      js: { kind: 'read', name: 'leaveRequests' }, sql: 'select count(*) from public.leave_requests' },
    { key: 'pickup_people', label: 'People allowed to collect a child (names and phone numbers)', allow: row(Y, N, Y, N, Y, Y, N),
      js: { kind: 'read', name: 'pickupContacts' }, sql: 'select count(*) from public.pickup_contacts' },
    { key: 'pickup_log', label: 'Who collected each child', allow: row(Y, N, Y, N, N, Y, N),
      js: { kind: 'read', name: 'pickups' }, sql: 'select count(*) from public.pickups' },
    { key: 'route_absences', label: 'Dates of absences reported for children on the route (no reasons)', allow: row(Y, N, N, N, Y, N, N),
      js: { kind: 'read', name: 'routeAbsences' }, sql: 'select count(*) from public.leave_days' },
    { key: 'bus_child_events', label: "Children's boarding and drop-off marks", allow: row(Y, N, Y, Y, Y, Y, N),
      js: { kind: 'read', name: 'busChildEvents' }, sql: 'select count(*) from public.trip_child_events' },
    { key: 'progress_reports_unpublished', label: 'Annual progress reports not yet published', allow: row(Y, N, Y, N, N, N, N),
      js: { kind: 'read', name: 'unpublishedEvaluations' }, sql: "select count(*) from public.evaluations where status <> 'published'" },
    { key: 'progress_reports_published', label: 'Published annual progress reports', allow: row(Y, N, Y, N, N, Y, N),
      js: { kind: 'read', name: 'publishedEvaluations' }, sql: "select count(*) from public.evaluations where status = 'published'" },
    { key: 'signatures_others', label: "Other staff members' signature records", allow: row(Y, N, N, N, N, N, N),
      js: { kind: 'read', name: 'otherSignatures' }, sql: "select count(*) from public.signatures where coalesce(staff_id, '') <> coalesce(app.my_staff_id(), '')" },
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
    { key: 'school_setup', label: 'Set up classes, staff and bus routes', allow: row(Y, N, N, N, N, N, N),
      js: { kind: 'command', name: 'setup.saveProgram', args: [{ name: 'Matrix class' }] }, sql: null },
    { key: 'block_account', label: 'Block a sign-in', allow: row(Y, N, N, N, N, N, N),
      js: { kind: 'command', name: 'admin.blockUser', args: ['00000000-0000-4000-8000-000000000006'] }, sql: null },
    { key: 'file_data_request', label: 'File a data request (own data)', allow: row(N, N, N, N, N, Y, Y),
      js: { kind: 'command', name: 'rights.file', args: [{ kind: 'export' }] }, sql: null },
    { key: 'set_announcement', label: 'Set the school announcement', allow: row(Y, N, N, N, N, N, N),
      js: { kind: 'command', name: 'admin.setAnnouncement', args: [{ text: 'x' }] }, sql: null },
    { key: 'report_absence', label: 'Report an absence (own child)', allow: row(N, N, N, N, N, Y, N),
      js: { kind: 'command', name: 'leave.request', args: [{ studentId: 'stu-04', fromDate: TODAY, toDate: TODAY }] }, sql: null },
    { key: 'record_pickup', label: 'Record who collected a child', allow: row(Y, N, Y, N, N, N, N),
      js: { kind: 'command', name: 'pickup.record', args: [{ studentId: 'stu-04', date: TODAY, collectedBy: { kind: 'guardian', id: 'grd-02' } }] }, sql: null },
    { key: 'start_progress_report', label: 'Start an annual progress report', allow: row(Y, N, Y, N, N, N, N),
      js: { kind: 'command', name: 'evaluations.start', args: [{ studentId: 'stu-04', academicYearId: 'AY2026-27' }] }, sql: null },
    { key: 'publish_progress_report', label: 'Publish or unpublish an annual progress report', allow: row(Y, N, N, N, N, N, N),
      js: { kind: 'command', name: 'evaluations.unpublish', args: ['evl-AY2025-26-stu-04', 'matrix probe'] }, sql: null },
    { key: 'own_signature', label: 'Upload own signature (teacher-pa)', allow: row(Y, N, Y, N, N, N, N),
      js: { kind: 'command', name: 'signatures.uploadCheck', args: [{ owner: { kind: 'staff', staffId: 'stf-teacher-pa' } }] }, sql: null },
    { key: 'school_settings', label: 'Set the school details (report footer, privacy contact, office hours, UPI)', allow: row(Y, N, N, N, N, N, N),
      js: { kind: 'command', name: 'admin.setSchoolDetails', args: [{ directorName: 'Matrix Exampleton' }] }, sql: null },
    { key: 'running_late', label: 'Tell a bus route\'s families the bus is late (route 1)', allow: row(Y, N, N, N, Y, N, N),
      js: { kind: 'command', name: 'transport.runningLate', args: [{ routeId: 'route-1', kind: 'late10' }] }, sql: null },
    { key: 'set_health', label: "Set a child's allergies and medical alerts (stu-04)", allow: row(Y, N, N, N, N, Y, N),
      js: { kind: 'command', name: 'health.set', args: [{ studentId: 'stu-04', allergies: 'Fake: none known' }] }, sql: null },
    { key: 'export_family', label: "Download a family's data (grd-02)", allow: row(Y, N, N, N, N, Y, N),
      js: { kind: 'command', name: 'admin.dataExport', args: ['grd-02'] }, sql: null },
  ],
};

// ---------------------------------------------------------------- JS evaluation (the registry and the read rules)

const anyOf = (list, pred) => (list || []).some(pred);
const onMyRoute = (db, p, sid) => { const s = byId(db.students, sid); return Boolean(s && s.routeId && (p.routeIds || []).includes(s.routeId)); };
const learner = (p, sid) => p.role === 'admin' || ((p.role === 'teacher' || p.role === 'parent') && p.studentIds.includes(sid));
/** Read rules as RLS states them (migrations 0001–0011), over the persona's scope. */
const READS = {
  children: (db, p) => STAFF_SEES_ALL.includes(p.role) || p.studentIds.length > 0,
  healthNotes: (db, p) => ['admin', 'teacher', 'parent'].includes(p.role) && anyOf(db.students, s => (s.healthNotes || s.healthAlerts) && (p.role === 'admin' || p.studentIds.includes(s.id))),
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
  // the account desk's rows (entity appUser: links, blocks, email changes, sign-outs): the principal only (0008)
  accountAudit: (db, p) => p.role === 'admin' && db.auditLog.some(r => r.entity === 'appUser'),
  signInActivity: (db, p, extra) => p.role === 'admin' && extra.signInEvents.length > 0,
  otherDataRequests: (db, p) => p.role === 'admin' && db.dataRequests.length > 0,
  // schema v4 (0009): read like the diary
  leaveRequests: (db, p) => anyOf(db.leaveRequests, r => learner(p, r.studentId)),
  // wave 2 (0011): the driver reads the pick-up people of children on their own routes (who may receive a child at a stop)
  pickupContacts: (db, p) => anyOf(db.pickupContacts, r => learner(p, r.studentId) || (p.role === 'driver' && onMyRoute(db, p, r.studentId))),
  routeAbsences: (db, p, extra) => anyOf(db.leaveRequests, r => p.role === 'admin' || (p.role === 'driver' && r.status === 'active' && r.toDate >= extra.today && onMyRoute(db, p, r.studentId))),
  busChildEvents: (db, p) => anyOf(db.trips, t => anyOf(t.childEvents, e => STAFF_SEES_ALL.includes(p.role)
    || (p.role === 'driver' && (p.routeIds || []).includes(t.routeId))
    || (p.role === 'teacher' && p.studentIds.includes(e.studentId))
    || (p.role === 'parent' && p.studentIds.includes(e.studentId) && anyOf(db.consents, c => c.guardianId === p.guardianId && c.studentId === e.studentId && c.purpose === 'bus_live' && c.version === CONSENT_VERSION && !c.withdrawnAt)))),
  pickups: (db, p) => anyOf(db.pickups, r => learner(p, r.studentId)),
  // schema v5 (0010): evaluations read like termly reports; signature rows the principal, and a staff member their own
  unpublishedEvaluations: (db, p) => p.role !== 'parent' && anyOf(db.evaluations, e => e.status !== 'published' && learner(p, e.studentId)),
  publishedEvaluations: (db, p) => anyOf(db.evaluations, e => e.status === 'published' && learner(p, e.studentId)),
  otherSignatures: (db, p) => p.role === 'admin' && anyOf(db.signatures, x => (x.staffId || '') !== (p.staffId || '')),
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
  if (cap.js.kind === 'read') return READS[cap.js.name](db, p, { signInEvents, today });
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
  for (const [c, rows] of Object.entries(FIXTURE.care)) for (const r of rows) if (!db[c].some(x => x.id === r.id)) db[c].push({ ...r });
  for (const [c, rows] of Object.entries(FIXTURE.v5)) for (const r of rows) if (!db[c].some(x => x.id === r.id)) db[c].push(structuredClone(r));
  return db;
}
