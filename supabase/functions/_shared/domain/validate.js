// Whole-database integrity check. Returns a list of violations (empty = valid); never throws on bad data.
// Messages carry ids, never names or notes.

import { SCHEMA_VERSION, COLLECTIONS, RETENTION_KEYS } from '../store/schema.js';
import { isISODate, compareISO, addDays } from './dates.js';
import { parseDocNumber, ayShort } from './ids.js';
import { derivedStatus, invoiceAmounts, PAYMENT_MODES } from './fees.js';
import { academicYearFor } from './calendar.js';

const isObj = x => x !== null && typeof x === 'object' && !Array.isArray(x);

/** Array fields each record must carry; a record without them is MALFORMED and excluded from further checks. */
const REQUIRED_ARRAYS = {
  programs: ['teacherIds'], students: ['guardianIds'], guardians: ['studentIds'], staff: ['programIds'],
  noticeReceipts: ['studentIds'], calendarEvents: ['programIds'], routes: ['stops'],
  trips: ['positions', 'stopEvents', 'childEvents'], feeStructures: ['installments'],
  invoices: ['lines', 'concessions'], payments: ['allocations'], reports: ['progress', 'observations'],
};

/**
 * @returns {{code:string, entity:string, id:string, message:string, severity:'error'|'warning'}[]}
 *   SHAPE / SCHEMA_VERSION / MALFORMED mean the document is structurally unusable.
 */
export function validateDb(db) {
  const { violations: v, clean } = checkStructure(db);
  if (!clean) return v;
  const add = (code, entity, id, message, severity = 'error') => v.push({ code, entity, id: String(id), message, severity });
  try { checks(clean, add, v); } catch (e) {
    add('MALFORMED', 'db', '-', `validator stopped on malformed data: ${e && e.message}`);
  }
  return v;
}

/**
 * Cheap structural check (used on every load/commit): document shape, schema version and per-record
 * shape. Returns the violations and, when the shape is usable, a copy with malformed records excluded.
 */
export function checkStructure(db) {
  const v = [];
  const add = (code, entity, id, message) => v.push({ code, entity, id: String(id), message, severity: 'error' });
  if (!isObj(db)) { add('SHAPE', 'db', '-', 'not an object'); return { violations: v, clean: null }; }
  if (db.schemaVersion !== SCHEMA_VERSION) add('SCHEMA_VERSION', 'db', '-', `schemaVersion ${db.schemaVersion} ≠ ${SCHEMA_VERSION}`);
  if (!Number.isSafeInteger(db.rev)) add('SHAPE', 'db', '-', 'rev missing or not an integer');
  if (!isObj(db.school)) add('SHAPE', 'school', '-', 'school missing or not an object');
  if (!isObj(db.counters) || !['invoice', 'receipt', 'refund'].every(k => isObj(db.counters[k]))) add('SHAPE', 'counters', '-', 'counters missing or malformed');
  for (const c of COLLECTIONS) if (!Array.isArray(db[c])) add('SHAPE', c, '-', 'collection missing or not an array');
  if (v.length) return { violations: v, clean: null };
  // Exclude malformed records (reported) so later checks never dereference them.
  const clean = { ...db };
  for (const c of COLLECTIONS) {
    clean[c] = db[c].filter((x, i) => {
      if (!isObj(x)) { add('MALFORMED', c, `#${i}`, 'record is not an object'); return false; }
      const bad = (REQUIRED_ARRAYS[c] || []).find(f => !Array.isArray(x[f]));
      if (bad) { add('MALFORMED', c, x.id ?? `#${i}`, `${bad} is not an array`); return false; }
      return true;
    });
  }
  return { violations: v, clean };
}

const ENUMS = {
  invoices: ['issued', 'partiallyPaid', 'paid', 'cancelled'],
  payments: ['valid', 'cancelled'],
  trips: ['active', 'ended'],
  threads: ['open', 'closed'],
  photos: ['pending', 'ready', 'rejected', 'deleting', 'deleted', 'expired'],
  progressEvents: ['introduced', 'practising', 'mastered'],
  reports: ['draft', 'submitted', 'published'],
  dataRequests: ['open', 'in_progress', 'done', 'declined'],
};
const AREAS = ['practicalLife', 'sensorial', 'language', 'math', 'culture'];
const TERMS = ['Term 1', 'Term 2', 'Term 3'];
const CONSENT_PURPOSE_NAMES = ['app_account', 'push', 'bus_live', 'photos'];

function checks(db, add, v) {
  const index = {};
  for (const c of COLLECTIONS) {
    if (c === 'noticeReceipts' || c === 'attendance') continue;
    const m = new Map();
    for (const x of db[c]) {
      if (!x.id) { add('MISSING_ID', c, '?', 'row without id'); continue; }
      if (m.has(x.id)) add('DUPLICATE_ID', c, x.id, 'duplicate id');
      m.set(x.id, x);
    }
    index[c] = m;
  }
  const has = (c, id) => index[c].has(id);
  const ref = (entity, id, field, c, target) => { if (!has(c, target)) add('BAD_REF', entity, id, `${field} → missing ${c} ${target}`); };
  const isInt = n => Number.isSafeInteger(n);
  const money = (entity, id, field, n) => { if (!isInt(n)) add('NOT_PAISE', entity, id, `${field} is not integer paise`); };

  const nonNeg = n => isInt(n) && n >= 0;
  const positive = (entity, id, field, n) => { money(entity, id, field, n); if (isInt(n) && n <= 0) add('NOT_POSITIVE', entity, id, `${field} must be greater than zero`); };
  for (const [c, allowed] of Object.entries(ENUMS)) {
    for (const x of db[c]) if (!allowed.includes(x.status)) add('BAD_STATUS', c, x.id, `status ${String(x.status).slice(0, 40)} not in ${allowed.join('/')}`);
  }

  // school (values reach the UI, so types are strict)
  const sc = db.school;
  if (!sc.currentAcademicYearId || !has('academicYears', sc.currentAcademicYearId)) add('BAD_REF', 'school', '-', 'currentAcademicYearId missing or unknown');
  for (const f of ['name', 'address', 'phone']) if (typeof sc[f] !== 'string') add('BAD_SCHOOL', 'school', '-', `${f} must be text`);
  if (!Array.isArray(sc.weeklyOffs) || !sc.weeklyOffs.every(d => isInt(d) && d >= 0 && d <= 6)) add('BAD_SCHOOL', 'school', '-', 'weeklyOffs must be day numbers 0–6');
  for (const f of ['invoicePrefix', 'receiptPrefix', 'refundPrefix']) if (!/^[A-Z]+$/.test(sc[f] ?? '')) add('BAD_SCHOOL', 'school', '-', `${f} must be capital letters`);
  if (sc.lateFeeRule !== null && sc.lateFeeRule !== undefined) {
    const r = sc.lateFeeRule;
    if (!isObj(r)) add('BAD_RULE', 'school', '-', 'lateFeeRule must be an object or null');
    else {
      if (!nonNeg(r.graceDays)) add('BAD_RULE', 'school', '-', 'lateFeeRule.graceDays must be a whole number ≥ 0');
      if (!['flat', 'perDay'].includes(r.mode)) add('BAD_RULE', 'school', '-', 'lateFeeRule.mode must be flat or perDay');
      if (!nonNeg(r.amountPaise)) add('BAD_RULE', 'school', '-', 'lateFeeRule.amountPaise must be integer paise ≥ 0');
      if (r.capPaise !== null && r.capPaise !== undefined && !nonNeg(r.capPaise)) add('BAD_RULE', 'school', '-', 'lateFeeRule.capPaise must be integer paise ≥ 0 or empty');
      if (typeof r.shiftDueToWorkingDay !== 'boolean') add('BAD_RULE', 'school', '-', 'lateFeeRule.shiftDueToWorkingDay must be true/false');
    }
  }
  if (!isObj(sc.retention)) add('BAD_SCHOOL', 'school', '-', 'retention must be an object');
  else for (const k of RETENTION_KEYS) if (sc.retention[k] !== null && !(isInt(sc.retention[k]) && sc.retention[k] > 0)) add('BAD_SCHOOL', 'school', '-', `retention.${k} must be whole months above zero, or null (not decided)`);
  const an = sc.announcement;
  if (an !== null && an !== undefined && !(isObj(an) && typeof an.text === 'string' && an.text.length > 0 && an.text.length <= 280 && ['info', 'warn'].includes(an.tone)
    && (an.until === null || isISODate(an.until)))) add('BAD_SCHOOL', 'school', '-', 'announcement must be null or {text ≤ 280 characters, tone info/warn, until date or null}');
  for (const ay of db.academicYears) {
    if (!isISODate(ay.startDate) || !isISODate(ay.endDate) || compareISO(ay.endDate, ay.startDate) < 0) add('BAD_DATE', 'academicYear', ay.id, 'invalid date range');
    try { ayShort(ay.id); } catch { add('BAD_ID', 'academicYear', ay.id, 'id must look like AY2026-27'); }
  }
  const ays = db.academicYears.filter(a => isISODate(a.startDate) && isISODate(a.endDate)).sort((a, b) => compareISO(a.startDate, b.startDate));
  for (let i = 1; i < ays.length; i++) {
    const prev = ays[i - 1], cur = ays[i];
    if (compareISO(cur.startDate, prev.endDate) <= 0) add('AY_OVERLAP', 'academicYear', cur.id, `overlaps ${prev.id}`);
    else if (cur.startDate !== addDays(prev.endDate, 1)) add('AY_GAP', 'academicYear', cur.id, `gap after ${prev.id} (${prev.endDate} → ${cur.startDate}); dates in the gap cannot take payments`, 'warning');
  }
  const ayOf = date => (isISODate(date) ? academicYearFor(db, date) : null);
  const segOf = ayId => { try { return ayShort(ayId); } catch { return null; } };

  // people
  for (const p of db.programs) for (const t of p.teacherIds || []) ref('program', p.id, 'teacherIds', 'staff', t);
  for (const s of db.staff) for (const p of s.programIds || []) ref('staff', s.id, 'programIds', 'programs', p);
  for (const s of db.students) {
    ref('student', s.id, 'programId', 'programs', s.programId);
    if (!isISODate(s.dob)) add('BAD_DATE', 'student', s.id, 'dob invalid');
    if (s.leftOn !== undefined && s.leftOn !== null && !isISODate(s.leftOn)) add('BAD_DATE', 'student', s.id, 'leftOn invalid');
    if (s.status === 'active' && s.leftOn) add('LEFT_ON_ACTIVE', 'student', s.id, 'an active student has a leftOn date');
    if (!s.guardianIds || !s.guardianIds.length) add('NO_GUARDIAN', 'student', s.id, 'student has no guardian');
    for (const g of s.guardianIds || []) {
      ref('student', s.id, 'guardianIds', 'guardians', g);
      const gd = index.guardians.get(g);
      if (gd && !gd.studentIds.includes(s.id)) add('NOT_BIDIRECTIONAL', 'student', s.id, `guardian ${g} does not list this student`);
    }
    if (s.routeId) {
      const r = index.routes.get(s.routeId);
      if (!r) add('BAD_REF', 'student', s.id, `routeId → missing route ${s.routeId}`);
      else if (!s.stopId || !r.stops.some(st => st.id === s.stopId)) add('NO_STOP', 'student', s.id, `on route ${s.routeId} without a stop on that route`);
    } else if (s.stopId) add('STOP_WITHOUT_ROUTE', 'student', s.id, 'stopId set without routeId');
  }
  for (const g of db.guardians) {
    for (const sid of g.studentIds || []) {
      ref('guardian', g.id, 'studentIds', 'students', sid);
      const st = index.students.get(sid);
      if (st && !st.guardianIds.includes(g.id)) add('NOT_BIDIRECTIONAL', 'guardian', g.id, `student ${sid} does not list this guardian`);
    }
  }

  // messaging
  for (const n of db.notices) {
    const a = n.audience || {};
    if (a.scope === 'program') for (const p of a.programIds || []) ref('notice', n.id, 'audience.programIds', 'programs', p);
    else if (a.scope === 'students') for (const s of a.studentIds || []) ref('notice', n.id, 'audience.studentIds', 'students', s);
    else if (a.scope !== 'school') add('BAD_AUDIENCE', 'notice', n.id, 'unknown audience scope');
  }
  const recKeys = new Set();
  for (const r of db.noticeReceipts) {
    const k = `${r.noticeId}|${r.guardianId}`;
    if (recKeys.has(k)) add('DUPLICATE_RECEIPT', 'noticeReceipt', k, 'more than one receipt for (notice, guardian)');
    recKeys.add(k);
    ref('noticeReceipt', k, 'noticeId', 'notices', r.noticeId);
    ref('noticeReceipt', k, 'guardianId', 'guardians', r.guardianId);
    for (const s of r.studentIds || []) ref('noticeReceipt', k, 'studentIds', 'students', s);
  }
  for (const t of db.threads) {
    ref('thread', t.id, 'guardianId', 'guardians', t.guardianId);
    ref('thread', t.id, 'studentId', 'students', t.studentId);
    ref('thread', t.id, 'programId', 'programs', t.programId);
  }
  for (const m of db.messages) ref('message', m.id, 'threadId', 'threads', m.threadId);

  // calendar
  for (const e of db.calendarEvents) {
    ref('calendarEvent', e.id, 'academicYearId', 'academicYears', e.academicYearId);
    if (!isISODate(e.startDate) || !isISODate(e.endDate) || compareISO(e.endDate, e.startDate) < 0) add('BAD_DATE', 'calendarEvent', e.id, 'invalid date range');
    for (const p of e.programIds || []) ref('calendarEvent', e.id, 'programIds', 'programs', p);
  }

  // transport
  for (const r of db.routes) {
    ref('route', r.id, 'driverId', 'staff', r.driverId);
    if (r.attendantId) ref('route', r.id, 'attendantId', 'staff', r.attendantId);
    money('route', r.id, 'transportFeePaise', r.transportFeePaise);
    const seqs = new Set();
    for (const st of r.stops) {
      if (seqs.has(st.seq)) add('DUPLICATE_SEQ', 'route', r.id, `stop seq ${st.seq} repeated`);
      seqs.add(st.seq);
      if (!Number.isFinite(st.lat) || !Number.isFinite(st.lng)) add('BAD_COORD', 'route', r.id, `stop ${st.id} has no coordinates`);
    }
  }
  for (const t of db.trips) {
    ref('trip', t.id, 'routeId', 'routes', t.routeId);
    const r = index.routes.get(t.routeId);
    for (const e of t.stopEvents || []) if (r && !r.stops.some(s => s.id === e.stopId)) add('BAD_REF', 'trip', t.id, `stopEvent → unknown stop ${e.stopId}`);
    for (const e of t.childEvents || []) ref('trip', t.id, 'childEvents.studentId', 'students', e.studentId);
  }

  // fees
  for (const fs of db.feeStructures) {
    ref('feeStructure', fs.id, 'academicYearId', 'academicYears', fs.academicYearId);
    ref('feeStructure', fs.id, 'programId', 'programs', fs.programId);
    for (const ins of fs.installments) for (const l of ins.lines) { ref('feeStructure', fs.id, 'headId', 'feeHeads', l.headId); money('feeStructure', fs.id, 'amountPaise', l.amountPaise); }
  }
  const invNumbers = new Map();
  for (const inv of db.invoices) {
    ref('invoice', inv.id, 'studentId', 'students', inv.studentId);
    ref('invoice', inv.id, 'academicYearId', 'academicYears', inv.academicYearId);
    for (const l of inv.lines) {
      ref('invoice', inv.id, 'lines.headId', 'feeHeads', l.headId);
      money('invoice', inv.id, 'lines.amountPaise', l.amountPaise);
      if (isInt(l.amountPaise) && l.amountPaise < 0) add('NEGATIVE_AMOUNT', 'invoice', inv.id, 'line amount below zero');
    }
    for (const c of inv.concessions) positive('invoice', inv.id, 'concessions.amountPaise', c.amountPaise);
    if (invNumbers.has(inv.number)) add('DUPLICATE_NUMBER', 'invoice', inv.id, `invoice number ${inv.number} repeated`);
    invNumbers.set(inv.number, inv.id);
    const seg = parseDocNumber(inv.number)?.ay;
    if (seg && segOf(inv.academicYearId) && seg !== segOf(inv.academicYearId)) add('NUMBER_AY_MISMATCH', 'invoice', inv.id, `number ${inv.number} is not in ${inv.academicYearId}`);
  }
  for (const p of db.payments) {
    ref('payment', p.id, 'studentId', 'students', p.studentId);
    positive('payment', p.id, 'amountPaise', p.amountPaise);
    money('payment', p.id, 'creditPaise', p.creditPaise);
    if (isInt(p.creditPaise) && p.creditPaise < 0) add('NEGATIVE_AMOUNT', 'payment', p.id, 'creditPaise below zero');
    if (!PAYMENT_MODES.includes(p.mode)) add('BAD_MODE', 'payment', p.id, `mode ${String(p.mode).slice(0, 40)}`);
    const ay = ayOf(p.paidOn);
    if (!isISODate(p.paidOn)) add('BAD_DATE', 'payment', p.id, 'paidOn invalid');
    else if (!ay) add('PAYMENT_AY', 'payment', p.id, 'paidOn is not inside any academic year');
    else {
      if (p.academicYearId !== undefined && p.academicYearId !== ay.id) add('PAYMENT_AY', 'payment', p.id, `academicYearId ${p.academicYearId} ≠ year of paidOn ${ay.id}`);
      const seg = parseDocNumber(p.receiptNumber)?.ay;
      if (seg && seg !== segOf(ay.id)) add('NUMBER_AY_MISMATCH', 'payment', p.id, `receipt ${p.receiptNumber} is not in the year of paidOn (${ay.id})`);
    }
    let alloc = 0;
    for (const a of p.allocations) {
      if (!isObj(a)) { add('MALFORMED', 'payment', p.id, 'allocation is not an object'); continue; }
      ref('payment', p.id, 'allocations.invoiceId', 'invoices', a.invoiceId);
      positive('payment', p.id, 'allocations.amountPaise', a.amountPaise);
      const inv = index.invoices.get(a.invoiceId);
      if (inv && inv.studentId !== p.studentId) add('CROSS_STUDENT', 'payment', p.id, `allocated to invoice ${a.invoiceId} of another student`);
      alloc += a.amountPaise;
    }
    if (isInt(alloc) && alloc + p.creditPaise !== p.amountPaise) add('PAYMENT_SPLIT', 'payment', p.id, 'amount ≠ allocations + credit');
    // a valid credit-mode payment is funded exactly by the credit rows it consumed; nothing else consumes credit
    const consumed = db.credits.filter(c => c.consumedByPaymentId === p.id).reduce((s, c) => s + c.amountPaise, 0);
    if (p.mode === 'credit' && p.status === 'valid' && consumed !== p.amountPaise) add('CREDIT_UNFUNDED', 'payment', p.id, `credit payment ${p.amountPaise} paise but consumed credit ${consumed}`);
    if ((p.mode !== 'credit' || p.status !== 'valid') && consumed !== 0) add('CREDIT_CONSUMER', 'payment', p.id, 'only a valid credit-mode payment may consume credit');
  }
  for (const r of db.refunds) {
    ref('refund', r.id, 'paymentId', 'payments', r.paymentId);
    positive('refund', r.id, 'amountPaise', r.amountPaise);
    const ay = ayOf(r.date);
    if (!isISODate(r.date)) add('BAD_DATE', 'refund', r.id, 'date invalid');
    else if (!ay) add('REFUND_AY', 'refund', r.id, 'date is not inside any academic year');
    else {
      const seg = parseDocNumber(r.voucherNumber)?.ay;
      if (seg && seg !== segOf(ay.id)) add('NUMBER_AY_MISMATCH', 'refund', r.id, `voucher ${r.voucherNumber} is not in the year of its date (${ay.id})`);
    }
    const p = index.payments.get(r.paymentId);
    if (r.invoiceId === null || r.invoiceId === undefined) {
      // refund of unallocated credit: exactly the credit rows it consumed
      const rows = db.credits.filter(c => c.consumedByRefundId === r.id);
      const sum = rows.reduce((s, c) => s + c.amountPaise, 0);
      if (sum !== r.amountPaise) add('REFUND_CREDIT_MISMATCH', 'refund', r.id, `credit refund ${r.amountPaise} paise but consumed credit ${sum}`);
      if (rows.some(c => c.sourcePaymentId !== r.paymentId)) add('REFUND_CREDIT_MISMATCH', 'refund', r.id, 'consumed credit from another payment');
    } else {
      ref('refund', r.id, 'invoiceId', 'invoices', r.invoiceId);
      const a = p && p.allocations.find(x => isObj(x) && x.invoiceId === r.invoiceId);
      if (p && !a) add('REFUND_UNALLOCATED', 'refund', r.id, 'payment was not allocated to that invoice');
    }
  }
  // refunds per (payment, invoice) never exceed the allocation
  const refundTotals = new Map();
  for (const r of db.refunds) if (r.invoiceId) refundTotals.set(`${r.paymentId}|${r.invoiceId}`, (refundTotals.get(`${r.paymentId}|${r.invoiceId}`) || 0) + r.amountPaise);
  for (const [k, total] of refundTotals) {
    const [pid, iid] = k.split('|');
    const a = index.payments.get(pid)?.allocations.find(x => isObj(x) && x.invoiceId === iid);
    if (a && total > a.amountPaise) add('OVER_REFUND', 'refund', k, 'refunds exceed the allocation');
  }
  for (const c of db.credits) {
    ref('credit', c.id, 'studentId', 'students', c.studentId);
    ref('credit', c.id, 'sourcePaymentId', 'payments', c.sourcePaymentId);
    if (c.consumedByPaymentId) ref('credit', c.id, 'consumedByPaymentId', 'payments', c.consumedByPaymentId);
    if (c.consumedByRefundId) ref('credit', c.id, 'consumedByRefundId', 'refunds', c.consumedByRefundId);
    if (c.consumedByPaymentId && c.consumedByRefundId) add('CREDIT_DOUBLE_USE', 'credit', c.id, 'consumed by both a payment and a refund');
    positive('credit', c.id, 'amountPaise', c.amountPaise);
  }
  // credit rows match payment remainders
  for (const p of db.payments) {
    const rows = db.credits.filter(c => c.sourcePaymentId === p.id).reduce((s, c) => s + c.amountPaise, 0);
    if (rows !== p.creditPaise) add('CREDIT_MISMATCH', 'payment', p.id, `creditPaise ${p.creditPaise} ≠ credit rows ${rows}`);
  }
  // invoice status matches derived balances; no negative balance (only when money fields are sane)
  if (!v.some(x => ['NOT_PAISE', 'BAD_REF', 'MALFORMED'].includes(x.code))) {
    for (const inv of db.invoices) {
      if (inv.status === 'cancelled') continue;
      const want = derivedStatus(db, inv);
      if (inv.status !== want) add('STATUS_MISMATCH', 'invoice', inv.id, `status ${inv.status}, derived ${want}`);
      if (invoiceAmounts(db, inv).balancePaise < 0) add('NEGATIVE_BALANCE', 'invoice', inv.id, 'balance below zero');
    }
  }
  checkSequence(add, 'invoice', db.invoices.map(i => i.number), db.counters.invoice);
  checkSequence(add, 'payment', db.payments.map(p => p.receiptNumber), db.counters.receipt);
  checkSequence(add, 'refund', db.refunds.map(r => r.voucherNumber), db.counters.refund);

  // attendance and diary
  const att = new Set();
  for (const a of db.attendance) {
    const k = `${a.date}|${a.studentId}`;
    if (att.has(k)) add('DUPLICATE_ATTENDANCE', 'attendance', k, 'more than one record for (date, student)');
    att.add(k);
    if (!has('students', a.studentId)) add('BAD_REF', 'attendance', k, 'studentId → missing student');
    if (!['present', 'absent', 'late', 'leave'].includes(a.status)) add('BAD_STATUS', 'attendance', k, `status ${a.status}`);
  }
  for (const d of db.diaryEntries) ref('diaryEntry', d.id, 'studentId', 'students', d.studentId);

  // learning (Phase 3). Messages carry ids, never text.
  const presKeys = new Map();
  for (const p of db.presentations) {
    if (!AREAS.includes(p.area)) add('BAD_AREA', 'presentation', p.id, `area ${String(p.area).slice(0, 30)}`);
    if (typeof p.name !== 'string' || !p.name.trim()) add('MISSING_NAME', 'presentation', p.id, 'name is empty');
    if (typeof p.key !== 'string' || !p.key) add('MISSING_KEY', 'presentation', p.id, 'key is empty');
    else if (presKeys.has(p.key)) add('DUPLICATE_KEY', 'presentation', p.id, `key repeats ${presKeys.get(p.key)}`);
    else presKeys.set(p.key, p.id);
    if (typeof p.active !== 'boolean') add('BAD_FLAG', 'presentation', p.id, 'active must be true/false');
    for (const f of ['ageFromMonths', 'ageToMonths']) if (p[f] !== null && p[f] !== undefined && !nonNeg(p[f])) add('BAD_AGE', 'presentation', p.id, `${f} must be whole months or empty`);
    if (nonNeg(p.ageFromMonths) && nonNeg(p.ageToMonths) && p.ageFromMonths > p.ageToMonths) add('BAD_AGE', 'presentation', p.id, 'ageFromMonths is above ageToMonths');
  }
  for (const o of db.observations) {
    ref('observation', o.id, 'studentId', 'students', o.studentId);
    ref('observation', o.id, 'programId', 'programs', o.programId);
    if (o.presentationId) ref('observation', o.id, 'presentationId', 'presentations', o.presentationId);
    if (!isISODate(o.date)) add('BAD_DATE', 'observation', o.id, 'date invalid');
    if (!AREAS.includes(o.area)) add('BAD_AREA', 'observation', o.id, `area ${String(o.area).slice(0, 30)}`);
    if (typeof o.text !== 'string' || !o.text.trim()) add('MISSING_TEXT', 'observation', o.id, 'text is empty');
    if (o.sharedAt && !o.sharedBy) add('SHARED_WITHOUT_ACTOR', 'observation', o.id, 'sharedAt set without sharedBy');
    if (!o.sharedAt && o.sharedBy) add('SHARED_WITHOUT_TIME', 'observation', o.id, 'sharedBy set without sharedAt');
    const pres = o.presentationId && index.presentations.get(o.presentationId);
    if (pres && pres.area !== o.area) add('AREA_MISMATCH', 'observation', o.id, 'area differs from its presentation area');
  }
  for (const ph of db.photos) {
    if (ph.status !== 'expired' && ph.status !== 'deleted') ref('photo', ph.id, 'observationId', 'observations', ph.observationId);
    ref('photo', ph.id, 'studentId', 'students', ph.studentId);
    const o = index.observations.get(ph.observationId);
    if (o && o.studentId !== ph.studentId) add('CROSS_STUDENT', 'photo', ph.id, 'photo is of a different child than its observation');
    if (ph.status === 'ready' && !ph.demo && !ph.path) add('MISSING_PATH', 'photo', ph.id, 'a ready photo has no storage path');
    if (!ph.soloConfirmedBy) add('NOT_CONFIRMED_SOLO', 'photo', ph.id, 'nobody confirmed that only this child is in the frame');
  }
  const evGroups = new Map();
  for (const e of db.progressEvents) {
    ref('progressEvent', e.id, 'studentId', 'students', e.studentId);
    ref('progressEvent', e.id, 'presentationId', 'presentations', e.presentationId);
    if (!isISODate(e.date)) add('BAD_DATE', 'progressEvent', e.id, 'date invalid');
    if (!(isInt(e.seq) && e.seq >= 1)) add('BAD_SEQ', 'progressEvent', e.id, 'seq must be a whole number from 1');
    if (e.correction === true && !(typeof e.reason === 'string' && e.reason.trim())) add('CORRECTION_WITHOUT_REASON', 'progressEvent', e.id, 'a correction needs a reason');
    const k = `${e.studentId}|${e.presentationId}`;
    if (!evGroups.has(k)) evGroups.set(k, []);
    evGroups.get(k).push(e);
  }
  for (const [k, list] of evGroups) {
    const seqs = list.map(e => e.seq).filter(isInt).sort((a, b) => a - b);
    seqs.forEach((n, i) => {
      if (i > 0 && n === seqs[i - 1]) add('DUPLICATE_SEQ', 'progressEvent', k, `seq ${n} repeated`);
      else if (n !== i + 1) add('NUMBER_GAP', 'progressEvent', k, `seq is not contiguous from 1 (saw ${n} at position ${i + 1})`);
    });
  }
  const reportKeys = new Set();
  for (const r of db.reports) {
    ref('report', r.id, 'studentId', 'students', r.studentId);
    ref('report', r.id, 'academicYearId', 'academicYears', r.academicYearId);
    if (!TERMS.includes(r.termName)) add('BAD_TERM', 'report', r.id, `termName ${String(r.termName).slice(0, 20)}`);
    if (!isISODate(r.fromDate) || !isISODate(r.toDate) || compareISO(r.toDate, r.fromDate) < 0) add('BAD_DATE', 'report', r.id, 'invalid term date range');
    if (!isInt(r.revision) || r.revision < 1) add('BAD_REVISION', 'report', r.id, 'revision must be a whole number from 1');
    const k = `${r.studentId}|${r.academicYearId}|${r.termName}`;
    if (reportKeys.has(k)) add('DUPLICATE_REPORT', 'report', r.id, 'more than one report for (student, academic year, term)');
    reportKeys.add(k);
    if (r.status === 'published' && !(r.publishedAt && r.publishedBy)) add('PUBLISHED_WITHOUT_STAMP', 'report', r.id, 'a published report needs publishedAt and publishedBy');
    if (r.status !== 'published' && r.publishedAt) add('PUBLISHED_STAMP_ON_DRAFT', 'report', r.id, 'publishedAt set on a report that is not published');
  }
  for (const r of db.dataRequests) {
    ref('dataRequest', r.id, 'guardianId', 'guardians', r.guardianId);
    if (!['export', 'erasure', 'correction'].includes(r.kind)) add('BAD_KIND', 'dataRequest', r.id, `kind ${String(r.kind).slice(0, 30)}`);
    if (['done', 'declined'].includes(r.status) && !r.resolution) add('CLOSED_WITHOUT_RESOLUTION', 'dataRequest', r.id, 'a closed request needs a resolution');
  }
  const consentKeys = new Set();
  for (const c of db.consents) {
    ref('consent', c.id, 'guardianId', 'guardians', c.guardianId);
    ref('consent', c.id, 'studentId', 'students', c.studentId);
    if (!CONSENT_PURPOSE_NAMES.includes(c.purpose)) add('BAD_PURPOSE', 'consent', c.id, `purpose ${String(c.purpose).slice(0, 30)}`);
    if (typeof c.version !== 'string' || !c.version) add('MISSING_VERSION', 'consent', c.id, 'version is empty');
    const k = `${c.guardianId}|${c.studentId}|${c.purpose}|${c.version}|${c.withdrawnAt ? 'w' : 'live'}`;
    if (!c.withdrawnAt && consentKeys.has(k)) add('DUPLICATE_CONSENT', 'consent', c.id, 'two live records for (guardian, child, purpose, version)');
    consentKeys.add(k);
  }
  return v;
}

/** Numbers unique and contiguous 1..n per academic-year segment; each counter equals the highest number issued. */
function checkSequence(add, entity, numbers, counters) {
  const byAy = new Map();
  const seen = new Set();
  for (const num of numbers) {
    const p = parseDocNumber(num);
    if (!p) { add('BAD_NUMBER', entity, String(num), 'number does not match PREFIX/YY-YY/NNNN'); continue; }
    if (seen.has(num)) add('DUPLICATE_NUMBER', entity, num, 'number repeated');
    seen.add(num);
    if (!byAy.has(p.ay)) byAy.set(p.ay, []);
    byAy.get(p.ay).push(p.n);
  }
  for (const [ay, ns] of byAy) {
    const sorted = [...new Set(ns)].sort((a, b) => a - b);
    sorted.forEach((n, i) => {
      if (n !== i + 1 && (i === 0 || sorted[i - 1] + 1 !== n)) add('NUMBER_GAP', entity, ay, `sequence gap before ${n} in ${ay}`);
    });
  }
  const counterSegs = new Set();
  for (const [key, value] of Object.entries(counters)) {
    let seg;
    try { seg = ayShort(key); } catch { add('BAD_COUNTER', entity, key, 'counter key is not an academic year id'); continue; }
    counterSegs.add(seg);
    if (!Number.isSafeInteger(value) || value < 0) { add('BAD_COUNTER', entity, key, 'counter is not a whole number'); continue; }
    const max = byAy.has(seg) ? Math.max(...byAy.get(seg)) : 0;
    if (value < max) add('COUNTER_BEHIND', entity, key, `counter ${value} below highest number ${max}`);
    if (value > max) add('COUNTER_AHEAD', entity, key, `counter ${value} above highest number ${max}; the next number would leave a gap`);
  }
  for (const seg of byAy.keys()) if (!counterSegs.has(seg)) add('COUNTER_BEHIND', entity, seg, 'numbers issued but no counter');
}
