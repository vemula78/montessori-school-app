import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildSeed } from '../src/seed/seed-data.js';
import { parseCsvObjects } from '../src/domain/csv.js';
import * as I from '../src/domain/import-people.js';
import { reconcile } from '../src/domain/reconcile.js';
import { validateDb } from '../src/domain/validate.js';
import { createApi } from '../src/api/index.js';
import { memoryBackend } from '../src/store/storage.js';

const read = name => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const NOW = new Date(Date.UTC(2026, 9, 2, 5, 0, 0));
const ctx = { actor: { role: 'admin', id: 'stf-principal' }, now: NOW.toISOString(), today: '2026-10-02' };
const counted = v => v.counts.ok + v.counts.quarantined + v.counts.duplicate;

function children() {
  const csv = parseCsvObjects(read('children-dirty.csv'));
  const mapping = I.suggestMapping('children', csv.headers);
  return { csv, mapping };
}

test('dirty children CSV: BOM, CRLF, DD/MM dates, quoted comma; every row gets exactly one status with a reason', () => {
  const db = buildSeed(NOW);
  const { csv, mapping } = children();
  assert.equal(csv.headers[0], 'Admission No', 'BOM stripped from the first header');
  assert.equal(csv.rows.length, 9);
  assert.equal(csv.rows[8].values['Last Name'], 'Notrealsen, Jr', 'quoted comma kept');
  assert.deepEqual(Object.keys(mapping).sort(), ['admissionNo', 'dob', 'firstName', 'guardian1Email', 'guardian1Name', 'guardian1Phone', 'guardian2Name', 'guardian2Phone', 'lastName', 'program', 'status', 'stop'].sort());
  const v = I.validateRows(db, { kind: 'children', mapping, rows: csv.rows }, { today: ctx.today });
  assert.equal(v.counts.inputRows, 9);
  assert.equal(counted(v), v.counts.inputRows, 'inputRows = ok + quarantined + duplicate');
  assert.deepEqual({ ok: v.counts.ok, quarantined: v.counts.quarantined, duplicate: v.counts.duplicate }, { ok: 4, quarantined: 4, duplicate: 1 });
  const by = Object.fromEntries(v.rows.map(r => [r.line, r]));
  assert.match(by[4].reason, /invalid date of birth "31\/02\/2022"/);
  assert.match(by[5].reason, /unknown program "Primary C"/);
  assert.equal(by[7].status, 'duplicate'); assert.match(by[7].reason, /repeated in this file \(same as line 6\)/);
  assert.equal(by[8].status, 'quarantined'); assert.match(by[8].reason, /conflict: lines 8, 9/);
  assert.equal(by[9].status, 'quarantined');
  assert.equal(by[2].target.dob, '2022-03-05', 'DD/MM/YYYY read day-first');
  assert.equal(by[2].target.stopId, 'route-1-stop-2', 'stop resolved by name');
  assert.equal(by[2].target.guardians[0].phone, '+919000000301', 'phone normalised');
  assert.equal(by[10].target.programId, 'prog-primary-a', 'program matched case-insensitively');
  for (const r of v.rows) if (r.status !== 'ok') assert.ok(r.reason, `line ${r.line} has a reason`);
  assert.deepEqual(v.guardians, { new: 4, merged: 1 }, 'siblings share one guardian (same phone)');
});

test('children commit creates students and merged guardians; re-importing the same file → every imported row duplicate (batch X)', () => {
  const db = buildSeed(NOW);
  const before = { students: db.students.length, guardians: db.guardians.length };
  const { csv, mapping } = children();
  const r = I.applyRows(db, { kind: 'children', mapping, rows: csv.rows }, 'imb-1', ctx);
  assert.deepEqual(r.created, { students: 4, guardians: 4, invoices: 0 });
  assert.deepEqual(r.merged, { guardians: 1 });
  assert.equal(r.inputRows, r.ok + r.quarantined + r.duplicate);
  assert.equal(db.students.length, before.students + 4);
  assert.equal(db.guardians.length, before.guardians + 4);
  const asha = db.students.find(s => s.admissionNo === 'NEW-001'), bela = db.students.find(s => s.admissionNo === 'NEW-002');
  assert.deepEqual(asha.guardianIds, bela.guardianIds, 'the two siblings share the guardian');
  assert.deepEqual(db.guardians.find(g => g.id === asha.guardianIds[0]).studentIds.sort(), [asha.id, bela.id].sort());
  assert.equal(validateDb(db).filter(x => x.severity !== 'warning').length, 0, 'document still valid');
  const again = I.validateRows(db, { kind: 'children', mapping, rows: csv.rows }, { today: ctx.today, batchId: 'imb-2' });
  assert.equal(again.counts.ok, 0, 'nothing new on re-import');
  assert.equal(again.counts.duplicate, 5, '4 imported rows + the in-file repeat');
  for (const row of again.rows.filter(x => x.status === 'duplicate' && x.line !== 7)) assert.match(row.reason, /duplicate \(batch imb-1\)/);
  assert.equal(counted(again), 9);
});

test('a guardian phone already on file under a different name is quarantined, never silently merged', () => {
  const db = buildSeed(NOW);
  const existing = db.guardians[0];
  const rows = [{ line: 2, values: { adm: 'NEW-100', fn: 'Kiran', dob: '01/01/2022', prog: 'Primary A', g: 'Someone Else', ph: existing.phone } }];
  const v = I.validateRows(db, { kind: 'children', mapping: { admissionNo: 'adm', firstName: 'fn', dob: 'dob', program: 'prog', guardian1Name: 'g', guardian1Phone: 'ph' }, rows }, { today: ctx.today });
  assert.equal(v.rows[0].status, 'quarantined');
  assert.match(v.rows[0].reason, /shares a phone\/email with an existing guardian under a different name/);
  const same = I.validateRows(db, { kind: 'children', mapping: { admissionNo: 'adm', firstName: 'fn', dob: 'dob', program: 'prog', guardian1Name: 'g', guardian1Phone: 'ph' },
    rows: [{ line: 2, values: { ...rows[0].values, g: `${existing.firstName} ${existing.lastName}` } }] }, { today: ctx.today });
  assert.equal(same.rows[0].status, 'ok');
  assert.deepEqual(same.guardians, { new: 0, merged: 1 });
});

test('fees CSV: opening-balance invoices, Σ imported = Σ source outstanding, reconciliation still passes, idempotent', () => {
  const db = buildSeed(NOW);
  const { csv: kids, mapping: km } = children();
  I.applyRows(db, { kind: 'children', mapping: km, rows: kids.rows }, 'imb-1', ctx);
  const csv = parseCsvObjects(read('fees-outstanding.csv'));
  const mapping = I.suggestMapping('fees', csv.headers);
  assert.deepEqual(mapping, { admissionNo: 'admission_no', installment: 'term', dueDate: 'due_date', outstandingPaise: 'balance' });
  const invBefore = db.invoices.length;
  const r = I.applyRows(db, { kind: 'fees', mapping, rows: csv.rows }, 'imb-fees', ctx);
  assert.deepEqual({ inputRows: r.inputRows, ok: r.ok, quarantined: r.quarantined, duplicate: r.duplicate }, { inputRows: 6, ok: 2, quarantined: 3, duplicate: 1 });
  assert.equal(r.openingBalancePaise, 1250000 + 900000);
  assert.equal(r.openingBalancePaise, r.sourceOutstandingPaise, 'Σ opening balances imported = Σ source outstanding');
  assert.equal(db.invoices.length, invBefore + 2);
  const reasons = r.rows.filter(x => x.status === 'quarantined').map(x => x.reason).join(' | ');
  assert.match(reasons, /unknown admission number "NEW-404"/);
  assert.match(reasons, /outstanding is zero/);
  assert.match(reasons, /invalid due date "31\/09\/2026"/);
  const opening = db.invoices.filter(i => i.source === 'import');
  assert.ok(opening.every(i => i.installmentName.startsWith('Opening balance — ') && i.lines[0].headId === I.OPENING_HEAD.id));
  assert.ok(reconcile(db, { asOfDate: ctx.today }).checks.every(c => c.ok), 'all five reconciliation checks pass');
  assert.equal(validateDb(db).filter(x => x.severity !== 'warning').length, 0, 'numbers contiguous, statuses derived');
  const again = I.applyRows(db, { kind: 'fees', mapping, rows: csv.rows }, 'imb-fees-2', ctx);
  assert.equal(again.ok, 0);
  assert.equal(again.created.invoices, 0);
  assert.equal(again.duplicate, 3);
});

test('demo api: stage → preview → commit through the api surface, counts reconcile', async () => {
  let t = NOW.getTime();
  const api = createApi({ backend: memoryBackend(), sessionBackend: memoryBackend(), seedFn: () => buildSeed(NOW), clock: () => new Date(t += 1000) });
  await api.ready();
  api.session.set('persona-stf-principal');
  const csv = await api.import.parseCsv(read('children-dirty.csv'));
  const mapping = await api.import.suggestMapping('children', csv.headers);
  const { batchId, counts } = await api.import.stage({ kind: 'children', mapping, rows: csv.rows });
  assert.equal(counts.inputRows, counts.ok + counts.quarantined + counts.duplicate);
  const pv = await api.import.preview(batchId);
  assert.equal(pv.rows.length, 9);
  const res = await api.import.commit(batchId);
  assert.equal(res.created.students, 4);
  await assert.rejects(api.import.commit(batchId), { code: 'VALIDATION' });
  api.session.set('persona-stf-teacher-pa');
  await assert.rejects(api.import.stage({ kind: 'children', mapping, rows: csv.rows }), { code: 'NOT_ALLOWED' });
});
