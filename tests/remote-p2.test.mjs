// Real-app api (remote.js) fixes from the Phase 2 audit, against a fake Supabase client (no network).
//   #14 stale snapshot responses never overwrite a newer one or survive a sign-out
//   #20 every write carries a request id; an unanswered write is retried with the SAME id; a saved write is not
//       reported as failed because the refetch afterwards failed
//   #36 the audit screen reads audit_log (the snapshot carries none)
//   #37 business dates are IST on a device in another zone
//   #40 the bus view re-reads the route's trips from the server on every call
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildSeed } from '../src/seed/seed-data.js';
import { createRemoteApi } from '../src/api/remote.js';
import { createSurface, ApiError, toApiError, op } from '../src/api/index.js';
import { dateInZone } from '../src/domain/dates.js';

const NOW = new Date(Date.UTC(2026, 9, 2, 5, 0, 0));
const snapshotOf = (me) => ({ status: 'active', me, revs: {}, remindersSent: [], ...buildSeed(NOW), auditLog: [] }); // my_snapshot carries no audit rows
const PARENT = { userId: 'u-parent', role: 'parent', staffId: null, guardianId: 'grd-02' };
const ACCOUNTANT = { userId: 'u-acct', role: 'accountant', staffId: 'stf-accountant', guardianId: null };

function fakeSb({ snapshots = [], tables = {} } = {}) {
  let session = { user: { id: 'u-parent', email: 'parent@example.com' }, access_token: 't' };
  const authListeners = [];
  const queries = [];
  const sb = {
    queries,
    setUser(id) { session = id ? { user: { id, email: `${id}@example.com` }, access_token: 't' } : null; },
    auth: {
      getSession: async () => ({ data: { session } }),
      onAuthStateChange: cb => { authListeners.push(cb); return { data: { subscription: { unsubscribe() {} } } }; },
      signOut: async () => { session = null; for (const cb of authListeners) cb('SIGNED_OUT', null); return {}; },
    },
    rpc: async () => { const next = snapshots.shift(); if (!next) throw new Error('no snapshot queued'); return next(); },
    from(table) {
      const q = { table, filters: [], order: null, limit: null };
      const b = {
        select(c) { q.select = c; return b; },
        eq(c, v) { q.filters.push(['eq', c, v]); return b; },
        gte(c, v) { q.filters.push(['gte', c, v]); return b; },
        in(c, v) { q.filters.push(['in', c, v]); return b; },
        order(c, o) { q.order = [c, o]; return b; },
        limit(n) { q.limit = n; return b; },
        then(res, rej) { queries.push(q); return Promise.resolve(tables[table] ? tables[table](q) : { data: [], error: null }).then(res, rej); },
      };
      return b;
    },
    channel() { const ch = { on() { return ch; }, subscribe() { return ch; } }; return ch; },
    removeChannel() {},
  };
  return sb;
}
const make = (sb, call = async () => ({ result: null })) => createRemoteApi({ supabaseUrl: 'http://127.0.0.1:9', supabaseAnonKey: 'x' }, { createSurface, ApiError, toApiError, op, sb, call });
const deferred = () => { let resolve; const p = new Promise(r => { resolve = r; }); return { p, resolve }; };

test('#14 a snapshot that was in flight when the user signed out is dropped (no data comes back)', async () => {
  const slow = deferred();
  const sb = fakeSb({ snapshots: [() => slow.p] });
  const api = await make(sb);
  const ready = api.ready();
  await api.auth.signOut();
  slow.resolve({ data: snapshotOf(PARENT), error: null });
  await ready;
  assert.equal(api.getDb(), null, 'the previous user\'s data is not restored');
  assert.equal(api.session.current(), null);
});

test('#14 a snapshot started under another user is dropped; an older response never overwrites a newer one', async () => {
  const slow = deferred();
  const sb = fakeSb({ snapshots: [() => slow.p] });
  const api = await make(sb);
  const first = api.refresh();
  sb.setUser('u-other'); // the session changed to someone else while the request was in flight
  slow.resolve({ data: snapshotOf(PARENT), error: null });
  await first;
  assert.equal(api.getDb(), null);

  const older = deferred(), newer = deferred();
  const sb2 = fakeSb({ snapshots: [() => older.p, () => newer.p] });
  const api2 = await make(sb2);
  const a = api2.refresh(), b = api2.refresh();
  const nb = snapshotOf(PARENT); nb.school = { ...nb.school, name: 'NEWER' };
  newer.resolve({ data: nb, error: null }); await b;
  const oa = snapshotOf(PARENT); oa.school = { ...oa.school, name: 'OLDER' };
  older.resolve({ data: oa, error: null }); await a;
  assert.equal(api2.getDb().school.name, 'NEWER');
});

test('#20 a write carries a request id, is retried once with the same id when unanswered, and is not failed by a failed refetch', async () => {
  const bodies = [];
  let n = 0;
  const call = async (fn, body) => { bodies.push({ fn, ...structuredClone(body) }); if (n++ === 0) throw new ApiError('OFFLINE', 'no answer'); return { result: { id: 'pay-1' } }; };
  const sb = fakeSb({ snapshots: [async () => ({ data: snapshotOf(ACCOUNTANT), error: null }), async () => ({ data: null, error: { message: 'network down' } })] });
  const api = await make(sb, call);
  await api.ready();
  const r = await api.fees.recordPayment({ studentId: 'stu-03', amountPaise: 100, mode: 'cash', paidOn: '2026-10-02' });
  assert.deepEqual(r, { id: 'pay-1' }, 'saved, so reported as saved even though the refetch failed');
  assert.equal(bodies.length, 2);
  assert.match(bodies[0].requestId, /^[A-Za-z0-9_-]{8,100}$/);
  assert.equal(bodies[1].requestId, bodies[0].requestId, 'the retry is the same request');
  const other = await api.fees.recordPayment({ studentId: 'stu-03', amountPaise: 100, mode: 'cash', paidOn: '2026-10-02' }).catch(() => null);
  void other;
  assert.notEqual(bodies[2].requestId, bodies[0].requestId, 'a new user action is a new request');
});

test('#36 the audit list is read from audit_log, filtered and newest first', async () => {
  const docs = [{ id: 'aud-2', ts: '2026-10-02T05:00:00.000Z', entity: 'payment', entityId: 'pay-1', action: 'record', summary: 'x' }];
  const sb = fakeSb({ snapshots: [async () => ({ data: snapshotOf(ACCOUNTANT), error: null })], tables: { audit_log: () => ({ data: docs.map(doc => ({ doc })), error: null }) } });
  const api = await make(sb);
  await api.ready();
  assert.deepEqual(api.getDb().auditLog, [], 'the snapshot carries no audit rows');
  const rows = await api.audit.list({ entity: 'payment', entityId: 'pay-1', limit: 5 });
  assert.deepEqual(rows, docs);
  const q = sb.queries.find(x => x.table === 'audit_log');
  assert.deepEqual(q.filters, [['eq', 'entity', 'payment'], ['eq', 'doc->>entityId', 'pay-1']]);
  assert.deepEqual(q.order, ['ts', { ascending: false }]);
  assert.equal(q.limit, 5);
});

test('#40 every bus-view call re-reads the route\'s trips and child events from the server', async () => {
  const today = dateInZone(Date.now(), 330);
  let tripDoc = { id: 'trp-new', routeId: 'route-1', direction: 'pickup', date: today, driverId: 'stf-driver-1', simulated: false, status: 'active', startedAt: new Date(Date.now() - 60000).toISOString(), endedAt: null, stopEvents: [] };
  const snap = snapshotOf(PARENT);
  snap.trips = []; // the snapshot knows of no trip (the live feed missed the start)
  const sb = fakeSb({
    snapshots: [async () => ({ data: snap, error: null })],
    tables: {
      trips: q => ({ data: q.filters.some(f => f[0] === 'eq' && f[1] === 'route_id' && f[2] === 'route-1') ? [{ doc: tripDoc }] : [], error: null }),
      trip_child_events: () => ({ data: [{ trip_id: 'trp-new', seq: 1, doc: { studentId: 'stu-03', stopId: 'route-1-stop-2', type: 'boarded', ts: new Date().toISOString(), by: 'stf-driver-1' } }], error: null }),
      trip_positions: () => ({ data: [], error: null }),
    },
  });
  const api = await make(sb);
  await api.ready();
  const v = await api.transport.parentView('stu-03');
  assert.equal(v.trip && v.trip.id, 'trp-new', 'the new trip is found');
  assert.ok(v.events.some(e => e.kind === 'child'), "the child's boarding event is shown");
  tripDoc = { ...tripDoc, status: 'ended', endedAt: new Date().toISOString() };
  const v2 = await api.transport.parentView('stu-03');
  assert.equal(v2.trip.status, 'ended', 'the end is noticed on the next call');
  assert.equal(sb.queries.filter(q => q.table === 'trips').length, 2);
});

test('#37 in the real app "today" is the IST date even on a device in another time zone', () => {
  const script = `
    const { createRemoteApi } = await import(${JSON.stringify(new URL('../src/api/remote.js', import.meta.url).href)});
    const idx = await import(${JSON.stringify(new URL('../src/api/index.js', import.meta.url).href)});
    const { todayISO, tsToLocalDate } = await import(${JSON.stringify(new URL('../src/domain/dates.js', import.meta.url).href)});
    const at = new Date(Date.UTC(2026, 9, 2, 20, 30)); // 02-Oct 13:30 in Los Angeles, 03-Oct 02:00 in India
    const before = todayISO(at);
    const sb = { auth: { getSession: async () => ({ data: { session: null } }), onAuthStateChange() {} }, channel() {}, removeChannel() {} };
    await createRemoteApi({}, { ...idx, sb, call: async () => ({}) });
    console.log(JSON.stringify([before, todayISO(at), tsToLocalDate(at.toISOString())]));`;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, TZ: 'America/Los_Angeles' }, encoding: 'utf8', cwd: fileURLToPath(new URL('..', import.meta.url)) });
  assert.deepEqual(JSON.parse(out.trim().split('\n').at(-1)), ['2026-10-02', '2026-10-03', '2026-10-03']);
});
