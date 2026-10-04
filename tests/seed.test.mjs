import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSeed } from '../src/seed/seed-data.js';
import { validateDb } from '../src/domain/validate.js';
import { reconcile } from '../src/domain/reconcile.js';
import { invoiceView, outstandingReport } from '../src/domain/fees.js';
import { todayISO } from '../src/domain/dates.js';
import { createApi } from '../src/api/index.js';
import { memoryBackend } from '../src/store/storage.js';

// Fixed clock: the seed's attendance/diary/trip are relative to "today", fees use fixed dates.
const NOW = new Date(2026, 9, 2, 10, 0, 0); // 02-Oct-2026 10:00 local
const db = buildSeed(NOW);
const today = todayISO(NOW);

test('validateDb(buildSeed()) has zero violations', () => {
  const v = validateDb(db);
  assert.deepEqual(v, [], v.map(x => `${x.code} ${x.entity} ${x.id}: ${x.message}`).join('\n'));
});

test('seed meets the demo minimums', () => {
  const counts = {
    programs: db.programs.length,
    activeStudents: db.students.filter(s => s.status === 'active').length,
    teachers: db.staff.filter(s => s.role === 'teacher').length,
    accountants: db.staff.filter(s => s.role === 'accountant').length,
    admins: db.staff.filter(s => s.role === 'admin').length,
    routes: db.routes.length,
    payments: db.payments.length,
    notices: db.notices.length,
    threads: db.threads.length,
  };
  assert.equal(counts.programs, 3);
  assert.ok(counts.activeStudents >= 20, JSON.stringify(counts));
  assert.ok(counts.teachers >= 4 && counts.accountants >= 1 && counts.admins >= 1, JSON.stringify(counts));
  assert.equal(counts.routes, 2);
  for (const r of db.routes) assert.ok(r.stops.length >= 5 && r.stops.length <= 6, `${r.id} has ${r.stops.length} stops`);
  assert.ok(counts.payments >= 10 && counts.notices >= 6 && counts.threads >= 4, JSON.stringify(counts));
  assert.ok(db.academicYears.some(a => a.id === 'AY2026-27') && db.academicYears.some(a => a.id === 'AY2025-26'));
  assert.equal(db.school.currentAcademicYearId, 'AY2026-27');
});

test('seed contains the edge cases the demo relies on', () => {
  const progsOf = g => new Set(g.studentIds.map(id => db.students.find(s => s.id === id)?.programId));
  assert.ok(db.guardians.some(g => progsOf(g).size >= 2), 'guardian with children in two programs');
  const views = db.invoices.map(i => invoiceView(db, i, today));
  assert.ok(views.some(v => v.status === 'partiallyPaid'), 'partially paid invoice');
  assert.ok(views.some(v => v.overdueDays > 0), `overdue invoice as of ${today}`);
  assert.ok(db.payments.some(p => p.status === 'cancelled'), 'cancelled payment');
  assert.ok(db.refunds.length >= 1, 'refund');
  assert.ok(db.calendarEvents.some(e => e.type === 'holiday' && e.programIds.length > 0), 'program-specific holiday');
  assert.ok(db.trips.some(t => t.status === 'ended' && t.simulated), 'ended simulated trip');
  assert.ok(db.attendance.length > 0 && db.diaryEntries.length > 0, 'attendance and diary');
  assert.ok(db.students.filter(s => s.routeId).every(s => db.routes.find(r => r.id === s.routeId).stops.some(x => x.id === s.stopId)), 'bus students have a stop on their route');
});

test('all five reconciliation checks pass on the seed', () => {
  const r = reconcile(db, { asOfDate: today });
  assert.equal(r.checks.length, 5);
  for (const c of r.checks) assert.ok(c.ok, `${c.name}: expected ${c.expected}, actual ${c.actual}, mismatches ${JSON.stringify(c.mismatches)}`);
  const report = outstandingReport(db, { academicYearId: 'AY2026-27', asOfDate: today });
  assert.equal(report.rows.reduce((s, x) => s + x.balancePaise, 0), report.totals.balancePaise);
  for (const row of report.rows) assert.equal(row.invoicedPaise - row.concessionPaise - row.paidPaise, row.balancePaise, row.studentId);
});

test('receipt and invoice numbers are unique and contiguous per academic year', () => {
  const groups = {};
  for (const n of db.payments.map(p => p.receiptNumber).concat(db.invoices.map(i => i.number))) {
    const [prefix, ay, seq] = n.split('/');
    (groups[`${prefix}/${ay}`] ||= []).push(Number(seq));
  }
  for (const [k, ns] of Object.entries(groups)) {
    ns.sort((a, b) => a - b);
    assert.deepEqual(ns, ns.map((_, i) => i + 1), k);
  }
});

test('validateDb flags broken references, stops, statuses and number gaps', () => {
  const bad = structuredClone(db);
  const bus = bad.students.find(s => s.routeId);
  bus.stopId = null;                                        // bus student without a stop
  bad.guardians[0].studentIds.push('no-such-student');      // dangling reference
  const partial = bad.invoices.find(i => i.status === 'partiallyPaid');
  partial.status = 'paid';                                  // status disagrees with balance
  bad.payments.at(-1).receiptNumber = bad.payments[0].receiptNumber; // duplicate number
  const codes = new Set(validateDb(bad).map(v => v.code));
  for (const c of ['NO_STOP', 'BAD_REF', 'DUPLICATE_NUMBER']) assert.ok(codes.has(c), `${c} in ${[...codes]}`);
  const bad2 = structuredClone(db);
  bad2.invoices.find(i => i.status === 'partiallyPaid').status = 'paid';
  assert.ok(validateDb(bad2).some(v => v.code === 'STATUS_MISMATCH'));
  const bad3 = structuredClone(db);
  const last = bad3.payments.filter(p => p.receiptNumber.includes('/26-27/')).sort((a, b) => (a.receiptNumber < b.receiptNumber ? -1 : 1)).at(-1);
  const n = Number(last.receiptNumber.split('/')[2]);
  last.receiptNumber = `RCP/26-27/${String(n + 1).padStart(4, '0')}`; // skip one number; no references change
  bad3.counters.receipt['AY2026-27'] = n + 1;
  const v3 = validateDb(bad3);
  assert.ok(v3.some(v => v.code === 'NUMBER_GAP'), JSON.stringify(v3));
  assert.ok(!v3.some(v => v.code === 'BAD_REF'));
});

test('api: every persona\'s read endpoints work on the seed and stay scoped', async () => {
  const api = createApi({ backend: memoryBackend(), sessionBackend: memoryBackend(), seedFn: () => buildSeed(NOW), clock: () => NOW });
  await api.ready();
  const personas = api.session.personas();
  assert.deepEqual([...new Set(personas.map(p => p.role))].sort(), ['accountant', 'admin', 'driver', 'parent', 'teacher']);
  let parentInvoices = 0;
  for (const p of personas) {
    api.session.set(p.id);
    const students = await api.people.students();
    if (p.role === 'parent') assert.deepEqual(students.map(s => s.id).sort(), [...p.studentIds].sort(), p.label);
    const evs = await api.calendar.events({});
    if (p.role === 'parent' || p.role === 'teacher') {
      assert.ok(evs.every(e => e.type === 'birthday' ? p.studentIds.includes(e.studentId) : e.programIds.length === 0 || e.programIds.some(x => p.programIds.includes(x))), `calendar scope ${p.label}`);
    }
    if (['admin', 'teacher', 'parent'].includes(p.role)) {
      const ths = await api.threads.list();
      if (p.role === 'parent') assert.ok(ths.every(t => t.guardianId === p.guardianId), p.label);
      if (p.role === 'teacher') assert.ok(ths.every(t => p.programIds.includes(t.programId)), p.label);
    }
    if (p.role !== 'driver') {
      const ns = await api.notices.list();
      if (p.role === 'parent') {
        for (const n of ns) {
          assert.ok(n.aboutStudentIds.every(id => p.studentIds.includes(id)), p.label);
          if (n.audience.scope === 'students') assert.ok(n.audience.studentIds.every(id => p.studentIds.includes(id)), p.label);
        }
      }
    }
    if (['admin', 'accountant', 'parent'].includes(p.role)) {
      const invs = await api.fees.invoices();
      if (p.role === 'parent') {
        assert.ok(invs.every(i => p.studentIds.includes(i.studentId)), p.label);
        parentInvoices += invs.length;
      }
      for (const pay of (await api.fees.payments()).slice(0, 3)) await api.fees.receiptView(pay.id);
    }
    if (p.role === 'parent') {
      for (const sid of p.studentIds) {
        const v = await api.transport.parentView(sid);
        const stopId = api.getDb().students.find(s => s.id === sid).stopId;
        if (v.trip) {
          assert.ok(v.trip.stopEvents.every(e => e.stopId === stopId), p.label);
          assert.ok(v.trip.childEvents.every(e => e.studentId === sid), p.label);
        }
      }
    }
    if (p.role === 'teacher') for (const pid of p.programIds) await api.attendance.forDate(todayISO(), pid);
    if (p.role === 'driver') for (const r of await api.transport.routes()) await api.transport.simulationPlan(r.id);
    if (p.role === 'admin' || p.role === 'accountant') {
      const r = await api.fees.reconcile();
      assert.ok(r.checks.every(c => c.ok));
      await api.fees.outstandingReport();
      await api.audit.list();
    }
  }
  assert.ok(parentInvoices > 0, 'parent invoice scoping was exercised on real rows');
  assert.deepEqual(await api.admin.validate(), []);
});

// ---------------------------------------------------------------- Phase 3 seed
test('Phase 3 seed: observations moved out of the diary, some shared and some not; reports in each state; photos are drawn, one child without consent', async () => {
  const { photoConsentFor, CONSENT_VERSION } = await import('../src/domain/commands.js');
  assert.equal(db.diaryEntries.filter(e => e.type === 'observation').length, 0, 'observation text lives in the observations collection');
  assert.ok(db.observations.some(o => o.sharedAt) && db.observations.some(o => !o.sharedAt), 'some shared, some staff-only');
  assert.ok(db.observations.every(o => (o.sharedAt === null) === (o.sharedBy === null)));
  assert.ok(db.presentations.length >= 150 && db.presentations.every(p => p.active && p.source === 'starter'));
  assert.deepEqual(db.reports.map(r => r.status).sort(), ['draft', 'published', 'submitted']);
  for (const r of db.reports) for (const o of r.observations) assert.ok(db.observations.find(x => x.id === o.id)?.sharedAt, 'a report carries shared observations only');
  assert.ok(db.photos.length > 0 && db.photos.every(p => p.path === null && p.demo?.illustration && p.status === 'ready'), 'seed photos are illustrations, never Storage paths');
  const zoya = db.students.find(s => s.firstName === 'Zoya');
  assert.equal(photoConsentFor(db, zoya.id), false, 'the one child without photo consent');
  assert.equal(db.photos.filter(p => p.studentId === zoya.id).length, 0, 'and so no photo of that child');
  assert.equal(db.students.filter(s => s.status === 'active' && !photoConsentFor(db, s.id)).length, 1, 'everyone else has it');
  assert.ok(db.consents.every(c => c.version === CONSENT_VERSION && !c.withdrawnAt));
  const left = db.students.find(s => s.status === 'left');
  assert.equal(left.leftOn, '2026-07-02');
  assert.ok(db.students.filter(s => s.status === 'active').every(s => s.leftOn === null));
  assert.deepEqual(Object.values(db.school.retention), [null, null, null, null, null], 'no retention period is decided in the demo');
});
