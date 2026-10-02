import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyDb } from '../src/store/schema.js';
import * as T from '../src/domain/transport.js';
import { simulationPlan } from '../src/domain/sim.js';

const BASE_MS = Date.UTC(2026, 9, 2, 2, 0, 0); // 07:30 IST
const iso = ms => new Date(ms).toISOString();
const ctx = (ms = BASE_MS) => ({ actor: { role: 'driver', id: 'DRV' }, now: iso(ms), today: '2026-10-02' });

function fixture() {
  const db = createEmptyDb();
  db.school.currentAcademicYearId = 'AY2026-27';
  db.academicYears.push({ id: 'AY2026-27', label: '2026-27', startDate: '2026-06-01', endDate: '2027-05-31' });
  db.programs.push({ id: 'PA', name: 'Primary A', ageRange: '3-6', teacherIds: [] });
  db.staff.push({ id: 'DRV', firstName: 'Dev', lastName: 'Testwala', role: 'driver', programIds: [], phone: '+91-90000-00009' });
  // stops listed out of order on purpose; seq defines the order (~1.1 km apart, north-bound)
  db.routes.push({ id: 'R1', name: 'Route 1', busNo: 'DEMO-1', driverId: 'DRV', attendantId: null, transportFeePaise: 100000, path: null, stops: [
    { id: 'S3', name: 'Third Stop', lat: 12.990, lng: 77.750, seq: 3, scheduledPickup: '07:50', scheduledDrop: '13:10' },
    { id: 'S1', name: 'First Stop', lat: 12.970, lng: 77.750, seq: 1, scheduledPickup: '07:30', scheduledDrop: '13:30' },
    { id: 'S2', name: 'Second Stop', lat: 12.980, lng: 77.750, seq: 2, scheduledPickup: '07:40', scheduledDrop: '13:20' },
  ] });
  db.guardians.push({ id: 'G1', firstName: 'G', lastName: 'Demoson', relation: 'mother', phone: '+91-90000-00100', email: 'g1@example.com', studentIds: ['K1'] });
  db.students.push({ id: 'K1', firstName: 'Kiran', lastName: 'Demoson', dob: '2022-01-01', programId: 'PA', admissionNo: 'K1', status: 'active', guardianIds: ['G1'], routeId: 'R1', stopId: 'S2', feeCategory: 'regular', healthNotes: null });
  return db;
}

test('haversine matches independent geometry within 1 %', () => {
  // 0.1° of latitude on a meridian = 0.1 × π/180 × 6371.0088 km ≈ 11.119 km
  const ns = T.haversineMeters({ lat: 12.90, lng: 77.60 }, { lat: 13.00, lng: 77.60 });
  assert.ok(Math.abs(ns - 11119.5) / 11119.5 < 0.01, String(ns));
  // 0.1° of longitude at 12.97° N ≈ 11.119 km × cos(12.97°) ≈ 10.836 km
  const ew = T.haversineMeters({ lat: 12.97, lng: 77.60 }, { lat: 12.97, lng: 77.70 });
  assert.ok(Math.abs(ew - 10835.8) / 10835.8 < 0.01, String(ew));
  assert.equal(T.haversineMeters({ lat: 12.97, lng: 77.75 }, { lat: 12.97, lng: 77.75 }), 0);
});

test('simulated trip visits stops in seq order, ends at the last stop, events nearing→arrived→departed', () => {
  const db = fixture();
  const route = db.routes[0];
  const plan = simulationPlan(route, { speedKmph: 30, tickMs: 1000 });
  const last = plan[plan.length - 1];
  assert.deepEqual([last.lat, last.lng], [12.990, 77.750]);
  assert.deepEqual([plan[0].lat, plan[0].lng], [12.970, 77.750]);
  assert.equal(plan[0].dtMs, 0);
  const trip = T.startTrip(db, { routeId: 'R1', direction: 'pickup', simulated: true }, ctx());
  let t = BASE_MS;
  for (const p of plan) { t += p.dtMs; T.recordPosition(db, trip.id, { lat: p.lat, lng: p.lng, accuracy: p.accuracy, ts: iso(t) }); }
  const evs = trip.stopEvents.map(e => `${e.stopId}:${e.type}`);
  assert.deepEqual(evs, ['S1:nearing', 'S1:arrived', 'S1:departed', 'S2:nearing', 'S2:arrived', 'S2:departed', 'S3:nearing', 'S3:arrived']);
  const arrivals = trip.stopEvents.filter(e => e.type === 'arrived').map(e => e.stopId);
  assert.deepEqual(arrivals, ['S1', 'S2', 'S3']);
  for (const s of ['S1', 'S2', 'S3']) {
    const order = trip.stopEvents.filter(e => e.stopId === s).map(e => e.type);
    assert.deepEqual(order, s === 'S3' ? ['nearing', 'arrived'] : ['nearing', 'arrived', 'departed']);
  }
  assert.equal(trip.simulated, true);
  T.endTrip(db, trip.id, ctx(t));
  assert.equal(trip.status, 'ended');
});

test('a single jitter fix inside the arrival radius does not trigger arrival', () => {
  const route = fixture().routes[0];
  const tracker = {};
  const at = (lat, ms) => ({ lat, lng: 77.750, accuracy: 10, ts: iso(BASE_MS + ms) });
  T.deriveStopEvents(route, tracker, at(12.9775, 0));     // ~280 m south of S2
  const near = T.deriveStopEvents(route, tracker, at(12.9776, 5000));
  assert.deepEqual(near.filter(e => e.stopId === 'S2').map(e => e.type), ['nearing']);
  const jitter = T.deriveStopEvents(route, tracker, at(12.9798, 10000)); // ~22 m: one fix only
  assert.equal(jitter.filter(e => e.stopId === 'S2').length, 0);
  const back = T.deriveStopEvents(route, tracker, at(12.9777, 15000));
  assert.equal(back.filter(e => e.type === 'arrived').length, 0);
  assert.equal(tracker.S2.phase, 'nearing');
});

test('fixes with accuracy > 100 m are stored but never drive events', () => {
  const db = fixture();
  const trip = T.startTrip(db, { routeId: 'R1', direction: 'pickup', simulated: false }, ctx());
  for (let i = 0; i < 4; i++) {
    const r = T.recordPosition(db, trip.id, { lat: 12.980, lng: 77.750, accuracy: 150, ts: iso(BASE_MS + i * 10000) });
    assert.deepEqual(r.newEvents, []);
  }
  assert.equal(trip.stopEvents.length, 0);
  assert.equal(trip.positions.length, 4);
});

test('ETA is null with fewer than two recent fixes; computed from recent motion otherwise', () => {
  const stop = { lat: 12.990, lng: 77.750 };
  const f = (lat, s) => ({ lat, lng: 77.750, accuracy: 10, ts: iso(BASE_MS + s * 1000) });
  assert.equal(T.etaMinutes([], stop, iso(BASE_MS)), null);
  assert.equal(T.etaMinutes([f(12.970, 0)], stop, iso(BASE_MS + 1000)), null);
  // two fixes but older than 60 s → null
  assert.equal(T.etaMinutes([f(12.970, 0), f(12.971, 10)], stop, iso(BASE_MS + 120000)), null);
  // ~111 m in 10 s ≈ 11 m/s; ~2.11 km left → ≈ 190 s → 4 min
  assert.equal(T.etaMinutes([f(12.970, 0), f(12.971, 10)], stop, iso(BASE_MS + 15000)), 4);
  // stationary → null rather than a made-up number
  assert.equal(T.etaMinutes([f(12.970, 0), f(12.970, 10)], stop, iso(BASE_MS + 15000)), null);
});

test('downsampling drops near-duplicates, keeps first/last and respects the cap', () => {
  const pos = [];
  assert.equal(T.downsamplePush(pos, { lat: 12.97, lng: 77.75, accuracy: 5, ts: iso(BASE_MS) }), true);
  assert.equal(T.downsamplePush(pos, { lat: 12.97001, lng: 77.75, accuracy: 5, ts: iso(BASE_MS + 2000) }), false); // 1 m, 2 s
  assert.equal(T.downsamplePush(pos, { lat: 12.97001, lng: 77.75, accuracy: 5, ts: iso(BASE_MS + 6000) }), true);  // 6 s later
  const capped = [];
  const first = { lat: 12.9, lng: 77.7, accuracy: 5, ts: iso(BASE_MS) };
  T.downsamplePush(capped, first, 10);
  let lastFix;
  for (let i = 1; i <= 100; i++) { lastFix = { lat: 12.9 + i * 0.001, lng: 77.7, accuracy: 5, ts: iso(BASE_MS + i * 10000) }; T.downsamplePush(capped, lastFix, 10); }
  assert.ok(capped.length <= 10, String(capped.length));
  assert.equal(capped[0], first);
  assert.equal(capped[capped.length - 1], lastFix);
});

test('parentView: own stop only, stale after 45 s, child events', () => {
  const db = fixture();
  const trip = T.startTrip(db, { routeId: 'R1', direction: 'pickup', simulated: true }, ctx());
  for (const [i, lat] of [12.9765, 12.9770, 12.9790, 12.9799, 12.9800].entries()) {
    T.recordPosition(db, trip.id, { lat, lng: 77.750, accuracy: 10, ts: iso(BASE_MS + i * 10000) });
  }
  T.markChild(db, trip.id, { studentId: 'K1', type: 'boarded' }, ctx(BASE_MS + 45000));
  const v = T.parentView(db, 'K1', iso(BASE_MS + 50000), '2026-10-02');
  assert.equal(v.stop.id, 'S2');
  assert.equal(v.fixAgeSeconds, 10);
  assert.equal(v.stale, false);
  assert.ok(v.events.some(e => e.kind === 'stop' && /arrived at Second Stop/.test(e.text)));
  assert.ok(!v.events.some(e => /First Stop|Third Stop/.test(e.text) && e.kind === 'stop'));
  assert.ok(v.trip.stopEvents.length > 0 && v.trip.stopEvents.every(e => e.stopId === 'S2'), 'returned trip is scoped too');
  assert.ok(v.events.some(e => e.kind === 'child' && /boarded/.test(e.text)));
  assert.equal(v.etaMinutes, null); // already arrived
  const later = T.parentView(db, 'K1', iso(BASE_MS + 40000 + 46000), '2026-10-02');
  assert.equal(later.stale, true);
  assert.throws(() => T.startTrip(db, { routeId: 'R1', direction: 'pickup' }, ctx()), { code: 'VALIDATION' });
});

test('trips older than 30 days keep events but drop positions', () => {
  const db = fixture();
  const old = T.startTrip(db, { routeId: 'R1', direction: 'drop', simulated: true }, { ...ctx(), today: '2026-08-01' });
  T.recordPosition(db, old.id, { lat: 12.97, lng: 77.75, accuracy: 5, ts: iso(BASE_MS) });
  old.stopEvents.push({ stopId: 'S1', type: 'arrived', ts: iso(BASE_MS) });
  T.endTrip(db, old.id, ctx());
  T.pruneOldTrips(db, '2026-10-02');
  assert.equal(old.positions.length, 0);
  assert.equal(old.stopEvents.length, 1);
});
