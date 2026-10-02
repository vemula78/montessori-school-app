// The only data module screens import. Async facade over the pure domain + storage adapter.
// Read scoping (what each persona may see) lives here; on a backend it moves server-side and
// this file becomes HTTP-call wrappers with the same signatures. Results are structured clones,
// so screens can never mutate stored state by accident.

import { Storage, DB_KEY, memoryBackend } from '../store/storage.js';
import { todayISO, nowISO } from '../domain/dates.js';
import { byId, fullName, activeStudents, childrenOf, sortByName } from '../domain/people.js';
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
const ROLE_LABEL = { admin: 'Principal', teacher: 'Teacher', accountant: 'Accountant', driver: 'Driver', parent: 'Parent' };
const STAFF_SEES_ALL = ['admin', 'accountant'];

function toApiError(e) {
  if (e instanceof ApiError) return e;
  if (e && typeof e.code === 'string') return new ApiError(e.code, e.message, e.details);
  return e; // a programming error: surface it unchanged
}
const out = x => (x === undefined ? undefined : structuredClone(x));

/** Personas are derived from the data: one per staff member and one per guardian. */
export function buildPersonas(db) {
  const allPrograms = db.programs.map(p => p.id);
  const allStudents = activeStudents(db).map(s => s.id);
  const progName = id => byId(db.programs, id)?.name ?? id;
  const list = [];
  for (const s of db.staff) {
    const base = { id: `persona-${s.id}`, role: s.role, staffId: s.id, label: `${ROLE_LABEL[s.role] || s.role} — ${fullName(s)}` };
    if (s.role === 'admin' || s.role === 'accountant') list.push({ ...base, studentIds: allStudents, programIds: allPrograms });
    else if (s.role === 'teacher') {
      const programIds = [...(s.programIds || [])];
      list.push({ ...base, label: `${base.label} (${programIds.map(progName).join(', ')})`, programIds, studentIds: activeStudents(db).filter(x => programIds.includes(x.programId)).map(x => x.id) });
    } else if (s.role === 'driver') {
      const routeIds = db.routes.filter(r => r.driverId === s.id || r.attendantId === s.id).map(r => r.id);
      list.push({ ...base, routeIds, programIds: [], studentIds: activeStudents(db).filter(x => routeIds.includes(x.routeId)).map(x => x.id) });
    }
  }
  for (const g of db.guardians) {
    // Withdrawn children stay visible to their guardian (read-only): fees, receipts, diary history.
    const kids = childrenOf(db, g.id);
    list.push({
      id: `persona-${g.id}`, role: 'parent', guardianId: g.id,
      label: `Parent — ${fullName(g)} (${kids.map(k => (k.status === 'active' ? k.firstName : `${k.firstName}, left`)).join('; ') || 'no children'})`,
      studentIds: kids.map(k => k.id), activeStudentIds: kids.filter(k => k.status === 'active').map(k => k.id),
      programIds: [...new Set(kids.map(k => k.programId))],
    });
  }
  const order = { admin: 0, teacher: 1, accountant: 2, driver: 3, parent: 4 };
  return list.sort((a, b) => order[a.role] - order[b.role] || a.label.localeCompare(b.label));
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

  // ---------------- session ----------------
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
  function allow(...roles) {
    const p = me();
    if (!roles.includes(p.role)) throw new ApiError('NOT_ALLOWED', `Not available to ${ROLE_LABEL[p.role] || p.role}`);
    return p;
  }
  const ctxFor = p => {
    const now = clock();
    return { actor: { role: p.role, id: p.staffId || p.guardianId }, now: nowISO(now), today: todayISO(now) };
  };
  const today = () => todayISO(clock());
  const sees = (p, studentId) => STAFF_SEES_ALL.includes(p.role) || p.studentIds.includes(studentId);
  function mustSee(p, studentId) {
    if (!byId(db().students, studentId)) throw new ApiError('NOT_FOUND', 'Student not found');
    if (!sees(p, studentId)) throw new ApiError('NOT_ALLOWED', 'Not your student');
  }
  /** Run a domain command inside commit with the current persona's ctx. */
  const write = (p, fn) => storage.commit(draft => fn(draft, ctxFor(p)));

  /** Wrap: async, coded errors → ApiError, results cloned. */
  const op = fn => async (...args) => {
    try { return out(await fn(...args)); } catch (e) { throw toApiError(e); }
  };

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

  // ---------------- people ----------------
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
  };

  // ---------------- notices ----------------
  const withStats = (d, n) => ({ ...n, ...M.noticeStats(d, n.id) });
  const byNewest = (a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0);
  function canManageNotice(p, d, noticeId) {
    const n = byId(d.notices, noticeId);
    if (!n) throw new ApiError('NOT_FOUND', 'Notice not found');
    if (p.role === 'admin') return n;
    if (p.role === 'teacher') {
      const ps = M.audiencePrograms(d, n.audience);
      if (n.createdBy === p.staffId || ps.length === 0 || ps.some(x => p.programIds.includes(x))) return n;
    }
    throw new ApiError('NOT_ALLOWED', 'Not your notice');
  }
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
    send: op(input => {
      const p = allow('admin', 'teacher');
      if (p.role === 'teacher') {
        const a = input && input.audience;
        if (!a || a.scope === 'school') throw new ApiError('NOT_ALLOWED', 'Teachers can message their own programs only');
        const ps = M.audiencePrograms(db(), a);
        if (!ps.length || ps.some(x => !p.programIds.includes(x))) throw new ApiError('NOT_ALLOWED', 'Teachers can message their own programs only');
      }
      return write(p, (d, ctx) => M.sendNotice(d, input, ctx));
    }),
    recipients: op(noticeId => {
      const p = allow('admin', 'teacher'); const d = db();
      canManageNotice(p, d, noticeId);
      let rows = M.noticeRecipients(d, noticeId);
      if (p.role === 'teacher') {
        rows = rows.map(r => ({ ...r, studentIds: r.studentIds.filter(id => p.studentIds.includes(id)) })).filter(r => r.studentIds.length > 0);
      }
      return rows.map(r => ({ ...r, studentNames: r.studentIds.map(id => fullName(byId(d.students, id))) }));
    }),
    markRead: op(noticeId => { const p = allow('parent'); return write(p, (d, ctx) => M.markNoticeRead(d, noticeId, p.guardianId, ctx)); }),
    acknowledge: op(noticeId => { const p = allow('parent'); return write(p, (d, ctx) => M.acknowledgeNotice(d, noticeId, p.guardianId, ctx)); }),
  };

  // ---------------- threads ----------------
  function visibleThread(p, d, id) {
    const t = byId(d.threads, id);
    if (!t) throw new ApiError('NOT_FOUND', 'Conversation not found');
    const ok = p.role === 'admin' || (p.role === 'teacher' && p.programIds.includes(t.programId)) || (p.role === 'parent' && t.guardianId === p.guardianId);
    if (!ok) throw new ApiError('NOT_ALLOWED', 'Not your conversation');
    return t;
  }
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
    open: op(({ guardianId, studentId, subject, body } = {}) => {
      const p = allow('admin', 'teacher', 'parent');
      const gid = p.role === 'parent' ? (guardianId || p.guardianId) : guardianId;
      if (p.role === 'parent' && gid !== p.guardianId) throw new ApiError('NOT_ALLOWED', 'You can only write as yourself');
      mustSee(p, studentId);
      if (byId(db().students, studentId).status !== 'active') throw new ApiError('VALIDATION', 'This child has left the school; their records are read-only');
      const r = write(p, (d, ctx) => M.openThread(d, { guardianId: gid, studentId, subject, body }, ctx));
      const view = M.threadView(db(), byId(db().threads, r.thread.id), p.role);
      return { ...view, thread: view, messages: r.messages };
    }),
    reply: op((id, body) => { const p = allow('admin', 'teacher', 'parent'); visibleThread(p, db(), id); return write(p, (d, ctx) => M.replyThread(d, id, body, ctx)); }),
    markRead: op(id => { const p = allow('admin', 'teacher', 'parent'); visibleThread(p, db(), id); return write(p, (d, ctx) => M.markThreadRead(d, id, ctx)); }),
    close: op(id => { const p = allow('admin', 'teacher', 'parent'); visibleThread(p, db(), id); return write(p, (d, ctx) => M.closeThread(d, id, ctx)); }),
  };

  // ---------------- calendar ----------------
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
    create: op(ev => { const p = allow('admin'); return write(p, (d, ctx) => C.createEvent(d, ev, ctx)); }),
    update: op((id, patch) => { const p = allow('admin'); return write(p, (d, ctx) => C.updateEvent(d, id, patch, ctx)); }),
    remove: op(id => { const p = allow('admin'); return write(p, (d, ctx) => C.removeEvent(d, id, ctx)); }),
    previewHolidayCsv: op((text, academicYearId) => { allow('admin'); return H.previewHolidayCsv(db(), text, academicYearId); }),
    importHolidays: op((preview, { includeOutsideYear = false } = {}) => {
      const p = allow('admin');
      return write(p, (d, ctx) => H.importHolidays(d, preview, { includeOutsideYear }, ctx));
    }),
    isWorkingDay: op((dateISO, programId) => { me(); return C.isWorkingDay(db(), dateISO, programId); }),
  };

  // ---------------- transport ----------------
  const visibleRoutes = (p, d) => {
    if (['admin', 'accountant', 'teacher'].includes(p.role)) return d.routes;
    if (p.role === 'driver') return d.routes.filter(r => (p.routeIds || []).includes(r.id));
    const ids = new Set(d.students.filter(s => p.studentIds.includes(s.id)).map(s => s.routeId).filter(Boolean));
    return d.routes.filter(r => ids.has(r.id));
  };
  function mustRoute(p, d, routeId) {
    const r = byId(d.routes, routeId);
    if (!r) throw new ApiError('NOT_FOUND', 'Route not found');
    if (!visibleRoutes(p, d).some(x => x.id === routeId)) throw new ApiError('NOT_ALLOWED', 'Not your route');
    return r;
  }
  function driverTrip(p, d, tripId) {
    const t = byId(d.trips, tripId);
    if (!t) throw new ApiError('NOT_FOUND', 'Trip not found');
    if (p.role === 'driver' && !(p.routeIds || []).includes(t.routeId)) throw new ApiError('NOT_ALLOWED', 'Not your route');
    return t;
  }
  /** Trip as a persona may see it: parents/teachers only get their own children's events and stops. */
  const tripOut = (t, p) => {
    const c = { ...t };
    delete c.tracker;
    if (p && (p.role === 'parent' || p.role === 'teacher')) {
      const kids = db().students.filter(s => p.studentIds.includes(s.id) && s.routeId === t.routeId);
      const stopIds = new Set(kids.map(s => s.stopId));
      const kidIds = new Set(kids.map(s => s.id));
      c.childEvents = t.childEvents.filter(e => kidIds.has(e.studentId));
      c.stopEvents = t.stopEvents.filter(e => stopIds.has(e.stopId));
    }
    return c;
  };
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
    startTrip: op(({ routeId, direction, simulated } = {}) => {
      const p = allow('admin', 'driver'); mustRoute(p, db(), routeId);
      return tripOut(write(p, (d, ctx) => T.startTrip(d, { routeId, direction, simulated }, ctx)));
    }),
    endTrip: op(tripId => { const p = allow('admin', 'driver'); driverTrip(p, db(), tripId); return tripOut(write(p, (d, ctx) => T.endTrip(d, tripId, ctx))); }),
    recordPosition: op((tripId, fix) => {
      const p = allow('admin', 'driver'); driverTrip(p, db(), tripId);
      const r = write(p, d => T.recordPosition(d, tripId, fix || {}));
      return { trip: tripOut(r.trip), newEvents: r.newEvents, rejected: r.rejected ?? null }; // rejected: why a fix was refused (duplicate/out-of-order)
    }),
    markChild: op((tripId, ev) => { const p = allow('admin', 'driver'); driverTrip(p, db(), tripId); return write(p, (d, ctx) => T.markChild(d, tripId, ev || {}, ctx)); }),
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

  // ---------------- fees ----------------
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
    saveStructure: op(s => { const p = fin(); return write(p, (d, ctx) => F.saveStructure(d, s, ctx)); }),
    generateInvoices: op(args => { const p = fin(); return write(p, (d, ctx) => F.generateInvoices(d, args, ctx)); }),
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
    addConcession: op((invoiceId, c) => { const p = fin(); return write(p, (d, ctx) => F.addConcession(d, invoiceId, c || {}, ctx)); }),
    removeConcession: op((invoiceId, concessionId, reason) => { const p = fin(); return write(p, (d, ctx) => F.removeConcession(d, invoiceId, concessionId, reason, ctx)); }),
    lateFeeDue: op((invoiceId, asOfDate) => {
      const p = allow('admin', 'accountant', 'parent'); const d = db();
      return F.lateFeeDue(d, seeInvoice(p, d, invoiceId), asOfDate || today());
    }),
    applyLateFee: op((invoiceId, asOfDate) => { const p = fin(); return write(p, (d, ctx) => F.applyLateFee(d, invoiceId, asOfDate || ctx.today, ctx)); }),
    waiveLateFee: op((invoiceId, reason) => { const p = fin(); return write(p, (d, ctx) => F.waiveLateFee(d, invoiceId, reason, ctx)); }),
    cancelInvoice: op((id, reason) => { const p = fin(); return write(p, (d, ctx) => F.cancelInvoice(d, id, reason, ctx)); }),
    recordPayment: op(args => { const p = fin(); return write(p, (d, ctx) => F.recordPayment(d, args || {}, ctx)); }),
    cancelPayment: op((id, reason) => { const p = fin(); return write(p, (d, ctx) => F.cancelPayment(d, id, reason, ctx)); }),
    /**
     * refund({paymentId, invoiceId, amountPaise, mode, reference, date, reason}) — money back against an invoice allocation.
     * refund({creditId, amountPaise, mode, reference, date, reason}) — return unallocated credit (advance) held on account.
     * refund({paymentId, invoiceId: null, amountPaise, …}) — same, from that payment's unconsumed credit.
     * date must be on/after the payment date and not in the future.
     */
    refund: op(args => { const p = fin(); return write(p, (d, ctx) => F.refund(d, args || {}, ctx)); }),
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
    mockOnlinePayment: op(({ studentId, invoiceIds } = {}) => {
      const p = allow('admin', 'accountant', 'parent'); mustSee(p, studentId);
      return write(p, (d, ctx) => F.mockOnlinePayment(d, { studentId, invoiceIds, guardianId: p.role === 'parent' ? p.guardianId : null }, ctx));
    }),
  };

  // ---------------- attendance ----------------
  function teachesProgram(p, programId) {
    if (p.role === 'admin') return;
    if (p.role === 'teacher' && p.programIds.includes(programId)) return;
    throw new ApiError('NOT_ALLOWED', 'Not your program');
  }
  const attendance = {
    forDate: op((date, programId) => { const p = allow('admin', 'teacher'); teachesProgram(p, programId); return A.attendanceForDate(db(), date, programId); }),
    mark: op((date, entries) => {
      const p = allow('admin', 'teacher');
      for (const e of entries || []) mustSee(p, e.studentId);
      return write(p, (d, ctx) => A.markAttendance(d, date, entries, ctx));
    }),
    summary: op((studentId, from, to) => { const p = allow('admin', 'teacher', 'parent'); mustSee(p, studentId); return A.attendanceSummary(db(), studentId, from, to); }),
  };

  // ---------------- diary ----------------
  const diary = {
    forStudentDate: op((studentId, date) => { const p = allow('admin', 'teacher', 'parent'); mustSee(p, studentId); return D.diaryForStudentDate(db(), studentId, date); }),
    forProgramDate: op((programId, date) => { const p = allow('admin', 'teacher'); teachesProgram(p, programId); return D.diaryForProgramDate(db(), programId, date); }),
    add: op(entry => { const p = allow('admin', 'teacher'); mustSee(p, entry && entry.studentId); return write(p, (d, ctx) => D.addDiaryEntry(d, entry, ctx)); }),
    markRead: op(entryId => {
      const p = allow('parent'); const e = byId(db().diaryEntries, entryId);
      if (!e) throw new ApiError('NOT_FOUND', 'Diary entry not found');
      mustSee(p, e.studentId);
      return write(p, (d, ctx) => D.markDiaryRead(d, entryId, ctx));
    }),
  };

  const audit = { list: op(q => { allow('admin', 'accountant'); return listAudit(db(), q || {}); }) };

  // ---------------- admin ----------------
  const broken = () => !storage || storage.status !== 'ok';
  const systemCtx = () => { const now = clock(); return { actor: { role: 'system', id: 'system' }, now: nowISO(now), today: todayISO(now) }; };
  const adminCtx = () => {
    if (broken()) return systemCtx();
    const p = session.current();
    if (!p || p.role !== 'admin') throw new ApiError('NOT_ALLOWED', 'Only the principal can do this');
    return ctxFor(p);
  };
  const admin = {
    resetToSeed: op(async () => {
      await ensureStorage();
      const ctx = adminCtx();
      storage.resetToSeed(ctx);
      readyPromise = Promise.resolve();
    }),
    exportJson: op(() => {
      if (!storage) throw new ApiError('STORAGE_CORRUPT', 'Data is not loaded');
      allow('admin');
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
  };

  return {
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
    session, people, notices, threads, calendar, transport, fees, attendance, diary, audit, admin,
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

const hasWindow = typeof window !== 'undefined'; // Node (tests) never touches Node's experimental Web Storage
const local = hasWindow ? pickBackend(window, 'localStorage') : { backend: memoryBackend(), persistent: false, reason: 'not running in a browser' };
const sess = hasWindow ? pickBackend(window, 'sessionStorage') : { backend: memoryBackend() };

export const api = createApi({
  backend: local.backend,
  sessionBackend: sess.backend,
  persistent: local.persistent,
  persistenceNote: local.reason,
  eventTarget: hasWindow ? window : null,
});
