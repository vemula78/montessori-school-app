// Real-app (Supabase) mode of the api: identical signatures and ApiError codes to the demo (index.js).
//   reads   the persona-scoped surface from index.js over the RLS-built snapshot (public.my_snapshot)
//   writes  every registry command through the `command` Edge Function, then a snapshot refetch
//   live    realtime postgres_changes (trip feed + nudges), refetch on tab focus
// Loaded only when app/index.html defined window.__APP_CONFIG__; the demo never loads this file.
// It receives createSurface/ApiError from index.js as arguments (no import back: index.js awaits this module).
// Business dates ("today") are the school's (IST) on every device: setBusinessZone below.
// Every write carries a request id; a retry of the same write (network failure) can never record it twice, and a
// write that was saved is never reported as failed because the refetch afterwards failed.
// A snapshot response is applied only if it is the newest and the signed-in user has not changed meanwhile.
// Photos: the upload goes to the one path the command function signed; a photo is viewed by asking the function for a
// 120-second signed path and fetching it here at once — the URL never leaves this file (only the Blob does).

import { todayISO, nowISO, addDays, setBusinessZone, IST_OFFSET_MIN } from '../domain/dates.js';
import * as T from '../domain/transport.js';
import { tripOut, consentStatus, allow, mustRoute, STAFF_SEES_ALL } from '../domain/commands.js';
import { makeClient, functionCaller } from './supabase/client.js';
import { fetchSnapshot } from './supabase/snapshot.js';
import { subscribeNudges, subscribeTripFeed } from './supabase/realtime.js';

/** deps.sb / deps.call: test doubles for the supabase client and the function caller (tests only). */
export async function createRemoteApi(config, { createSurface, ApiError, toApiError, op, sb: sbTest = null, call: callTest = null }) {
  setBusinessZone(IST_OFFSET_MIN);
  const sb = sbTest || await makeClient(config);
  const call = callTest || functionCaller(sb, config, ApiError);
  const clock = () => new Date();
  const listeners = new Set();
  const SIGNED_OUT = () => ({ status: 'signedOut', db: null, persona: null, me: null });
  let snap = SIGNED_OUT();
  let email = null;
  let readyPromise = null;
  let stopNudges = null;
  let gen = 0;        // bumped whenever the signed-in user changes: older snapshot responses are dropped
  let seq = 0, applied = 0; // refresh order: an older response never overwrites a newer one
  let shownUserId = null;   // whose data the snapshot holds
  const newRequestId = () => (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`);

  const info = () => ({
    status: snap.db ? 'ok' : 'missing', mode: 'supabase', authState: snap.status, unsaved: false, writeFailed: false,
    persistent: true, persistenceNote: null, corruptKey: null, lastError: null, rev: snap.db ? snap.db.rev : null,
    bytesUsed: 0, approxQuotaBytes: 0,
  });
  const emit = () => { const i = info(); for (const fn of listeners) { try { fn(snap.db, i); } catch (e) { console.error(e); } } };

  const sessionUser = async () => { const { data } = await sb.auth.getSession(); return data && data.session ? data.session.user : null; };
  async function refresh() {
    const myGen = gen, mySeq = ++seq;
    const user = await sessionUser();
    if (!user) {
      if (myGen === gen && mySeq > applied) { applied = mySeq; email = null; snap = SIGNED_OUT(); emit(); }
      return snap;
    }
    const next = await fetchSnapshot(sb, ApiError);
    // drop a response that started under another sign-in, or that a newer refresh has already overtaken
    const still = await sessionUser();
    if (myGen !== gen || !still || still.id !== user.id || mySeq < applied) return snap;
    applied = mySeq;
    email = user.email || null;
    shownUserId = user.id;
    snap = next;
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
    const body = { name, args, requestId: newRequestId() };
    let r;
    try { r = await call('command', body); } catch (e) {
      // no answer (offline/timeout): the server may or may not have saved it; the same request id makes the retry safe
      if (!e || e.code !== 'OFFLINE') throw e;
      r = await call('command', body);
    }
    if (reload) {
      try { await refresh(); } catch (e) { console.error('saved, but the refetch failed:', toApiError(e)); }
    }
    return r.result;
  };
  const cmd = name => op((...args) => command(name, args));
  const read = name => op((...args) => command(name, args, { reload: false }));

  const surface = createSurface({ db, me, clock, cmd });
  const { people, notices, threads, calendar, transport, fees, attendance, diary, audit, importHelpers, curriculum, observations, progress, reports } = surface;

  // ---------------- audit: read from audit_log (RLS: principal, accountant), never from the snapshot ----------------
  audit.list = op(async ({ entity, entityId, limit = 100 } = {}) => {
    allow(me(), 'admin', 'accountant');
    let q = sb.from('audit_log').select('doc').order('ts', { ascending: false }).limit(Math.max(1, Math.min(Number(limit) || 100, 1000)));
    if (entity) q = q.eq('entity', entity);
    if (entityId) q = q.eq('doc->>entityId', entityId);
    const { data, error } = await q;
    if (error) throw new ApiError('OFFLINE', `Could not load the audit log (${error.message})`);
    return (data || []).map(r => r.doc);
  });

  // ---------------- transport: positions come from trip_positions, never from the snapshot ----------------
  const tripOfRoute = (d, routeId) => T.activeTripFor(d, routeId)
    || d.trips.filter(t => t.routeId === routeId && t.date === todayISO(clock())).sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))[0] || null;
  /** The route's trips of yesterday and today as the server has them now (RLS-scoped), with their child events. */
  async function freshTrips(routeId) {
    const { data, error } = await sb.from('trips').select('doc').eq('route_id', routeId).gte('date', addDays(todayISO(clock()), -1));
    if (error) throw new ApiError('OFFLINE', `Could not load the bus status (${error.message})`);
    const ids = (data || []).map(r => r.doc.id);
    let evs = [];
    if (ids.length) {
      const r = await sb.from('trip_child_events').select('trip_id,seq,doc').in('trip_id', ids).order('seq');
      if (r.error) throw new ApiError('OFFLINE', `Could not load the bus status (${r.error.message})`);
      evs = r.data || [];
    }
    return (data || []).map(r => ({ ...r.doc, positions: [], childEvents: evs.filter(e => e.trip_id === r.doc.id).map(e => e.doc) }));
  }
  async function positionsTail(tripId, n = 50) {
    const { data, error } = await sb.from('trip_positions').select('lat,lng,accuracy,ts').eq('trip_id', tripId).order('ts', { ascending: false }).limit(n);
    if (error) throw new ApiError('OFFLINE', `Could not load bus positions (${error.message})`);
    return (data || []).reverse().map(r => ({ lat: r.lat, lng: r.lng, accuracy: r.accuracy, ts: new Date(r.ts).toISOString() }));
  }
  // re-reads the route's trips every call, so the bus screen's periodic reload notices a trip that started or
  // ended even when the live feed missed it
  transport.parentView = op(async studentId => {
    const p = me(); const d = db();
    if (!STAFF_SEES_ALL.includes(p.role) && !p.studentIds.includes(studentId)) throw new ApiError('NOT_ALLOWED', 'Not your student');
    const s = d.students.find(x => x.id === studentId);
    if (!s) throw new ApiError('NOT_FOUND', 'Student not found');
    if (s.routeId) {
      const fresh = await freshTrips(s.routeId);
      const ids = new Set(fresh.map(t => t.id));
      d.trips = [...d.trips.filter(t => !(t.routeId === s.routeId && (ids.has(t.id) || t.date >= addDays(todayISO(clock()), -1)))), ...fresh];
    }
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

  // ---------------- progress history: progress_events (RLS: staff of the child), the snapshot holds the latest only ----------------
  progress.history = op(async (studentId, presentationId) => {
    const p = allow(me(), 'admin', 'teacher');
    if (p.role !== 'admin' && !p.studentIds.includes(studentId)) throw new ApiError('NOT_ALLOWED', 'Not your student');
    const { data, error } = await sb.from('progress_events').select('doc').eq('student_id', studentId).eq('presentation_id', presentationId).order('seq', { ascending: true });
    if (error) throw new ApiError('OFFLINE', `Could not load the progress history (${error.message})`);
    return (data || []).map(r => r.doc);
  });

  // ---------------- photos: Storage through signed paths only ----------------
  const storageBase = `${String(config.supabaseUrl).replace(/\/+$/, '')}/storage/v1`;
  // Blobs are returned as they are (no structured clone); errors are still ApiErrors
  const raw = fn => async (...args) => { try { return await fn(...args); } catch (e) { throw toApiError(e); } };
  const photos = {
    ...surface.photos,
    /** register({observationId, soloConfirmed:true}) → {photo, path, upload:{bucket, path, token, signedPath, expiresAt}} — pass it to upload(). */
    register: cmd('photos.register'),
    /** upload(blob, grant) — the prepared JPEG to the grant's one path (retry with the same grant until it expires). */
    upload: raw(async (blob, grant) => {
      me();
      const g = grant && grant.upload;
      if (!g || !g.token || !g.path) throw new ApiError('VALIDATION', grant && grant.uploadError ? grant.uploadError : 'This photo has no upload permission; add it again');
      if (typeof Blob !== 'undefined' && !(blob instanceof Blob)) throw new ApiError('VALIDATION', 'Nothing to upload');
      if (blob.type !== 'image/jpeg') throw new ApiError('VALIDATION', 'Only a prepared JPEG can be uploaded');
      let r;
      try { r = await sb.storage.from(g.bucket).uploadToSignedUrl(g.path, g.token, blob, { contentType: 'image/jpeg' }); } catch {
        throw new ApiError('OFFLINE', 'Cannot reach the school server; try the upload again');
      }
      const err = r && r.error;
      if (!err) return { uploaded: true };
      const status = Number(err.statusCode || err.status || 0), text = String(err.message || err.error || '');
      if (status === 409 || /exists|duplicate/i.test(text)) return { uploaded: true, already: true }; // a retry after a lost answer
      if (status === 413 || /too large|exceeded/i.test(text)) throw new ApiError('VALIDATION', 'The photo is larger than 400 KiB');
      if (status === 415 || /mime/i.test(text)) throw new ApiError('VALIDATION', 'Only JPEG photos can be uploaded');
      if (status === 400 || status === 401 || status === 403) throw new ApiError('VALIDATION', 'The upload permission has expired; add the photo again');
      throw new ApiError('OFFLINE', 'The upload did not finish; try again');
    }),
    /**
     * consentStatus({programId} | {studentIds}) → {studentId: boolean}: may photos of these children be taken. Computed by
     * the server over every guardian's consents (staff never receive consent rows; audit C2).
     */
    consentStatus: read('photos.consentStatus'),
    /** consent(studentId) → boolean (one child; same server answer). */
    consent: op(async studentId => Boolean((await command('photos.consentStatus', [{ studentIds: [studentId] }], { reload: false }))[studentId])),
    /** complete(photoId) → {photo} once the server has checked the file (refused: VALIDATION, and the file is deleted). */
    complete: cmd('photos.complete'),
    remove: cmd('photos.remove'),
    /** blob(photoId) → Blob. Show it with URL.createObjectURL and revoke it when done; no URL is ever returned. */
    blob: raw(async photoId => {
      const r = await command('photos.viewUrl', [photoId], { reload: false });
      let res;
      try { res = await fetch(`${storageBase}${r.signedPath}`, { cache: 'no-store', referrerPolicy: 'no-referrer' }); } catch {
        throw new ApiError('OFFLINE', 'Cannot reach the school server to load the photo');
      }
      if (!res.ok) throw new ApiError(res.status === 400 || res.status === 404 ? 'NOT_FOUND' : 'OFFLINE', 'The photo could not be loaded');
      return res.blob();
    }),
  };

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
      gen++;
      shownUserId = null;
      if (stopNudges) { stopNudges(); stopNudges = null; }
      await sb.auth.signOut();
      snap = SIGNED_OUT();
      emit();
    }),
    redeemInvite: op(async (code, childDob) => {
      const r = await command('auth.redeemInvite', [code, childDob]);
      return { guardianId: r.guardianId, children: r.children };
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
      const data = [];
      for (let from = 0; ; from += 1000) { // the API answers at most 1000 rows per request: read every page
        const r = await sb.from('import_batches').select('doc').order('id').range(from, from + 999);
        if (r.error) throw new ApiError('OFFLINE', r.error.message);
        data.push(...(r.data || []));
        if ((r.data || []).length < 1000) break;
      }
      return data.map(r => r.doc).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
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
    setRetention: cmd('admin.setRetention'),
    /** {asOf, leftWithoutDate:[studentId], categories:{photos:{months, students, due}, …}} computed by the server over all records. */
    retentionPreview: read('retention.preview'),
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
  // a sign-out, or a session that now belongs to another user (SIGNED_IN / USER_UPDATED from another tab or client),
  // drops the snapshot at once; another user's data is then loaded fresh
  sb.auth.onAuthStateChange((event, session) => {
    const uid = session && session.user ? session.user.id : null;
    const switched = uid && shownUserId && uid !== shownUserId;
    if (event !== 'SIGNED_OUT' && !switched) return;
    gen++;
    if (stopNudges) { stopNudges(); stopNudges = null; }
    shownUserId = null; email = null;
    snap = SIGNED_OUT();
    emit();
    if (switched) refresh().catch(e => console.error(toApiError(e)));
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
    auth, consent, push, import: imports, reminders, curriculum, observations, progress, reports, photos,
    _supabase: sb,
  };
  return api;
}
