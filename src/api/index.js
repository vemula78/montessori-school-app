// The only data module screens import. Async facade over the pure domain.
// Two modes, bound to the entry HTML (never a runtime toggle):
//   demo     (root index.html)  — this file: localStorage, seed data, persona switcher.
//   supabase (app/index.html sets window.__APP_CONFIG__) — ./remote.js: same signatures, same ApiError codes,
//            reads over the server-scoped snapshot, writes through the `command` Edge Function.
// Writes go through the command registry (src/domain/commands.js): the SAME authorize + run that the
// server executes. Results are structured clones, so screens can never mutate stored state by accident.

import { Storage, DB_KEY, memoryBackend } from '../store/storage.js';
import { todayISO, nowISO } from '../domain/dates.js';
import { byId, fullName, childrenOf, sortByName } from '../domain/people.js';
import * as M from '../domain/messaging.js';
import * as C from '../domain/calendar.js';
import * as H from '../domain/holiday-csv.js';
import * as T from '../domain/transport.js';
import { simulationPlan } from '../domain/sim.js';
import * as F from '../domain/fees.js';
import { reconcile } from '../domain/reconcile.js';
import * as A from '../domain/attendance.js';
import * as D from '../domain/diary.js';
import { listAudit } from '../domain/audit.js';
import { validateDb } from '../domain/validate.js';
import {
  COMMANDS, execute, buildPersonas, photoConsentFor, systemPersona, ctxFor as cmdCtx, allow as allowP, mustSee as mustSeeP, canManageNotice, visibleThread,
  visibleRoutes, mustRoute, driverTrip, teachesProgram, tripOut as tripOutP, STAFF_SEES_ALL, CONSENT_VERSION,
} from '../domain/commands.js';
import { remindersDue, lateFeesDueList } from '../domain/reminders.js';
import { parseCsvObjects } from '../domain/csv.js';
import * as I from '../domain/import-people.js';
import { guardianExport } from '../domain/export.js';
import { previewCurriculumCsv } from '../domain/curriculum.js';
import { listPresentations } from '../domain/presentations.js';
import { listObservations, learnerVisible } from '../domain/observations.js';
import { progressState, progressHistory } from '../domain/progress.js';
import { listReports, getReport } from '../domain/reports.js';
import { photoView } from '../domain/photos.js';
import { retentionPlan } from '../domain/retention.js';
import { createDemoPhotos } from './demo-photos.js';

export { buildPersonas };

export class ApiError extends Error {
  /** @param {string} code  @param {string} message  @param {any} [details] */
  constructor(code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export const SESSION_KEY = 'montessori.session.v1';

export function toApiError(e) {
  if (e instanceof ApiError) return e;
  if (e && typeof e.code === 'string') return new ApiError(e.code, e.message, e.details);
  return e; // a programming error: surface it unchanged
}
const out = x => (x === undefined ? undefined : structuredClone(x));
/** Wrap: async, coded errors → ApiError, results cloned. */
export const op = fn => async (...args) => {
  try { return out(await fn(...args)); } catch (e) { throw toApiError(e); }
};
export const realAppOnly = what => new ApiError('NOT_ALLOWED', `${what} is available in the real app (app/), not in the demo`);

/**
 * The persona-scoped api surface shared by both modes: every read, plus every registry write via `cmd`.
 * @param {{db:()=>any, me:()=>any, clock:()=>Date, cmd:(name:string)=>Function}} deps
 *   db()  current Db (throws when not loaded); me() current persona (throws NOT_ALLOWED when none);
 *   cmd(name) → async (...args) running that registry command (demo: local commit; supabase: Edge Function).
 */
export function createSurface({ db, me, clock, cmd }) {
  const today = () => todayISO(clock());
  const allow = (...roles) => allowP(me(), ...roles);
  const mustSee = (p, studentId) => mustSeeP(p, db(), studentId);

  const studentView = (d, s, p) => {
    const v = { ...s, name: fullName(s), programName: byId(d.programs, s.programId)?.name ?? '—' };
    if (p.role === 'driver') v.healthNotes = null; // not needed for boarding
    return v;
  };
  const visibleGuardianIds = (d, p) => {
    if (STAFF_SEES_ALL.includes(p.role)) return d.guardians.map(g => g.id);
    if (p.role === 'parent') return [p.guardianId];
    if (p.role === 'teacher') return [...new Set(d.students.filter(s => p.studentIds.includes(s.id)).flatMap(s => s.guardianIds))];
    return [];
  };
  /** A teacher sees only the children of a guardian that are in the teacher's programs. */
  const guardianView = (p, g) => ({ ...g, name: fullName(g), studentIds: p.role === 'teacher' ? g.studentIds.filter(id => p.studentIds.includes(id)) : [...g.studentIds] });

  const people = {
    programs: op(() => { me(); return db().programs; }),
    students: op(({ programId } = {}) => {
      const p = me(); const d = db();
      let list = STAFF_SEES_ALL.includes(p.role) ? d.students : d.students.filter(s => p.studentIds.includes(s.id));
      if (programId) list = list.filter(s => s.programId === programId);
      return sortByName(list).map(s => studentView(d, s, p));
    }),
    student: op(id => { const p = me(); mustSee(p, id); return studentView(db(), byId(db().students, id), p); }),
    guardians: op(() => {
      const p = me(); const d = db(); const ids = visibleGuardianIds(d, p);
      return sortByName(d.guardians.filter(g => ids.includes(g.id))).map(g => guardianView(p, g));
    }),
    guardian: op(id => {
      const p = me(); const d = db();
      const g = byId(d.guardians, id);
      if (!g) throw new ApiError('NOT_FOUND', 'Guardian not found');
      if (!visibleGuardianIds(d, p).includes(id)) throw new ApiError('NOT_ALLOWED', 'Not visible to you');
      return guardianView(p, g);
    }),
    staff: op(({ role } = {}) => {
      me();
      return sortByName(db().staff.filter(s => !role || s.role === role)).map(s => ({ ...s, name: fullName(s) }));
    }),
    childrenOf: op(guardianId => {
      const p = me(); const d = db();
      if (!visibleGuardianIds(d, p).includes(guardianId)) throw new ApiError('NOT_ALLOWED', 'Not visible to you');
      return childrenOf(d, guardianId).filter(s => p.role !== 'teacher' || p.studentIds.includes(s.id)).map(s => studentView(d, s, p));
    }),
    /** updateStudent({studentId, programId?, status?, leftOn?, routeId?, stopId?}) — principal only; the one way a child changes class or leaves. */
    updateStudent: cmd('people.updateStudent'),
  };

  const withStats = (d, n) => ({ ...n, ...M.noticeStats(d, n.id) });
  const byNewest = (a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0);
  const notices = {
    list: op(() => {
      const p = me(); const d = db();
      if (p.role === 'parent') {
        // Only this guardian's own children: never other targeted children.
        return M.noticesForGuardian(d, p.guardianId).map(n => {
          const about = n.receipt.studentIds;
          const audience = n.audience.scope === 'students' ? { ...n.audience, studentIds: n.audience.studentIds.filter(id => about.includes(id)) } : n.audience;
          return { ...n, audience, aboutStudentIds: [...about] };
        }).sort(byNewest);
      }
      if (p.role === 'admin' || p.role === 'accountant') return d.notices.map(n => withStats(d, n)).sort(byNewest);
      if (p.role === 'teacher') return M.noticesForPrograms(d, p.programIds).map(n => withStats(d, n)).sort(byNewest);
      return [];
    }),
    send: cmd('notices.send'),
    recipients: op(noticeId => {
      const p = allow('admin', 'teacher'); const d = db();
      canManageNotice(p, d, noticeId);
      let rows = M.noticeRecipients(d, noticeId);
      if (p.role === 'teacher') {
        rows = rows.map(r => ({ ...r, studentIds: r.studentIds.filter(id => p.studentIds.includes(id)) })).filter(r => r.studentIds.length > 0);
      }
      return rows.map(r => ({ ...r, studentNames: r.studentIds.map(id => fullName(byId(d.students, id))) }));
    }),
    markRead: cmd('notices.markRead'),
    acknowledge: cmd('notices.acknowledge'),
  };

  const threads = {
    list: op(() => {
      const p = allow('admin', 'teacher', 'parent'); const d = db();
      const list = d.threads.filter(t => p.role === 'admin' || (p.role === 'teacher' && p.programIds.includes(t.programId)) || (p.role === 'parent' && t.guardianId === p.guardianId));
      return list.map(t => M.threadView(d, t, p.role)).sort((a, b) => {
        const ta = a.lastMessage?.sentAt || a.createdAt, tb = b.lastMessage?.sentAt || b.createdAt;
        return ta < tb ? 1 : ta > tb ? -1 : 0;
      });
    }),
    get: op(id => {
      const p = allow('admin', 'teacher', 'parent'); const d = db();
      const t = visibleThread(p, d, id);
      return { thread: M.threadView(d, t, p.role), messages: M.threadMessages(d, id) };
    }),
    open: cmd('threads.open'),
    reply: cmd('threads.reply'),
    markRead: cmd('threads.markRead'),
    close: cmd('threads.close'),
  };

  const calendar = {
    academicYears: op(() => {
      me(); const d = db();
      return [...d.academicYears].sort((a, b) => (a.startDate < b.startDate ? -1 : 1)).map(ay => ({ ...ay, current: ay.id === d.school.currentAcademicYearId }));
    }),
    events: op(({ academicYearId, programId, types, from, to } = {}) => {
      const p = me(); const d = db();
      const ayId = academicYearId || d.school.currentAcademicYearId;
      let birthdayStudentIds;
      if (p.role === 'parent' || p.role === 'teacher') birthdayStudentIds = p.studentIds;
      else if (p.role === 'driver') birthdayStudentIds = [];
      const evs = C.listEvents(d, { academicYearId: ayId, programId, types, from, to, birthdayStudentIds });
      if (STAFF_SEES_ALL.includes(p.role)) return evs;
      // parents/teachers: school-wide events plus their own programs; drivers: school-wide only
      return evs.filter(ev => ev.type === 'birthday' || ev.programIds.length === 0 || ev.programIds.some(x => p.programIds.includes(x)));
    }),
    create: cmd('calendar.create'),
    update: cmd('calendar.update'),
    remove: cmd('calendar.remove'),
    previewHolidayCsv: op((text, academicYearId) => { allow('admin'); return H.previewHolidayCsv(db(), text, academicYearId); }),
    importHolidays: cmd('calendar.importHolidays'),
    isWorkingDay: op((dateISO, programId) => { me(); return C.isWorkingDay(db(), dateISO, programId); }),
  };

  const tripOut = (t, p) => tripOutP(db(), t, p);
  const transport = {
    routes: op(() => { const p = me(); return visibleRoutes(p, db()); }),
    route: op(id => { const p = me(); return mustRoute(p, db(), id); }),
    routeForStudent: op(studentId => {
      const p = me(); mustSee(p, studentId); const d = db();
      const s = byId(d.students, studentId);
      if (!s.routeId) return null;
      const route = byId(d.routes, s.routeId);
      return route ? { route, stop: route.stops.find(x => x.id === s.stopId) || null } : null;
    }),
    roster: op(routeId => { const p = allow('admin', 'driver'); mustRoute(p, db(), routeId); return T.routeRoster(db(), routeId); }),
    startTrip: cmd('transport.startTrip'),
    endTrip: cmd('transport.endTrip'),
    recordPosition: cmd('transport.recordPosition'),
    markChild: cmd('transport.markChild'),
    activeTrip: op(routeId => { const p = me(); mustRoute(p, db(), routeId); const t = T.activeTripFor(db(), routeId); return t ? tripOut(t, p) : null; }),
    trips: op(({ routeId, date } = {}) => {
      const p = me(); const d = db();
      const routeIds = new Set(visibleRoutes(p, d).map(r => r.id));
      if (p.role === 'parent') throw new ApiError('NOT_ALLOWED', 'Use the bus view for your child');
      return d.trips.filter(t => routeIds.has(t.routeId) && (!routeId || t.routeId === routeId) && (!date || t.date === date))
        .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)).map(t => tripOut(t, p));
    }),
    parentView: op(studentId => {
      const p = me(); mustSee(p, studentId);
      const now = clock();
      return T.parentView(db(), studentId, nowISO(now), todayISO(now));
    }),
    simulationPlan: op((routeId, o = {}) => { const p = allow('admin', 'driver'); return simulationPlan(mustRoute(p, db(), routeId), o); }),
  };

  function seeInvoice(p, d, id) {
    const inv = byId(d.invoices, id);
    if (!inv) throw new ApiError('NOT_FOUND', 'Invoice not found');
    if (!(STAFF_SEES_ALL.includes(p.role) || (p.role === 'parent' && p.studentIds.includes(inv.studentId)))) throw new ApiError('NOT_ALLOWED', 'Not your invoice');
    return inv;
  }
  function seePayment(p, d, id) {
    const pay = byId(d.payments, id);
    if (!pay) throw new ApiError('NOT_FOUND', 'Payment not found');
    if (!(STAFF_SEES_ALL.includes(p.role) || (p.role === 'parent' && p.studentIds.includes(pay.studentId)))) throw new ApiError('NOT_ALLOWED', 'Not your payment');
    return pay;
  }
  const fin = () => allow('admin', 'accountant');
  const fees = {
    heads: op(() => { allow('admin', 'accountant', 'parent'); return db().feeHeads; }),
    structures: op(({ academicYearId } = {}) => { fin(); return db().feeStructures.filter(s => !academicYearId || s.academicYearId === academicYearId); }),
    saveStructure: cmd('fees.saveStructure'),
    generateInvoices: cmd('fees.generateInvoices'),
    invoices: op(({ studentId, status, academicYearId, programId } = {}) => {
      const p = allow('admin', 'accountant', 'parent'); const d = db(); const asOf = today();
      return d.invoices
        .filter(i => (STAFF_SEES_ALL.includes(p.role) || p.studentIds.includes(i.studentId))
          && (!studentId || i.studentId === studentId) && (!status || i.status === status)
          && (!academicYearId || i.academicYearId === academicYearId)
          && (!programId || byId(d.students, i.studentId)?.programId === programId))
        .map(i => F.invoiceView(d, i, asOf))
        .sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : a.number < b.number ? -1 : 1));
    }),
    invoice: op(id => { const p = allow('admin', 'accountant', 'parent'); const d = db(); return F.invoiceView(d, seeInvoice(p, d, id), today()); }),
    addConcession: cmd('fees.addConcession'),
    removeConcession: cmd('fees.removeConcession'),
    lateFeeDue: op((invoiceId, asOfDate) => {
      const p = allow('admin', 'accountant', 'parent'); const d = db();
      return F.lateFeeDue(d, seeInvoice(p, d, invoiceId), asOfDate || today());
    }),
    /** The accountant's "late fees due" list (computed as of today; nothing is applied automatically). */
    lateFeesDueList: op(() => { fin(); return lateFeesDueList(db(), today()); }),
    applyLateFee: cmd('fees.applyLateFee'),
    /** applyLateFees({invoiceIds}) → {applied:[{invoiceId, line}], skipped:[{invoiceId, reason}]} */
    applyLateFees: cmd('fees.applyLateFees'),
    waiveLateFee: cmd('fees.waiveLateFee'),
    cancelInvoice: cmd('fees.cancelInvoice'),
    recordPayment: cmd('fees.recordPayment'),
    cancelPayment: cmd('fees.cancelPayment'),
    /**
     * refund({paymentId, invoiceId, amountPaise, mode, reference, date, reason}) — money back against an invoice allocation.
     * refund({creditId, amountPaise, mode, reference, date, reason}) — return unallocated credit (advance) held on account.
     * refund({paymentId, invoiceId: null, amountPaise, …}) — same, from that payment's unconsumed credit.
     * date must be on/after the payment date and not in the future.
     */
    refund: cmd('fees.refund'),
    payments: op(({ studentId, from, to } = {}) => {
      const p = allow('admin', 'accountant', 'parent'); const d = db();
      return d.payments
        .filter(x => (STAFF_SEES_ALL.includes(p.role) || p.studentIds.includes(x.studentId))
          && (!studentId || x.studentId === studentId) && (!from || x.paidOn >= from) && (!to || x.paidOn <= to))
        // externalReceivedPaise: money actually received; 'credit' payments are internal transfers (0)
        .map(x => ({ ...x, studentName: fullName(byId(d.students, x.studentId)), externalReceivedPaise: x.mode === 'credit' ? 0 : x.amountPaise }))
        .sort((a, b) => (a.recordedAt < b.recordedAt ? 1 : a.recordedAt > b.recordedAt ? -1 : 0));
    }),
    payment: op(id => { const p = allow('admin', 'accountant', 'parent'); return seePayment(p, db(), id); }),
    receiptView: op(paymentId => { const p = allow('admin', 'accountant', 'parent'); seePayment(p, db(), paymentId); return F.receiptView(db(), paymentId); }),
    availableCredit: op(studentId => { const p = allow('admin', 'accountant', 'parent'); mustSee(p, studentId); return F.availableCreditPaise(db(), studentId); }),
    outstandingReport: op(({ academicYearId, programId, asOfDate } = {}) => {
      fin(); const d = db();
      return F.outstandingReport(d, { academicYearId: academicYearId || d.school.currentAcademicYearId, programId, asOfDate: asOfDate || today() });
    }),
    reconcile: op(() => { fin(); return reconcile(db(), { asOfDate: today() }); }),
    mockOnlinePayment: cmd('fees.mockOnlinePayment'),
  };

  const attendance = {
    forDate: op((date, programId) => { const p = allow('admin', 'teacher'); teachesProgram(p, programId); return A.attendanceForDate(db(), date, programId); }),
    mark: cmd('attendance.mark'),
    summary: op((studentId, from, to) => { const p = allow('admin', 'teacher', 'parent'); mustSee(p, studentId); return A.attendanceSummary(db(), studentId, from, to); }),
  };

  const diary = {
    forStudentDate: op((studentId, date) => { const p = allow('admin', 'teacher', 'parent'); mustSee(p, studentId); return D.diaryForStudentDate(db(), studentId, date); }),
    forProgramDate: op((programId, date) => { const p = allow('admin', 'teacher'); teachesProgram(p, programId); return D.diaryForProgramDate(db(), programId, date); }),
    add: cmd('diary.add'),
    markRead: cmd('diary.markRead'),
  };

  const audit = { list: op(q => { allow('admin', 'accountant'); return listAudit(db(), q || {}); }) };


  // ---------------- Phase 3: curriculum, observations, photos, progress, reports ----------------
  // Reads work over the same Db shape in both modes (the real app's snapshot carries the same collections, scoped by RLS).
  const curriculum = {
    /** list({area?, includeRetired? = true}) → presentations in classroom order (area, sequence, name). Staff only. */
    list: op(({ area, includeRetired = true } = {}) => listPresentations(db(), me(), { area, includeRetired })),
    /** previewCsv(text) → {rows, duplicates, rejected, counts}: pure, nothing is written. importCsv(text) previews the same text again itself. */
    previewCsv: op(text => { allow('admin'); return previewCurriculumCsv(db(), text); }),
    importCsv: cmd('curriculum.importCsv'),
    loadStarter: cmd('curriculum.loadStarter'),
    save: cmd('curriculum.save'),
    retire: cmd('curriculum.retire'),
    restore: cmd('curriculum.restore'),
  };
  const observations = {
    /** list({studentId} | {programId}, from?, to?) → newest first; parents get shared observations of their own children only. */
    list: op((q = {}) => listObservations(db(), me(), q)),
    add: cmd('observations.add'),
    edit: cmd('observations.edit'),
    share: cmd('observations.share'),
    unshare: cmd('observations.unshare'),
  };
  const progress = {
    /** state({studentId} | {programId}) → the current status per (child, presentation); staff only (parents see the report). */
    state: op((q = {}) => progressState(db(), me(), q)),
    /** history(studentId, presentationId) → every event, oldest first. */
    history: op((studentId, presentationId) => progressHistory(db(), me(), studentId, presentationId)),
    record: cmd('progress.record'),
  };
  const reports = {
    list: op((q = {}) => listReports(db(), me(), q)),
    get: op(id => getReport(db(), me(), id)),
    generate: cmd('reports.generate'),
    saveNarratives: cmd('reports.saveNarratives'),
    submit: cmd('reports.submit'),
    publish: cmd('reports.publish'),
    unpublish: cmd('reports.unpublish'),
  };
  /** The photo rows of an observation as this persona may see them (parents: ready photos of shared observations only). */
  const photoRows = (p, d, observationId) => {
    const o = (d.observations || []).find(x => x.id === observationId);
    if (!o) throw new ApiError('NOT_FOUND', 'Observation not found');
    if (!['admin', 'teacher', 'parent'].includes(p.role) || !learnerVisible(p, o.studentId) || (p.role === 'parent' && !o.sharedAt)) throw new ApiError('NOT_ALLOWED', 'Not visible to you');
    return (d.photos || []).filter(x => x.observationId === o.id && (p.role === 'parent' ? x.status === 'ready' : !['deleted', 'expired'].includes(x.status)))
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)).map(photoView);
  };
  const photos = {
    list: op(observationId => { const p = me(); const rows = photoRows(p, db(), observationId); return p.role === 'parent' && rows.length && !photoConsentFor(db(), rows[0].studentId) ? [] : rows; }),
    /** consent(studentId) → true when photos of this child may be taken (photoConsentFor); staff only. */
    consent: op(studentId => { const p = allow('admin', 'teacher'); mustSee(p, studentId); return photoConsentFor(db(), studentId); }),
    /** consentStatus({programId} | {studentIds}) → {studentId: boolean} for the staff photo badges. */
    consentStatus: op(({ programId, studentIds } = {}) => {
      const p = allow('admin', 'teacher'); const d = db();
      const ids = programId ? d.students.filter(s => s.programId === programId).map(s => s.id) : (studentIds || []);
      return Object.fromEntries(ids.map(id => { mustSee(p, id); return [id, photoConsentFor(d, id)]; }));
    }),
  };

  /** Children/fees CSV import helpers that need no server (parsing and the suggested column mapping). */
  const importHelpers = {
    /** parseCsv(text) → {headers, rows:[{line, values}], problems:[{line, reason}]} — pass rows to stage() unchanged. */
    parseCsv: op(text => { allow('admin', 'accountant'); return parseCsvObjects(text); }),
    targetFields: op(kind => { allow('admin', 'accountant'); if (!I.TARGET_FIELDS[kind]) throw new ApiError('VALIDATION', `Unknown import kind: ${kind}`); return { fields: I.TARGET_FIELDS[kind], required: I.REQUIRED_FIELDS[kind] }; }),
    suggestMapping: op((kind, headers) => { allow('admin', 'accountant'); return I.suggestMapping(kind, headers || []); }),
  };

  return { people, notices, threads, calendar, transport, fees, attendance, diary, audit, importHelpers, curriculum, observations, progress, reports, photos, helpers: { tripOut, seeInvoice, seePayment, visibleGuardianIds, photoRows } };
}

/**
 * @param {{backend?, sessionBackend?, seedFn?:()=>any, clock?:()=>Date, eventTarget?:EventTarget|null,
 *   persistent?:boolean, persistenceNote?:string|null}} opts
 *   persistent:false = in-memory fallback (browser storage unusable); reported by admin.storageInfo().
 */
export function createApi(opts = {}) {
  const backend = opts.backend || memoryBackend();
  const sessionBackend = opts.sessionBackend || memoryBackend();
  const clock = opts.clock || (() => new Date());
  const listeners = new Set();
  let storage = null;
  let readyPromise = null;

  const emit = (db, info) => { for (const fn of listeners) { try { fn(db, info); } catch (e) { console.error(e); } } };

  async function ensureStorage() {
    if (storage) return storage;
    const seedFn = opts.seedFn || (await import('../seed/seed-data.js')).buildSeed;
    storage = new Storage({ backend, seedFn, clock, persistent: opts.persistent ?? true, persistenceNote: opts.persistenceNote ?? null });
    storage.subscribe(emit);
    if (opts.eventTarget) {
      // key === null means another tab cleared all storage
      opts.eventTarget.addEventListener('storage', e => { if (e.key === DB_KEY || e.key === null) storage.handleExternalChange(); });
    }
    return storage;
  }

  function db() {
    if (!storage || storage.status !== 'ok' || !storage.db) {
      throw new ApiError('STORAGE_CORRUPT', storage?.lastError || 'Data is not loaded; call api.ready() first');
    }
    return storage.db;
  }

  // ---------------- session (demo: persona switcher) ----------------
  function readSession() { try { return sessionBackend.getItem(SESSION_KEY); } catch { return null; } }
  const session = {
    personas() { return storage && storage.db ? out(buildPersonas(storage.db)) : []; },
    current() {
      if (!storage || !storage.db) return null;
      const id = readSession();
      return id ? out(buildPersonas(storage.db).find(p => p.id === id) || null) : null;
    },
    set(personaId) {
      if (!buildPersonas(db()).some(p => p.id === personaId)) throw new ApiError('NOT_FOUND', `Unknown persona: ${personaId}`);
      sessionBackend.setItem(SESSION_KEY, personaId);
      emit(storage.db, storage.info());
    },
    clear() { try { sessionBackend.removeItem ? sessionBackend.removeItem(SESSION_KEY) : sessionBackend.setItem(SESSION_KEY, ''); } catch { /* ignore */ } emit(storage?.db ?? null, storage ? storage.info() : null); },
  };

  function me() {
    const p = session.current();
    if (!p) throw new ApiError('NOT_ALLOWED', 'Choose a persona first');
    return p;
  }
  const ctxNow = p => { const now = clock(); return cmdCtx(p, nowISO(now), todayISO(now)); };

  /** A registry command run locally: authorize + run inside storage.commit (nothing written if either throws). */
  const cmd = name => op((...args) => {
    const c = COMMANDS[name];
    if (!c) throw new ApiError('NOT_FOUND', `Unknown command: ${name}`);
    if (c.serverOnly) throw realAppOnly('This action');
    const p = me();
    db();
    return storage.commit(d => execute(name, d, args, ctxNow(p), p));
  });

  const surface = createSurface({ db, me, clock, cmd });
  const { people, notices, threads, calendar, transport, fees, attendance, diary, audit, importHelpers, curriculum, observations, progress, reports } = surface;
  const today = () => todayISO(clock());

  // ---------------- live trip feed (demo: same-browser commits and storage events) ----------------
  /** fn({type:'position', fix}) for each new kept fix; fn({type:'trip', trip}) when status/events change (positions omitted). */
  transport.subscribeTrip = (routeId, fn) => {
    const p = me();
    mustRoute(p, db(), routeId);
    let tripId = null, lastTs = null, lastSig = null;
    const current = d => T.activeTripFor(d, routeId) || d.trips.filter(t => t.routeId === routeId && t.date === today()).sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))[0] || null;
    const view = (d, t) => { const v = tripOutP(d, t, p); delete v.positions; return v; };
    const sigOf = v => JSON.stringify([v.id, v.status, v.endedAt, v.stopEvents, v.childEvents]);
    const prime = () => {
      const d = storage?.db; const t = d && current(d);
      tripId = t ? t.id : null; lastTs = t && t.positions.length ? t.positions.at(-1).ts : null; lastSig = t ? sigOf(view(d, t)) : null;
    };
    prime();
    const check = d => {
      if (!d) return;
      const t = current(d);
      if (!t) return;
      if (t.id !== tripId) { tripId = t.id; lastTs = null; lastSig = null; }
      const v = view(d, t);
      const sig = sigOf(v);
      if (sig !== lastSig) { lastSig = sig; try { fn(out({ type: 'trip', trip: v })); } catch (e) { console.error(e); } }
      for (const fix of t.positions) {
        if (lastTs && fix.ts <= lastTs) continue;
        lastTs = fix.ts;
        try { fn(out({ type: 'position', fix: { lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy, ts: fix.ts } })); } catch (e) { console.error(e); }
      }
    };
    listeners.add(check);
    return () => listeners.delete(check);
  };

  // ---------------- real-app-only namespaces, demo behaviour ----------------
  const auth = {
    status: op(() => ({ state: 'demo', email: null })),
    signInWithOtp: op(() => { throw realAppOnly('Sign-in with an email code'); }),
    verifyOtp: op(() => { throw realAppOnly('Sign-in with an email code'); }),
    redeemInvite: op(() => { throw realAppOnly('Linking with an invite code'); }),
    signOut: op(() => { session.clear(); }),
  };
  const consent = {
    // The demo holds no personal data; live bus tracking is shown, so the demo reports it as given.
    status: op(() => ({ version: CONSENT_VERSION, purposes: { app_account: { given: true, at: null }, push: { given: false, at: null }, bus_live: { given: true, at: null }, photos: { given: true, at: null } }, demo: true })),
    give: op(() => { throw realAppOnly('Recording consent'); }),
    withdraw: op(() => { throw realAppOnly('Withdrawing consent'); }),
  };
  const push = {
    vapidPublicKey: op(() => null),
    subscribe: op(() => { throw realAppOnly('Push notifications'); }),
    unsubscribe: op(() => { throw realAppOnly('Push notifications'); }),
    list: op(() => []),
  };
  Object.assign(fees, {
    createGatewayOrder: op(() => { throw realAppOnly('Online payment (Razorpay)'); }),
    verifyGatewayPayment: op(() => { throw realAppOnly('Online payment (Razorpay)'); }),
    gatewayOrderStatus: op(() => { throw realAppOnly('Online payment (Razorpay)'); }),
    importSettlementCsv: op(() => { throw realAppOnly('Settlement reconciliation'); }),
    settlementReport: op(() => { throw realAppOnly('Settlement reconciliation'); }),
  });

  // Import works in the demo too: batches live in memory only (lost on reload); commit writes local data.
  const batches = new Map();
  const imports = {
    ...importHelpers,
    stage: op(({ kind, mapping, rows } = {}) => {
      const p = allowP(me(), 'admin', 'accountant');
      I.checkMapping(kind, mapping);
      if (!Array.isArray(rows) || !rows.length) throw new ApiError('VALIDATION', 'The file has no data rows');
      const batchId = `imb-demo-${batches.size + 1}`;
      const v = I.validateRows(db(), { kind, mapping, rows }, { today: today(), batchId });
      batches.set(batchId, { id: batchId, kind, mapping: { ...mapping }, rows: structuredClone(rows), status: 'staged', inputRows: rows.length, createdAt: nowISO(clock()), createdBy: p.staffId, result: null });
      return { batchId, counts: v.counts };
    }),
    preview: op(batchId => {
      allowP(me(), 'admin', 'accountant');
      const b = batches.get(batchId);
      if (!b) throw new ApiError('NOT_FOUND', 'Import batch not found');
      const v = I.validateRows(db(), b, { today: today(), batchId });
      return { batchId, kind: b.kind, status: b.status, rows: v.rows, counts: v.counts, guardians: v.guardians, sourceOutstandingPaise: v.sourceOutstandingPaise };
    }),
    commit: op(batchId => {
      const p = allowP(me(), 'admin', 'accountant');
      const b = batches.get(batchId);
      if (!b) throw new ApiError('NOT_FOUND', 'Import batch not found');
      if (b.status !== 'staged') throw new ApiError('VALIDATION', `This import was already ${b.status}`);
      const r = storage.commit(d => I.applyRows(d, b, batchId, ctxNow(p)));
      Object.assign(b, { status: 'committed', result: { ...r, rows: undefined } });
      return r;
    }),
    batches: op(() => { allowP(me(), 'admin', 'accountant'); return [...batches.values()].map(({ rows, ...b }) => b); }),
  };

  const reminders = {
    /** Demo: the reminders the daily job WOULD send today for visible invoices (sentOn null = not sent; no job runs in the demo). */
    list: op(() => {
      const p = allowP(me(), 'admin', 'accountant', 'parent');
      return remindersDue(db(), today()).filter(r => STAFF_SEES_ALL.includes(p.role) || p.studentIds.includes(r.studentId))
        .map(r => ({ invoiceId: r.invoiceId, kind: r.kind, sentOn: null, text: r.text }));
    }),
  };

  // ---------------- photos (demo): bytes in IndexedDB (a teacher's own file) or an SVG illustration (seed rows) ----------------
  const demoPhotos = opts.photos || createDemoPhotos();
  const raw = fn => async (...args) => { try { return await fn(...args); } catch (e) { throw toApiError(e); } }; // no structured clone: Blobs pass through
  const photos = {
    ...surface.photos,
    /** register({observationId, soloConfirmed:true}) → {photo, path, upload:null} */
    register: cmd('photos.register'),
    /** upload(blob, grant) — demo: keep the prepared blob in IndexedDB under the photo id (grant = register's result, plus width/height of the blob). */
    upload: raw(async (blob, grant = {}) => {
      me(); db();
      const id = grant.photo?.id;
      if (!id) throw new ApiError('VALIDATION', 'No upload grant');
      if (!(blob instanceof Blob)) throw new ApiError('VALIDATION', 'Nothing to upload');
      await demoPhotos.put(id, { blob, width: Number.isInteger(grant.width) ? grant.width : null, height: Number.isInteger(grant.height) ? grant.height : null });
    }),
    /** complete(photoId) → {photo}; a refused file is recorded as rejected and then reported, as the server does (422). */
    complete: raw(async photoId => {
      const p = me(); db();
      const rec = await demoPhotos.get(photoId);
      const objectInfo = rec ? { mime: rec.blob.type, bytes: rec.blob.size, width: rec.width, height: rec.height, hasExif: false, hasXmp: false } : { missing: true };
      const r = out(storage.commit(d => execute('photos.complete', d, [photoId], { ...ctxNow(p), objectInfo }, p)));
      if (r.failure) { await demoPhotos.remove(photoId); throw new ApiError(r.failure.code, r.failure.message); }
      return r;
    }),
    /** remove(photoId, reason?) → deleting, then (demo) the bytes are dropped and the row finishes as deleted. */
    remove: raw(async (photoId, reason) => {
      const r = await cmd('photos.remove')(photoId, reason);
      await demoPhotos.remove(photoId);
      const sys = systemPersona('demo');
      storage.commit(d => execute('photos.finishDelete', d, [{ photoIds: [photoId] }], systemCtx(), sys));
      return r;
    }),
    /** blob(photoId) → Blob of a ready photo this persona may see. Show it with URL.createObjectURL only. */
    blob: raw(async photoId => {
      const p = me(); const d = db();
      const ph = (d.photos || []).find(x => x.id === photoId);
      if (!ph) throw new ApiError('NOT_FOUND', 'Photo not found');
      const o = (d.observations || []).find(x => x.id === ph.observationId);
      if (!learnerVisible(p, ph.studentId) || (p.role === 'parent' && !(o && o.sharedAt))) throw new ApiError('NOT_ALLOWED', 'Not visible to you');
      if (ph.status !== 'ready') throw new ApiError('NOT_FOUND', 'Photo not available');
      if (!photoConsentFor(d, ph.studentId)) throw new ApiError('NOT_ALLOWED', 'Photo consent does not hold for this child');
      if (ph.demo && ph.demo.illustration) {
        const svg = (await import('../seed/illustrations.js')).illustrationSvg(ph.demo.illustration);
        if (svg) return new Blob([svg], { type: 'image/svg+xml' });
      }
      const rec = await demoPhotos.get(photoId);
      if (!rec) throw new ApiError('NOT_FOUND', 'This photo is not stored in this browser (demo photos live in the browser that took them)');
      return rec.blob;
    }),
    /** Where the demo keeps photo bytes, for Settings. */
    storageInfo: raw(() => demoPhotos.info()),
  };

  // ---------------- admin ----------------
  const broken = () => !storage || storage.status !== 'ok';
  const systemCtx = () => { const now = clock(); return { actor: { role: 'system', id: 'system' }, now: nowISO(now), today: todayISO(now) }; };
  const adminCtx = () => {
    if (broken()) return systemCtx();
    const p = session.current();
    if (!p || p.role !== 'admin') throw new ApiError('NOT_ALLOWED', 'Only the principal can do this');
    return ctxNow(p);
  };
  const admin = {
    resetToSeed: op(async () => {
      await ensureStorage();
      const ctx = adminCtx();
      storage.resetToSeed(ctx);
      try { await demoPhotos.clear(); } catch { /* the seed's photos are drawn, not stored; nothing else to clear */ }
      readyPromise = Promise.resolve();
    }),
    exportJson: op(() => {
      if (!storage) throw new ApiError('STORAGE_CORRUPT', 'Data is not loaded');
      allowP(me(), 'admin');
      return storage.exportJson();
    }),
    importJson: op(async text => {
      await ensureStorage();
      const ctx = adminCtx();
      const r = storage.importJson(text, ctx);
      readyPromise = Promise.resolve();
      return r;
    }),
    storageInfo: op(() => (storage ? storage.info() : { bytesUsed: 0, approxQuotaBytes: 0, status: 'empty', unsaved: false, writeFailed: false, persistent: opts.persistent ?? true, persistenceNote: opts.persistenceNote ?? null, corruptKey: null, lastError: null, rev: null })),
    validate: op(() => { me(); return validateDb(db()); }),
    inviteCode: op(() => { throw realAppOnly('Invite codes'); }),
    invites: op(() => { allowP(me(), 'admin', 'accountant'); return []; }),
    revokeUser: op(() => { throw realAppOnly('Revoking a sign-in'); }),
    /** The guardian's own data as JSON (DPDP access request). */
    dataExport: op(guardianId => {
      const p = allowP(me(), 'admin', 'parent');
      if (p.role === 'parent' && guardianId !== p.guardianId) throw new ApiError('NOT_ALLOWED', 'You can download only your own data');
      return JSON.stringify(guardianExport(db(), guardianId, { full: p.role === 'admin', photoOk: sid => photoConsentFor(db(), sid) }), null, 2);
    }),
    erasureRequests: op(() => { allowP(me(), 'admin'); return []; }),
    revokeInvite: op(() => { throw realAppOnly('Invite codes'); }),
    users: op(() => { allowP(me(), 'admin'); return []; }),
    anonymiseGuardian: op(() => { throw realAppOnly('Erasing a guardian'); }),
    setStaffRole: op(() => { throw realAppOnly('Changing a staff role'); }),
    /** setRetention({photosMonthsAfterLeaving, diaryMonthsAfterLeaving, …}) — whole months, or null = not decided. */
    setRetention: cmd('admin.setRetention'),
    /** What retention would remove today: {asOf, leftWithoutDate:[studentId], categories:{photos:{months, students, due}, …}}. */
    retentionPreview: op(() => {
      allowP(me(), 'admin');
      const plan = retentionPlan(db(), today());
      return { asOf: plan.asOf, leftWithoutDate: plan.leftWithoutDate, categories: Object.fromEntries(Object.entries(plan.categories).map(([k, c]) => [k, { months: c.months, students: c.students.length, due: c.due }])) };
    }),
  };

  return {
    mode: 'demo',
    ready() {
      if (!readyPromise) {
        readyPromise = (async () => {
          await ensureStorage();
          const r = storage.load();
          if (r.status === 'corrupt' || r.status === 'unsupportedVersion') {
            throw new ApiError('STORAGE_CORRUPT', r.error, { corruptKey: r.corruptKey, status: r.status });
          }
        })();
        readyPromise.catch(() => {});
      }
      return readyPromise;
    },
    /** fn(db, info) after every commit and cross-tab change; info.status !== 'ok' (db null) → show recovery. */
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    getDb() { return storage ? storage.db : null; },
    /** Real app: refetch the server snapshot. Demo: nothing to fetch. */
    refresh: op(() => undefined),
    session, people, notices, threads, calendar, transport, fees, attendance, diary, audit, admin,
    curriculum, observations, progress, reports, photos,
    auth, consent, push, import: imports, reminders,
    /** test hook */
    _storage: () => storage,
  };
}

/**
 * Choose the browser store. Probes by READING only, so a full store (writes refused) is still used and
 * its data still loads. If the store cannot be accessed at all, falls back to memory and says why.
 * @returns {{backend, persistent:boolean, reason:string|null}}
 */
export function pickBackend(win, name) {
  if (!win) return { backend: memoryBackend(), persistent: false, reason: 'no browser window' };
  try {
    const s = win[name];
    if (!s) return { backend: memoryBackend(), persistent: false, reason: `${name} is not available in this browser` };
    s.getItem('__montessori_probe__');
    return { backend: s, persistent: true, reason: null };
  } catch (e) {
    return { backend: memoryBackend(), persistent: false, reason: `${name} is blocked (${e.name || 'Error'}: ${e.message}); changes will be lost on reload` };
  }
}

function createDemoApi() {
  const hasWindow = typeof window !== 'undefined'; // Node (tests) never touches Node's experimental Web Storage
  const local = hasWindow ? pickBackend(window, 'localStorage') : { backend: memoryBackend(), persistent: false, reason: 'not running in a browser' };
  const sess = hasWindow ? pickBackend(window, 'sessionStorage') : { backend: memoryBackend() };
  return createApi({
    backend: local.backend,
    sessionBackend: sess.backend,
    persistent: local.persistent,
    persistenceNote: local.reason,
    eventTarget: hasWindow ? window : null,
  });
}

// Mode is bound to the entry HTML: only app/index.html defines __APP_CONFIG__ (before this module loads).
// The demo never loads remote.js or supabase-js; the real app never loads the seed.
const APP_CONFIG = globalThis.__APP_CONFIG__;
export const api = APP_CONFIG
  ? await (await import('./remote.js')).createRemoteApi(APP_CONFIG, { createSurface, ApiError, toApiError, op })
  : createDemoApi();
