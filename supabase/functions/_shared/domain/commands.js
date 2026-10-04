// The single registry of write commands and their authorization.
// The demo api (src/api/index.js) runs a command as storage.commit(d => { authorize; run }); the
// `command` Edge Function runs the SAME entry server-side: load the slice → authorize → run → persist
// with an optimistic revision check. Authorization is therefore written once and enforced on the server.
//
// Entry shape:
//   slice      which revision-guarded slice the command writes ('ledger'|'messaging'|'calendar'|'transport'|
//              'classroom'|'people'|'account'|'settlement'|'export'|'erasure'|'learning'|'retention'); the server
//              loads that slice's collections.
//   authorize(p, db, args)   throws DomainError NOT_ALLOWED / NOT_FOUND; p = persona (see personaFor)
//   run(db, args, ctx, p)    mutates db and returns the api result (same shape in both modes)
//   load(args)               optional hints for the server loader (e.g. {tripId})
//   serverOnly               true → the demo api refuses it (needs tables that only exist server-side)
//   readOnly                 true → the server runs it but never persists (e.g. import.preview)
//   allowUnlinked            true → may run for a signed-in user without an app_users link
//   demoOnly                 true → the demo runs it; the server refuses it (e.g. the mock payment: no money moves)
//   beforeConsent            true → a parent may run it before giving app_account consent (consent itself, data access);
//                            every other parent command only sees children with current app_account consent
//   storedResult(result)     what the server keeps for a replay of this request id (default: the result itself)
// args is always the positional argument array of the api method.

import { fail, newId } from './ids.js';
import { byId, fullName, activeStudents, childrenOf } from './people.js';
import * as M from './messaging.js';
import * as C from './calendar.js';
import * as H from './holiday-csv.js';
import * as T from './transport.js';
import * as F from './fees.js';
import * as A from './attendance.js';
import * as D from './diary.js';
import * as G from './gateway.js';
import * as I from './import-people.js';
import { appendAudit } from './audit.js';
import { tsToMs } from './dates.js';
import { guardianExport } from './export.js';
import * as O from './observations.js';
import * as P from './photos.js';
import * as PG from './progress.js';
import * as RP from './reports.js';
import * as RT from './retention.js';
import * as CU from './presentations.js';
import { isISODate, compareISO } from './dates.js';

export const ROLE_LABEL = { admin: 'Principal', teacher: 'Teacher', accountant: 'Accountant', driver: 'Driver', parent: 'Parent' };
export const STAFF_SEES_ALL = ['admin', 'accountant'];
export const CONSENT_PURPOSES = ['app_account', 'push', 'bus_live', 'photos'];
// v2 (Phase 3): the photos purpose and the retention section of the notice. Must equal PRIVACY_VERSION
// (src/ui/privacy.js) and app.consent_version() (latest migration defining it).
export const CONSENT_VERSION = 'v2';
export const MAX_INVITE_FAILURES = 5; // wrong dates of birth per invite code, across all accounts
export const ERASED_MESSAGE = '[message erased at the guardian\'s request]';

// ---------------------------------------------------------------- personas

function staffPersona(db, s) {
  const allPrograms = db.programs.map(p => p.id);
  const allStudents = activeStudents(db).map(x => x.id);
  const progName = id => byId(db.programs, id)?.name ?? id;
  const base = { id: `persona-${s.id}`, role: s.role, staffId: s.id, label: `${ROLE_LABEL[s.role] || s.role} — ${fullName(s)}` };
  if (s.role === 'admin' || s.role === 'accountant') return { ...base, studentIds: allStudents, programIds: allPrograms };
  if (s.role === 'teacher') {
    const programIds = [...(s.programIds || [])];
    return { ...base, label: `${base.label} (${programIds.map(progName).join(', ')})`, programIds, studentIds: activeStudents(db).filter(x => programIds.includes(x.programId)).map(x => x.id) };
  }
  if (s.role === 'driver') {
    const routeIds = db.routes.filter(r => r.driverId === s.id || r.attendantId === s.id).map(r => r.id);
    return { ...base, routeIds, programIds: [], studentIds: activeStudents(db).filter(x => routeIds.includes(x.routeId)).map(x => x.id) };
  }
  return null;
}

function guardianPersona(db, g) {
  // Withdrawn children stay visible to their guardian (read-only): fees, receipts, diary history.
  const kids = childrenOf(db, g.id);
  return {
    id: `persona-${g.id}`, role: 'parent', guardianId: g.id,
    label: `Parent — ${fullName(g)} (${kids.map(k => (k.status === 'active' ? k.firstName : `${k.firstName}, left`)).join('; ') || 'no children'})`,
    studentIds: kids.map(k => k.id), activeStudentIds: kids.filter(k => k.status === 'active').map(k => k.id),
    programIds: [...new Set(kids.map(k => k.programId))],
  };
}

/** Personas are derived from the data: one per staff member and one per guardian (demo persona switcher). */
export function buildPersonas(db) {
  const list = [];
  for (const s of db.staff) { const p = staffPersona(db, s); if (p) list.push(p); }
  for (const g of db.guardians) list.push(guardianPersona(db, g));
  const order = { admin: 0, teacher: 1, accountant: 2, driver: 3, parent: 4 };
  return list.sort((a, b) => order[a.role] - order[b.role] || a.label.localeCompare(b.label));
}

/**
 * The persona of one signed-in user, from their app_users link (server side; role is never taken from
 * JWT claims). Returns null when the link points at nothing.
 * @param {{role:string, staffId?:string|null, guardianId?:string|null}} link
 */
export function personaFor(db, link) {
  if (!link) return null;
  if (link.role === 'parent') {
    const g = byId(db.guardians, link.guardianId);
    return g ? guardianPersona(db, g) : null;
  }
  const s = byId(db.staff, link.staffId);
  if (!s || s.role !== link.role) return null;
  return staffPersona(db, s);
}

export const ctxFor = (p, now, today) => ({ actor: { role: p.role, id: p.staffId || p.guardianId }, now, today });
/** The persona of a server job (cron, the command function's follow-up steps; the demo api for photos.finishDelete). */
export const systemPersona = (label = 'system') => ({ id: `system-${label}`, role: 'system', staffId: null, guardianId: null, studentIds: [], programIds: [], routeIds: [] });

// ---------------------------------------------------------------- authorization helpers

const deny = msg => fail('NOT_ALLOWED', msg);
export function allow(p, ...roles) {
  if (!p) deny('Choose a persona first');
  if (!roles.includes(p.role)) deny(`Not available to ${ROLE_LABEL[p.role] || p.role}`);
  return p;
}
export const sees = (p, studentId) => STAFF_SEES_ALL.includes(p.role) || p.studentIds.includes(studentId);
export function mustSee(p, db, studentId) {
  if (!byId(db.students, studentId)) fail('NOT_FOUND', 'Student not found');
  if (!sees(p, studentId)) deny('Not your student');
}
export function canManageNotice(p, db, noticeId) {
  const n = byId(db.notices, noticeId);
  if (!n) fail('NOT_FOUND', 'Notice not found');
  if (p.role === 'admin') return n;
  if (p.role === 'teacher') {
    const ps = M.audiencePrograms(db, n.audience);
    if (n.createdBy === p.staffId || ps.length === 0 || ps.some(x => p.programIds.includes(x))) return n;
  }
  return deny('Not your notice');
}
export function visibleThread(p, db, id) {
  const t = byId(db.threads, id);
  if (!t) fail('NOT_FOUND', 'Conversation not found');
  const ok = p.role === 'admin' || (p.role === 'teacher' && p.programIds.includes(t.programId)) || (p.role === 'parent' && t.guardianId === p.guardianId);
  if (!ok) deny('Not your conversation');
  return t;
}
export const visibleRoutes = (p, db) => {
  if (['admin', 'accountant', 'teacher'].includes(p.role)) return db.routes;
  if (p.role === 'driver') return db.routes.filter(r => (p.routeIds || []).includes(r.id));
  const ids = new Set(db.students.filter(s => p.studentIds.includes(s.id)).map(s => s.routeId).filter(Boolean));
  return db.routes.filter(r => ids.has(r.id));
};
export function mustRoute(p, db, routeId) {
  const r = byId(db.routes, routeId);
  if (!r) fail('NOT_FOUND', 'Route not found');
  if (!visibleRoutes(p, db).some(x => x.id === routeId)) deny('Not your route');
  return r;
}
export function driverTrip(p, db, tripId) {
  const t = byId(db.trips, tripId);
  if (!t) fail('NOT_FOUND', 'Trip not found');
  if (p.role === 'driver' && !(p.routeIds || []).includes(t.routeId)) deny('Not your route');
  return t;
}
export function teachesProgram(p, programId) {
  if (p.role === 'admin') return;
  if (p.role === 'teacher' && p.programIds.includes(programId)) return;
  deny('Not your program');
}

/** Trip as a persona may see it: parents/teachers only get their own children's events and stops. */
export function tripOut(db, t, p) {
  const c = { ...t };
  delete c.tracker;
  if (p && (p.role === 'parent' || p.role === 'teacher')) {
    const kids = db.students.filter(s => p.studentIds.includes(s.id) && s.routeId === t.routeId);
    const stopIds = new Set(kids.map(s => s.stopId));
    const kidIds = new Set(kids.map(s => s.id));
    c.childEvents = t.childEvents.filter(e => kidIds.has(e.studentId));
    c.stopEvents = t.stopEvents.filter(e => stopIds.has(e.stopId));
  }
  return c;
}

// ---------------------------------------------------------------- registry

const FIN = ['admin', 'accountant'];
const fin = p => allow(p, ...FIN);

export const COMMANDS = {
  // ---- notices / threads (messaging)
  'notices.send': {
    slice: 'messaging',
    authorize(p, db, [input]) {
      allow(p, 'admin', 'teacher');
      if (p.role === 'teacher') {
        const a = input && input.audience;
        if (!a || a.scope === 'school') deny('Teachers can message their own programs only');
        const ps = M.audiencePrograms(db, a);
        if (!ps.length || ps.some(x => !p.programIds.includes(x))) deny('Teachers can message their own programs only');
      }
    },
    run: (db, [input], ctx) => M.sendNotice(db, input, ctx),
  },
  'notices.markRead': { slice: 'messaging', authorize: p => allow(p, 'parent'), run: (db, [noticeId], ctx, p) => M.markNoticeRead(db, noticeId, p.guardianId, ctx) },
  'notices.acknowledge': { slice: 'messaging', authorize: p => allow(p, 'parent'), run: (db, [noticeId], ctx, p) => M.acknowledgeNotice(db, noticeId, p.guardianId, ctx) },
  'threads.open': {
    slice: 'messaging',
    authorize(p, db, [{ guardianId, studentId } = {}]) {
      allow(p, 'admin', 'teacher', 'parent');
      const gid = p.role === 'parent' ? (guardianId || p.guardianId) : guardianId;
      if (p.role === 'parent' && gid !== p.guardianId) deny('You can only write as yourself');
      mustSee(p, db, studentId);
      if (byId(db.students, studentId).status !== 'active') fail('VALIDATION', 'This child has left the school; their records are read-only');
    },
    run(db, [{ guardianId, studentId, subject, body } = {}], ctx, p) {
      const gid = p.role === 'parent' ? (guardianId || p.guardianId) : guardianId;
      const r = M.openThread(db, { guardianId: gid, studentId, subject, body }, ctx);
      const view = M.threadView(db, r.thread, p.role);
      return { ...view, thread: view, messages: r.messages };
    },
  },
  'threads.reply': { slice: 'messaging', authorize: (p, db, [id]) => { allow(p, 'admin', 'teacher', 'parent'); visibleThread(p, db, id); }, run: (db, [id, body], ctx) => M.replyThread(db, id, body, ctx) },
  'threads.markRead': { slice: 'messaging', authorize: (p, db, [id]) => { allow(p, 'admin', 'teacher', 'parent'); visibleThread(p, db, id); }, run: (db, [id], ctx) => M.markThreadRead(db, id, ctx) },
  'threads.close': { slice: 'messaging', authorize: (p, db, [id]) => { allow(p, 'admin', 'teacher', 'parent'); visibleThread(p, db, id); }, run: (db, [id], ctx) => M.closeThread(db, id, ctx) },

  // ---- calendar
  'calendar.create': { slice: 'calendar', authorize: p => allow(p, 'admin'), run: (db, [ev], ctx) => C.createEvent(db, ev, ctx) },
  'calendar.update': { slice: 'calendar', authorize: p => allow(p, 'admin'), run: (db, [id, patch], ctx) => C.updateEvent(db, id, patch, ctx) },
  'calendar.remove': { slice: 'calendar', authorize: p => allow(p, 'admin'), run: (db, [id], ctx) => C.removeEvent(db, id, ctx) },
  'calendar.importHolidays': {
    slice: 'calendar', authorize: p => allow(p, 'admin'),
    run: (db, [preview, { includeOutsideYear = false } = {}], ctx) => H.importHolidays(db, preview, { includeOutsideYear }, ctx),
  },

  // ---- transport (rev is per route on the server)
  'transport.startTrip': {
    slice: 'transport', load: ([a = {}]) => ({ routeId: a.routeId }),
    authorize: (p, db, [{ routeId } = {}]) => { allow(p, 'admin', 'driver'); mustRoute(p, db, routeId); },
    run: (db, [{ routeId, direction, simulated } = {}], ctx) => tripOut(db, T.startTrip(db, { routeId, direction, simulated }, ctx)),
  },
  'transport.endTrip': {
    slice: 'transport', load: ([tripId]) => ({ tripId }),
    authorize: (p, db, [tripId]) => { allow(p, 'admin', 'driver'); driverTrip(p, db, tripId); },
    run: (db, [tripId], ctx) => tripOut(db, T.endTrip(db, tripId, ctx)),
  },
  'transport.recordPosition': {
    slice: 'transport', load: ([tripId]) => ({ tripId }),
    authorize: (p, db, [tripId]) => { allow(p, 'admin', 'driver'); driverTrip(p, db, tripId); },
    run(db, [tripId, fix], ctx) {
      const r = T.recordPosition(db, tripId, fix || {}, ctx);
      // rejected: why a fix was refused (future/duplicate/out-of-order)
      return { trip: tripOut(db, r.trip), newEvents: r.newEvents, rejected: r.rejected ?? null };
    },
  },
  'transport.markChild': {
    slice: 'transport', load: ([tripId]) => ({ tripId }),
    authorize: (p, db, [tripId]) => { allow(p, 'admin', 'driver'); driverTrip(p, db, tripId); },
    run: (db, [tripId, ev], ctx) => T.markChild(db, tripId, ev || {}, ctx),
  },

  // ---- fees (ledger)
  'fees.saveStructure': { slice: 'ledger', authorize: fin, run: (db, [s], ctx) => F.saveStructure(db, s, ctx) },
  'fees.generateInvoices': { slice: 'ledger', authorize: fin, run: (db, [a], ctx) => F.generateInvoices(db, a, ctx) },
  'fees.addConcession': { slice: 'ledger', authorize: fin, run: (db, [invoiceId, c], ctx) => F.addConcession(db, invoiceId, c || {}, ctx) },
  'fees.removeConcession': { slice: 'ledger', authorize: fin, run: (db, [invoiceId, concessionId, reason], ctx) => F.removeConcession(db, invoiceId, concessionId, reason, ctx) },
  'fees.applyLateFee': { slice: 'ledger', authorize: fin, run: (db, [invoiceId, asOfDate], ctx) => F.applyLateFee(db, invoiceId, asOfDate || ctx.today, ctx) },
  /** Batch: apply the late fee due today on each chosen invoice; never all-or-nothing, every skip has a reason. */
  'fees.applyLateFees': {
    slice: 'ledger', authorize: fin,
    run(db, [{ invoiceIds } = {}], ctx) {
      if (!Array.isArray(invoiceIds) || !invoiceIds.length) fail('VALIDATION', 'Choose at least one invoice');
      const applied = [], skipped = [];
      for (const invoiceId of [...new Set(invoiceIds)]) {
        try { applied.push({ invoiceId, line: F.applyLateFee(db, invoiceId, ctx.today, ctx) }); } catch (e) {
          if (!e || typeof e.code !== 'string') throw e;
          skipped.push({ invoiceId, reason: e.message });
        }
      }
      return { applied, skipped };
    },
  },
  'fees.waiveLateFee': { slice: 'ledger', authorize: fin, run: (db, [invoiceId, reason], ctx) => F.waiveLateFee(db, invoiceId, reason, ctx) },
  'fees.cancelInvoice': { slice: 'ledger', authorize: fin, run: (db, [id, reason], ctx) => F.cancelInvoice(db, id, reason, ctx) },
  'fees.recordPayment': { slice: 'ledger', authorize: fin, run: (db, [a], ctx) => F.recordPayment(db, a || {}, ctx) },
  'fees.cancelPayment': { slice: 'ledger', authorize: fin, run: (db, [id, reason], ctx) => F.cancelPayment(db, id, reason, ctx) },
  'fees.refund': { slice: 'ledger', authorize: fin, run: (db, [a], ctx) => F.refund(db, a || {}, ctx) },
  'fees.mockOnlinePayment': {
    slice: 'ledger', demoOnly: true, // records a payment with no money moving: never reachable in the real app
    authorize: (p, db, [{ studentId } = {}]) => { allow(p, 'admin', 'accountant', 'parent'); mustSee(p, db, studentId); },
    run: (db, [{ studentId, invoiceIds } = {}], ctx, p) => F.mockOnlinePayment(db, { studentId, invoiceIds, guardianId: p.role === 'parent' ? p.guardianId : null }, ctx),
  },
  /** Amount and payer details for a new gateway order (the client's amount can only lower it). Read only. */
  'fees.gatewayOrderQuote': {
    slice: 'ledger', serverOnly: true, readOnly: true,
    authorize(p, db, [{ studentId } = {}]) {
      allow(p, 'admin', 'accountant', 'parent');
      mustSee(p, db, studentId);
    },
    run(db, [{ studentId, invoiceIds, amountPaise } = {}], ctx, p) {
      const q = G.orderAmount(db, { studentId, invoiceIds, amountPaise });
      const payer = p.role === 'parent' ? byId(db.guardians, p.guardianId) : null;
      return { ...q, studentId, guardianId: p.role === 'parent' ? p.guardianId : null, invoiceIds: q.balances.map(b => b.invoiceId),
        prefill: { name: payer ? fullName(payer) : '', email: ctx.userEmail || '' } };
    },
  },
  /** May this caller see/settle a gateway order for this student? (parent of the child, or finance staff) */
  'fees.gatewayOrderAccess': {
    slice: 'ledger', serverOnly: true, readOnly: true,
    authorize(p, db, [{ studentId } = {}]) { allow(p, 'admin', 'accountant', 'parent'); mustSee(p, db, studentId); },
    run: () => true,
  },
  /** Gateway capture → ledger. Called by pay-verify / rzp-webhook / pay-status only (system actor). */
  'fees.recordGatewayPayment': {
    slice: 'ledger', serverOnly: true,
    authorize: p => allow(p, 'system'),
    run: (db, [args], ctx) => G.recordGatewayPayment(db, args, ctx),
  },
  'fees.recordGatewayRefund': {
    slice: 'ledger', serverOnly: true,
    authorize: p => allow(p, 'system'),
    run: (db, [args], ctx) => G.recordGatewayRefund(db, args, ctx),
  },

  /** cron-daily housekeeping: end a trip left running (> 3 h) — system only. */
  'transport.autoEndTrip': {
    slice: 'transport', serverOnly: true, load: ([tripId]) => ({ tripId }),
    authorize: p => allow(p, 'system'),
    run(db, [tripId, reason], ctx) {
      const t = T.endTrip(db, tripId, ctx);
      t.autoEnded = String(reason || 'ended automatically');
      return tripOut(db, t);
    },
  },

  // ---- attendance / diary (classroom)
  'attendance.mark': {
    slice: 'classroom', load: ([date]) => ({ attendanceDate: date }),
    authorize(p, db, [, entries]) { allow(p, 'admin', 'teacher'); for (const e of entries || []) mustSee(p, db, e.studentId); },
    run: (db, [date, entries], ctx) => A.markAttendance(db, date, entries, ctx),
  },
  'diary.add': {
    slice: 'classroom',
    authorize: (p, db, [entry]) => { allow(p, 'admin', 'teacher'); mustSee(p, db, entry && entry.studentId); },
    run: (db, [entry], ctx) => D.addDiaryEntry(db, entry, ctx),
  },
  'diary.markRead': {
    slice: 'classroom', load: ([entryId]) => ({ diaryEntryId: entryId }),
    authorize(p, db, [entryId]) {
      allow(p, 'parent');
      const e = byId(db.diaryEntries, entryId);
      if (!e) fail('NOT_FOUND', 'Diary entry not found');
      mustSee(p, db, e.studentId);
    },
    run: (db, [entryId], ctx) => D.markDiaryRead(db, entryId, ctx),
  },

  // ---- gateway settlement report (CSV from the gateway dashboard)
  'fees.importSettlementCsv': {
    slice: 'settlement', serverOnly: true, authorize: p => allow(p, ...FIN),
    run(db, [text], ctx) {
      const parsed = G.parseSettlementCsv(text);
      const m = G.mergeSettlementLines(db.settlementLines, parsed);
      db.settlementLines.push(...m.added);
      const res = { inputRows: parsed.inputRows, imported: m.imported, duplicate: m.duplicate, rejected: [...parsed.rejected, ...m.rejected].sort((a, b) => a.line - b.line) };
      if (res.imported + res.duplicate + res.rejected.length !== res.inputRows) fail('VALIDATION', 'Settlement import counts do not reconcile');
      appendAudit(db, ctx, { entity: 'settlement', entityId: '-', action: 'import', summary: `input ${res.inputRows}, imported ${res.imported}, duplicate ${res.duplicate}, rejected ${res.rejected.length}` });
      return res;
    },
  },
  'fees.settlementReport': {
    slice: 'settlement', serverOnly: true, readOnly: true, authorize: p => allow(p, ...FIN),
    run: (db, [range]) => G.settlementReport(db, db.settlementLines, range || {}),
  },

  // ---- data import (staging is its own slice; commit writes the ledger: students, guardians, invoices, numbers)
  'import.stage': {
    slice: 'people', serverOnly: true, authorize: p => allow(p, 'admin', 'accountant'),
    run: (db, [{ kind, mapping, rows } = {}], ctx) => I.stageBatch(db, { kind, mapping, rows }, ctx),
  },
  'import.preview': {
    slice: 'ledger', serverOnly: true, readOnly: true, load: ([batchId]) => ({ importBatchId: batchId }),
    authorize: p => allow(p, 'admin', 'accountant'),
    run: (db, [batchId], ctx) => I.previewBatch(db, batchId, ctx.today),
  },
  'import.commit': {
    slice: 'ledger', serverOnly: true, load: ([batchId]) => ({ importBatchId: batchId }),
    authorize: p => allow(p, 'admin', 'accountant'),
    run: (db, [batchId], ctx) => I.commitBatch(db, batchId, ctx),
  },

  // ---- people
  'people.setStaffRole': {
    slice: 'ledger', serverOnly: true, authorize: p => allow(p, 'admin'),
    run(db, [{ staffId, role } = {}], ctx) {
      const s = byId(db.staff, staffId);
      if (!s) fail('NOT_FOUND', 'Staff member not found');
      if (!['admin', 'teacher', 'accountant', 'driver'].includes(role)) fail('VALIDATION', `Unknown role: ${role}`);
      if (s.id === ctx.actor.id && role !== 'admin') fail('VALIDATION', 'You cannot remove your own principal role');
      const before = s.role;
      s.role = role;
      appendAudit(db, ctx, { entity: 'staff', entityId: s.id, action: 'setRole', summary: `${before} → ${role}` });
      return { ...s, name: fullName(s) };
    },
  },
  /**
   * DPDP erasure of a guardian. Erased: the guardian's name/phone/email/relation, the messages they wrote, their
   * sign-in links (revoked here; the command function then deletes the sign-in itself, its push devices and the
   * payer details in stored gateway events), their open invites, and their columns in raw import rows.
   * Retained (and recorded on the request, with the reason): fee records, the children's school records, staff
   * messages, consent records and audit rows. Re-running it retries the server steps.
   */
  'people.anonymiseGuardian': {
    slice: 'erasure', serverOnly: true, authorize: p => allow(p, 'admin'), load: () => ({ importRowsAll: true }),
    run(db, [guardianId], ctx) {
      const g = byId(db.guardians, guardianId);
      if (!g) fail('NOT_FOUND', 'Guardian not found');
      const was = /^Erased-\d+$/.test(g.firstName);
      const n = was ? Number(g.firstName.slice(7)) : db.guardians.filter(x => /^Erased-\d+$/.test(x.firstName)).length + 1;
      const label = `Erased-${n}`;
      const kids = childrenOf(db, g.id);
      const prior = { firstName: g.firstName, lastName: g.lastName, phone: g.phone, email: g.email };
      Object.assign(g, { firstName: label, lastName: '', phone: '', email: '', relation: '' });
      const threadIds = new Set(db.threads.filter(t => t.guardianId === g.id).map(t => t.id));
      let messages = 0;
      for (const m of db.messages) {
        if (threadIds.has(m.threadId) && m.senderRole === 'parent' && m.senderId === g.id && m.body !== ERASED_MESSAGE) { m.body = ERASED_MESSAGE; messages++; }
      }
      const revokedUserIds = [];
      for (const u of db.appUsers || []) if (u.guardianId === g.id) { u.status = 'revoked'; revokedUserIds.push(u.id); }
      let invitesRevoked = 0;
      for (const i of db.invites || []) if (i.guardianId === g.id && !i.redeemedAt && !i.revokedAt) { i.revokedAt = ctx.now; invitesRevoked++; }
      const importRows = was ? 0 : I.redactGuardianInImportRows(db, prior, kids.map(k => k.admissionNo));
      const erased = { guardianDetails: true, messages, signIns: revokedUserIds.length, invitesRevoked, importRows };
      const retained = [
        `Fee records (invoices, payments, refunds, receipts) are kept as the law requires; the payer now shows as ${label}.`,
        "The children's own school records (enrolment, attendance, diary, fees) stay under the school's retention schedule.",
        "Messages written by school staff in this guardian's conversations are kept; the guardian's own messages were erased.",
        'Consent records are kept as evidence of what was agreed and when (they carry ids, not names).',
        'Audit log entries are kept; they carry ids and amounts, not names.',
      ];
      // 'cleanup' until the command function (or cron, on a retry) has deleted the sign-ins and scrubbed gateway copies
      const reqs = (db.erasureRequests || []).filter(r => r.guardianId === guardianId && ['open', 'cleanup'].includes(r.status));
      if (!reqs.length) { const r = { id: newId('era'), guardianId, requestedAt: ctx.now, requestedBy: ctx.actor.id, status: 'open', doneAt: null, doneBy: null }; db.erasureRequests.push(r); reqs.push(r); }
      for (const r of reqs) Object.assign(r, { status: 'cleanup', erasedAt: ctx.now, doneBy: ctx.actor.id, erased, retained, pendingUserIds: [...new Set([...(r.pendingUserIds || []), ...revokedUserIds])] });
      appendAudit(db, ctx, { entity: 'guardian', entityId: g.id, action: 'anonymise', summary: `guardian erased (${label}): ${messages} message(s), ${revokedUserIds.length} sign-in(s), ${invitesRevoked} invite(s), ${importRows} import row(s); ledger kept` });
      return { guardianId: g.id, label, revokedUserIds, erased, retained };
    },
  },
  /** Erasure clean-up outcome (command function / cron): done when no server step failed, else kept with the error. */
  'people.finishErasure': {
    slice: 'erasure', serverOnly: true, authorize: p => allow(p, 'system'),
    run(db, [guardianId, { errors = [] } = {}], ctx) {
      const reqs = (db.erasureRequests || []).filter(r => r.guardianId === guardianId && r.status === 'cleanup');
      for (const r of reqs) {
        r.cleanupAttempts = (r.cleanupAttempts || 0) + 1;
        if (errors.length) { r.lastError = String(errors.join('; ')).slice(0, 500); continue; }
        Object.assign(r, { status: 'done', doneAt: ctx.now, lastError: null, pendingUserIds: [] });
      }
      if (reqs.length) appendAudit(db, ctx, { entity: 'guardian', entityId: guardianId, action: 'erasureCleanup', summary: errors.length ? `clean-up failed (${errors.length} step(s)); retried by cron` : 'sign-ins deleted and gateway copies scrubbed; erasure done' });
      return { guardianId, requests: reqs.length, done: !errors.length };
    },
  },

  // ---- learning: curriculum, observations, photos, progress, termly reports (slice 'learning')
  // Hints name the one child whose records a command needs (the server loads that child's rows only).
  'curriculum.loadStarter': { slice: 'learning', authorize: p => allow(p, 'admin'), run: (db, args, ctx) => CU.loadStarter(db, ctx) },
  /** save({id?, area, name, sequence, ageFromMonths, ageToMonths, description}) — create, or edit (a rename keeps the id). */
  'curriculum.save': { slice: 'learning', authorize: p => allow(p, 'admin'), run: (db, [input], ctx) => CU.savePresentation(db, input || {}, ctx) },
  'curriculum.retire': { slice: 'learning', authorize: p => allow(p, 'admin'), run: (db, [id], ctx) => CU.setPresentationActive(db, id, false, ctx) },
  'curriculum.restore': { slice: 'learning', authorize: p => allow(p, 'admin'), run: (db, [id], ctx) => CU.setPresentationActive(db, id, true, ctx) },
  /** importCsv(preview) — preview from api.curriculum.previewCsv; → {inputRows, imported, skippedDuplicate, rejected, rejectedRows} */
  'curriculum.importCsv': { slice: 'learning', authorize: p => allow(p, 'admin'), run: (db, [preview], ctx) => CU.importCurriculum(db, preview, ctx) },

  /** add({studentId, date, area, presentationId?, text}) — staff-only until shared. */
  'observations.add': {
    slice: 'learning', load: ([i = {}]) => ({ learningStudentId: String(i?.studentId ?? '') }),
    authorize: (p, db, [i = {}]) => { staffLearning(p); O.mustSeeLearner(p, db, i?.studentId); },
    run: (db, [i], ctx) => O.observationView(db, O.addObservation(db, i || {}, ctx)),
  },
  /** edit(id, {date?, area?, presentationId?, text?}) — only while unshared. */
  'observations.edit': {
    slice: 'learning', load: ([id]) => ({ observationId: String(id ?? '') }),
    authorize: (p, db, [id]) => { staffLearning(p); O.mustSeeLearner(p, db, observationOf(db, id).studentId); },
    run: (db, [id, patch], ctx) => O.observationView(db, O.editObservation(db, id, patch || {}, ctx)),
  },
  'observations.share': {
    slice: 'learning', load: ([id]) => ({ observationId: String(id ?? '') }),
    authorize: (p, db, [id]) => { staffLearning(p); O.mustSeeLearner(p, db, observationOf(db, id).studentId); },
    run: (db, [id], ctx) => O.observationView(db, O.shareObservation(db, id, ctx)),
  },
  /** A teacher within 24 hours of sharing; the principal at any time. */
  'observations.unshare': {
    slice: 'learning', load: ([id]) => ({ observationId: String(id ?? '') }),
    authorize: (p, db, [id]) => { staffLearning(p); O.mustSeeLearner(p, db, observationOf(db, id).studentId); },
    run: (db, [id], ctx) => O.observationView(db, O.unshareObservation(db, id, ctx)),
  },

  /**
   * register({observationId, soloConfirmed:true}) → {photo, path, upload}. Needs photo consent (photoConsentFor), the
   * teacher's "only this child is in the frame" and room under the per-child cap. The real app's command function
   * adds upload = {bucket, path, token, signedPath, expiresAt} (2 h); the copy kept for a replay of the request id
   * has no token (uploadWithheld), so a replay never re-issues a grant.
   */
  'photos.register': {
    slice: 'learning', load: ([a = {}]) => ({ observationId: String(a?.observationId ?? '') }),
    storedResult: r => ({ ...r, upload: null, uploadWithheld: true }),
    authorize: (p, db, [a = {}]) => { staffLearning(p); O.mustSeeLearner(p, db, observationOf(db, a?.observationId).studentId); },
    run(db, [a = {}], ctx) {
      const o = observationOf(db, a.observationId);
      if (byId(db.students, o.studentId).status !== 'active') fail('VALIDATION', 'Student is not active');
      if (a.soloConfirmed !== true) fail('VALIDATION', 'Confirm that only this child is in the photo');
      if (!photoConsentFor(db, o.studentId)) fail('VALIDATION', 'No photo consent for this child (every guardian using the app must agree to photos)');
      if (P.livePhotoCount(db, o.studentId) >= P.PHOTO_CAP) fail('VALIDATION', `This child already has ${P.PHOTO_CAP} photos; delete one to add another`);
      const ph = P.registerPhoto(db, { observationId: o.id }, ctx);
      return { photo: P.photoView(ph), path: ph.path, upload: null };
    },
  },
  /**
   * complete(photoId) → {photo} — the server first reads the uploaded object and passes what it found as
   * ctx.objectInfo (never from the client); a refused file is deleted and the row committed as rejected (then 422).
   * Demo: the api runs it with a synthetic objectInfo after storing the prepared blob.
   */
  'photos.complete': {
    slice: 'learning', load: ([id]) => ({ photoId: String(id ?? '') }),
    authorize: (p, db, [id]) => takerOf(p, db, id),
    run(db, [id], ctx) { const r = P.completePhoto(db, id, ctx.objectInfo, ctx); return { photo: P.photoView(r.photo), ...(r.failure ? { failure: r.failure } : {}) }; },
  },
  /** Server step before complete: the object path of a photo the caller may complete (never returned to the browser). */
  'photos.uploadTarget': {
    slice: 'learning', serverOnly: true, readOnly: true, load: ([id]) => ({ photoId: String(id ?? '') }),
    authorize: (p, db, [id]) => takerOf(p, db, id),
    run: (db, [id]) => { const ph = byId(db.photos, id); return { photoId: ph.id, path: ph.path, status: ph.status }; },
  },
  /** remove(photoId, reason?) → deleting; the command function then deletes the object (cron retries). */
  'photos.remove': {
    slice: 'learning', load: ([id]) => ({ photoId: String(id ?? '') }),
    authorize: (p, db, [id]) => { staffLearning(p); O.mustSeeLearner(p, db, photoOf(db, id).studentId); },
    run: (db, [id, reason], ctx) => ({ photo: P.photoView(P.markDeleting(db, id, reason ? String(reason).slice(0, 200) : 'removed by staff', ctx)) }),
  },
  /**
   * The bytes of a ready photo, for a persona who may see it: staff of the child; a parent of the child once the
   * observation is shared. The command function turns {path} into a signed URL (120 s) that remote.js fetches at
   * once; readOnly, so nothing about it is stored.
   */
  'photos.viewUrl': {
    slice: 'learning', serverOnly: true, readOnly: true, load: ([id]) => ({ photoId: String(id ?? '') }),
    authorize(p, db, [id]) {
      allow(p, 'admin', 'teacher', 'parent');
      const ph = photoOf(db, id);
      O.mustSeeLearner(p, db, ph.studentId);
      if (p.role === 'parent' && !byId(db.observations, ph.observationId)?.sharedAt) deny('This photo has not been shared with you');
      if (ph.status !== 'ready' || !ph.path) fail('NOT_FOUND', 'Photo not available'); // demo rows have no stored object
    },
    run: (db, [id]) => { const ph = byId(db.photos, id); return { photoId: ph.id, path: ph.path }; },
  },
  /** System (command function, cron; the demo api after deleting its blob): objects gone → deleted / expired. */
  'photos.finishDelete': {
    slice: 'learning', load: ([a = {}]) => ({ photoIds: Array.isArray(a?.photoIds) ? a.photoIds.map(String) : [] }),
    authorize: p => allow(p, 'system'),
    run: (db, [a = {}], ctx) => P.finishDelete(db, a.photoIds, ctx),
  },
  /** System (cron): pending rows whose upload never completed. */
  'photos.markRejected': {
    slice: 'learning', serverOnly: true, load: ([a = {}]) => ({ photoIds: Array.isArray(a?.photoIds) ? a.photoIds.map(String) : [] }),
    authorize: p => allow(p, 'system'),
    run: (db, [a = {}], ctx) => P.markRejected(db, a.photoIds, a.reason || 'abandoned: not uploaded within 2 hours', ctx),
  },
  /** System (cron): every child with live photos whose photo consent no longer holds → their photos deleting. */
  'photos.consentSweep': {
    slice: 'learning', serverOnly: true, load: () => ({ photosLive: true }),
    authorize: p => allow(p, 'system'),
    run: (db, args, ctx) => P.sweepConsent(db, sid => photoConsentFor(db, sid), ctx),
  },

  /** record({studentId, presentationId, status, date, note?, correction?, reason?}) — appends one event. */
  'progress.record': {
    slice: 'learning', load: ([i = {}]) => ({ learningStudentId: String(i?.studentId ?? '') }),
    authorize: (p, db, [i = {}]) => { staffLearning(p); O.mustSeeLearner(p, db, i?.studentId); },
    run: (db, [i], ctx) => PG.recordProgress(db, i || {}, ctx),
  },

  /** generate({studentId, academicYearId, termName, fromDate, toDate}) — refused while that term's report is published. */
  'reports.generate': {
    slice: 'learning', load: ([i = {}]) => ({ learningStudentId: String(i?.studentId ?? '') }),
    authorize: (p, db, [i = {}]) => { staffLearning(p); O.mustSeeLearner(p, db, i?.studentId); },
    run: (db, [i], ctx) => RP.generateReport(db, i || {}, ctx),
  },
  /** saveNarratives(reportId, {narratives, revision}) — CONFLICT if the report moved since revision. */
  'reports.saveNarratives': {
    slice: 'learning', load: ([id]) => ({ reportId: String(id ?? '') }),
    authorize: (p, db, [id]) => { staffLearning(p); O.mustSeeLearner(p, db, reportOf(db, id).studentId); },
    run: (db, [id, a], ctx) => RP.saveNarratives(db, id, a || {}, ctx),
  },
  'reports.submit': {
    slice: 'learning', load: ([id]) => ({ reportId: String(id ?? '') }),
    authorize: (p, db, [id]) => { staffLearning(p); O.mustSeeLearner(p, db, reportOf(db, id).studentId); },
    run: (db, [id], ctx) => RP.submitReport(db, id, ctx),
  },
  'reports.publish': {
    slice: 'learning', load: ([id]) => ({ reportId: String(id ?? '') }),
    authorize: (p, db, [id]) => { allow(p, 'admin'); reportOf(db, id); },
    run: (db, [id], ctx) => RP.publishReport(db, id, ctx),
  },
  'reports.unpublish': {
    slice: 'learning', load: ([id]) => ({ reportId: String(id ?? '') }),
    authorize: (p, db, [id]) => { allow(p, 'admin'); reportOf(db, id); },
    run: (db, [id, reason], ctx) => RP.unpublishReport(db, id, reason, ctx),
  },

  // ---- enrolment and retention
  /**
   * updateStudent({studentId, programId?, status?, leftOn?, routeId?, stopId?}) — the only way a child changes class
   * or leaves. status 'left' sets leftOn (given, else today); back to 'active' clears it; leftOn alone corrects the
   * date of a child who has left.
   */
  'people.updateStudent': {
    slice: 'ledger', authorize: p => allow(p, 'admin'),
    run(db, [{ studentId, ...patch } = {}], ctx) {
      const s = byId(db.students, studentId);
      if (!s) fail('NOT_FOUND', 'Student not found');
      for (const k of Object.keys(patch)) if (!['programId', 'status', 'leftOn', 'routeId', 'stopId'].includes(k)) fail('VALIDATION', `Unknown field: ${k}`);
      const changes = [];
      const leftDate = d => {
        if (!isISODate(d)) fail('VALIDATION', `Invalid leaving date: ${d}`);
        if (compareISO(d, ctx.today) > 0) fail('VALIDATION', 'The leaving date is in the future');
        return d;
      };
      if ('programId' in patch && patch.programId !== s.programId) {
        if (!byId(db.programs, patch.programId)) fail('NOT_FOUND', 'Program not found');
        changes.push(`program ${s.programId} → ${patch.programId}`);
        s.programId = patch.programId;
      }
      if ('routeId' in patch || 'stopId' in patch) {
        const routeId = 'routeId' in patch ? patch.routeId || null : s.routeId, stopId = 'stopId' in patch ? patch.stopId || null : s.stopId;
        if (routeId) {
          const r = byId(db.routes, routeId);
          if (!r) fail('NOT_FOUND', 'Route not found');
          if (!r.stops.some(x => x.id === stopId)) fail('VALIDATION', 'Choose a stop on that route');
        } else if (stopId) fail('VALIDATION', 'A stop needs a route');
        if (routeId !== s.routeId || stopId !== s.stopId) changes.push(`route ${s.routeId || '-'}/${s.stopId || '-'} → ${routeId || '-'}/${stopId || '-'}`);
        Object.assign(s, { routeId, stopId });
      }
      if ('status' in patch) {
        if (!['active', 'left'].includes(patch.status)) fail('VALIDATION', `Unknown status: ${patch.status}`);
        const leftOn = patch.status === 'left' ? leftDate(patch.leftOn ?? ctx.today) : null;
        if (patch.status !== s.status || leftOn !== (s.leftOn ?? null)) changes.push(`status ${s.status} → ${patch.status}${leftOn ? ` (left ${leftOn})` : ''}`);
        Object.assign(s, { status: patch.status, leftOn });
      } else if ('leftOn' in patch) {
        if (s.status !== 'left') fail('VALIDATION', 'Only a child who has left has a leaving date');
        const d = leftDate(patch.leftOn);
        if (d !== s.leftOn) changes.push(`leaving date ${s.leftOn || 'unknown'} → ${d}`);
        s.leftOn = d;
      }
      appendAudit(db, ctx, { entity: 'student', entityId: s.id, action: 'update', summary: changes.join('; ') || 'no change' });
      return { ...s, name: fullName(s) };
    },
  },
  /** setRetention({photosMonthsAfterLeaving, …}) — whole months after leaving, or null (not decided). */
  'admin.setRetention': { slice: 'ledger', authorize: p => allow(p, 'admin'), run: (db, [r], ctx) => RT.setRetention(db, r || {}, ctx) },
  /** What retention would remove today (counts per category, and the children who left without a date). */
  'retention.preview': {
    slice: 'retention', serverOnly: true, readOnly: true, load: () => RETENTION_LOAD, authorize: p => allow(p, 'admin'),
    run(db, args, ctx) {
      const plan = RT.retentionPlan(db, ctx.today);
      return { asOf: plan.asOf, leftWithoutDate: plan.leftWithoutDate,
        categories: Object.fromEntries(Object.entries(plan.categories).map(([k, c]) => [k, { months: c.months, students: c.students.length, due: c.due }])) };
    },
  },
  /** System (cron retention step): {expire:[photoId], deletes:{collection:[key]}}, each re-checked as due today. */
  'retention.purge': {
    slice: 'retention', serverOnly: true, load: () => RETENTION_LOAD, authorize: p => allow(p, 'system'),
    run: (db, [request], ctx) => RT.purgeRetention(db, request || {}, ctx),
  },

  // ---- account: consent, invites (server only: these tables do not exist in the demo document)
  'consent.give': {
    slice: 'account', serverOnly: true, beforeConsent: true, authorize: p => allow(p, 'parent'),
    /**
     * give({purposes, perChild?, version, textHash?}) — purposes apply to every child of the parent; perChild
     * ({studentId: [purpose]}) adds optional purposes for one child only (siblings may differ, e.g. photos).
     * app_account is never per child (required until every child has it); an optional purpose for a child needs
     * that child's app_account at this version (given in the same call or already live).
     * textHash: optional SHA-256 hex of the notice text the parent saw.
     */
    run(db, [{ purposes, perChild = null, version, textHash = null } = {}], ctx, p) {
      if (version !== CONSENT_VERSION) fail('VALIDATION', `Unknown privacy notice version: ${version}`);
      const list = [...new Set(purposes || [])];
      if (perChild !== null && (typeof perChild !== 'object' || Array.isArray(perChild))) fail('VALIDATION', 'perChild must be {studentId: [purpose]}');
      const extra = Object.entries(perChild || {}).map(([sid, ps]) => {
        if (!p.studentIds.includes(sid)) deny('Not your child');
        if (!Array.isArray(ps)) fail('VALIDATION', 'perChild must be {studentId: [purpose]}');
        if (ps.includes('app_account')) fail('VALIDATION', 'The app account purpose is given for all your children together');
        return [sid, [...new Set(ps)]];
      });
      if (!list.length && !extra.some(([, ps]) => ps.length)) fail('VALIDATION', 'Choose at least one purpose');
      // app_account is the base purpose: required until every child has it; optional purposes can be added later
      const hasBase = consentStatus(db, p).purposes.app_account.given;
      if (!hasBase && !list.includes('app_account')) fail('VALIDATION', 'The app account purpose is required to use the app');
      for (const x of [...list, ...extra.flatMap(([, ps]) => ps)]) if (!CONSENT_PURPOSES.includes(x)) fail('VALIDATION', `Unknown purpose: ${x}`);
      if (textHash !== null && !/^[0-9a-f]{64}$/.test(String(textHash))) fail('VALIDATION', 'textHash must be a SHA-256 hex digest');
      const live = (studentId, purpose) => (db.consents || []).find(c => c.guardianId === p.guardianId && c.studentId === studentId && c.purpose === purpose && c.version === version && !c.withdrawnAt);
      const wanted = new Map(p.studentIds.map(sid => [sid, new Set(list)]));
      for (const [sid, ps] of extra) for (const x of ps) wanted.get(sid).add(x);
      for (const [sid, ps] of wanted) {
        if ([...ps].some(x => x !== 'app_account') && !ps.has('app_account') && !live(sid, 'app_account')) fail('VALIDATION', `Give the app account purpose for child ${sid} first`);
      }
      const invite = (db.invites || []).find(i => i.guardianId === p.guardianId && i.redeemedBy && i.redeemedBy === ctx.userId);
      const evidence = { method: 'invite_code+child_dob+email_otp', inviteId: invite ? invite.id : null };
      let given = 0;
      for (const [studentId, ps] of wanted) {
        for (const purpose of ['app_account', ...[...ps].filter(x => x !== 'app_account')].filter(x => ps.has(x))) {
          if (live(studentId, purpose)) continue;
          db.consents.push({ id: newId('cns'), guardianId: p.guardianId, studentId, purpose, version, textHash, givenAt: ctx.now, withdrawnAt: null, evidence });
          given++;
        }
      }
      const per = extra.filter(([, ps]) => ps.length).map(([sid, ps]) => `${sid}:${ps.join('+')}`).join(' ');
      appendAudit(db, ctx, { entity: 'consent', entityId: p.guardianId, action: 'give', summary: `${list.join(',') || '-'}${per ? ` per child ${per}` : ''} ${version}: ${given} new record(s) for ${p.studentIds.length} child(ren)` });
      return consentStatus(db, p);
    },
  },
  // withdraw(purpose, {studentIds?}) — studentIds (photos only): withdraw for those children alone. Withdrawing photos
  // (or the app account) also marks the photos of every child whose photo consent no longer holds as deleting, in the
  // same transaction; the objects go with cron's photosCleanup
  'consent.withdraw': {
    slice: 'account', serverOnly: true, beforeConsent: true, authorize: p => allow(p, 'parent'),
    load: ([purpose]) => (['photos', 'app_account'].includes(purpose) ? { photosOfCaller: true } : {}),
    run(db, [purpose, { studentIds = null } = {}], ctx, p) {
      if (!CONSENT_PURPOSES.includes(purpose)) fail('VALIDATION', `Unknown purpose: ${purpose}`);
      if (studentIds !== null) {
        if (purpose !== 'photos') fail('VALIDATION', 'Only photo consent can be withdrawn for one child');
        if (!Array.isArray(studentIds) || !studentIds.length) fail('VALIDATION', 'studentIds must list at least one child');
        for (const sid of studentIds) if (!p.studentIds.includes(sid)) deny('Not your child');
      }
      const only = studentIds === null ? null : new Set(studentIds);
      let n = 0;
      for (const c of db.consents || []) if (c.guardianId === p.guardianId && c.purpose === purpose && !c.withdrawnAt && (!only || only.has(c.studentId))) { c.withdrawnAt = ctx.now; n++; }
      if (purpose === 'app_account') {
        for (const u of db.appUsers || []) if (u.guardianId === p.guardianId && u.status === 'active') u.status = 'withdrawn';
        db.erasureRequests.push({ id: newId('era'), guardianId: p.guardianId, requestedAt: ctx.now, status: 'open', doneAt: null, doneBy: null });
      }
      appendAudit(db, ctx, { entity: 'consent', entityId: p.guardianId, action: 'withdraw', summary: `${purpose}${only ? ` for ${[...only].join(',')}` : ''}: ${n} record(s) withdrawn` });
      if (['photos', 'app_account'].includes(purpose)) P.sweepConsent(db, sid => photoConsentFor(db, sid), ctx, only ? [...only] : p.studentIds);
      return consentStatus(db, p);
    },
  },
  'admin.inviteCode': {
    slice: 'account', serverOnly: true, authorize: (p, db, [guardianId]) => { allow(p, 'admin', 'accountant'); if (!byId(db.guardians, guardianId)) fail('NOT_FOUND', 'Guardian not found'); },
    // the plain code is shown once: the copy kept for a replay of the request id has no code, so a replay neither
    // re-reveals it nor issues another one (the office issues a new code if the first answer was lost)
    storedResult: r => ({ ...r, code: null, codeWithheld: true }),
    // ctx.inviteCode / ctx.inviteCodeHash are made by the server (crypto); the plain code is returned once and never stored.
    run(db, [guardianId], ctx) {
      for (const i of db.invites || []) if (i.guardianId === guardianId && !i.redeemedAt && !i.revokedAt) i.revokedAt = ctx.now; // one live code per guardian
      const expiresAt = new Date(tsToMs(ctx.now) + 14 * 86400000).toISOString();
      const inv = { id: newId('inv-code'), codeHash: ctx.inviteCodeHash, guardianId, expiresAt, redeemedAt: null, redeemedBy: null, revokedAt: null, createdBy: ctx.actor.id, createdAt: ctx.now, failedAttempts: 0 };
      db.invites.push(inv);
      appendAudit(db, ctx, { entity: 'invite', entityId: inv.id, action: 'issue', summary: `invite for guardian ${guardianId}, expires ${expiresAt.slice(0, 10)}` });
      return { code: ctx.inviteCode, expiresAt };
    },
  },
  'admin.invites': {
    slice: 'account', serverOnly: true, readOnly: true, authorize: p => allow(p, 'admin', 'accountant'),
    // redeemedUserStatus: for a redeemed code, the redeeming sign-in's link status now ('active' | 'revoked' |
    // 'withdrawn' | 'pending'), or 'missing' when that sign-in no longer links this family; null when not redeemed.
    run: (db, args, ctx) => (db.invites || []).map(i => {
      const u = i.redeemedBy ? (db.appUsers || []).find(x => x.id === i.redeemedBy && x.guardianId === i.guardianId) : null;
      return {
        id: i.id, guardianId: i.guardianId, guardianName: fullName(byId(db.guardians, i.guardianId)), createdAt: i.createdAt, createdBy: i.createdBy,
        expiresAt: i.expiresAt, redeemedAt: i.redeemedAt, revokedAt: i.revokedAt, failedAttempts: i.failedAttempts || 0,
        status: i.redeemedAt ? 'redeemed' : i.revokedAt ? 'revoked' : (i.failedAttempts || 0) >= MAX_INVITE_FAILURES ? 'locked' : tsToMs(i.expiresAt) < tsToMs(ctx.now) ? 'expired' : 'open',
        redeemedUserStatus: i.redeemedBy ? (u ? u.status : 'missing') : null,
      };
    }).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
  },
  'admin.revokeInvite': {
    slice: 'account', serverOnly: true, authorize: p => allow(p, 'admin', 'accountant'),
    run(db, [inviteId], ctx) {
      const i = (db.invites || []).find(x => x.id === inviteId);
      if (!i) fail('NOT_FOUND', 'Invite not found');
      if (i.redeemedAt) fail('VALIDATION', 'This invite was already used; revoke the user instead');
      if (!i.revokedAt) i.revokedAt = ctx.now;
      appendAudit(db, ctx, { entity: 'invite', entityId: i.id, action: 'revoke', summary: `invite for guardian ${i.guardianId} revoked` });
      return { id: i.id, revokedAt: i.revokedAt };
    },
  },
  'admin.users': {
    slice: 'account', serverOnly: true, readOnly: true, authorize: p => allow(p, 'admin'),
    run: db => (db.appUsers || []).map(u => ({ ...u, name: fullName(u.staffId ? byId(db.staff, u.staffId) : byId(db.guardians, u.guardianId)) })),
  },
  'admin.erasureRequests': {
    slice: 'account', serverOnly: true, readOnly: true, authorize: p => allow(p, 'admin'),
    run: db => (db.erasureRequests || []).map(r => ({ ...r, guardianName: fullName(byId(db.guardians, r.guardianId)) })),
  },
  /** DPDP access request: a guardian's data as JSON — the principal for anyone, a parent for themself only. Audited. */
  'admin.dataExport': {
    slice: 'export', serverOnly: true, beforeConsent: true,
    load: ([guardianId]) => ({ attendanceAll: true, diaryAll: true, tripsAll: true, importRowsAll: true, exportGuardianId: String(guardianId ?? '') }),
    authorize(p, db, [guardianId]) {
      allow(p, 'admin', 'parent');
      if (p.role === 'parent' && guardianId !== p.guardianId) deny('You can download only your own data');
      if (!byId(db.guardians, guardianId)) fail('NOT_FOUND', 'Guardian not found');
    },
    run(db, [guardianId], ctx) {
      appendAudit(db, ctx, { entity: 'guardian', entityId: guardianId, action: 'dataExport', summary: 'personal data export generated' });
      return JSON.stringify(guardianExport(db, guardianId), null, 2);
    },
  },
  'admin.revokeUser': {
    slice: 'account', serverOnly: true, authorize: p => allow(p, 'admin'),
    run(db, [userId], ctx) {
      const u = (db.appUsers || []).find(x => x.id === userId);
      if (!u) fail('NOT_FOUND', 'User not found');
      if (u.staffId && u.staffId === ctx.actor.id) fail('VALIDATION', 'You cannot revoke your own access');
      u.status = 'revoked';
      appendAudit(db, ctx, { entity: 'appUser', entityId: userId, action: 'revoke', summary: `${u.role} access revoked` });
      return { userId, status: u.status };
    },
  },
  /**
   * Redeem an invite after OTP sign-in. ctx.userId/ctx.userEmail/ctx.inviteCodeHash come from the server.
   * Failed attempts are recorded (and counted) even though the call fails: run returns {failure} instead of throwing.
   */
  'auth.redeemInvite': {
    slice: 'account', serverOnly: true, allowUnlinked: true, beforeConsent: true,
    authorize(p, db, args, ctx) {
      if (p) fail('VALIDATION', 'This account is already linked');
      const recent = (db.auditLog || []).filter(r => r.entity === 'invite' && r.action === 'redeemFailed' && r.actorId === ctx.userId).length;
      if (recent >= 5) deny('Too many failed attempts; ask the school office for a new code');
    },
    run(db, [, childDob], ctx) {
      const failure = message => { appendAudit(db, ctx, { entity: 'invite', entityId: '-', action: 'redeemFailed', summary: message }); return { failure: { code: 'VALIDATION', message } }; };
      const inv = (db.invites || []).find(i => i.codeHash === ctx.inviteCodeHash);
      if (!inv || inv.revokedAt) return failure('Invite code not recognised');
      if (inv.redeemedAt) return failure('This invite code has already been used');
      // per code, whichever accounts tried: guessing dates of birth across many sign-ins does not get past this
      if ((inv.failedAttempts || 0) >= MAX_INVITE_FAILURES) return failure(`This invite code is locked after ${MAX_INVITE_FAILURES} wrong dates of birth; ask the school office for a new code`);
      if (tsToMs(inv.expiresAt) < tsToMs(ctx.now)) return failure('This invite code has expired; ask the school office for a new one');
      const kids = childrenOf(db, inv.guardianId);
      if (!kids.some(k => k.dob === childDob)) {
        inv.failedAttempts = (inv.failedAttempts || 0) + 1;
        return failure("The date of birth does not match any of this guardian's children");
      }
      inv.redeemedAt = ctx.now;
      inv.redeemedBy = ctx.userId;
      const g = byId(db.guardians, inv.guardianId);
      g.email = ctx.userEmail;
      const existing = (db.appUsers || []).find(u => u.id === ctx.userId);
      const link = { id: ctx.userId, role: 'parent', staffId: null, guardianId: inv.guardianId, status: 'active', linkedAt: ctx.now };
      if (existing) Object.assign(existing, link); else db.appUsers.push(link);
      appendAudit(db, ctx, { entity: 'invite', entityId: inv.id, action: 'redeem', summary: `guardian ${inv.guardianId} linked to user ${ctx.userId}` });
      return { guardianId: inv.guardianId, children: kids.map(k => ({ id: k.id, firstName: k.firstName })), inviteId: inv.id };
    },
  },
};

/**
 * May photos of this child be taken and kept? Every guardian of the child who holds live app_account consent for the
 * child also holds live photos consent for the child, at the current notice version — and at least one such guardian
 * exists. Per child: a sibling's consent does not count. (Conservative on purpose; the school may relax it to any one.)
 */
export function photoConsentFor(db, studentId) {
  const s = byId(db.students, studentId);
  if (!s) return false;
  const live = (c, purpose) => c.studentId === studentId && c.purpose === purpose && c.version === CONSENT_VERSION && !c.withdrawnAt;
  const consents = db.consents || [];
  const holders = [...new Set(consents.filter(c => live(c, 'app_account') && (s.guardianIds || []).includes(c.guardianId)).map(c => c.guardianId))];
  return holders.length > 0 && holders.every(g => consents.some(c => c.guardianId === g && live(c, 'photos')));
}

/**
 * {version, purposes:{app_account, push, bus_live, photos}: {given, at}, byChild:{studentId: [purpose]}} — a purpose
 * counts as given when every child has it; byChild lists the live purposes of each child (photos may differ by child).
 */
export function consentStatus(db, p) {
  const purposes = {};
  const liveRow = (sid, purpose) => (db.consents || []).find(c => c.guardianId === p.guardianId && c.studentId === sid && c.purpose === purpose && c.version === CONSENT_VERSION && !c.withdrawnAt);
  for (const purpose of CONSENT_PURPOSES) {
    const rows = p.studentIds.map(sid => liveRow(sid, purpose));
    const given = p.studentIds.length > 0 && rows.every(Boolean);
    purposes[purpose] = { given, at: given ? rows.map(r => r.givenAt).sort()[0] : null };
  }
  const byChild = Object.fromEntries(p.studentIds.map(sid => [sid, CONSENT_PURPOSES.filter(x => liveRow(sid, x))]));
  return { version: CONSENT_VERSION, purposes, byChild };
}

const staffLearning = p => allow(p, 'admin', 'teacher');
function observationOf(db, id) { const o = byId(db.observations, id); if (!o) fail('NOT_FOUND', 'Observation not found'); return o; }
function photoOf(db, id) { const x = byId(db.photos, id); if (!x) fail('NOT_FOUND', 'Photo not found'); return x; }
function reportOf(db, id) { const r = byId(db.reports, id); if (!r) fail('NOT_FOUND', 'Report not found'); return r; }
/** The principal, or the staff member who took the photo (and still sees the child). */
function takerOf(p, db, id) {
  staffLearning(p);
  const ph = photoOf(db, id);
  O.mustSeeLearner(p, db, ph.studentId);
  if (p.role !== 'admin' && ph.takenBy !== p.staffId) deny('Only the person who took the photo can finish its upload');
  return ph;
}
const RETENTION_LOAD = { learningAll: true, diaryAll: true, attendanceAll: true };

/** The DB slice each command needs on the server, and the collections it may write. */
const BASE = ['academicYears', 'programs', 'students', 'guardians', 'staff', 'routes', 'feeHeads'];
const LEARNING = ['presentations', 'observations', 'photos', 'progressEvents', 'reports'];
export const SLICES = {
  ledger: { reads: [...BASE, 'calendarEvents', 'feeStructures', 'invoices', 'payments', 'refunds', 'credits', 'importBatches', 'importRows', 'erasureRequests'],
    writes: ['school', 'counters', 'students', 'guardians', 'staff', 'feeHeads', 'feeStructures', 'invoices', 'payments', 'refunds', 'credits', 'importBatches', 'erasureRequests'] },
  messaging: { reads: [...BASE, 'notices', 'noticeReceipts', 'threads', 'messages'], writes: ['notices', 'noticeReceipts', 'threads', 'messages'] },
  calendar: { reads: [...BASE, 'calendarEvents'], writes: ['calendarEvents'] },
  transport: { reads: [...BASE, 'calendarEvents', 'trips'], writes: ['trips'] },
  classroom: { reads: [...BASE, 'calendarEvents', 'attendance', 'diaryEntries'], writes: ['attendance', 'diaryEntries'] },
  people: { reads: [...BASE, 'invoices', 'importBatches'], writes: ['importBatches', 'importRows'] },
  account: { reads: [...BASE, 'consents', 'invites', 'appUsers', 'erasureRequests', 'photos'], writes: ['guardians', 'consents', 'invites', 'appUsers', 'erasureRequests', 'photos'] },
  settlement: { reads: [...BASE, 'invoices', 'payments', 'refunds', 'settlementLines'], writes: ['settlementLines'] },
  export: { reads: [...BASE, 'invoices', 'payments', 'refunds', 'credits', 'notices', 'noticeReceipts', 'threads', 'messages', 'attendance', 'diaryEntries', 'consents',
    'trips', 'appUsers', 'invites', 'erasureRequests', 'importBatches', 'importRows', 'remindersSent', 'pushSubscriptions', 'gatewayOrders', 'gatewayEvents',
    ...LEARNING], writes: [] },
  erasure: { reads: [...BASE, 'threads', 'messages', 'appUsers', 'invites', 'erasureRequests', 'importBatches', 'importRows'],
    writes: ['guardians', 'messages', 'appUsers', 'invites', 'erasureRequests', 'importRows'] },
  // learning records are loaded per child (hints) except for system sweeps; consents are read for the photo rule
  learning: { reads: [...BASE, 'consents', ...LEARNING], writes: LEARNING },
  // the only slice whose command removes rows (retention.purge, system only); persist's allow-list matches PURGEABLE
  retention: { reads: [...BASE, ...LEARNING, 'diaryEntries', 'attendance', 'threads', 'messages'], writes: RT.PURGEABLE },
};
/** Server-only collections (not part of the Db document; consents joined it in schema v2). */
export const SERVER_COLLECTIONS = ['invites', 'appUsers', 'erasureRequests', 'importBatches', 'importRows', 'settlementLines', 'remindersSent', 'pushSubscriptions', 'gatewayOrders', 'gatewayEvents'];

/**
 * Other slices whose revision must also be checked (and moved) when a command of slice `primary` changes these
 * collections: every slice that writes one of them, so two slices can never overwrite each other's copy of the
 * same row (finding 13). A staff change also moves app_users (role), which the account slice writes.
 * Transport is guarded per route and shares no collection with any other slice.
 */
export function guardSlices(primary, changedCollections) {
  const changed = new Set(changedCollections);
  const out = new Set();
  for (const [name, sl] of Object.entries(SLICES)) {
    if (name === primary || name === 'transport') continue;
    if (sl.writes.some(w => changed.has(w))) out.add(name);
  }
  if (changed.has('staff') && primary !== 'account') out.add('account');
  return [...out].sort();
}

/**
 * The server-side parent persona for a command: only children whose guardian has current app_account consent for
 * them (finding 6). Commands marked beforeConsent use the full persona.
 */
export function consentScopedPersona(db, p, consents) {
  const ok = new Set((consents || []).filter(c => c.guardianId === p.guardianId && c.purpose === 'app_account' && c.version === CONSENT_VERSION && !c.withdrawnAt).map(c => c.studentId));
  const studentIds = p.studentIds.filter(id => ok.has(id));
  return { ...p, studentIds, activeStudentIds: (p.activeStudentIds || []).filter(id => ok.has(id)),
    programIds: [...new Set(studentIds.map(id => byId(db.students, id)?.programId).filter(Boolean))] };
}

/** Revision key: transport is guarded per route so two buses never conflict with each other. */
export function revKey(name, db, args) {
  const cmd = COMMANDS[name];
  if (cmd.slice !== 'transport') return cmd.slice;
  const routeId = name === 'transport.startTrip' ? args[0]?.routeId : byId(db.trips, args[0])?.routeId;
  return `transport:${routeId || '-'}`;
}

/**
 * Run one command against a draft db (both modes). Throws DomainError on refusal; returns run's result.
 * @param {object} p  persona (null only for allowUnlinked commands)
 */
export function execute(name, db, args, ctx, p) {
  const cmd = COMMANDS[name];
  if (!cmd) fail('NOT_FOUND', `Unknown command: ${name}`);
  if (!p && !cmd.allowUnlinked) deny('Sign in first');
  cmd.authorize(p, db, args, ctx);
  return cmd.run(db, args, ctx, p);
}
