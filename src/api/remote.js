// Real-app (Supabase) mode of the api: identical signatures and ApiError codes to the demo (index.js).
//   reads   the persona-scoped surface from index.js over the RLS-built snapshot (public.my_snapshot)
//   writes  every registry command through the `command` Edge Function, then a snapshot refetch
//   live    realtime postgres_changes (trip feed + nudges), refetch on tab focus
// Loaded only when app/index.html defined window.__APP_CONFIG__; the demo never loads this file.
// It receives createSurface/ApiError from index.js as arguments (no import back: index.js awaits this module).

import { todayISO, nowISO } from '../domain/dates.js';
import * as T from '../domain/transport.js';
import { tripOut, consentStatus, allow, mustRoute, STAFF_SEES_ALL } from '../domain/commands.js';
import { makeClient, functionCaller } from './supabase/client.js';
import { fetchSnapshot } from './supabase/snapshot.js';
import { subscribeNudges, subscribeTripFeed } from './supabase/realtime.js';

export async function createRemoteApi(config, { createSurface, ApiError, toApiError, op }) {
  const sb = await makeClient(config);
  const call = functionCaller(sb, config, ApiError);
  const clock = () => new Date();
  const listeners = new Set();
  let snap = { status: 'signedOut', db: null, persona: null, me: null };
  let email = null;
  let readyPromise = null;
  let stopNudges = null;

  const info = () => ({
    status: snap.db ? 'ok' : 'missing', mode: 'supabase', authState: snap.status, unsaved: false, writeFailed: false,
    persistent: true, persistenceNote: null, corruptKey: null, lastError: null, rev: snap.db ? snap.db.rev : null,
    bytesUsed: 0, approxQuotaBytes: 0,
  });
  const emit = () => { const i = info(); for (const fn of listeners) { try { fn(snap.db, i); } catch (e) { console.error(e); } } };

  async function refresh() {
    const { data } = await sb.auth.getSession();
    const session = data && data.session;
    email = session && session.user ? session.user.email : null;
    if (!session) { snap = { status: 'signedOut', db: null, persona: null, me: null }; emit(); return snap; }
    snap = await fetchSnapshot(sb, ApiError);
    if (snap.status === 'active' && !stopNudges) stopNudges = subscribeNudges(sb, () => refresh().catch(e => console.error(e)));
    emit();
    return snap;
  }

  function db() {
    if (!snap.db) throw new ApiError('NOT_ALLOWED', snap.status === 'signedOut' ? 'Please sign in' : `Your access is ${snap.status}`);
    return snap.db;
  }
  function me() {
    if (!snap.persona) throw new ApiError('NOT_ALLOWED', snap.status === 'signedOut' ? 'Please sign in' : 'This sign-in is not linked to the school yet');
    return snap.persona;
  }
  const command = async (name, args, { reload = true } = {}) => {
    const r = await call('command', { name, args });
    if (reload) await refresh();
    return r.result;
  };
  const cmd = name => op((...args) => command(name, args));
  const read = name => op((...args) => command(name, args, { reload: false }));

  const surface = createSurface({ db, me, clock, cmd });
  const { people, notices, threads, calendar, transport, fees, attendance, diary, audit, importHelpers } = surface;

  // ---------------- transport: positions come from trip_positions, never from the snapshot ----------------
  const tripOfRoute = (d, routeId) => T.activeTripFor(d, routeId)
    || d.trips.filter(t => t.routeId === routeId && t.date === todayISO(clock())).sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))[0] || null;
  async function positionsTail(tripId, n = 50) {
    const { data, error } = await sb.from('trip_positions').select('lat,lng,accuracy,ts').eq('trip_id', tripId).order('ts', { ascending: false }).limit(n);
    if (error) throw new ApiError('OFFLINE', `Could not load bus positions (${error.message})`);
    return (data || []).reverse().map(r => ({ lat: r.lat, lng: r.lng, accuracy: r.accuracy, ts: new Date(r.ts).toISOString() }));
  }
  transport.parentView = op(async studentId => {
    const p = me(); const d = db();
    if (!STAFF_SEES_ALL.includes(p.role) && !p.studentIds.includes(studentId)) throw new ApiError('NOT_ALLOWED', 'Not your student');
    const s = d.students.find(x => x.id === studentId);
    if (!s) throw new ApiError('NOT_FOUND', 'Student not found');
    const trip = s.routeId ? tripOfRoute(d, s.routeId) : null;
    const positions = trip ? await positionsTail(trip.id) : [];
    const d2 = trip ? { ...d, trips: d.trips.map(t => (t.id === trip.id ? { ...t, positions } : t)) } : d;
    const now = clock();
    return T.parentView(d2, studentId, nowISO(now), todayISO(now));
  });
  transport.activeTrip = op(async routeId => {
    const p = me(); const d = db();
    mustRoute(p, d, routeId);
    const t = T.activeTripFor(d, routeId);
    if (!t) return null;
    return { ...tripOut(d, t, p), positions: await positionsTail(t.id) };
  });
  transport.subscribeTrip = (routeId, fn) => {
    const p = me(); const d = db();
    mustRoute(p, d, routeId);
    return subscribeTripFeed(sb, routeId, () => tripOfRoute(db(), routeId)?.id ?? null, doc => tripOut(db(), { positions: [], stopEvents: [], childEvents: [], ...doc }, me()), fn);
  };

  // ---------------- fees: gateway (Razorpay) and settlements ----------------
  Object.assign(fees, {
    createGatewayOrder: op(args => call('pay-create-order', args || {})),
    verifyGatewayPayment: op(async args => { const pay = await call('pay-verify', args || {}); await refresh(); return pay; }),
    gatewayOrderStatus: op(async orderId => { const r = await call('pay-status', { orderId }); if (r.payment) await refresh(); return r; }),
    importSettlementCsv: cmd('fees.importSettlementCsv'),
    settlementReport: read('fees.settlementReport'),
  });

  // ---------------- auth ----------------
  const auth = {
    status: op(async () => {
      if (!readyPromise) await api.ready();
      if (snap.status === 'signedOut') return { state: 'signedOut', email: null };
      return { state: snap.status, email };
    }),
    signInWithOtp: op(async address => {
      const e = String(address || '').trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new ApiError('VALIDATION', 'Enter a valid email address');
      const { error } = await sb.auth.signInWithOtp({ email: e, options: { shouldCreateUser: true } });
      if (error) throw new ApiError(error.status === 429 ? 'RATE_LIMITED' : 'VALIDATION', error.status === 429 ? 'Too many codes requested; wait a minute and try again' : error.message);
    }),
    verifyOtp: op(async (address, code) => {
      const { error } = await sb.auth.verifyOtp({ email: String(address || '').trim().toLowerCase(), token: String(code || '').trim(), type: 'email' });
      if (error) throw new ApiError('VALIDATION', 'That code is not right or has expired; request a new one');
      await refresh();
      return snap.status === 'signedOut' ? { state: 'signedOut', email: null } : { state: snap.status, email };
    }),
    signOut: op(async () => {
      if (stopNudges) { stopNudges(); stopNudges = null; }
      await sb.auth.signOut();
      snap = { status: 'signedOut', db: null, persona: null, me: null };
      emit();
    }),
    redeemInvite: op(async (code, childDob) => {
      const r = await call('command', { name: 'auth.redeemInvite', args: [code, childDob] });
      await refresh();
      return { guardianId: r.result.guardianId, children: r.result.children };
    }),
  };

  // ---------------- consent (DPDP) ----------------
  const consent = {
    status: op(() => consentStatus(db(), me())),
    give: cmd('consent.give'),
    withdraw: cmd('consent.withdraw'),
  };

  // ---------------- push subscriptions (the one direct table write; RLS: own rows) ----------------
  const push = {
    vapidPublicKey: op(() => config.vapidPublicKey || null),
    subscribe: op(async sub => {
      const p = me();
      const s = typeof sub === 'string' ? JSON.parse(sub) : sub;
      if (!s || !s.endpoint || !s.keys || !s.keys.p256dh || !s.keys.auth) throw new ApiError('VALIDATION', 'Not a push subscription');
      await sb.from('push_subscriptions').delete().eq('endpoint', s.endpoint);
      const { error } = await sb.from('push_subscriptions').insert({ endpoint: s.endpoint, p256dh: s.keys.p256dh, auth: s.keys.auth });
      if (error) throw new ApiError(error.code === '23505' ? 'VALIDATION' : 'OFFLINE', error.code === '23505' ? 'This device already receives notifications for another sign-in' : `Could not save the subscription (${error.message})`);
      return { endpoint: s.endpoint, role: p.role };
    }),
    unsubscribe: op(async endpoint => {
      const { error } = await sb.from('push_subscriptions').delete().eq('endpoint', endpoint);
      if (error) throw new ApiError('OFFLINE', `Could not remove the subscription (${error.message})`);
    }),
    list: op(async () => {
      me();
      const { data, error } = await sb.from('push_subscriptions').select('endpoint,created_at,failures').order('created_at');
      if (error) throw new ApiError('OFFLINE', error.message);
      return (data || []).map(r => ({ endpoint: r.endpoint, createdAt: r.created_at, failures: r.failures }));
    }),
  };

  // ---------------- data import ----------------
  const imports = {
    ...importHelpers,
    stage: cmd('import.stage'),
    preview: read('import.preview'),
    commit: cmd('import.commit'),
    batches: op(async () => {
      allow(me(), 'admin', 'accountant');
      const { data, error } = await sb.from('import_batches').select('doc');
      if (error) throw new ApiError('OFFLINE', error.message);
      return (data || []).map(r => r.doc).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .map(b => ({ id: b.id, kind: b.kind, status: b.status, inputRows: b.inputRows, createdAt: b.createdAt, createdBy: b.createdBy, result: b.result }));
    }),
  };

  // ---------------- reminders (written by cron-daily into reminders_sent; RLS-scoped in the snapshot) ----------------
  const reminders = {
    list: op(() => { allow(me(), 'admin', 'accountant', 'parent'); return (db().remindersSent || []).map(r => ({ invoiceId: r.invoiceId, kind: r.kind, sentOn: r.sentOn, text: r.text })); }),
  };

  // ---------------- admin ----------------
  const demoOnly = what => op(() => { throw new ApiError('NOT_ALLOWED', `${what} exists only in the demo; the real app's data lives on the server`); });
  const admin = {
    inviteCode: cmd('admin.inviteCode'),
    invites: read('admin.invites'),
    revokeInvite: cmd('admin.revokeInvite'),
    users: read('admin.users'),
    revokeUser: cmd('admin.revokeUser'),
    dataExport: read('admin.dataExport'),
    erasureRequests: read('admin.erasureRequests'),
    anonymiseGuardian: cmd('people.anonymiseGuardian'),
    setStaffRole: cmd('people.setStaffRole'),
    storageInfo: op(() => info()),
    validate: op(() => { throw new ApiError('NOT_ALLOWED', 'Integrity is enforced by the server (constraints, revision checks) in the real app'); }),
    resetToSeed: demoOnly('Reset to demo data'),
    exportJson: demoOnly('Export of the whole database'),
    importJson: demoOnly('Import of a whole database'),
  };

  // ---------------- session: the signed-in user only ----------------
  const session = {
    personas() { return snap.persona ? [structuredClone(snap.persona)] : []; },
    current() { return snap.persona ? structuredClone(snap.persona) : null; },
    set() { throw new ApiError('NOT_ALLOWED', 'In the real app you are the person you signed in as'); },
    clear() { auth.signOut().catch(e => console.error(e)); },
  };

  const onFocus = () => { if (document.visibilityState === 'visible' && snap.status === 'active') refresh().catch(e => console.error(toApiError(e))); };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onFocus);
  sb.auth.onAuthStateChange(event => {
    if (event === 'SIGNED_OUT') { snap = { status: 'signedOut', db: null, persona: null, me: null }; emit(); }
  });

  const api = {
    mode: 'supabase',
    ready() {
      if (!readyPromise) {
        readyPromise = refresh().then(() => undefined);
        readyPromise.catch(() => { readyPromise = null; });
      }
      return readyPromise;
    },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    getDb() { return snap.db; },
    /** Refetch the snapshot now (after a payment window closes, etc.). */
    refresh: op(() => refresh().then(() => undefined)),
    session, people, notices, threads, calendar, transport, fees, attendance, diary, audit, admin,
    auth, consent, push, import: imports, reminders,
    _supabase: sb,
  };
  return api;
}
