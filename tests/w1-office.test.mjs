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

// ---------------------------------------------------------------- #51 concession on a part-paid invoice

test('#51 a concession can be added to a part-paid invoice up to its balance; paid + concessions never exceed the total; removal stays locked', () => {
  const db = withInvoices();
  const a1 = inv(db, 'A', 'Term 1');
  F.recordPayment(db, { studentId: 'A', amountPaise: 1000000, mode: 'cash', paidOn: '2026-06-10', allocations: [{ invoiceId: a1.id, amountPaise: 1000000 }] }, ctx());
  const before = F.invoiceAmounts(db, a1);
  assert.equal(before.balancePaise, 1800000);
  assert.throws(() => F.addConcession(db, a1.id, { type: 'scholarship', description: 'too much', amountPaise: 1800001 }, ctx()), { code: 'INVOICE_LOCKED' });
  const c = execute('fees.addConcession', db, [a1.id, { type: 'scholarship', description: 'Hardship', amountPaise: 500000 }], ctx(), ACCOUNTANT);
  const after = F.invoiceAmounts(db, a1);
  assert.equal(after.balancePaise, 1300000);
  assert.ok(after.paidPaise + after.concessionPaise <= after.linesPaise);
  assert.equal(db.invoices.find(i => i.id === a1.id).status, 'partiallyPaid');
  // the whole remaining balance as a concession settles it; nothing more can be conceded
  execute('fees.addConcession', db, [a1.id, { type: 'adhoc', description: 'Rest waived', amountPaise: 1300000 }], ctx(), ACCOUNTANT);
  const end = F.invoiceAmounts(db, a1);
  assert.equal(end.balancePaise, 0);
  assert.equal(end.paidPaise + end.concessionPaise, end.linesPaise);
  assert.equal(db.invoices.find(i => i.id === a1.id).status, 'paid');
  assert.throws(() => F.addConcession(db, a1.id, { type: 'adhoc', description: 'x', amountPaise: 1 }, ctx()), { code: 'INVOICE_LOCKED' });
  assert.throws(() => F.removeConcession(db, a1.id, c.id, 'changed mind', ctx()), { code: 'INVOICE_LOCKED' });
  assert.ok(reconcile(db).checks.every(x => x.ok));
  assert.match(db.auditLog.at(-1).summary, /₹13,000\.00/, 'audit summaries show rupees (#53)');
});

// ---------------------------------------------------------------- #43 one-off invoice for one child

test('#43 a one-off invoice for one child takes the next number; numbering stays contiguous; it cannot shadow a structure instalment or repeat', () => {
  const db = fixture();
  F.generateInvoices(db, { academicYearId: 'AY2026-27', programId: 'P1', installmentName: 'Term 1' }, ctx('2026-06-01'));
  const args = { studentId: 'B', academicYearId: 'AY2026-27', title: 'Uniform', dueDate: '2026-07-10', lines: [{ headId: 'H-MAT', amountPaise: 150000, description: 'two sets' }, { headId: 'H-ADM', amountPaise: 500000 }] };
  assert.throws(() => execute('fees.createInvoice', db, [args], ctx(), persona('teacher', 'stf-t')), { code: 'NOT_ALLOWED' });
  const one = execute('fees.createInvoice', db, [args], ctx('2026-07-01'), ACCOUNTANT);
  assert.equal(one.number, 'INV/26-27/0003', 'after the two Term 1 invoices');
  assert.equal(one.installmentName, 'Uniform');
  assert.deepEqual(one.lines.map(l => [l.description, l.amountPaise]), [['Materials — two sets', 150000], ['Admission', 500000]]);
  assert.equal(F.invoiceAmounts(db, one).balancePaise, 650000);
  assert.deepEqual(one.concessions, [], 'no automatic discounts on a one-off charge');
  F.generateInvoices(db, { academicYearId: 'AY2026-27', programId: 'P2', installmentName: 'Term 1' }, ctx('2026-07-02'));
  const numbers = db.invoices.map(i => Number(i.number.slice(-4))).sort((a, b) => a - b);
  assert.deepEqual(numbers, numbers.map((_, i) => i + 1), 'contiguous: 1..n with no gap or repeat');
  assert.throws(() => execute('fees.createInvoice', db, [args], ctx(), ACCOUNTANT), /already has a "Uniform" invoice/, 'a repeat (double tap) is refused');
  assert.throws(() => execute('fees.createInvoice', db, [{ ...args, title: 'term 2' }], ctx(), ACCOUNTANT), /instalment of the fee structure/);
  assert.throws(() => execute('fees.createInvoice', db, [{ ...args, title: 'Trip', lines: [{ headId: 'H-LATE', amountPaise: 100 }] }], ctx(), ACCOUNTANT), /not added by hand/);
  assert.throws(() => execute('fees.createInvoice', db, [{ ...args, title: 'Trip', lines: [] }], ctx(), ACCOUNTANT), /at least one fee line/);
  assert.throws(() => execute('fees.createInvoice', db, [{ ...args, title: 'Trip', lines: [{ headId: 'H-MAT', amountPaise: 0 }] }], ctx(), ACCOUNTANT), { code: 'INVALID_AMOUNT' });
  assert.throws(() => execute('fees.createInvoice', db, [{ ...args, title: 'Trip', dueDate: '2027-07-01' }], ctx(), ACCOUNTANT), /outside/);
  // it is paid like any other invoice
  F.recordPayment(db, { studentId: 'B', amountPaise: 650000, mode: 'upi', paidOn: '2026-07-05', allocations: [{ invoiceId: one.id, amountPaise: 650000 }] }, ctx('2026-07-05'));
  assert.equal(db.invoices.find(i => i.id === one.id).status, 'paid');
  assert.ok(reconcile(db).checks.every(x => x.ok));
  assert.match(db.auditLog.find(a => a.action === 'create' && a.entity === 'invoice').summary, /Uniform.*₹6,500\.00/);
});

// ---------------------------------------------------------------- #50 staff-ward fee category

test('#50 the principal can mark a child staff-ward (audited); the structure\'s staff-ward discount then applies to new invoices', () => {
  const db = fixture();
  const c = ctx('2026-06-01', 'admin', 'stf-p');
  assert.throws(() => execute('people.updateStudent', db, [{ studentId: 'C', feeCategory: 'vip' }], c, PRINCIPAL), /Unknown fee category/);
  assert.throws(() => execute('people.updateStudent', db, [{ studentId: 'C', feeCategory: 'staffWard' }], c, ACCOUNTANT), { code: 'NOT_ALLOWED' });
  execute('people.updateStudent', db, [{ studentId: 'C', feeCategory: 'staffWard' }], c, PRINCIPAL);
  assert.equal(db.students.find(s => s.id === 'C').feeCategory, 'staffWard');
  assert.match(db.auditLog.at(-1).summary, /fee category regular → staffWard/);
  F.generateInvoices(db, { academicYearId: 'AY2026-27', programId: 'P1', installmentName: 'Term 2' }, c);
  const cons = inv(db, 'C', 'Term 2').concessions;
  assert.deepEqual(cons.map(x => [x.type, x.amountPaise]), [['staffWard', 1250000]], '50% of tuition from FS1');
  assert.deepEqual(inv(db, 'A', 'Term 2').concessions, [], 'a regular child gets none');
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
const Payment = await import('../src/ui/screens/fees-payment.js');

/** Every dialog opened while `fn` runs is answered: true presses its last button (OK), false cancels it. Returns the dialogs' HTML. */
async function answeringDialogs(answer, fn) {
  const prev = document.createElement;
  const seen = [];
  document.createElement = () => {
    const d = fake();
    d.close = () => {};
    d.showModal = () => {
      seen.push(d.innerHTML);
      if (answer) d.handlers.click[0]({ target: { closest: () => ({ hasAttribute: () => false, dataset: { act: '1' } }) } });
      else d.handlers.cancel[0]({ preventDefault() {} });
    };
    return d;
  };
  try { await fn(); } finally { document.createElement = prev; }
  return seen;
}
/** Submits the ledger's Record payment form as typed (the box "keep any excess as credit" left as rendered: unticked). */
async function submitPayment(ctx, { amount, paidOn = todayISO(), allowCredit = false }) {
  const form = { amount: { value: amount }, mode: { value: 'cash' }, reference: { value: '' }, paidOn: { value: paidOn }, allowCredit: { checked: allowCredit },
    guardianId: { value: '' }, querySelectorAll: () => [], querySelector: () => ({ disabled: false }) };
  for (const h of ctx.el.querySelector('#fp-form').handlers.submit) await h({ preventDefault() {}, target: form });
}

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

test('#46 a mistyped amount is not silently kept as credit: the box starts unticked and an excess must be confirmed', async () => {
  const api = await mkApi();
  api.session.set(ACCOUNTANT_P);
  const sid = (await api.fees.invoices({})).find((i) => i.status !== 'cancelled' && i.balancePaise > 0).studentId;
  const due = (await api.fees.invoices({ studentId: sid })).filter((i) => i.status !== 'cancelled' && i.balancePaise > 0).reduce((s, i) => s + i.balancePaise, 0);
  const html = await draw(api, ACCOUNTANT_P, Payment, {}, { studentId: sid });
  assert.match(html, /<input type="checkbox" name="allowCredit">/, 'unticked by default');
  assert.match(html, /id="fp-left"/, 'a live "allocated / left over" line under Apply to');
  const ctx = last;
  const count = async () => (await api.fees.payments({ studentId: sid })).length;
  const n0 = await count();
  const typo = String((due + 4500000) / 100); // Rs 45,000 more than is due
  const cancelled = await answeringDialogs(false, () => submitPayment(ctx, { amount: typo }));
  assert.equal(cancelled.length, 1, 'one confirmation');
  assert.match(cancelled[0], /₹45,000\.00/, 'it names the excess');
  assert.equal(await count(), n0, 'cancelled: no receipt');
  const ok = await answeringDialogs(true, () => submitPayment(ctx, { amount: typo }));
  assert.equal(ok.length, 1);
  const pays = await api.fees.payments({ studentId: sid });
  assert.equal(pays.length, n0 + 1, 'confirmed: one receipt');
  assert.equal(pays[0].creditPaise, 4500000, 'the confirmed excess is kept as credit');
});

test('#46 an amount within what is due records at once, with no dialog', async () => {
  const api = await mkApi();
  api.session.set(ACCOUNTANT_P);
  const sid = (await api.fees.invoices({})).find((i) => i.status !== 'cancelled' && i.balancePaise > 0).studentId;
  await draw(api, ACCOUNTANT_P, Payment, {}, { studentId: sid });
  const n0 = (await api.fees.payments({ studentId: sid })).length;
  const seen = await answeringDialogs(false, () => submitPayment(last, { amount: '100' }));
  assert.equal(seen.length, 0);
  assert.equal((await api.fees.payments({ studentId: sid })).length, n0 + 1);
});

const Invoices = await import('../src/ui/screens/fees-invoices.js');

test('#43 #50 #54 ledger: New invoice for staff; fee category shown, changeable by the principal only; payment modes in words', async () => {
  const api = await mkApi();
  api.session.set(ACCOUNTANT_P);
  const pays = await api.fees.payments({});
  const sid = pays.find((p) => p.mode === 'cash').studentId;
  const acc = await draw(api, ACCOUNTANT_P, Payment, {}, { studentId: sid });
  assert.match(acc, /id="fp-newinv"/);
  assert.match(acc, /fee category: (regular|staff ward)/);
  assert.ok(!acc.includes('id="fp-feecat"'), 'the accountant cannot change it');
  assert.match(acc, /<td>Cash/);
  assert.ok(!acc.includes('<td>cash'), 'no raw mode code');
  assert.match(await draw(api, PRINCIPAL_P, Payment, {}, { studentId: sid }), /id="fp-feecat"/);
  const kid = (await api.people.childrenOf('grd-01'))[0].id;
  const parent = await draw(api, PARENT_P, Payment, {}, { studentId: kid });
  assert.ok(!parent.includes('fp-newinv') && !parent.includes('fee category'), 'parents see neither');
  api.session.set(ACCOUNTANT_P);
  const made = await api.fees.createInvoice({ studentId: sid, academicYearId: 'AY2026-27', title: 'Field trip', dueDate: todayISO(), lines: [{ headId: 'fh-materials', amountPaise: 75000 }] });
  assert.match(await draw(api, ACCOUNTANT_P, Payment, {}, { studentId: sid }), new RegExp(`${made.number.replace(/\//g, '\\/')}<\\/a><\\/td><td>Field trip`));
});

test('#51 #54 invoice detail: a part-paid invoice still offers Add concession (up to the balance); concession types in words; a child who left with dues can be picked', async () => {
  const api = await mkApi();
  api.session.set(ACCOUNTANT_P);
  const part = (await api.fees.invoices({})).find((i) => i.status === 'partiallyPaid');
  const html = await draw(api, ACCOUNTANT_P, Invoices, {}, { id: part.id });
  assert.match(html, /id="fi-con"/);
  assert.match(html, /A concession of up to the balance/);
  const withCon = (await api.fees.invoices({})).find((i) => i.concessions.length);
  const h2 = await draw(api, ACCOUNTANT_P, Invoices, {}, { id: withCon.id });
  assert.ok(!/badge info">(sibling|staffWard|adhoc|scholarship)</.test(h2), 'no raw concession code');
  assert.match(h2, /badge info">(Sibling|Staff ward|Ad-hoc|Scholarship)</);
  api.session.set(PRINCIPAL_P);
  await api.people.updateStudent({ studentId: part.studentId, status: 'left' });
  const list = await draw(api, ACCOUNTANT_P, Invoices);
  const name = (await api.people.student(part.studentId)).name;
  assert.match(list, new RegExp(`<optgroup label="Left, with dues"><option value="${part.studentId}">${name}</option>`));
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
