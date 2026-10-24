// Wave 1, fee office: year rollover, structures, one-off invoices, day book, payments, statements, audit (proposals 41-55).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyDb } from '../src/store/schema.js';
import * as F from '../src/domain/fees.js';
import { execute, SLICES } from '../src/domain/commands.js';
import { reconcile } from '../src/domain/reconcile.js';
import { createApi } from '../src/api/index.js';
import { buildSeed } from '../src/seed/seed-data.js';
import { memoryBackend } from '../src/store/storage.js';
import { todayISO, addDays } from '../src/domain/dates.js';
import { href } from '../src/ui/router.js';

const ctx = (today = '2026-10-20', role = 'accountant', id = 'stf-acc') => ({ actor: { role, id }, now: `${today}T05:00:00.000Z`, today });
const persona = (role, staffId) => ({ id: `persona-${staffId}`, role, staffId, guardianId: null, studentIds: [], programIds: [] });
const PRINCIPAL = persona('admin', 'stf-p');
const ACCOUNTANT = persona('accountant', 'stf-acc');

/** Small self-contained fixture (fake names only), the shape of tests/fees.test.mjs. */
function fixture() {
  const db = createEmptyDb();
  db.school = { ...db.school, name: 'Fixture School (Demo)', currentAcademicYearId: 'AY2026-27',
    lateFeeRule: { graceDays: 5, mode: 'perDay', amountPaise: 1000, capPaise: 20000, shiftDueToWorkingDay: true } };
  db.academicYears.push(
    { id: 'AY2025-26', label: '2025-26', startDate: '2025-06-01', endDate: '2026-05-31' },
    { id: 'AY2026-27', label: '2026-27', startDate: '2026-06-01', endDate: '2027-05-31' },
  );
  db.programs.push({ id: 'P1', name: 'Primary A', ageRange: '3-6', teacherIds: [] }, { id: 'P2', name: 'Primary B', ageRange: '3-6', teacherIds: [] });
  db.feeHeads.push(
    { id: 'H-TUI', name: 'Tuition', kind: 'tuition' }, { id: 'H-TRN', name: 'Transport', kind: 'transport' },
    { id: 'H-MAT', name: 'Materials', kind: 'materials' }, { id: 'H-LATE', name: 'Late fee', kind: 'lateFee' },
    { id: 'H-ADM', name: 'Admission', kind: 'admission' }, { id: 'H-OB', name: 'Opening balance', kind: 'openingBalance' },
  );
  db.staff.push({ id: 'stf-acc', firstName: 'Ava', lastName: 'Demoson', role: 'accountant', programIds: [], phone: '+91-90000-00001' },
    { id: 'stf-p', firstName: 'Pia', lastName: 'Demoson', role: 'admin', programIds: [], phone: '+91-90000-00003' });
  const g = (id, studentIds, phone) => ({ id, firstName: 'G', lastName: `Sampleraj${id}`, relation: 'mother', phone, email: `${id}@example.com`, studentIds });
  db.guardians.push(g('G1', ['A', 'B'], '+91-90000-00100'), g('G2', ['C'], '+91-90000-00101'));
  const s = (id, programId, dob, guardianIds, extra = {}) => ({ id, firstName: id, lastName: 'Sampleraj', dob, programId, admissionNo: `ADM-${id}`,
    status: 'active', guardianIds, routeId: null, stopId: null, feeCategory: 'regular', healthNotes: null, ...extra });
  db.students.push(s('A', 'P1', '2021-03-01', ['G1']), s('B', 'P2', '2022-05-01', ['G1']), s('C', 'P1', '2021-08-01', ['G2']));
  const inst = [
    { name: 'Term 1', dueDate: '2026-06-15', lines: [{ headId: 'H-TUI', amountPaise: 2500000 }, { headId: 'H-MAT', amountPaise: 300000 }] },
    { name: 'Term 2', dueDate: '2026-10-02', lines: [{ headId: 'H-TUI', amountPaise: 2500000 }] },
  ];
  db.feeStructures.push({ id: 'FS1', academicYearId: 'AY2026-27', programId: 'P1', siblingDiscountBp: 1000, staffWardDiscountBp: 5000, installments: inst },
    { id: 'FS2', academicYearId: 'AY2026-27', programId: 'P2', siblingDiscountBp: 1000, installments: inst });
  return db;
}
function withInvoices() {
  const db = fixture();
  for (const p of ['P1', 'P2']) for (const t of ['Term 1', 'Term 2']) F.generateInvoices(db, { academicYearId: 'AY2026-27', programId: p, installmentName: t }, ctx('2026-06-01'));
  return db;
}
const inv = (db, studentId, term) => db.invoices.find(i => i.studentId === studentId && i.installmentName === term && i.status !== 'cancelled');
const NEXT = { startDate: '2027-06-01', endDate: '2028-05-31', copyFrom: 'AY2026-27' };

// ---------------------------------------------------------------- #41 academic year rollover

test('#41 after the year ends no payment can be recorded; starting the next year (principal) fixes it and copies structures +1 year', () => {
  const db = withInvoices();
  const june = ctx('2027-06-02');
  assert.throws(() => execute('fees.recordPayment', db, [{ studentId: 'A', amountPaise: 100000, mode: 'cash', paidOn: '2027-06-02' }], june, ACCOUNTANT), /not inside any academic year/);
  assert.throws(() => execute('fees.startAcademicYear', db, [NEXT], june, ACCOUNTANT), { code: 'NOT_ALLOWED' }, 'the principal starts a year');
  const r = execute('fees.startAcademicYear', db, [NEXT], ctx('2027-06-02', 'admin', 'stf-p'), PRINCIPAL);
  assert.equal(r.academicYear.id, 'AY2027-28');
  assert.equal(r.academicYear.label, '2027-28');
  assert.equal(r.yearCreated, true);
  assert.deepEqual([r.sourceStructures, r.structuresCopied, r.structuresSkippedExisting], [2, 2, 0]);
  const fs = db.feeStructures.find(x => x.academicYearId === 'AY2027-28' && x.programId === 'P1');
  assert.deepEqual(fs.installments.map(i => i.dueDate), ['2027-06-15', '2027-10-02'], 'due dates moved one year');
  assert.deepEqual(fs.installments[0].lines, [{ headId: 'H-TUI', amountPaise: 2500000 }, { headId: 'H-MAT', amountPaise: 300000 }]);
  assert.equal(fs.staffWardDiscountBp, 5000);
  assert.ok(SLICES.ledger.writes.includes('academicYears'), 'the real app persists the new year through the ledger slice');
  const pay = execute('fees.recordPayment', db, [{ studentId: 'A', amountPaise: 100000, mode: 'cash', paidOn: '2027-06-02' }], june, ACCOUNTANT);
  assert.equal(pay.receiptNumber, 'RCP/27-28/0001', 'receipts of the new year start their own sequence');
  assert.equal(db.school.currentAcademicYearId, 'AY2026-27', 'starting a year does not switch the current one by itself');
});

test('#41 starting the same year twice creates one year and copies nothing again (counts add up)', () => {
  const db = withInvoices();
  const c = ctx('2027-04-01', 'admin', 'stf-p');
  execute('fees.startAcademicYear', db, [NEXT], c, PRINCIPAL);
  const before = db.feeStructures.length;
  const r = execute('fees.startAcademicYear', db, [NEXT], c, PRINCIPAL);
  assert.equal(r.yearCreated, false);
  assert.equal(db.academicYears.filter(a => a.id === 'AY2027-28').length, 1);
  assert.equal(db.feeStructures.length, before);
  assert.equal(r.structuresCopied + r.structuresSkippedExisting, r.sourceStructures);
  assert.deepEqual([r.structuresCopied, r.structuresSkippedExisting], [0, 2]);
  assert.throws(() => execute('fees.startAcademicYear', db, [{ ...NEXT, endDate: '2028-04-30' }], c, PRINCIPAL), /already exists/);
  assert.throws(() => execute('fees.startAcademicYear', db, [{ startDate: '2027-05-01', endDate: '2028-04-30' }], c, PRINCIPAL), /already exists/, 'same start year, other dates');
  assert.throws(() => execute('fees.startAcademicYear', fixture(), [{ startDate: '2027-05-01', endDate: '2028-04-30' }], c, PRINCIPAL), /overlap 2026-27/);
  assert.throws(() => execute('fees.startAcademicYear', db, [{ startDate: '2028-06-01', endDate: '2028-05-31' }], c, PRINCIPAL), /after/);
  assert.throws(() => execute('fees.startAcademicYear', db, [{ startDate: '2028-06-01', endDate: '2029-07-31' }], c, PRINCIPAL), /one year/);
  assert.equal(reconcile(db, { asOfDate: '2027-04-01' }).checks.every(x => x.ok), true);
});

test('#41 the principal sets the current year and the late-fee rule; both are audited and validated', () => {
  const db = fixture();
  const c = ctx('2027-06-02', 'admin', 'stf-p');
  execute('fees.startAcademicYear', db, [{ startDate: '2027-06-01', endDate: '2028-05-31' }], c, PRINCIPAL);
  assert.equal(db.feeStructures.filter(s => s.academicYearId === 'AY2027-28').length, 0, 'nothing copied without copyFrom');
  assert.throws(() => execute('fees.setCurrentAcademicYear', db, ['AY2027-28'], c, ACCOUNTANT), { code: 'NOT_ALLOWED' });
  assert.throws(() => execute('fees.setCurrentAcademicYear', db, ['AY2099-00'], c, PRINCIPAL), { code: 'NOT_FOUND' });
  execute('fees.setCurrentAcademicYear', db, ['AY2027-28'], c, PRINCIPAL);
  assert.equal(db.school.currentAcademicYearId, 'AY2027-28');
  const rule = { graceDays: 7, mode: 'flat', amountPaise: 50000, capPaise: null, shiftDueToWorkingDay: false };
  assert.throws(() => execute('fees.setLateFeeRule', db, [rule], c, ACCOUNTANT), { code: 'NOT_ALLOWED' });
  for (const bad of [{ ...rule, mode: 'weekly' }, { ...rule, amountPaise: 0 }, { ...rule, amountPaise: 10.5 }, { ...rule, graceDays: -1 }, { ...rule, mode: 'perDay', capPaise: 100 }]) {
    assert.throws(() => execute('fees.setLateFeeRule', db, [bad], c, PRINCIPAL), { code: /VALIDATION|INVALID_AMOUNT/ }, JSON.stringify(bad));
  }
  execute('fees.setLateFeeRule', db, [rule], c, PRINCIPAL);
  assert.deepEqual(db.school.lateFeeRule, rule);
  execute('fees.setLateFeeRule', db, [null], c, PRINCIPAL);
  assert.equal(db.school.lateFeeRule, null, 'null turns late fees off');
  const actions = db.auditLog.map(a => `${a.entity}.${a.action}`);
  for (const a of ['academicYear.create', 'school.setCurrentAcademicYear', 'school.setLateFeeRule']) assert.ok(actions.includes(a), a);
});

test('#41 home notice: 60 days before the year ends without a next year; after it ends, switch to the next one', () => {
  const db = fixture();
  assert.equal(F.yearRolloverNotice(db, '2027-03-31'), null, 'more than 60 days left');
  assert.deepEqual(F.yearRolloverNotice(db, '2027-04-01'), { kind: 'startNext', currentId: 'AY2026-27', endDate: '2027-05-31', daysLeft: 60 });
  assert.equal(F.yearRolloverNotice(db, '2027-06-02').kind, 'startNext', 'ended with no next year: still start it');
  execute('fees.startAcademicYear', db, [{ startDate: '2027-06-01', endDate: '2028-05-31' }], ctx('2027-04-01', 'admin', 'stf-p'), PRINCIPAL);
  assert.equal(F.yearRolloverNotice(db, '2027-04-01'), null, 'next year exists, current year still running');
  assert.deepEqual(F.yearRolloverNotice(db, '2027-06-01'), { kind: 'switch', currentId: 'AY2026-27', nextId: 'AY2027-28', nextLabel: '2027-28' });
});

// ---------------------------------------------------------------- screens (demo api over the seed; fake DOM as in tests/care-ui.test.mjs)

const NOW = new Date();
const PRINCIPAL_P = 'persona-stf-principal', ACCOUNTANT_P = 'persona-stf-accountant', PARENT_P = 'persona-grd-01';

function fake() {
  const children = new Map();
  let html = '';
  const el = {
    value: '', checked: false, disabled: false, textContent: '', className: '', files: [], dataset: {}, handlers: {}, children, isConnected: true,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener(t, f) { (el.handlers[t] ||= []).push(f); },
    querySelector(sel) { if (!children.has(sel)) children.set(sel, fake()); return children.get(sel); },
    querySelectorAll() { return []; },
    closest: () => null, appendChild() {}, remove() {}, focus() {}, insertAdjacentHTML(_w, h) { html += h; },
  };
  Object.defineProperty(el, 'innerHTML', { get: () => html, set: (v) => { html = v; children.clear(); } });
  return el;
}
globalThis.document ??= { createElement: () => fake(), body: { appendChild() {} }, head: { appendChild() {} }, getElementById: () => null, addEventListener() {}, visibilityState: 'visible' };
globalThis.location ??= { hash: '', reload() {} };

async function mkApi(clock = NOW) {
  const api = createApi({ backend: memoryBackend(), sessionBackend: memoryBackend(), seedFn: () => buildSeed(NOW), clock: () => clock });
  await api.ready();
  return api;
}
/** Renders a screen; returns its HTML, with the ctx (and so ctx.el's registered handlers) on .ctx. */
async function draw(api, who, mod, query = {}, params = {}) {
  api.session.set(who);
  const ctx = { api, persona: api.session.current(), query, params, el: fake(), get db() { return api.getDb(); },
    go() {}, setQuery() {}, href, toast() {}, onChange() {}, cleanup() {}, rerender() {} };
  await mod.render(ctx);
  last = ctx;
  return ctx.el.innerHTML;
}
let last = null;
const Structures = await import('../src/ui/screens/fees-structures.js');
const Home = await import('../src/ui/screens/home.js');

test('#41 screens: the principal gets the year and late-fee controls, the accountant does not; the home pages warn before the year ends', async () => {
  const api = await mkApi();
  const p = await draw(api, PRINCIPAL_P, Structures);
  assert.match(p, /data-year="start"/);
  assert.match(p, /data-year="late"/);
  assert.match(p, /Late fee: 7 grace days, then ₹10\.00 a day, at most ₹500\.00/);
  const a = await draw(api, ACCOUNTANT_P, Structures);
  assert.ok(!a.includes('data-year='), 'accountant: no year controls');
  assert.match(a, /The principal starts the next year/);
  const late = await mkApi(new Date('2027-04-15T06:00:00Z'));
  assert.match(await draw(late, PRINCIPAL_P, Home), /The academic year ends on 31-May-2027 \(in 46 days\)[\s\S]*Start the next academic year/);
  assert.match(await draw(late, ACCOUNTANT_P, Home), /Ask the principal to start the next academic year/);
  assert.ok(!(await draw(api, PRINCIPAL_P, Home)).includes('The academic year ends'), 'no warning months before the end');
});

test('#55 #45 accountant home: a Needs attention list (late fees to apply) and "collected today" opens today\'s day book', async () => {
  const api = await mkApi();
  api.session.set(ACCOUNTANT_P);
  const lf = await api.fees.lateFeesDueList();
  assert.ok(lf.length > 0, 'the seed has overdue invoices past the grace period');
  const html = await draw(api, ACCOUNTANT_P, Home);
  assert.match(html, /Needs attention/);
  assert.match(html, new RegExp(`${lf.length} invoices? with a late fee to apply`));
  assert.match(html, /href="#\/fees\?status=overdue"/, 'demo: the late-fees screen is real-app only, so the overdue invoices');
  assert.ok(!html.includes('reconciliation check'), 'the seed reconciles');
  const t = todayISO();
  assert.ok(html.includes(`href="${href('/reports', { tab: 'collection', from: t, to: t }).replace(/&/g, '&amp;')}"`), 'collected today links to the day book');
});

test('#42 a programme without a structure offers Create; the editor can add instalments and heads (blank rows dropped)', async () => {
  const api = await mkApi();
  api.session.set(PRINCIPAL_P);
  await api.fees.startAcademicYear({ startDate: '2027-06-01', endDate: '2028-05-31' });
  const html = await draw(api, ACCOUNTANT_P, Structures, { ay: 'AY2027-28' });
  assert.equal((html.match(/data-create="/g) || []).length, api.getDb().programs.length, 'Create on every programme of the new year');
  const pid = api.getDb().programs[0].id;
  const s = Structures.structureFromRows({ academicYearId: 'AY2027-28', programId: pid }, [
    { name: 'Term 1', dueDate: '2027-06-10', lines: [{ headId: 'fh-tuition', amount: '25,000' }, { headId: 'fh-admission', amount: '5000.50' }, { headId: 'fh-materials', amount: ' ' }] },
    { name: ' Monthly - July ', dueDate: '2027-07-05', lines: [{ headId: 'fh-tuition', amount: '8000' }] },
  ], { sib: '10', sw: '' });
  assert.deepEqual(s.installments[0].lines, [{ headId: 'fh-tuition', amountPaise: 2500000 }, { headId: 'fh-admission', amountPaise: 500050 }]);
  assert.equal(s.installments[1].name, 'Monthly - July');
  assert.equal(s.siblingDiscountBp, 1000);
  assert.equal(s.staffWardDiscountBp, null);
  assert.throws(() => Structures.structureFromRows({}, [{ name: 'T', dueDate: '2027-06-10', lines: [{ headId: 'fh-tuition', amount: '12x' }] }], { sib: '0', sw: '' }), /Invalid amount for T/);
  assert.throws(() => Structures.structureFromRows({}, [], { sib: '', sw: '' }), /Sibling discount/);
  api.session.set(ACCOUNTANT_P);
  const saved = await api.fees.saveStructure(s);
  assert.equal(saved.installments.length, 2);
  const after = await draw(api, ACCOUNTANT_P, Structures, { ay: 'AY2027-28' });
  assert.match(after, /Monthly - July/);
  assert.match(after, /Admission fee \(sample\) ₹5,000\.50/);
  // an edit that removes a line and the second instalment keeps the same structure id
  const edited = await api.fees.saveStructure(Structures.structureFromRows(saved, [{ name: 'Term 1', dueDate: '2027-06-10', lines: [{ headId: 'fh-tuition', amount: '25000' }] }], { sib: '10', sw: '' }));
  assert.equal(edited.id, saved.id);
  assert.deepEqual(edited.installments.map(i => i.lines.length), [1]);
});
