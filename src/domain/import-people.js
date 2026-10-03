// Data import from the previous system (CSV): children + guardians, and outstanding fees as opening balances.
// Flow: rows (already parsed, mapped by the user: target field → source header) → validate → commit.
// Every input row ends in exactly one status, so   inputRows = ok + quarantined + duplicate   always holds.
// Idempotent: re-importing the same file marks every row 'duplicate (batch X)'.
// Historical receipts are NOT recreated; fees become one "Opening balance" invoice per student per installment.

import { fail, newId, nextNumber } from './ids.js';
import { parseDate, compareISO, diffDays } from './dates.js';
import { rupeesToPaise, sumPaise } from './money.js';
import { byId } from './people.js';
import { academicYearFor } from './calendar.js';
import { appendAudit } from './audit.js';
import { normHeader } from './csv.js';

export const IMPORT_KINDS = ['children', 'fees'];
export const TARGET_FIELDS = {
  children: ['admissionNo', 'firstName', 'lastName', 'dob', 'program', 'status', 'route', 'stop',
    'guardian1Name', 'guardian1Relation', 'guardian1Phone', 'guardian1Email',
    'guardian2Name', 'guardian2Relation', 'guardian2Phone', 'guardian2Email'],
  fees: ['admissionNo', 'installment', 'dueDate', 'outstandingPaise'],
};
export const REQUIRED_FIELDS = { children: ['admissionNo', 'firstName', 'dob', 'program', 'guardian1Name'], fees: ['admissionNo', 'installment', 'dueDate', 'outstandingPaise'] };
export const OPENING_HEAD = { id: 'fh-opening-balance', name: 'Opening balance (carried from previous system)', kind: 'openingBalance' };
const MAX_CHILD_AGE_DAYS = 12 * 366;

/** Header aliases for a suggested mapping (generic names only; never a vendor's name). */
const ALIASES = {
  admissionNo: ['admissionno', 'admissionnumber', 'admno', 'admissionid', 'enrolmentno', 'enrollmentno', 'studentid', 'regno'],
  firstName: ['firstname', 'childfirstname', 'studentfirstname', 'givenname'],
  lastName: ['lastname', 'surname', 'childlastname', 'familyname'],
  dob: ['dob', 'dateofbirth', 'birthdate', 'birthday'],
  program: ['program', 'programme', 'class', 'classname', 'grade', 'section', 'group'],
  status: ['status', 'studentstatus'],
  route: ['route', 'busroute', 'routename'],
  stop: ['stop', 'busstop', 'pickuppoint', 'stopname'],
  guardian1Name: ['guardian1name', 'parent1name', 'mothername', 'parentname', 'guardianname'],
  guardian1Relation: ['guardian1relation', 'parent1relation', 'relation'],
  guardian1Phone: ['guardian1phone', 'parent1phone', 'motherphone', 'mothermobile', 'phone', 'mobile', 'parentphone', 'parentmobile'],
  guardian1Email: ['guardian1email', 'parent1email', 'motheremail', 'email', 'parentemail'],
  guardian2Name: ['guardian2name', 'parent2name', 'fathername'],
  guardian2Relation: ['guardian2relation', 'parent2relation'],
  guardian2Phone: ['guardian2phone', 'parent2phone', 'fatherphone', 'fathermobile'],
  guardian2Email: ['guardian2email', 'parent2email', 'fatheremail'],
  installment: ['installment', 'instalment', 'term', 'feeterm', 'period'],
  dueDate: ['duedate', 'due', 'dueon'],
  outstandingPaise: ['outstanding', 'balance', 'due amount', 'dueamount', 'pending', 'pendingamount', 'outstandingamount'],
};

/** {targetField: sourceHeader} guessed from header names; the user confirms or edits it. */
export function suggestMapping(kind, headers) {
  if (!IMPORT_KINDS.includes(kind)) fail('VALIDATION', `Unknown import kind: ${kind}`);
  const out = {};
  for (const f of TARGET_FIELDS[kind]) {
    const h = headers.find(x => (ALIASES[f] || []).map(normHeader).includes(normHeader(x)));
    if (h !== undefined && !Object.values(out).includes(h)) out[f] = h;
  }
  return out;
}

/** A 10-digit Indian mobile (6-9 first) with optional +91 / 91 / 0 prefix, spaces, dashes or brackets → '+91' + 10 digits; else null. */
export function normalisePhone(raw) {
  const d = String(raw || '').replace(/[\s\-().]/g, '');
  let m;
  if ((m = /^(?:\+?91|0)?([6-9]\d{9})$/.exec(d))) return `+91${m[1]}`;
  return null;
}
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const splitName = full => {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  return parts.length === 1 ? { firstName: parts[0], lastName: '' } : { firstName: parts.slice(0, -1).join(' '), lastName: parts.at(-1) };
};
const STATUS_ALIASES = { active: 'active', current: 'active', enrolled: 'active', studying: 'active', left: 'left', withdrawn: 'left', alumni: 'left', inactive: 'left', tc: 'left' };

/** Source row → {line, values} (accepts {line, values} or a plain {header: value} object). */
const rowValues = r => (r && typeof r === 'object' && r.values && typeof r.values === 'object' ? r.values : r || {});

function mapRow(mapping, r) {
  const v = rowValues(r);
  const get = f => (mapping[f] === undefined || mapping[f] === null || mapping[f] === '' ? '' : String(v[mapping[f]] ?? '').trim());
  return get;
}

export function checkMapping(kind, mapping) {
  if (!IMPORT_KINDS.includes(kind)) fail('VALIDATION', `Unknown import kind: ${kind}`);
  if (!mapping || typeof mapping !== 'object') fail('VALIDATION', 'A column mapping is required');
  for (const k of Object.keys(mapping)) if (!TARGET_FIELDS[kind].includes(k)) fail('VALIDATION', `Unknown target field: ${k}`);
  const missing = REQUIRED_FIELDS[kind].filter(f => !mapping[f]);
  if (missing.length) fail('VALIDATION', `Map these required fields first: ${missing.join(', ')}`);
}

const findProgram = (db, raw) => {
  const n = normHeader(raw);
  return db.programs.find(p => normHeader(p.id) === n || normHeader(p.name) === n) || null;
};
function findStop(db, routeRaw, stopRaw) {
  const routes = routeRaw ? db.routes.filter(r => normHeader(r.id) === normHeader(routeRaw) || normHeader(r.name) === normHeader(routeRaw) || normHeader(r.busNo) === normHeader(routeRaw)) : db.routes;
  if (routeRaw && !routes.length) return { error: `unknown route "${routeRaw}"` };
  const hits = [];
  for (const r of routes) for (const s of r.stops) if (normHeader(s.name) === normHeader(stopRaw) || normHeader(s.id) === normHeader(stopRaw)) hits.push({ routeId: r.id, stopId: s.id });
  if (!hits.length) return { error: `unknown stop "${stopRaw}"` };
  if (hits.length > 1) return { error: `stop "${stopRaw}" is on more than one route; map the route column too` };
  return hits[0];
}

// ---------------------------------------------------------------- children

function childTarget(db, get, today) {
  const t = { admissionNo: get('admissionNo'), firstName: get('firstName'), lastName: get('lastName') };
  if (!t.admissionNo) return { reason: 'admission number is empty' };
  if (!t.firstName) return { reason: 'first name is empty' };
  const dobRaw = get('dob');
  t.dob = parseDate(dobRaw);
  if (!t.dob) return { reason: dobRaw ? `invalid date of birth "${dobRaw}" (use DD/MM/YYYY or YYYY-MM-DD)` : 'date of birth is empty' };
  if (compareISO(t.dob, today) > 0) return { reason: 'date of birth is in the future' };
  if (diffDays(t.dob, today) > MAX_CHILD_AGE_DAYS) return { reason: `date of birth ${dobRaw} gives an age over 12 years; check the year` };
  const prog = findProgram(db, get('program'));
  if (!prog) return { reason: get('program') ? `unknown program "${get('program')}"` : 'program is empty' };
  t.programId = prog.id;
  const st = get('status');
  t.status = st ? STATUS_ALIASES[normHeader(st)] : 'active';
  if (!t.status) return { reason: `unknown status "${st}" (use active or left)` };
  t.routeId = null; t.stopId = null;
  if (get('stop') || get('route')) {
    if (!get('stop')) return { reason: 'route given without a stop' };
    const s = findStop(db, get('route'), get('stop'));
    if (s.error) return { reason: s.error };
    Object.assign(t, s);
  }
  t.guardians = [];
  for (const n of [1, 2]) {
    const name = get(`guardian${n}Name`), phoneRaw = get(`guardian${n}Phone`), emailRaw = get(`guardian${n}Email`);
    if (!name && !phoneRaw && !emailRaw) continue;
    const nm = splitName(name);
    if (!nm) return { reason: `guardian ${n} has a phone/email but no name` };
    const phone = phoneRaw ? normalisePhone(phoneRaw) : null;
    if (phoneRaw && !phone) return { reason: `guardian ${n} phone "${phoneRaw}" is not a 10-digit Indian mobile number` };
    const email = emailRaw ? emailRaw.toLowerCase() : null;
    if (email && !EMAIL_RE.test(email)) return { reason: `guardian ${n} email "${emailRaw}" is not valid` };
    if (!phone && !email) return { reason: `guardian ${n} needs a phone or an email` };
    t.guardians.push({ ...nm, relation: get(`guardian${n}Relation`) || (n === 1 ? 'Guardian' : 'Guardian 2'), phone, email });
  }
  if (!t.guardians.length) return { reason: 'guardian 1 is missing' };
  return { target: t };
}

const sameChild = (a, b) => a.firstName === b.firstName && a.lastName === b.lastName && a.dob === b.dob && a.programId === b.programId;
const childSig = t => JSON.stringify([t.firstName, t.lastName, t.dob, t.programId, t.status, t.routeId, t.stopId, t.guardians]);
const guardianKeys = g => [g.phone && `p:${g.phone}`, g.email && `e:${g.email}`].filter(Boolean);
const existingGuardianKeys = g => [normalisePhone(g.phone) && `p:${normalisePhone(g.phone)}`, g.email && `e:${String(g.email).toLowerCase()}`].filter(Boolean);
const sameName = (a, b) => normHeader(`${a.firstName}${a.lastName}`) === normHeader(`${b.firstName}${b.lastName}`);

// ---------------------------------------------------------------- fees

function feeTarget(db, get) {
  const t = { admissionNo: get('admissionNo'), installment: get('installment') };
  if (!t.admissionNo) return { reason: 'admission number is empty' };
  if (!t.installment) return { reason: 'installment is empty' };
  const s = db.students.find(x => x.admissionNo === t.admissionNo);
  if (!s) return { reason: `unknown admission number "${t.admissionNo}" (import children first)` };
  t.studentId = s.id;
  const dRaw = get('dueDate');
  t.dueDate = parseDate(dRaw);
  if (!t.dueDate) return { reason: dRaw ? `invalid due date "${dRaw}"` : 'due date is empty' };
  const ay = academicYearFor(db, t.dueDate);
  if (!ay) return { reason: `due date ${dRaw} is not inside any academic year` };
  t.academicYearId = ay.id;
  const aRaw = get('outstandingPaise');
  const p = rupeesToPaise(aRaw);
  if (p === null) return { reason: aRaw ? `outstanding "${aRaw}" is not an amount in rupees` : 'outstanding amount is empty' };
  if (p < 0) return { reason: 'outstanding amount is negative (credits are not imported; record them manually)' };
  if (p === 0) return { reason: 'outstanding is zero; nothing to carry over' };
  t.outstandingPaise = p;
  return { target: t };
}
const openingName = installment => `Opening balance — ${installment}`;

// ---------------------------------------------------------------- validate + apply

/**
 * Validate mapped rows against the current db. Pure.
 * @returns {{kind, rows:[{rowNo, line, status:'ok'|'quarantined'|'duplicate', reason, target}], counts, guardians:{new:number, merged:number}}}
 */
export function validateRows(db, { kind, mapping, rows }, { today, batchId = null } = {}) {
  checkMapping(kind, mapping);
  if (!Array.isArray(rows)) fail('VALIDATION', 'rows must be an array');
  const out = rows.map((r, i) => {
    const line = r && Number.isInteger(r.line) ? r.line : i + 2; // header is line 1
    if (r && r.problem) return { rowNo: i + 1, line, status: 'quarantined', reason: r.problem, target: null };
    const get = mapRow(mapping, r);
    const res = kind === 'children' ? childTarget(db, get, today) : feeTarget(db, get);
    return res.target ? { rowNo: i + 1, line, status: 'ok', reason: null, target: res.target } : { rowNo: i + 1, line, status: 'quarantined', reason: res.reason, target: null };
  });
  const batchOf = x => (x.importBatchId ? `batch ${x.importBatchId}` : 'already in the app');
  const ok = () => out.filter(r => r.status === 'ok');

  // duplicates against the db
  for (const r of ok()) {
    if (kind === 'children') {
      const s = db.students.find(x => x.admissionNo === r.target.admissionNo);
      if (!s) continue;
      if (sameChild(s, r.target)) Object.assign(r, { status: 'duplicate', reason: `duplicate (${batchOf(s)})` });
      else Object.assign(r, { status: 'quarantined', reason: `conflict: admission number ${r.target.admissionNo} already belongs to a child with different details` });
    } else {
      const inv = db.invoices.find(x => x.source === 'import' && x.studentId === r.target.studentId && x.installmentName === openingName(r.target.installment) && x.status !== 'cancelled');
      if (!inv) continue;
      const amt = sumPaise(inv.lines.map(l => l.amountPaise));
      if (amt === r.target.outstandingPaise && inv.dueDate === r.target.dueDate) Object.assign(r, { status: 'duplicate', reason: `duplicate (${batchOf(inv)})` });
      else Object.assign(r, { status: 'quarantined', reason: `conflict: an opening balance for ${r.target.installment} already exists with a different amount or due date (${inv.number})` });
    }
  }
  // duplicates within the file: identical repeats → duplicate; differing repeats → all quarantined
  const groups = new Map();
  for (const r of ok()) {
    const k = kind === 'children' ? r.target.admissionNo : `${r.target.studentId}|${r.target.installment}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const sig = kind === 'children' ? childSig : t => JSON.stringify([t.dueDate, t.outstandingPaise]);
    if (g.every(r => sig(r.target) === sig(g[0].target))) {
      for (const r of g.slice(1)) Object.assign(r, { status: 'duplicate', reason: `repeated in this file (same as line ${g[0].line})` });
    } else {
      const lines = g.map(r => r.line).join(', ');
      for (const r of g) Object.assign(r, { status: 'quarantined', reason: `conflict: lines ${lines} share ${kind === 'children' ? 'an admission number' : 'a student and installment'} with different details` });
    }
  }
  // guardians: merge siblings within the file and with existing guardians (phone/email); a name clash is quarantined
  let guardiansNew = 0, guardiansMerged = 0;
  if (kind === 'children') {
    const known = new Map(); // key → {name, ref}
    for (const g of db.guardians) for (const k of existingGuardianKeys(g)) known.set(k, { name: g, ref: { existingId: g.id } });
    const fileRefs = new Set();
    for (const r of ok()) {
      const refs = [];
      let clash = null;
      for (const g of r.target.guardians) {
        const hit = guardianKeys(g).map(k => known.get(k)).find(Boolean);
        if (hit && !sameName(hit.name, g)) { clash = `guardian ${g.firstName} shares a phone/email with ${hit.ref.existingId ? 'an existing guardian' : 'another guardian in this file'} under a different name`; break; }
        refs.push(hit ? hit.ref : null);
      }
      if (clash) { Object.assign(r, { status: 'quarantined', reason: `conflict: ${clash}` }); continue; }
      r.target.guardians.forEach((g, i) => {
        let ref = refs[i];
        if (!ref) { ref = { fileKey: guardianKeys(g)[0] }; for (const k of guardianKeys(g)) known.set(k, { name: g, ref }); }
        g.ref = ref;
        if (ref.existingId) { guardiansMerged++; }
        else if (fileRefs.has(ref.fileKey)) guardiansMerged++;
        else { fileRefs.add(ref.fileKey); guardiansNew++; }
      });
    }
  }
  const counts = { inputRows: out.length, ok: 0, quarantined: 0, duplicate: 0 };
  for (const r of out) counts[r.status]++;
  if (counts.ok + counts.quarantined + counts.duplicate !== counts.inputRows) fail('VALIDATION', 'Import counts do not reconcile');
  const sourceOutstandingPaise = kind === 'fees' ? sumPaise(ok().map(r => r.target.outstandingPaise)) : 0;
  return { kind, batchId, rows: out, counts, guardians: { new: guardiansNew, merged: guardiansMerged }, sourceOutstandingPaise };
}

/**
 * Apply the 'ok' rows of a validation. Re-validates first (the preview may be stale).
 * @returns {{inputRows, ok, quarantined, duplicate, created:{students, guardians, invoices}, merged:{guardians}, openingBalancePaise, sourceOutstandingPaise, rows}}
 */
export function applyRows(db, { kind, mapping, rows }, batchId, ctx) {
  const v = validateRows(db, { kind, mapping, rows }, { today: ctx.today, batchId });
  const created = { students: 0, guardians: 0, invoices: 0 };
  const merged = { guardians: 0 };
  let openingBalancePaise = 0;
  if (kind === 'children') {
    const fileGuardian = new Map(); // fileKey → guardian id
    for (const r of v.rows) {
      if (r.status !== 'ok') continue;
      const t = r.target;
      const sid = newId('stu');
      const gids = [];
      for (const g of t.guardians) {
        let gid = g.ref.existingId || fileGuardian.get(g.ref.fileKey);
        if (gid) merged.guardians++;
        else {
          gid = newId('grd');
          fileGuardian.set(g.ref.fileKey, gid);
          db.guardians.push({ id: gid, firstName: g.firstName, lastName: g.lastName, relation: g.relation, phone: g.phone || '', email: g.email || '', studentIds: [], source: 'import', importBatchId: batchId });
          created.guardians++;
        }
        if (!gids.includes(gid)) gids.push(gid);
      }
      db.students.push({ id: sid, firstName: t.firstName, lastName: t.lastName, dob: t.dob, programId: t.programId, admissionNo: t.admissionNo, status: t.status,
        guardianIds: gids, routeId: t.routeId, stopId: t.stopId, feeCategory: 'regular', healthNotes: null, source: 'import', importBatchId: batchId });
      for (const gid of gids) { const g = byId(db.guardians, gid); if (!g.studentIds.includes(sid)) g.studentIds.push(sid); }
      created.students++;
    }
  } else {
    let head = db.feeHeads.find(h => h.kind === 'openingBalance');
    if (!head && v.counts.ok) { head = { ...OPENING_HEAD }; db.feeHeads.push(head); }
    for (const r of v.rows) {
      if (r.status !== 'ok') continue;
      const t = r.target;
      db.invoices.push({
        id: newId('inv'), number: nextNumber(db, 'invoice', t.academicYearId), studentId: t.studentId, academicYearId: t.academicYearId,
        installmentName: openingName(t.installment), issueDate: ctx.today, dueDate: t.dueDate,
        lines: [{ id: newId('iln'), headId: head.id, description: OPENING_HEAD.name, amountPaise: t.outstandingPaise }],
        concessions: [], status: 'issued', cancelReason: null, createdAt: ctx.now, source: 'import', importBatchId: batchId,
      });
      created.invoices++;
      openingBalancePaise += t.outstandingPaise;
    }
    if (openingBalancePaise !== v.sourceOutstandingPaise) fail('VALIDATION', 'Opening balances do not reconcile with the source outstanding');
  }
  const result = { batchId, kind, inputRows: v.counts.inputRows, ok: v.counts.ok, quarantined: v.counts.quarantined, duplicate: v.counts.duplicate,
    created, merged, openingBalancePaise, sourceOutstandingPaise: v.sourceOutstandingPaise,
    rows: v.rows.map(r => ({ rowNo: r.rowNo, line: r.line, status: r.status, reason: r.reason })) };
  appendAudit(db, ctx, { entity: 'import', entityId: batchId || '-', action: 'commit',
    summary: `${kind}: input ${result.inputRows}, ok ${result.ok}, quarantined ${result.quarantined}, duplicate ${result.duplicate}; created students ${created.students}, guardians ${created.guardians}, invoices ${created.invoices}; merged guardians ${merged.guardians}; opening balances ${openingBalancePaise} paise` });
  return result;
}

// ---------------------------------------------------------------- server batches (import_batches / import_rows)

export function stageBatch(db, { kind, mapping, rows }, ctx) {
  checkMapping(kind, mapping);
  if (!Array.isArray(rows) || !rows.length) fail('VALIDATION', 'The file has no data rows');
  if (rows.length > 5000) fail('VALIDATION', 'At most 5,000 rows per import');
  const batchId = newId('imb');
  db.importBatches.push({ id: batchId, kind, mapping: { ...mapping }, status: 'staged', inputRows: rows.length, createdBy: ctx.actor.id, createdAt: ctx.now, result: null });
  rows.forEach((r, i) => db.importRows.push({ id: `${batchId}#${i + 1}`, batchId, rowNo: i + 1, line: Number.isInteger(r?.line) ? r.line : i + 2, values: { ...rowValues(r) }, problem: r?.problem || null }));
  const v = validateRows(db, { kind, mapping, rows }, { today: ctx.today, batchId });
  appendAudit(db, ctx, { entity: 'import', entityId: batchId, action: 'stage', summary: `${kind}: ${rows.length} rows staged` });
  return { batchId, counts: v.counts };
}

const batchRows = (db, batchId) => db.importRows.filter(r => r.batchId === batchId).sort((a, b) => a.rowNo - b.rowNo);
function mustBatch(db, batchId) {
  const b = byId(db.importBatches, batchId);
  if (!b) fail('NOT_FOUND', 'Import batch not found');
  return b;
}

export function previewBatch(db, batchId, today) {
  const b = mustBatch(db, batchId);
  const v = validateRows(db, { kind: b.kind, mapping: b.mapping, rows: batchRows(db, batchId) }, { today: today || b.createdAt.slice(0, 10), batchId });
  return { batchId, kind: b.kind, status: b.status, rows: v.rows, counts: v.counts, guardians: v.guardians, sourceOutstandingPaise: v.sourceOutstandingPaise };
}

export function commitBatch(db, batchId, ctx) {
  const b = mustBatch(db, batchId);
  if (b.status !== 'staged') fail('VALIDATION', `This import was already ${b.status}`);
  const r = applyRows(db, { kind: b.kind, mapping: b.mapping, rows: batchRows(db, batchId) }, batchId, ctx);
  Object.assign(b, { status: 'committed', committedAt: ctx.now, committedBy: ctx.actor.id, result: { ...r, rows: undefined } });
  return r;
}

export const batchList = db => [...db.importBatches].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  .map(b => ({ id: b.id, kind: b.kind, status: b.status, inputRows: b.inputRows, createdAt: b.createdAt, createdBy: b.createdBy, result: b.result }));

